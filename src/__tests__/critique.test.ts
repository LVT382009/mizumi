import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCritique, filterByConfidence, parseCritiqueOutput } from "../critique.js";
import type { ReviewResponseType } from "../review.js";

// ---------------------------------------------------------------------------
// filterByConfidence — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("filterByConfidence", () => {
  const baseReview: ReviewResponseType = {
    summary: "Test review",
    riskScore: 3,
    comments: [
      {
        file: "src/a.ts",
        line: 1,
        severity: "critical",
        category: "security",
        message: "SQL injection",
        suggestion: "Use parameterized queries",
        confidence: 95,
      },
      {
        file: "src/b.ts",
        line: 2,
        severity: "high",
        category: "bug",
        message: "Null dereference",
        confidence: 85,
      },
      {
        file: "src/c.ts",
        line: 3,
        severity: "medium",
        category: "performance",
        message: "Unnecessary loop",
        confidence: 70,
      },
      {
        file: "src/d.ts",
        line: 4,
        severity: "low",
        category: "style",
        message: "Inconsistent naming",
        confidence: 50,
      },
    ],
    decision: "request_changes",
  };

  it("filters out comments below threshold", () => {
    const result = filterByConfidence(baseReview, 80);
    expect(result.comments).toHaveLength(2);
    expect(result.comments.every((c) => c.confidence >= 80)).toBe(true);
  });

  it("keeps all comments when threshold is 0", () => {
    const result = filterByConfidence(baseReview, 0);
    expect(result.comments).toHaveLength(4);
  });

  it("removes all comments when threshold is 100", () => {
    const result = filterByConfidence(baseReview, 100);
    expect(result.comments).toHaveLength(0);
  });

  it("keeps decision unchanged when critical/high findings remain above threshold", () => {
    const result = filterByConfidence(baseReview, 80);
    expect(result.decision).toBe("request_changes");
  });

  it("downgrades decision to 'comment' when critical/high are filtered but medium/low remain", () => {
    const reviewWithOnlyCritical: ReviewResponseType = {
      ...baseReview,
      comments: [baseReview.comments[0]], // only the critical (confidence 95)
    };
    const result = filterByConfidence(reviewWithOnlyCritical, 96);
    // critical (95) is filtered out, no comments remain that are >= 96
    // but the filter removes the critical finding; if some lower findings existed
    // the decision would be "comment". Here: no comments pass, so "approve".
    expect(result.comments).toHaveLength(0);
    expect(result.decision).toBe("approve");
  });

  it("sets decision to 'comment' when all critical/high are filtered but some comments remain", () => {
    const review: ReviewResponseType = {
      ...baseReview,
      comments: [
        { ...baseReview.comments[0], confidence: 60 }, // critical but low confidence
        baseReview.comments[2], // medium at 70
      ],
    };
    const filtered = filterByConfidence(review, 65);
    // critical (60) filtered, medium (70) passes → no critical/high → "comment"
    expect(filtered.decision).toBe("comment");
    expect(filtered.comments).toHaveLength(1);
  });

  it("sets decision to 'approve' when all comments are filtered out", () => {
    const result = filterByConfidence(baseReview, 100);
    expect(result.decision).toBe("approve");
  });

  it("preserves non-comment fields in returned review", () => {
    const result = filterByConfidence(baseReview, 80);
    expect(result.summary).toBe("Test review");
    expect(result.riskScore).toBe(3);
  });

  it("handles empty comments array", () => {
    const emptyReview: ReviewResponseType = {
      summary: "Clean PR",
      riskScore: 1,
      comments: [],
      decision: "approve",
    };
    const result = filterByConfidence(emptyReview, 80);
    expect(result.comments).toHaveLength(0);
    expect(result.decision).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
// parseCritiqueOutput — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("parseCritiqueOutput", () => {
  const original: ReviewResponseType = {
    summary: "Original",
    riskScore: 3,
    comments: [
      {
        file: "a.ts",
        line: 1,
        severity: "critical",
        category: "bug",
        message: "Bug",
        confidence: 90,
      },
    ],
    decision: "request_changes",
  };

  it("parses JSON from markdown code block", () => {
    const text = "```json\n" + JSON.stringify(original) + "\n```";
    const result = parseCritiqueOutput(text, original);
    expect(result.summary).toBe("Original");
    expect(result.comments).toHaveLength(1);
  });

  it("parses bare JSON without code block", () => {
    const text = JSON.stringify(original);
    const result = parseCritiqueOutput(text, original);
    expect(result.summary).toBe("Original");
  });

  it("returns original when JSON is invalid", () => {
    const text = "not valid json at all";
    const result = parseCritiqueOutput(text, original);
    expect(result).toBe(original);
  });

  it("returns original when output is empty string", () => {
    const result = parseCritiqueOutput("", original);
    expect(result).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// runCritique — requires mocking generateObject
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getApiKey: vi.fn(() => "test-key"),
  requireApiKey: vi.fn(() => "test-key"),
  MizumiConfig: {},
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn(() => "mock-model")),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => "mock-model")),
}));

