import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReviewComment, ReviewResponse, runReview, sanitizeReviewOutput } from "../review.js";
import type { ReviewResponseType } from "../review.js";

// ---------------------------------------------------------------------------
// Mocks — must come before any import that reaches the real modules
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../config.js", () => ({
  requireApiKey: vi.fn(() => "test-key"),
}));

vi.mock("../sanitize.js", () => ({
  wrapDiff: vi.fn((diff: string) => `WRAPPED(${diff})`),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => "anthropic-model")),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    const modelFn = vi.fn(() => "openai-model");
    (modelFn as any).chat = vi.fn(() => "openai-chat-model");
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "google-model")),
}));

import { generateObject, generateText } from "ai";

const mockGenerateObject = vi.mocked(generateObject);
const mockGenerateText = vi.mocked(generateText);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Record<string, any>> = {}) {
  return {
    provider: "openai" as const,
    model: "gpt-4.1-mini",
    baseUrl: "",
    profile: "chill" as const,
    maxComments: 15,
    language: "en-US",
    selfCritique: true,
    confidenceThreshold: 80,
    autoReview: true,
    autoPauseAfter: 5,
    excludePatterns: [],
    tierRouting: true,
    smallDiffThreshold: 50,
    securityPaths: ["**/auth/**", "**/crypto/**", "**/sql/**"],
    ...overrides,
  };
}

const fakeReviewOutput: ReviewResponseType = {
  summary: "Looks good",
  riskScore: 1,
  comments: [],
  decision: "approve",
};

// ---------------------------------------------------------------------------
// ReviewComment schema
// ---------------------------------------------------------------------------

