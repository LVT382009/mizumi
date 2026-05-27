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
// confidenceBadge - pure function
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

  it("returns correct markdown for high level", () => {
    expect(confidenceBadge("high")).toBe("![High](https://img.shields.io/badge/confidence-high-green)");
  });

  it("returns correct markdown for medium level", () => {
    expect(confidenceBadge("medium")).toBe("![Medium](https://img.shields.io/badge/confidence-medium-yellow)");
  });

  it("returns correct markdown for low level", () => {
    expect(confidenceBadge("low")).toBe("![Low](https://img.shields.io/badge/confidence-low-lightgray)");
  });
});

// ---------------------------------------------------------------------------
// calibrateConfidence - borderline + non-borderline logic
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
  astContractAnalysis: true,
  behavioralSummary: true,
  ownershipRouting: true,
  deltaReview: true,
      taintAnalysis: true,
      reviewLearning: true,
    blastRadius: true,
    specCompliance: true,
    authBoundary: true,
    fatigueDashboard: true,
    secretEntropy: true, safetyScore: true, adaptiveStrategy: true, businessContext: true,
      orgMemory: true,
        testGapDetection: true,
    suppressionMemories: true,
    swarmReview: true,
    complexityPrediction: true,
    prSplitSuggestions: true, findingLifecycle: true, intentClassification: true,
    depImpactAnalysis: true,
    threadContinuity: true,
    crossPRPersistence: true,
    sarifExport: true,
    reviewPriority: true,
    defenseFramework: true,
    checksApi: true,
    repoHealth: true,
    chunkReview: true,
    reviewCache: true,
    findingDedup: true,
    pipelineParallel: true,
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
      { confidence: 95 },
      { confidence: 70 },
      { confidence: 30 },
    ]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result).toHaveLength(3);
  });

  it("handles empty comments array", async () => {
    mockGetApiKey.mockReturnValue("");
    const review: ReviewResponseType = {
      summary: "empty",
      riskScore: 0,
      comments: [],
      decision: "comment",
    };
    const result = await calibrateConfidence(review, makeConfig());
    expect(result).toHaveLength(0);
  });

  it("maps all-high-confidence findings (all >80) to 'high'", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([
      { confidence: 85 },
      { confidence: 90 },
      { confidence: 95 },
    ]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result.every((c) => c.calibratedConfidence === "high")).toBe(true);
  });

  it("maps all-low-confidence findings (all <=50) to 'low'", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([
      { confidence: 10 },
      { confidence: 30 },
      { confidence: 50 },
    ]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result.every((c) => c.calibratedConfidence === "low")).toBe(true);
  });

  it("handles mixed findings with some borderline, some not", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([
      { confidence: 90 },
      { confidence: 70 },
      { confidence: 30 },
    ]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result).toHaveLength(3);
    const high = result.find((c) => c.confidence === 90);
    const medium = result.find((c) => c.confidence === 70);
    const low = result.find((c) => c.confidence === 30);
    expect(high?.calibratedConfidence).toBe("high");
    expect(medium?.calibratedConfidence).toBe("medium");
    expect(low?.calibratedConfidence).toBe("low");
  });

  it("non-borderline high-confidence finding stays at original confidence level", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 92 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].confidence).toBe(92);
    expect(result[0].calibratedConfidence).toBe("high");
  });

  it("non-borderline low-confidence finding stays at original confidence level", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 25 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].confidence).toBe(25);
    expect(result[0].calibratedConfidence).toBe("low");
  });

  it("borderline finding with no second model returns 'medium'", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("confidence 59 (below BORDERLINE_MIN, but >50) maps to 'medium'", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 59 }]);
    const result = await calibrateConfidence(review, makeConfig());
    // 59 is non-borderline (<60) but >50, so it maps to "medium"
    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("confidence 50 (below BORDERLINE_MIN and <=50) maps to 'low'", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 50 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("low");
  });

  it("confidence 81 (above BORDERLINE_MAX) maps to 'high'", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 81 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("high");
  });

  it("confidence exactly 60 is borderline and maps to 'medium' without second model", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 60 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("confidence exactly 80 is borderline and maps to 'medium' without second model", async () => {
    mockGetApiKey.mockReturnValue("");
    const review = makeReview([{ confidence: 80 }]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("multiple borderline findings each get independent calibration", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject
      .mockResolvedValueOnce({ object: { confirmed: "yes" } } as any)
      .mockResolvedValueOnce({ object: { confirmed: "no" } } as any)
      .mockResolvedValueOnce({ object: { confirmed: "yes" } } as any);

    const review = makeReview([
      { confidence: 65 },
      { confidence: 70 },
      { confidence: 75 },
    ]);
    const result = await calibrateConfidence(review, makeConfig());
    expect(result).toHaveLength(3);
    expect(result[0].calibratedConfidence).toBe("high");
    expect(result[1].calibratedConfidence).toBe("low");
    expect(result[2].calibratedConfidence).toBe("high");
  });
});
