import { describe, it, expect, vi } from "vitest";
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
// runCritique — requires mocking generateText
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("../config.js", () => ({
  requireApiKey: vi.fn(() => "test-key"),
  MizumiConfig: {},
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn(() => "mock-model")),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => "mock-model")),
}));

import { generateText } from "ai";

const mockGenerateText = vi.mocked(generateText);

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
    expect(mockGenerateText).not.toHaveBeenCalled();
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
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("calls LLM when selfCritique is true and comments exist", async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
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
      }),
    } as any);

    const result = await runCritique(reviewWithComments, baseConfig);
    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(result.comments).toHaveLength(1);
  });

  it("falls back to confidence-only filter when LLM call fails", async () => {
    mockGenerateText.mockRejectedValue(new Error("LLM unavailable"));

    const result = await runCritique(reviewWithComments, baseConfig);
    // Falls back to filterByConfidence on the original review
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(90);
  });

  it("falls back to original when critique output is unparseable", async () => {
    mockGenerateText.mockResolvedValue({
      text: "I can't return JSON, sorry",
    } as any);

    const result = await runCritique(reviewWithComments, baseConfig);
    // parseCritiqueOutput fails → returns original → filterByConfidence applies
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].confidence).toBe(90);
  });
});
