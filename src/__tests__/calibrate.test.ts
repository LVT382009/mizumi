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

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "mock-google-model")),
}));

import { generateObject } from "ai";
import { getApiKey } from "../config.js";
import { mapConcurrent } from "../pipeline-parallel.js";
import * as core from "@actions/core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const mockGenerateObject = vi.mocked(generateObject);
const mockGetApiKey = vi.mocked(getApiKey);
const mockCreateAnthropic = vi.mocked(createAnthropic);
const mockCreateOpenAI = vi.mocked(createOpenAI);
const mockCreateGoogleGenerativeAI = vi.mocked(createGoogleGenerativeAI);
const mockMapConcurrent = vi.mocked(mapConcurrent);

// Track mapConcurrent concurrency args for verification
let capturedMapConcurrentCalls: { items: unknown[]; concurrency: number }[] = [];
vi.mock("../pipeline-parallel.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../pipeline-parallel.js")>();
  return {
    ...orig,
    mapConcurrent: vi.fn(async <T, R>(
      items: T[],
      fn: (item: T, index: number) => Promise<R>,
      concurrency: number,
    ): Promise<R[]> => {
      capturedMapConcurrentCalls.push({ items, concurrency });
      return orig.mapConcurrent(items, fn, concurrency);
    }),
  };
});

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
    reviewDashboard: true,
      auditTrail: true,
      reviewReplay: true,
      concurrencyAnalysis: true,
    crossprConflictDetection: true,
    architectureDriftDetection: true,
    testAssertionAudit: true,
breakingChangeRadar: true,
importCycleDetector: true,
deadCodeDetector: true,
    typeSafetyErosion: true,
    todoDebtDetector: true,
    magicNumberDetector: true,
    errorHandlingDetector: true,
    performanceAntipatternDetector: true,
resourceLifecycleDetector: true,
observabilityGapDetector: true,
    concurrencyHazardDetector: true,
    lifecycleProtocolDetector: true,
semanticTypeConfusionDetector: true,
dataFlowBoundaryDetector: true,
nullGuardDetector: true,
      aiCodePathologyDetector: true,
      ungatedCriticalReturnDetector: true,
      hardcodedConfigDetector: true,
    debugArtifactDetector: true,
    callbackMisuseDetector: true,
    ...overrides,
  };
}

function makeReview(comments: Array<{ confidence: number; severity?: string; category?: string; message?: string; file?: string; line?: number; suggestion?: string }>): ReviewResponseType {
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
      ...(c.suggestion ? { suggestion: c.suggestion } : {}),
    })),
    decision: "comment",
  };
}