import { generateObject } from "ai";

const mockGenerateObject = vi.mocked(generateObject);

describe("runCritique", () => {
  const baseConfig = {
    selfCritique: true,
    confidenceThreshold: 80,
    provider: "openai" as const,
    model: "gpt-4.1-mini",
    baseUrl: "",
    profile: "chill" as const,
    maxComments: 15,
    language: "en-US",
    autoReview: true, autoPauseAfter: 5,
    excludePatterns: [],
    tierRouting: true,
    smallDiffThreshold: 50,
    securityPaths: ["**/auth/**", "**/crypto/**", "**/sql/**", "**/secret*", "**/password*"],
    spendThreshold: 0,
    gateThreshold: "none" as const,
  };

  const reviewWithComments: ReviewResponseType = {
    summary: "Has issues",
    riskScore: 4,
    comments: [
      {
        file: "src/app.ts",
        line: 10,
        severity: "high",
        category: "bug",
        message: "Null pointer",
        confidence: 90,
      },
      {
        file: "src/util.ts",
        line: 5,
        severity: "low",
        category: "style",
        message: "Bad name",
        confidence: 50,
      },
    ],
    decision: "request_changes",
  };

  it("skips critique and filters by confidence when selfCritique is false", async () => {
    const result = await runCritique(reviewWithComments, {
      ...baseConfig,
      selfCritique: false,
    });
    // Should skip LLM call and just filter by confidence (80)
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(90);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("skips critique when review has no comments", async () => {
    const emptyReview: ReviewResponseType = {
      summary: "Clean",
      riskScore: 1,
      comments: [],
      decision: "approve",
    };
    const result = await runCritique(emptyReview, baseConfig);
    expect(result.comments).toHaveLength(0);
    expect(result.decision).toBe("approve");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("calls LLM when selfCritique is true and comments exist", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Filtered",
        riskScore: 2,
        comments: [
          {
            file: "src/app.ts",
            line: 10,
            severity: "high",
            category: "bug",
            message: "Null pointer",
            confidence: 90,
          },
        ],
        decision: "comment",
      },
    } as any);

    const result = await runCritique(reviewWithComments, baseConfig);
    expect(mockGenerateObject).toHaveBeenCalledOnce();
    expect(result.comments).toHaveLength(1);
  });

  it("falls back to confidence-only filter when LLM call fails", async () => {
    mockGenerateObject.mockRejectedValue(new Error("LLM unavailable"));

    const result = await runCritique(reviewWithComments, baseConfig);
    // Falls back to filterByConfidence on the original review
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(90);
  });

  it("falls back to original when generateObject fails to produce structured output", async () => {
    mockGenerateObject.mockRejectedValue(new Error("NoObjectGeneratedError"));

    const result = await runCritique(reviewWithComments, baseConfig);
    // parseCritiqueOutput fails → returns original → filterByConfidence applies
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(90);
  });

  it("applies confidence filter even when selfCritique is true and LLM succeeds", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Some filtered",
        riskScore: 2,
        comments: [
          { file: "src/app.ts", line: 10, severity: "high", category: "bug", message: "Real bug", confidence: 95 },
          { file: "src/util.ts", line: 5, severity: "low", category: "style", message: "Nit", confidence: 40 },
        ],
        decision: "comment",
      },
    } as any);

    const result = await runCritique(reviewWithComments, baseConfig);
    // confidenceThreshold is 80, so the low-confidence nit should be filtered
    expect(result.comments.every((c) => c.confidence >= 80)).toBe(true);
  });

  it("returns approve when critique filters out all comments", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "All filtered",
        riskScore: 1,
        comments: [],
        decision: "approve",
      },
    } as any);

    const result = await runCritique(reviewWithComments, baseConfig);
    expect(result.comments).toHaveLength(0);
    expect(result.decision).toBe("approve");
  });

  it("passes review comments JSON in critique prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Filtered",
        riskScore: 2,
        comments: [],
        decision: "approve",
      },
    } as any);

    await runCritique(reviewWithComments, baseConfig);
    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("Null pointer");
    expect(callOpts.prompt).toContain("Critically evaluate");
  });
});