describe("ReviewComment schema", () => {
  const validComment = {
    file: "src/app.ts",
    line: 10,
    severity: "high" as const,
    category: "bug" as const,
    message: "Null pointer dereference",
    confidence: 90,
  };

  it("should parse valid comment with all required fields", () => {
    const result = ReviewComment.safeParse(validComment);
    expect(result.success).toBe(true);
  });

  it("should parse comment with optional endLine and suggestion", () => {
    const result = ReviewComment.safeParse({
      ...validComment,
      endLine: 15,
      suggestion: "Add null check",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endLine).toBe(15);
      expect(result.data.suggestion).toBe("Add null check");
    }
  });

  it("should reject comment with invalid severity", () => {
    const result = ReviewComment.safeParse({
      ...validComment,
      severity: "extreme",
    });
    expect(result.success).toBe(false);
  });

  it("should reject comment with invalid category", () => {
    const result = ReviewComment.safeParse({
      ...validComment,
      category: "typo",
    });
    expect(result.success).toBe(false);
  });

  it("should reject comment with confidence above 100", () => {
    const result = ReviewComment.safeParse({
      ...validComment,
      confidence: 101,
    });
    expect(result.success).toBe(false);
  });

  it("should reject comment with confidence below 0", () => {
    const result = ReviewComment.safeParse({
      ...validComment,
      confidence: -1,
    });
    expect(result.success).toBe(false);
  });

  it("should reject comment missing required file field", () => {
    const { file, ...noFile } = validComment;
    const result = ReviewComment.safeParse(noFile);
    expect(result.success).toBe(false);
  });

  it("should reject comment missing required line field", () => {
    const { line, ...noLine } = validComment;
    const result = ReviewComment.safeParse(noLine);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReviewResponse schema
// ---------------------------------------------------------------------------

describe("ReviewResponse schema", () => {
  const validResponse: ReviewResponseType = {
    summary: "Clean PR",
    riskScore: 2,
    comments: [],
    decision: "approve",
  };

  it("should parse valid response with empty comments", () => {
    const result = ReviewResponse.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it("should parse valid response with comments", () => {
    const result = ReviewResponse.safeParse({
      ...validResponse,
      comments: [
        {
          file: "src/a.ts",
          line: 5,
          severity: "medium",
          category: "performance",
          message: "N+1 query",
          confidence: 85,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.comments).toHaveLength(1);
    }
  });

  it("should reject response with riskScore 0 (minimum is 1)", () => {
    const result = ReviewResponse.safeParse({ ...validResponse, riskScore: 0 });
    expect(result.success).toBe(false);
  });

  it("should reject response with riskScore 6 (maximum is 5)", () => {
    const result = ReviewResponse.safeParse({ ...validResponse, riskScore: 6 });
    expect(result.success).toBe(false);
  });

  it("should reject response with invalid decision", () => {
    const result = ReviewResponse.safeParse({ ...validResponse, decision: "reject" });
    expect(result.success).toBe(false);
  });

  it("should reject response missing summary", () => {
    const { summary, ...noSummary } = validResponse;
    const result = ReviewResponse.safeParse(noSummary);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Profile instructions (tested indirectly via system prompt in runReview)
// ---------------------------------------------------------------------------

describe("profile instructions in system prompt", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("chill profile mentions bugs and security but not style", async () => {
    let capturedSystem = "";
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedSystem = opts.system;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "positions", "", "", "", makeConfig({ profile: "chill" }));

    expect(capturedSystem).toContain("bugs");
    expect(capturedSystem).toContain("security");
    expect(capturedSystem).toContain("Do NOT comment on: style");
  });

  it("assertive profile mentions style", async () => {
    let capturedSystem = "";
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedSystem = opts.system;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "positions", "", "", "", makeConfig({ profile: "assertive" }));

    expect(capturedSystem).toContain("style");
    expect(capturedSystem).toContain("naming");
    expect(capturedSystem).not.toContain("Do NOT comment on: style");
  });

  it("followup profile mentions previous review", async () => {
    let capturedSystem = "";
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedSystem = opts.system;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "positions", "", "", "", makeConfig({ profile: "followup" }));

    expect(capturedSystem).toContain("previous review");
  });
});

// ---------------------------------------------------------------------------
// System prompt build (tested indirectly via runReview)
// ---------------------------------------------------------------------------

describe("system prompt build", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("includes validPositions text in system prompt", async () => {
    let capturedSystem = "";
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedSystem = opts.system;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    const positions = "src/app.ts:10,src/app.ts:15";
    await runReview("diff", positions, "", "", "", makeConfig());

    expect(capturedSystem).toContain(positions);
    expect(capturedSystem).toContain("Valid comment positions");
  });

  it("includes severity guidelines in system prompt", async () => {
    let capturedSystem = "";
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedSystem = opts.system;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "positions", "", "", "", makeConfig());

    expect(capturedSystem).toContain("critical");
    expect(capturedSystem).toContain("security vulnerabilities");
    expect(capturedSystem).toContain("nitpick");
  });
});

// ---------------------------------------------------------------------------
// runReview — mocked LLM call
// ---------------------------------------------------------------------------

describe("runReview", () => {
  beforeEach(() => {
    mockGenerateObject.mockReset();
  });

  it("returns structured ReviewResponse from LLM output", async () => {
    const expected: ReviewResponseType = {
      summary: "One issue found",
      riskScore: 3,
      comments: [
        {
          file: "src/util.ts",
          line: 42,
          severity: "high",
          category: "bug",
          message: "Unhandled promise rejection",
          suggestion: "Add .catch() handler",
          confidence: 92,
        },
      ],
      decision: "request_changes",
    };

    mockGenerateObject.mockResolvedValue({ object:expected, usage: { inputTokens: 1000, outputTokens: 500, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any);

    const { output: result, usage } = await runReview("diff content", "src/util.ts:42", "", "", "", makeConfig());

    expect(result).toEqual(expected);
    expect(result.decision).toBe("request_changes");
    expect(result.comments).toHaveLength(1);
    expect(usage.inputTokens).toBe(1000);
  });

  it("passes diff content through wrapDiff", async () => {
    let capturedMessages: any[] = [];
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedMessages = opts.messages;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    const { wrapDiff } = await import("../sanitize.js");
    await runReview("some diff", "pos", "", "", "", makeConfig());

    expect(wrapDiff).toHaveBeenCalledWith("some diff");
    const userText = typeof capturedMessages[0]?.content === "string"
      ? capturedMessages[0].content
      : capturedMessages[0]?.content?.[0]?.text ?? "";
    expect(userText).toContain("WRAPPED(some diff)");
  });

  it("appends memory content to user prompt when provided", async () => {
    let capturedMessages: any[] = [];
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedMessages = opts.messages;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "pos", "past review patterns", "", "", makeConfig());

    const userText = typeof capturedMessages[0]?.content === "string"
      ? capturedMessages[0].content
      : capturedMessages[0]?.content?.[0]?.text ?? "";
    expect(userText).toContain("Project Memory");
    expect(userText).toContain("past review patterns");
  });

  it("appends rules content to user prompt when provided", async () => {
    let capturedMessages: any[] = [];
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedMessages = opts.messages;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "pos", "", "no console.log in production", "", makeConfig());

    const userText = typeof capturedMessages[0]?.content === "string"
      ? capturedMessages[0].content
      : capturedMessages[0]?.content?.[0]?.text ?? "";
    expect(userText).toContain("Project Rules");
    expect(userText).toContain("no console.log in production");
  });

  it("omits memory and rules sections when not provided", async () => {
    let capturedMessages: any[] = [];
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedMessages = opts.messages;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "pos", "", "", "", makeConfig());

    const userText = typeof capturedMessages[0]?.content === "string"
      ? capturedMessages[0].content
      : capturedMessages[0]?.content?.[0]?.text ?? "";
    expect(userText).not.toContain("Project Memory");
    expect(userText).not.toContain("Project Rules");
  });

  it("calls generateObject with maxOutputTokens 4096", async () => {
    mockGenerateObject.mockResolvedValue({ object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any);

    await runReview("diff", "pos", "", "", "", makeConfig());

    expect(mockGenerateObject).toHaveBeenCalledOnce();
    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.maxOutputTokens).toBe(4096);
  });

  it("falls back to generateText when generateObject fails with NoObjectGeneratedError", async () => {
    const noObjError = new Error("No object generated: the model did not return a response.") as any;
    noObjError.name = "AI_NoObjectGeneratedError";
    mockGenerateObject.mockRejectedValue(noObjError);
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({ summary: "Fallback review", riskScore: 3, comments: [], decision: "comment" }),
      usage: { inputTokens: 500, outputTokens: 200 },
    } as any);

    const result = await runReview("diff", "pos", "", "", "", makeConfig());

    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(result.output.summary).toBe("Fallback review");
    expect(result.usage.inputTokens).toBe(500);
  });

  it("falls back to empty review when generateText output is not valid JSON", async () => {
    const noObjError = new Error("No object generated") as any;
    noObjError.name = "AI_NoObjectGeneratedError";
    mockGenerateObject.mockRejectedValue(noObjError);
    mockGenerateText.mockResolvedValue({
      text: "This is not JSON at all",
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await runReview("diff", "pos", "", "", "", makeConfig());

    expect(result.output.comments).toHaveLength(0);
    expect(result.output.riskScore).toBe(3);
  });

  it("adds Anthropic cacheControl when provider is anthropic", async () => {
    let capturedMessages: any[] = [];
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedMessages = opts.messages;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "pos", "", "", "", makeConfig({ provider: "anthropic" }));

    expect(capturedMessages[0]?.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("does not add cacheControl for non-Anthropic providers", async () => {
    let capturedMessages: any[] = [];
    mockGenerateObject.mockImplementation(async (opts: any) => {
      capturedMessages = opts.messages;
      return { object:fakeReviewOutput, usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200, cacheWriteTokens: 0 } } } as any;
    });

    await runReview("diff", "pos", "", "", "", makeConfig({ provider: "openai" }));

    expect(capturedMessages[0]?.providerOptions).toBeUndefined();
  });

  it("custom provider passes base URL to createOpenAI", async () => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    mockGenerateObject.mockResolvedValue({ object:fakeReviewOutput, usage: { inputTokens: 500, outputTokens: 200, inputTokenDetails: { noCacheTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } } } as any);

    await runReview("diff", "pos", "", "", "", makeConfig({ provider: "custom", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/llama-3.3-70b-instruct" }));

    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://api.together.xyz/v1",
      name: "custom",
    }));
  });

  it("custom provider throws when baseUrl is empty and CUSTOM_BASE_URL is not set", async () => {
    delete process.env.CUSTOM_BASE_URL;
    const config = makeConfig({ provider: "custom", baseUrl: "" });
    await expect(
      runReview("diff", "pos", "", "", "", config)
    ).rejects.toThrow("Custom provider requires base_url input or CUSTOM_BASE_URL env var");
  });
});

// ---------------------------------------------------------------------------
// sanitizeReviewOutput — output validation guards
// ---------------------------------------------------------------------------

describe("sanitizeReviewOutput", () => {
  const baseReview: ReviewResponseType = {
    summary: "Looks good",
    riskScore: 2,
    comments: [],
    decision: "comment",
  };

  it("passes through valid output unchanged", () => {
    const review = { ...baseReview, riskScore: 3, decision: "approve" as const };
    const result = sanitizeReviewOutput(review);
    expect(result.riskScore).toBe(3);
    expect(result.decision).toBe("approve");
  });

  it("clamps riskScore to 1-5 range", () => {
    expect(sanitizeReviewOutput({ ...baseReview, riskScore: 0 }).riskScore).toBe(1);
    expect(sanitizeReviewOutput({ ...baseReview, riskScore: 10 }).riskScore).toBe(5);
    expect(sanitizeReviewOutput({ ...baseReview, riskScore: -1 }).riskScore).toBe(1);
  });

  it("defaults NaN riskScore to 3", () => {
    expect(sanitizeReviewOutput({ ...baseReview, riskScore: NaN }).riskScore).toBe(3);
  });

  it("defaults invalid decision to comment", () => {
    const result = sanitizeReviewOutput({ ...baseReview, decision: "reject" as any });
    expect(result.decision).toBe("comment");
  });

  it("rounds riskScore to integer", () => {
    expect(sanitizeReviewOutput({ ...baseReview, riskScore: 2.7 }).riskScore).toBe(3);
  });

  it("clamps confidence to 0-100 range", () => {
    const review = {
      ...baseReview,
      comments: [
        { file: "a.ts", line: 1, severity: "high" as const, category: "bug" as const, message: "x", confidence: 150 },
        { file: "b.ts", line: 2, severity: "low" as const, category: "style" as const, message: "y", confidence: -10 },
      ],
    };
    const result = sanitizeReviewOutput(review);
    expect(result.comments[0].confidence).toBe(100);
    expect(result.comments[1].confidence).toBe(0);
  });

  it("clamps negative line numbers to 1", () => {
    const review = {
      ...baseReview,
      comments: [{ file: "a.ts", line: -5, severity: "high" as const, category: "bug" as const, message: "x", confidence: 80 }],
    };
    const result = sanitizeReviewOutput(review);
    expect(result.comments[0].line).toBe(1);
  });

  it("defaults NaN line to 1", () => {
    const review = {
      ...baseReview,
      comments: [{ file: "a.ts", line: NaN, severity: "high" as const, category: "bug" as const, message: "x", confidence: 80 }],
    };
    const result = sanitizeReviewOutput(review);
    expect(result.comments[0].line).toBe(1);
  });

  it("fixes endLine that is before line", () => {
    const review = {
      ...baseReview,
      comments: [{ file: "a.ts", line: 10, endLine: 5, severity: "high" as const, category: "bug" as const, message: "x", confidence: 80 }],
    };
    const result = sanitizeReviewOutput(review);
    expect(result.comments[0].endLine).toBeGreaterThanOrEqual(result.comments[0].line);
  });

  it("filters out comments with empty file path", () => {
    const review = {
      ...baseReview,
      comments: [
        { file: "", line: 1, severity: "high" as const, category: "bug" as const, message: "x", confidence: 80 },
        { file: "  ", line: 2, severity: "low" as const, category: "style" as const, message: "y", confidence: 70 },
        { file: "valid.ts", line: 3, severity: "medium" as const, category: "bug" as const, message: "z", confidence: 90 },
      ],
    };
    const result = sanitizeReviewOutput(review);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe("valid.ts");
  });

  it("defaults NaN confidence to 50", () => {
    const review = {
      ...baseReview,
      comments: [{ file: "a.ts", line: 1, severity: "medium" as const, category: "bug" as const, message: "x", confidence: NaN }],
    };
    const result = sanitizeReviewOutput(review);
    expect(result.comments[0].confidence).toBe(50);
  });
});