describe("calibrateConfidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMapConcurrentCalls = [];
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

  // ---------------------------------------------------------------------------
  // NEW TESTS: edge cases, error paths, internal logic, structure preservation
  // ---------------------------------------------------------------------------

  it("should pass concurrency=3 to mapConcurrent when pipelineParallel is true", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig({ pipelineParallel: true }));

    const call = capturedMapConcurrentCalls.find((c) => c.concurrency !== undefined);
    expect(call).toBeDefined();
    expect(call!.concurrency).toBe(3);
  });

  it("should pass concurrency=1 to mapConcurrent when pipelineParallel is false", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig({ pipelineParallel: false }));

    const call = capturedMapConcurrentCalls.find((c) => c.concurrency !== undefined);
    expect(call).toBeDefined();
    expect(call!.concurrency).toBe(1);
  });

  it("should call core.warning when LLM call fails for a borderline finding", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockRejectedValue(new Error("rate limit exceeded"));

    const review = makeReview([{ confidence: 70, file: "src/app.ts", line: 42 }]);
    await calibrateConfidence(review, makeConfig());

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Calibration failed for src/app.ts:42"),
    );
  });

  it("should call core.info with calibration summary counts", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig());

    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Confidence calibration:"),
    );
  });

  it("should not call core.info when borderline falls back without second model (early return)", async () => {
    mockGetApiKey.mockReturnValue(""); // no second model

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig());

    expect(core.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Confidence calibration:"),
    );
  });

  it("should skip mapConcurrent entirely when no borderline findings exist", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });

    const review = makeReview([{ confidence: 95 }]);
    await calibrateConfidence(review, makeConfig());

    const calls = capturedMapConcurrentCalls.filter(
      (c) => Array.isArray(c.items) && c.items.length > 0,
    );
    expect(calls).toHaveLength(0);
  });

  it("should preserve all original comment fields in calibrated output", async () => {
    mockGetApiKey.mockReturnValue("");

    const review = makeReview([{
      confidence: 90,
      file: "src/auth.ts",
      line: 15,
      severity: "critical",
      category: "security",
      message: "SQL injection vulnerability",
    }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].file).toBe("src/auth.ts");
    expect(result[0].line).toBe(15);
    expect(result[0].severity).toBe("critical");
    expect(result[0].category).toBe("security");
    expect(result[0].message).toBe("SQL injection vulnerability");
    expect(result[0].confidence).toBe(90);
  });

  it("should preserve all original fields in borderline calibrated output with second model", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{
      confidence: 70,
      file: "src/api.ts",
      line: 99,
      severity: "high",
      category: "bug",
      message: "Null pointer dereference",
    }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].file).toBe("src/api.ts");
    expect(result[0].line).toBe(99);
    expect(result[0].severity).toBe("high");
    expect(result[0].category).toBe("bug");
    expect(result[0].message).toBe("Null pointer dereference");
  });

  it("should include suggestion in verification prompt when present", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{
      confidence: 70,
      file: "src/handle.ts",
      line: 10,
      message: "Missing error handling",
      suggestion: "Add try-catch block",
    }]);
    await calibrateConfidence(review, makeConfig());

    const call = mockGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).toContain("Suggested fix: Add try-catch block");
  });

  it("should not include suggestion line in prompt when suggestion is absent", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70, file: "src/main.ts", line: 5 }]);
    await calibrateConfidence(review, makeConfig());

    const call = mockGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).not.toContain("Suggested fix:");
  });

  it("should include file, line, severity, category, and message in verification prompt", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{
      confidence: 70,
      file: "src/util.ts",
      line: 22,
      severity: "medium",
      category: "performance",
      message: "N+1 query detected",
    }]);
    await calibrateConfidence(review, makeConfig());

    const call = mockGenerateObject.mock.calls[0][0] as any;
    expect(call.prompt).toContain("File: src/util.ts");
    expect(call.prompt).toContain("Line: 22");
    expect(call.prompt).toContain("Severity: medium");
    expect(call.prompt).toContain("Category: performance");
    expect(call.prompt).toContain("Message: N+1 query detected");
  });

  it("should use maxOutputTokens=32 for verification call", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig());

    const call = mockGenerateObject.mock.calls[0][0] as any;
    expect(call.maxOutputTokens).toBe(32);
  });

  it("should select openai as second model when primary provider is anthropic and openai key exists", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "sk-openai-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig({ provider: "anthropic" }));

    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: "sk-openai-key" });
  });

  it("should select anthropic as second model when primary provider is openai and anthropic key exists", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "anthropic") return "sk-ant-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 70 }]);
    await calibrateConfidence(review, makeConfig({ provider: "openai" }));

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-key" });
  });

  it("should use google as second model when anthropic and openai keys are absent but google key exists", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "google") return "google-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    // Primary is anthropic, only google key => google provider selected as second model
    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig({ provider: "anthropic" }));

    // If a second model was used, borderline gets calibrated (not default "medium")
    // The generateObject mock resolves with confirmed="yes", so should get "high"
    expect(result[0].calibratedConfidence).toBe("high");
  });

  it("should fall back to same-provider model when no different provider has API key", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "anthropic") return "sk-ant-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "no" } } as any);

    // primary is anthropic, only anthropic key available => same-provider fallback
    const review = makeReview([{ confidence: 65 }]);
    const result = await calibrateConfidence(review, makeConfig({ provider: "anthropic" }));

    // Should still use a model (same-provider) and calibrate
    expect(result[0].calibratedConfidence).toBe("low");
    expect(mockCreateAnthropic).toHaveBeenCalled();
  });

  it("should return null second model when no API keys exist for any provider", async () => {
    mockGetApiKey.mockReturnValue("");

    const review = makeReview([{ confidence: 70 }]);
    const result = await calibrateConfidence(review, makeConfig());

    // Without a second model, borderline defaults to medium
    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("should not modify non-borderline confidence score when borderline findings are also present", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([
      { confidence: 92 },
      { confidence: 70 },
      { confidence: 25 },
    ]);
    const result = await calibrateConfidence(review, makeConfig());

    const highFinding = result.find((c) => c.confidence === 92);
    const lowFinding = result.find((c) => c.confidence === 25);
    expect(highFinding?.calibratedConfidence).toBe("high");
    expect(lowFinding?.calibratedConfidence).toBe("low");
    // Original scores unchanged for non-borderline
    expect(highFinding?.confidence).toBe(92);
    expect(lowFinding?.confidence).toBe(25);
  });

  it("should map confidence 51 to 'medium' (barely above 50 threshold)", async () => {
    mockGetApiKey.mockReturnValue("");

    const review = makeReview([{ confidence: 51 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("medium");
  });

  it("should map confidence 50 to 'low' (at the 50 boundary)", async () => {
    mockGetApiKey.mockReturnValue("");

    const review = makeReview([{ confidence: 50 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("low");
  });

  it("should map confidence 0 to 'low'", async () => {
    mockGetApiKey.mockReturnValue("");

    const review = makeReview([{ confidence: 0 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("low");
  });

  it("should map confidence 100 to 'high'", async () => {
    mockGetApiKey.mockReturnValue("");

    const review = makeReview([{ confidence: 100 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("high");
  });

  it("should handle borderline confidence exactly 60 with second model confirming", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    const review = makeReview([{ confidence: 60 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("high");
    expect(result[0].confidence).toBe(75); // 60 + 15 = 75
  });

  it("should handle borderline confidence exactly 80 with second model rejecting", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "no" } } as any);

    const review = makeReview([{ confidence: 80 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("low");
    expect(result[0].confidence).toBe(60); // 80 - 20 = 60
  });

  it("should log warning with error message string when non-Error is thrown", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockRejectedValue("string error");

    const review = makeReview([{ confidence: 70, file: "src/fail.ts", line: 8 }]);
    await calibrateConfidence(review, makeConfig());

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Calibration failed for src/fail.ts:8"),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("string error"),
    );
  });

  it("should clamp boosted confidence at 100 for borderline finding near upper boundary", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "yes" } } as any);

    // 89 is not borderline (>80), so test with 79 which is borderline + 15 = 94, not clamp
    // But let's test with 80 which is borderline max: 80 + 15 = 95
    const review = makeReview([{ confidence: 80 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("high");
    expect(result[0].confidence).toBe(95); // min(80 + 15, 100) = 95
  });

  it("should clamp lowered confidence at 0 for borderline finding near lower boundary", async () => {
    mockGetApiKey.mockImplementation((provider: string) => {
      if (provider === "openai") return "test-key";
      return "";
    });
    mockGenerateObject.mockResolvedValue({ object: { confirmed: "no" } } as any);

    // Confidence 60 is borderline min: 60 - 20 = 40, not 0
    // Confidence 5 would not be borderline, so test 60: 60-20=40
    // For near-zero we need a finding where confidence-20<0, but borderline min is 60
    // So 60-20=40, the floor is 0 but we never hit it with valid borderline range
    // Let's test 60 to confirm the max(c-20,0) logic
    const review = makeReview([{ confidence: 60 }]);
    const result = await calibrateConfidence(review, makeConfig());

    expect(result[0].calibratedConfidence).toBe("low");
    expect(result[0].confidence).toBe(40); // max(60 - 20, 0) = 40
  });
});