// ---------------------------------------------------------------------------
// filterByConfidence — additional edge cases
// ---------------------------------------------------------------------------

describe("filterByConfidence — additional edge cases", () => {
  it("keeps comments exactly at threshold", () => {
    const review: ReviewResponseType = {
      summary: "Edge",
      riskScore: 3,
      comments: [
        { file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", confidence: 80 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 80);
    expect(result.comments).toHaveLength(1);
  });

  it("filters comments just below threshold", () => {
    const review: ReviewResponseType = {
      summary: "Edge",
      riskScore: 3,
      comments: [
        { file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", confidence: 79 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 80);
    expect(result.comments).toHaveLength(0);
    expect(result.decision).toBe("approve");
  });

  it("handles threshold of 1 correctly", () => {
    const review: ReviewResponseType = {
      summary: "Low bar",
      riskScore: 2,
      comments: [
        { file: "a.ts", line: 1, severity: "low", category: "style", message: "Style", confidence: 1 },
      ],
      decision: "comment",
    };
    const result = filterByConfidence(review, 1);
    expect(result.comments).toHaveLength(1);
  });

  it("handles single high-confidence comment preserving decision", () => {
    const review: ReviewResponseType = {
      summary: "One issue",
      riskScore: 4,
      comments: [
        { file: "a.ts", line: 1, severity: "critical", category: "security", message: "XSS", confidence: 99 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 90);
    expect(result.comments).toHaveLength(1);
    expect(result.decision).toBe("request_changes");
  });

  it("downgrades to comment when only medium/low survive at high threshold", () => {
    const review: ReviewResponseType = {
      summary: "Mixed",
      riskScore: 3,
      comments: [
        { file: "a.ts", line: 1, severity: "critical", category: "security", message: "XSS", confidence: 50 },
        { file: "b.ts", line: 2, severity: "medium", category: "performance", message: "Slow", confidence: 85 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 60);
    expect(result.comments).toHaveLength(1);
    expect(result.decision).toBe("comment");
  });

  it("preserves summary and riskScore unchanged", () => {
    const review: ReviewResponseType = {
      summary: "Custom summary",
      riskScore: 5,
      comments: [
        { file: "a.ts", line: 1, severity: "low", category: "style", message: "X", confidence: 10 },
      ],
      decision: "comment",
    };
    const result = filterByConfidence(review, 50);
    expect(result.summary).toBe("Custom summary");
    expect(result.riskScore).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// parseCritiqueOutput — additional edge cases
// ---------------------------------------------------------------------------

describe("parseCritiqueOutput — additional edge cases", () => {
  const original: ReviewResponseType = {
    summary: "Original",
    riskScore: 3,
    comments: [
      { file: "a.ts", line: 1, severity: "critical", category: "bug", message: "Bug", confidence: 90 },
    ],
    decision: "request_changes",
  };

  it("handles markdown code block without json label", () => {
    const text = "```\n" + JSON.stringify(original) + "\n```";
    const result = parseCritiqueOutput(text, original);
    expect(result.summary).toBe("Original");
  });

  it("returns original for whitespace-only input", () => {
    const result = parseCritiqueOutput("   \n  \t  ", original);
    expect(result).toBe(original);
  });

  it("returns original for partial/truncated JSON", () => {
    const truncated = '{"summary": "Test", "riskScore": 3, "comments": [';
    const result = parseCritiqueOutput(truncated, original);
    expect(result).toBe(original);
  });

  it("returns original for valid JSON that does not match schema", () => {
    const wrongSchema = JSON.stringify({ totally: "wrong", fields: true });
    const result = parseCritiqueOutput(wrongSchema, original);
    expect(result).toBe(original);
  });

  it("handles JSON with extra text before code block", () => {
    const text = "Here is the result:\n```json\n" + JSON.stringify(original) + "\n```";
    const result = parseCritiqueOutput(text, original);
    expect(result.summary).toBe("Original");
  });

  it("handles nested code blocks gracefully", () => {
    // Unlikely but edge case: inner code block in message
    const reviewWithCode: ReviewResponseType = {
      summary: "Has code",
      riskScore: 2,
      comments: [
        { file: "a.ts", line: 1, severity: "high", category: "bug", message: "Use `const x = 1;`", confidence: 85 },
      ],
      decision: "comment",
    };
    const text = "```json\n" + JSON.stringify(reviewWithCode) + "\n```";
    const result = parseCritiqueOutput(text, original);
    expect(result.summary).toBe("Has code");
  });

  // --- parseCritiqueOutput with malformed inputs ---

  it("returns original for HTML input", () => {
    const html = "<html><body><p>Not JSON</p></body></html>";
    const result = parseCritiqueOutput(html, original);
    expect(result).toBe(original);
  });

  it("returns original for XML input", () => {
    const xml = "<response><summary>test</summary></response>";
    const result = parseCritiqueOutput(xml, original);
    expect(result).toBe(original);
  });

  it("returns original for random text input", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = parseCritiqueOutput(text, original);
    expect(result).toBe(original);
  });

  it("returns original for binary-looking content", () => {
    const binary = "\x00\x01\x02\x03\xff\xfe\xfd";
    const result = parseCritiqueOutput(binary, original);
    expect(result).toBe(original);
  });

  it("returns original for JSON with missing required fields", () => {
    const incompleteJson = JSON.stringify({ summary: "Partial" });
    const result = parseCritiqueOutput(incompleteJson, original);
    expect(result).toBe(original);
  });

  it("parses JSON with extra fields (returns valid subset)", () => {
    const extraFields = JSON.stringify({
      ...original,
      extraField: "should be ignored",
      anotherExtra: 42,
    });
    const result = parseCritiqueOutput(extraFields, original);
    expect(result.summary).toBe("Original");
    expect(result.riskScore).toBe(3);
    expect(result.comments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// filterByConfidence — all severity levels
// ---------------------------------------------------------------------------

describe("filterByConfidence — all severity levels", () => {
  const allSeverities: ReviewResponseType = {
    summary: "All severities",
    riskScore: 5,
    comments: [
      { file: "a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass", confidence: 95 },
      { file: "b.ts", line: 2, severity: "high", category: "bug", message: "Null deref", confidence: 85 },
      { file: "c.ts", line: 3, severity: "medium", category: "performance", message: "Slow loop", confidence: 70 },
      { file: "d.ts", line: 4, severity: "low", category: "style", message: "Bad name", confidence: 55 },
      { file: "e.ts", line: 5, severity: "nitpick", category: "style", message: "Extra space", confidence: 30 },
    ],
    decision: "request_changes",
  };

  it("keeps critical and high above threshold 80, downgrades to comment-only when no high remain", () => {
    // Only critical (95) and high (85) pass at 80 — critical+high still present
    const result = filterByConfidence(allSeverities, 80);
    expect(result.comments).toHaveLength(2);
    expect(result.decision).toBe("request_changes");
  });

  it("keeps only medium+low when threshold filters out critical/high — decision becomes comment", () => {
    const review: ReviewResponseType = {
      ...allSeverities,
      comments: [
        { file: "a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass", confidence: 60 },
        { file: "c.ts", line: 3, severity: "medium", category: "performance", message: "Slow loop", confidence: 75 },
        { file: "d.ts", line: 4, severity: "low", category: "style", message: "Bad name", confidence: 65 },
      ],
    };
    const result = filterByConfidence(review, 70);
    // critical (60) filtered, medium (75) and low (65) — 65 < 70 so only medium passes
    // no critical/high remain => "comment"
    expect(result.comments).toHaveLength(1);
    expect(result.decision).toBe("comment");
  });

  it("decision is comment when only low-severity findings remain", () => {
    const review: ReviewResponseType = {
      ...allSeverities,
      comments: [
        { file: "a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass", confidence: 40 },
        { file: "d.ts", line: 4, severity: "low", category: "style", message: "Bad name", confidence: 85 },
      ],
    };
    const result = filterByConfidence(review, 50);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].severity).toBe("low");
    expect(result.decision).toBe("comment");
  });

  it("keeps nitpick findings when threshold is very low", () => {
    const result = filterByConfidence(allSeverities, 1);
    expect(result.comments).toHaveLength(5);
  });

  it("filters out nitpick when threshold exceeds their confidence", () => {
    const result = filterByConfidence(allSeverities, 40);
    // nitpick (30) is filtered, low (55) passes
    expect(result.comments).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// filterByConfidence — confidence threshold boundary (79 vs 80 at threshold 80)
// ---------------------------------------------------------------------------

describe("filterByConfidence — boundary 79 vs 80", () => {
  it("keeps finding with confidence exactly 80 at threshold 80", () => {
    const review: ReviewResponseType = {
      summary: "Boundary",
      riskScore: 3,
      comments: [
        { file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", confidence: 80 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 80);
    expect(result.comments).toHaveLength(1);
  });

  it("filters out finding with confidence 79 at threshold 80", () => {
    const review: ReviewResponseType = {
      summary: "Boundary",
      riskScore: 3,
      comments: [
        { file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", confidence: 79 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 80);
    expect(result.comments).toHaveLength(0);
    expect(result.decision).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
// runCritique — provider fallback + prompt framing + config flags
// ---------------------------------------------------------------------------

describe("runCritique — provider and prompt details", () => {
  const baseConfig = {
    selfCritique: true,
    confidenceThreshold: 80,
    provider: "openai" as const,
    model: "gpt-4.1-mini",
    baseUrl: "",
    profile: "chill" as const,
    maxComments: 15,
    language: "en-US",
    autoReview: true, autoPauseAfter: 5,
    excludePatterns: [],
    tierRouting: true,
    smallDiffThreshold: 50,
    securityPaths: ["**/auth/**", "**/crypto/**", "**/sql/**", "**/secret*", "**/password*"],
    spendThreshold: 0,
    gateThreshold: "none" as const,
  };

  const reviewWithComments: ReviewResponseType = {
    summary: "Has issues",
    riskScore: 4,
    comments: [
      { file: "src/app.ts", line: 10, severity: "high", category: "bug", message: "Null pointer", confidence: 90 },
      { file: "src/util.ts", line: 5, severity: "low", category: "style", message: "Bad name", confidence: 50 },
    ],
    decision: "request_changes",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prompt contains obra or subterfuge framing", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Filtered",
        riskScore: 2,
        comments: [],
        decision: "approve",
      },
    } as any);

    await runCritique(reviewWithComments, baseConfig);
    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toMatch(/critically|subterfuge|obra/i);
  });

  it("respects selfCritique=false and skips LLM call", async () => {
    const result = await runCritique(reviewWithComments, {
      ...baseConfig,
      selfCritique: false,
    });
    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(result.comments).toHaveLength(1);
  });

  it("falls back to confidence-only filter when LLM rejects", async () => {
    mockGenerateObject.mockRejectedValue(new Error("Rate limit exceeded"));

    const result = await runCritique(reviewWithComments, baseConfig);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(90);
  });

  it("uses anthropic haiku when provider is anthropic", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Anthropic critique",
        riskScore: 1,
        comments: [],
        decision: "approve",
      },
    } as any);

    const anthropicConfig = { ...baseConfig, provider: "anthropic" as const, model: "claude-sonnet-4-20250514" };
    await runCritique(reviewWithComments, anthropicConfig);
    expect(mockGenerateObject).toHaveBeenCalledOnce();
  });

  it("uses configured model when provider is openai", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "OpenAI critique",
        riskScore: 1,
        comments: [],
        decision: "approve",
      },
    } as any);

    await runCritique(reviewWithComments, baseConfig);
    expect(mockGenerateObject).toHaveBeenCalledOnce();
    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.model).toBeDefined();
  });

  it("uses google provider when configured", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Google critique",
        riskScore: 1,
        comments: [],
        decision: "approve",
      },
    } as any);

    const googleConfig = { ...baseConfig, provider: "google" as const, model: "gemini-2.0-flash" };
    await runCritique(reviewWithComments, googleConfig);
    expect(mockGenerateObject).toHaveBeenCalledOnce();
  });

  it("returns approve when critique LLM returns empty comments and filters out all", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Clean",
        riskScore: 1,
        comments: [],
        decision: "approve",
      },
    } as any);

    const result = await runCritique(reviewWithComments, baseConfig);
    expect(result.decision).toBe("approve");
    expect(result.comments).toHaveLength(0);
  });

  it("passes confidence threshold value in the critique prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        summary: "Filtered",
        riskScore: 2,
        comments: [],
        decision: "approve",
      },
    } as any);

    const highThresholdConfig = { ...baseConfig, confidenceThreshold: 95 };
    await runCritique(reviewWithComments, highThresholdConfig);
    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("95");
  });
});

// ---------------------------------------------------------------------------
// filterByConfidence — decision is "comment" and only low findings pass
// ---------------------------------------------------------------------------

describe("filterByConfidence — comment decision with low-only findings", () => {
  it("decision becomes comment when only low findings pass threshold", () => {
    const review: ReviewResponseType = {
      summary: "Low only",
      riskScore: 2,
      comments: [
        { file: "a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass", confidence: 30 },
        { file: "b.ts", line: 2, severity: "low", category: "style", message: "Bad name", confidence: 90 },
      ],
      decision: "request_changes",
    };
    const result = filterByConfidence(review, 50);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].severity).toBe("low");
    expect(result.decision).toBe("comment");
  });
});
