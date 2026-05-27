import { describe, it, expect } from "vitest";
import { classifyDiff, estimateTokens, guardContextWindow } from "../router.js";
import { MizumiConfig } from "../config.js";

const baseConfig: MizumiConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  baseUrl: "",
  profile: "chill",
  maxComments: 15,
  language: "en-US",
  selfCritique: true,
  confidenceThreshold: 80,
  autoReview: true,
  autoPauseAfter: 5,
  excludePatterns: [],
  tierRouting: true,
  smallDiffThreshold: 50,
  securityPaths: ["**/auth/**", "**/crypto/**", "**/sql/**", "**/secret*", "**/password*"],
  complianceCheck: true,
  autoFix: false,
  confidenceCalibration: true,
  changeStack: true,
  improveEnabled: false,
  dryRun: false,
  linterScan: true,
  autoLabels: true,
  spendThreshold: 0,
  gateThreshold: "none",
  ruleEngine: true,
  ciValidatedFix: false,
  ciFixTimeout: 600,
  ciFixMaxRetries: 3,
  ciFixRevertOnFailure: true,
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
  secretEntropy: true,
  safetyScore: true,
  adaptiveStrategy: true,
  businessContext: true,
  orgMemory: true,
  testGapDetection: true,
  suppressionMemories: true,
  swarmReview: true,
  complexityPrediction: true,
  prSplitSuggestions: true,
  findingLifecycle: true,
  intentClassification: true,
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
};

