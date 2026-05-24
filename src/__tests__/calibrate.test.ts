import { describe, it, expect, vi, beforeEach } from "vitest";
import { confidenceBadge, calibrateConfidence } from "../calibrate.js";
import type { ReviewResponseType } from "../review.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("../config.js", () => ({
  getApiKey: vi.fn(() => ""),
  requireApiKey: vi.fn(() => "test-key"),
  MizumiConfig: {},
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => "mock-anthropic-model")),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => vi.fn(() => "mock-openai-model")),
}));

import { generateObject } from "ai";
import { getApiKey } from "../config.js";

const mockGenerateObject = vi.mocked(generateObject);
const mockGetApiKey = vi.mocked(getApiKey);

// ---------------------------------------------------------------------------
// confidenceBadge — pure function
// ---------------------------------------------------------------------------

describe("confidenceBadge", () => {
  it("returns green badge for high confidence", () => {
    expect(confidenceBadge("high")).toContain("green");
  });

  it("returns yellow badge for medium confidence", () => {
    expect(confidenceBadge("medium")).toContain("yellow");
  });

  it("returns gray badge for low confidence", () => {
    expect(confidenceBadge("low")).toContain("lightgray");
  });

  it("includes shields.io URL", () => {
    expect(confidenceBadge("high")).toContain("img.shields.io");
  });

  it("includes 'confidence' in badge label", () => {
    expect(confidenceBadge("medium")).toContain("confidence");
  });
});

// ---------------------------------------------------------------------------
// calibrateConfidence — borderline + non-borderline logic
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-6",
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
    securityPaths: [],
    complianceCheck: false,
    autoFix: false,
    confidenceCalibration: true,
    changeStack: false,
    improveEnabled: false,
    dryRun: false,
    linterScan: false,
    autoLabels: false,
    spendThreshold: 0,
    gateThreshold: "none" as const,
    ...overrides,
  };
}

function makeReview(comments: Array<{ confidence: number; severity?: string; category?: string; message?: string; file?: string; line?: number }>): ReviewResponseType {
  return {
    summary: "test",
    riskScore: 3,
    comments: comments.map((c, i) => ({
      file: c.file || `src/file${i}.ts`,
      line: c.line || i + 1,
      severity: (c.severity || "medium") as "critical" | "high" | "medium" | "low" | "nitpick",
      category: (c.category || "bug") as "bug" | "security" | "performance" | "style" | "architecture" | "compliance",
      message: c.message || "Test finding",
      confidence: c.confidence,
    })),
    decision: "comment",
  };
}

describe("calibrateConfidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps high confidence (>80) findings to 'high' calibrated level", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 95 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("high");
  });

  it("maps low confidence (<60) findings to 'low' calibrated level", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 40 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("low");
  });

  it("maps borderline confidence (60-80) to 'medium' when no second model available", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("boosts borderline to 'high' when second model confirms", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({
      object: { confirmed: "yes" },
    } as any);

    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig({ provider: "anthropic" }));
    const borderline = result.find((c) => c.calibratedConfidence !== undefined);
    expect(borderline?.calibratedConfidence).toBe("high");
  });

  it("lowers borderline to 'low' when second model rejects", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({
      object: { confirmed: "no" },
    } as any);

    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig({ provider: "anthropic" }));
    const borderline = result.find((c) => c.calibratedConfidence === "low");
    expect(borderline).toBeDefined();
  });

  it("falls back to 'medium' when LLM call fails", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockRejectedValue(new Error("API error"));

    const review = makeReview([{ confidence: 75 }]);
    const result = await calibrateConfidence(review, makeConfig());
    const borderline = result.find((c) => c.calibratedConfidence === "medium");
    expect(borderline).toBeDefined();
  });

  it("adjusts confidence score up when confirmed", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({
      object: { confirmed: "yes" },
    } as any);

    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig());
    const borderline = result.find((c) => c.confidence > 70);
    expect(borderline?.confidence).toBe(85); // 70 + 15 = 85
  });

  it("adjusts confidence score down when rejected", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({
      object: { confirmed: "no" },
    } as any);

    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig());
    const borderline = result.find((c) => c.confidence < 70);
    expect(borderline?.confidence).toBe(50); // 70 - 20 = 50
  });

  it("clamps confidence at 100 max when boosting", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({
      object: { confirmed: "yes" },
    } as any);

    const review = makeReview([{ confidence: 80 }]); // borderline max
    const result = await calibrateConfidence(review, makeConfig());
    const borderline = result.find((c) => c.calibratedConfidence === "high");
    expect(borderline?.confidence).toBe(95); // min(80 + 15, 100) = 95
  });

  it("clamps confidence at 0 min when lowering", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({
      object: { confirmed: "no" },
    } as any);

    const review = makeReview([{ confidence: 60 }]); // borderline min
    const result = await calibrateConfidence(review, makeConfig());
    const borderline = result.find((c) => c.calibratedConfidence === "low");
    expect(borderline?.confidence).toBe(40); // max(60 - 20, 0) = 40
  });

  it("processes multiple borderline findings", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject
      .mockResolvedValueOnce({ object: { confirmed: "yes" } } as any)
      .mockResolvedValueOnce({ object: { confirmed: "no" } } as any);

    const review = makeReview([{ confidence: 65 }, { confidence: 75 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.calibratedConfidence === "high")).toBeDefined();
    expect(result.find((c) => c.calibratedConfidence === "low")).toBeDefined();
  });

  it("returns all findings including non-borderline", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([
      { confidence: 95 },  // high → "high"
      { confidence: 70 },  // borderline → "medium" (no model)
      { confidence: 30 },  // low → "low"
    ]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result).toHaveLength(3);
  });
});