describe("classifyDiff", () => {
  it("returns standard when tier routing is disabled", () => {
    const config = { ...baseConfig, tierRouting: false };
    const result = classifyDiff(10, 1, ["src/app.ts"], config);
    expect(result).toEqual({ tier: "standard", reason: "tier routing disabled" });
  });

  it("returns standard when tier routing is disabled even for security files", () => {
    const config = { ...baseConfig, tierRouting: false };
    const result = classifyDiff(500, 10, ["src/auth/login.ts"], config);
    expect(result.tier).toBe("standard");
  });

  it("returns thorough for security-sensitive auth file", () => {
    const result = classifyDiff(200, 5, ["src/auth/login.ts"], baseConfig);
    expect(result).toEqual({ tier: "thorough", reason: "security-sensitive files detected" });
  });

  it("returns thorough for crypto file", () => {
    const result = classifyDiff(100, 2, ["lib/crypto/hash.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns thorough for sql file", () => {
    const result = classifyDiff(100, 2, ["db/sql/migrations.sql"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns thorough for file matching secret* pattern", () => {
    const result = classifyDiff(50, 1, ["config/secrets.yaml"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns thorough for file matching password* pattern", () => {
    const result = classifyDiff(50, 1, ["src/password-reset.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("prioritizes thorough over light when security file is in a small diff", () => {
    const result = classifyDiff(5, 1, ["src/auth/handler.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns light for small diff under threshold with fewer than 3 files", () => {
    const result = classifyDiff(20, 1, ["src/utils.ts"], baseConfig);
    expect(result.tier).toBe("light");
    expect(result.reason).toContain("20 lines");
    expect(result.reason).toContain("1 files");
  });

  it("returns light for small diff with 2 files", () => {
    const result = classifyDiff(30, 2, ["src/a.ts", "src/b.ts"], baseConfig);
    expect(result.tier).toBe("light");
  });

  it("returns standard for small diff with 3+ files even if line count is low", () => {
    const result = classifyDiff(10, 3, ["src/a.ts", "src/b.ts", "src/c.ts"], baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("returns standard for diff at threshold boundary", () => {
    const result = classifyDiff(50, 1, ["src/app.ts"], baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("returns standard for normal-sized diff", () => {
    const result = classifyDiff(200, 4, ["src/app.ts", "src/utils.ts", "lib/helper.ts", "test/app.test.ts"], baseConfig);
    expect(result).toEqual({ tier: "standard", reason: "normal diff" });
  });

  it("respects custom smallDiffThreshold", () => {
    const config = { ...baseConfig, smallDiffThreshold: 100 };
    const result = classifyDiff(80, 1, ["src/app.ts"], config);
    expect(result.tier).toBe("light");
  });

  it("uses default when one security file and one normal file", () => {
    // Security takes precedence
    const result = classifyDiff(100, 2, ["src/app.ts", "src/auth/oauth.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("handles empty file list", () => {
    const result = classifyDiff(0, 0, [], baseConfig);
    expect(result.tier).toBe("light");
  });

  it("handles custom security paths", () => {
    const config = { ...baseConfig, securityPaths: ["**/payment/**"] };
    const result = classifyDiff(100, 2, ["src/payment/charge.ts"], config);
    expect(result.tier).toBe("thorough");
  });

  it("does not match security path when custom paths do not include defaults", () => {
    const config = { ...baseConfig, securityPaths: ["**/payment/**"] };
    const result = classifyDiff(100, 2, ["src/auth/login.ts"], config);
    expect(result.tier).toBe("standard");
  });

  it("returns light for exactly 0 lines and 0 files", () => {
    const result = classifyDiff(0, 0, [], baseConfig);
    expect(result.tier).toBe("light");
    expect(result.reason).toContain("0 lines");
  });

  it("returns light for 1 line and 1 file", () => {
    const result = classifyDiff(1, 1, ["src/fix.ts"], baseConfig);
    expect(result.tier).toBe("light");
  });

  it("returns light for 49 lines and 1 file (just under threshold)", () => {
    const result = classifyDiff(49, 1, ["src/app.ts"], baseConfig);
    expect(result.tier).toBe("light");
  });

  it("returns standard at threshold boundary with 2 files", () => {
    const result = classifyDiff(50, 2, ["a.ts", "b.ts"], baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("returns standard when line count under threshold but 3 files", () => {
    const result = classifyDiff(10, 3, ["a.ts", "b.ts", "c.ts"], baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("returns standard for line count under threshold but many files", () => {
    const result = classifyDiff(5, 10, Array.from({ length: 10 }, (_, i) => `file${i}.ts`), baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("with securityPaths empty array does not match any file", () => {
    const config = { ...baseConfig, securityPaths: [] };
    const result = classifyDiff(100, 2, ["src/auth/login.ts"], config);
    expect(result.tier).toBe("standard");
  });

  it("with custom securityPaths matches on new pattern only", () => {
    const config = { ...baseConfig, securityPaths: ["**/billing/**"] };
    const result = classifyDiff(100, 2, ["src/billing/charge.ts"], config);
    expect(result.tier).toBe("thorough");
  });

  it("with custom smallDiffThreshold of 0 returns standard for any positive line count", () => {
    const config = { ...baseConfig, smallDiffThreshold: 0 };
    const result = classifyDiff(1, 1, ["src/app.ts"], config);
    // 1 > 0 so not light; no security files; => standard
    expect(result.tier).toBe("standard");
  });

  it("matches nested security path deep in directory tree", () => {
    const result = classifyDiff(100, 1, ["src/app/modules/auth/handlers/oauth.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("does not partial-match security path (auth in filename not dir)", () => {
    const result = classifyDiff(100, 1, ["src/authorize.ts"], baseConfig);
    // "**/auth/**" matches directory, not filename "authorize"
    expect(result.tier).toBe("standard");
  });

  it("handles file with special characters in path", () => {
    const result = classifyDiff(100, 1, ["src/auth/[id].ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("handles multiple security-sensitive files across patterns", () => {
    const result = classifyDiff(200, 3, ["src/auth/oauth.ts", "lib/crypto/aes.ts", "db/sql/query.sql"], baseConfig);
    expect(result.tier).toBe("thorough");
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("1234")).toBe(1);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokens("123")).toBe(1);
  });

  it("estimates longer text", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for single character", () => {
    expect(estimateTokens("a")).toBe(1);
  });

  it("handles 5 chars (rounds up to 2)", () => {
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("guardContextWindow", () => {
  it("returns original text when it fits", () => {
    const short = "hello world";
    const result = guardContextWindow(short, "anthropic");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(short);
  });

  it("truncates when text exceeds context limit", () => {
    // Create text that exceeds local provider's 32k context
    // 32k limit - 2000 (system) - 2000 (output) = 28000 available tokens
    // 28000 tokens * 4 chars = 112000 chars
    const huge = "x".repeat(200_000);
    const result = guardContextWindow(huge, "local");
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[MIZUMI: diff truncated");
    expect(result.estimatedTokens).toBeLessThan(30000);
  });

  it("uses default 120k limit for unknown provider", () => {
    const result = guardContextWindow("short", "unknown_provider");
    expect(result.truncated).toBe(false);
  });

  it("preserves head and tail when truncating", () => {
    const huge = "A".repeat(200_000) + "TAILMARKER";
    const result = guardContextWindow(huge, "local");
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("TAILMARKER");
    expect(result.text).toContain("A");
  });

  it("respects custom systemPromptTokens", () => {
    const text = "x".repeat(100_000);
    const normal = guardContextWindow(text, "anthropic", 2000);
    const largeSystem = guardContextWindow(text, "anthropic", 50000);
    expect(normal.estimatedTokens).toBeLessThanOrEqual(largeSystem.estimatedTokens);
  });

  it("with anthropic provider has 180k limit", () => {
    // 180000 - 2000 - 2000 = 176000 available tokens => 704000 chars
    const text = "x".repeat(700_000);
    const result = guardContextWindow(text, "anthropic");
    expect(result.truncated).toBe(false);
  });

  it("with google provider has 1M limit", () => {
    // 1000000 - 2000 - 2000 = 996000 available tokens = 3,984,000 chars
    const text = "x".repeat(4_000_000);
    const result = guardContextWindow(text, "google");
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[MIZUMI: diff truncated");
  });

  it("with openai provider stays within 120k token budget", () => {
    // 120000 - 2000 - 2000 = 116000 available tokens = 464,000 chars
    const text = "y".repeat(400_000);
    const result = guardContextWindow(text, "openai");
    expect(result.truncated).toBe(false);
    expect(result.estimatedTokens).toBeLessThanOrEqual(116000);
  });

  it("includes truncation marker text", () => {
    const huge = "z".repeat(200_000);
    const result = guardContextWindow(huge, "local");
    expect(result.text).toContain("... [MIZUMI: diff truncated to fit context window] ...");
  });

  it("with nvidia provider has 120k limit", () => {
    const text = "a".repeat(100_000);
    const result = guardContextWindow(text, "nvidia");
    expect(result.truncated).toBe(false);
  });

  it("with openrouter provider has 120k limit", () => {
    const text = "a".repeat(100_000);
    const result = guardContextWindow(text, "openrouter");
    expect(result.truncated).toBe(false);
  });

  it("truncated text preserves beginning content", () => {
    const body = "HEADER_CONTENT_" + "x".repeat(200_000);
    const result = guardContextWindow(body, "local");
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("HEADER_CONTENT_")).toBe(true);
  });
});
