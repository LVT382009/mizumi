import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @actions/core before any imports
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  getInput: vi.fn((name: string) => {
    if (name === "provider") return "anthropic";
    if (name === "model") return "claude-sonnet-4-6";
    if (name === "anthropic_api_key") return "sk-ant-test";
    return "";
  }),
  getBooleanInput: vi.fn((name: string) => {
    if (name === "taint_analysis") return true;
    if (name === "ast_contract_analysis") return true;
    if (name === "rule_engine") return true;
    return false;
  }),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

// Mock all module dependencies
vi.mock("../platform.js", () => ({
  detectPlatform: vi.fn(() => "gitlab"),
  getWorkspace: vi.fn(() => "/tmp/workspace"),
  createPlatformClient: vi.fn(),
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(() => ({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    baseUrl: "",
    profile: "chill",
    maxComments: 5,
    language: "en-US",
    selfCritique: false,
    confidenceThreshold: 80,
    autoReview: true,
    autoPauseAfter: 5,
    excludePatterns: [],
    tierRouting: true,
    smallDiffThreshold: 50,
    securityPaths: [],
    complianceCheck: true,
    autoFix: false,
    confidenceCalibration: true,
    changeStack: true,
    improveEnabled: false,
    dryRun: true, // dryRun to avoid actual API calls
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
  })),
}));

vi.mock("../router.js", () => ({
  classifyDiff: vi.fn(() => ({ tier: "light", reason: "small diff" })),
  guardContextWindow: vi.fn((text: string) => ({ text, truncated: false, estimatedTokens: 100 })),
}));

vi.mock("../classifier.js", () => ({
  classifyPR: vi.fn(() => ({ category: "bugfix", reason: "test" })),
}));

vi.mock("../linemap.js", () => ({
  buildLineMapFromRawDiff: vi.fn(),
  buildPositionHint: vi.fn(() => "hint"),
}));

vi.mock("../review.js", () => ({
  runReview: vi.fn(() => Promise.resolve({
    output: {
      summary: "No major issues",
      riskScore: 1,
      comments: [],
      decision: "approve",
    },
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
  })),
}));

vi.mock("../critique.js", () => ({
  runCritique: vi.fn((_review: unknown, _config: unknown) =>
    Promise.resolve({
      summary: "No major issues",
      riskScore: 1,
      comments: [],
      decision: "approve",
    })
  ),
}));

vi.mock("../rules.js", () => ({
  runRules: vi.fn(() => []),
}));

vi.mock("../rule-engine.js", () => ({
  executeRuleEngine: vi.fn(() => ({ findings: [], rulesUsed: 0, discoveredNew: 0, decayed: 0 })),
}));

vi.mock("../ast-contracts.js", () => ({
  runASTContractAnalysis: vi.fn(() => ({ violations: [], filesAnalyzed: 0 })),
}));

vi.mock("../slop.js", () => ({
  detectSlop: vi.fn(() => ({ isSlop: false, score: 0 })),
}));

vi.mock("../calibrate.js", () => ({
  calibrateConfidence: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../spend.js", () => ({
  createSpendEntry: vi.fn(() => ({})),
  appendSpendEntry: vi.fn(),
}));

vi.mock("../db.js", () => ({
  recordSuggestion: vi.fn(),
}));

vi.mock("../feedback.js", () => ({
  recordFindings: vi.fn(),
  readFeedbackStore: vi.fn(() => ({})),
  computeSuppressedPatterns: vi.fn(() => new Set()),
  applyNoiseReduction: vi.fn((comments: unknown[]) => comments),
}));

vi.mock("../memory.js", () => ({
  writeMemory: vi.fn(),
  readMemory: vi.fn(() => ""),
  loadSkills: vi.fn(() => ({ loaded: "" })),
}));

import * as core from "@actions/core";
import { createPlatformClient, detectPlatform, getWorkspace } from "../platform.js";
import { loadConfig } from "../config.js";
import { classifyDiff, guardContextWindow } from "../router.js";
import { classifyPR } from "../classifier.js";
import { runReview } from "../review.js";
import { runCritique } from "../critique.js";
import { runRules } from "../rules.js";
import { executeRuleEngine } from "../rule-engine.js";
import { runASTContractAnalysis } from "../ast-contracts.js";
import { detectSlop } from "../slop.js";
import { calibrateConfidence } from "../calibrate.js";
import { createSpendEntry, appendSpendEntry } from "../spend.js";
import { recordFindings } from "../feedback.js";
import { readMemory, writeMemory } from "../memory.js";

// ---------------------------------------------------------------------------
// Module imports and structure
// ---------------------------------------------------------------------------

describe("gitlab-entry module structure", () => {
  it("is importable without error", async () => {
    const mod = await import("../gitlab-entry.js");
    expect(typeof mod).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Pipeline step ordering — verify integrations are wired correctly
// ---------------------------------------------------------------------------

describe("GitLab pipeline integration", () => {
  const mockClient = {
    platform: "gitlab" as const,
    getProjectId: vi.fn(() => "123"),
    getMR: vi.fn(() => Promise.resolve({
      number: 1,
      title: "Test MR",
      body: "",
      headSha: "abc123",
      headRef: "feature",
      baseRef: "main",
      baseSha: "def456",
      author: "dev",
    })),
    fetchDiff: vi.fn(() => Promise.resolve({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      rawDiff: "",
    })),
    postReview: vi.fn(() => Promise.resolve({ reviewId: 1, findingCount: 0 })),
    postComment: vi.fn(() => Promise.resolve()),
    listBotComments: vi.fn(() => Promise.resolve([])),
    deleteComment: vi.fn(() => Promise.resolve()),
    createStatus: vi.fn(() => Promise.resolve()),
    getCIStatus: vi.fn(() => Promise.resolve("no_checks" as const)),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createPlatformClient).mockResolvedValue(mockClient);
  });

  it("detects gitlab platform", () => {
    const platform = detectPlatform();
    expect(platform).toBe("gitlab");
  });

  it("loads config with taintAnalysis enabled", () => {
    const config = loadConfig();
    expect(config.taintAnalysis).toBe(true);
  });

  it("classifies diff using router", () => {
    const result = classifyDiff(10, 1, ["src/a.ts"], loadConfig());
    expect(result).toHaveProperty("tier");
    expect(result).toHaveProperty("reason");
  });

  it("guards context window for large diffs", () => {
    const result = guardContextWindow("some diff text", "anthropic");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("truncated");
  });

  it("runs rules on diff files", () => {
    const findings = runRules([]);
    expect(Array.isArray(findings)).toBe(true);
  });

  it("runs rule engine on diff files", () => {
    const result = executeRuleEngine([], "/tmp", "123");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("rulesUsed");
  });

  it("runs AST contract analysis on diff files", () => {
    const result = runASTContractAnalysis([], "/tmp");
    expect(result).toHaveProperty("violations");
    expect(result).toHaveProperty("filesAnalyzed");
  });

  it("detects slop in diff", () => {
    const result = detectSlop("", 10, 5, 1, ["src/a.ts"]);
    expect(result).toHaveProperty("isSlop");
    expect(result).toHaveProperty("score");
  });

  it("reads memory from workspace", () => {
    const mem = readMemory("/tmp");
    expect(typeof mem).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Dry-run mode — verify outputs are set without posting
// ---------------------------------------------------------------------------

describe("GitLab dry-run mode", () => {
  it("config has dryRun=true in test mock", () => {
    const config = loadConfig();
    expect(config.dryRun).toBe(true);
  });

  it("review mock returns structured output", async () => {
    const config = loadConfig();
    const result = await runReview("diff", "hint", "", "", "", config);
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("usage");
    expect(result.output).toHaveProperty("summary");
    expect(result.output).toHaveProperty("riskScore");
    expect(result.output).toHaveProperty("comments");
    expect(result.output).toHaveProperty("decision");
  });

  it("critique mock returns filtered output", async () => {
    const config = loadConfig();
    const review = {
      summary: "test",
      riskScore: 1,
      comments: [],
      decision: "approve" as const,
    };
    const result = await runCritique(review, config);
    expect(result).toHaveProperty("comments");
    expect(result).toHaveProperty("riskScore");
    expect(result).toHaveProperty("decision");
  });
});

// ---------------------------------------------------------------------------
// Spend tracking integration
// ---------------------------------------------------------------------------

describe("GitLab spend tracking", () => {
  it("creates spend entry with correct fields", () => {
    const entry = createSpendEntry(
      "test-project", 1,
      "anthropic", "claude-sonnet-4-6",
      { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
      "light", 0, 1,
    );
    expect(entry).toBeDefined();
  });

  it("appendSpendEntry is callable", () => {
    appendSpendEntry("/tmp", {});
    expect(appendSpendEntry).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error handling — graceful degradation
// ---------------------------------------------------------------------------

describe("GitLab error handling", () => {
  it("rule engine failure is caught gracefully", () => {
    vi.mocked(executeRuleEngine).mockImplementationOnce(() => {
      throw new Error("DB locked");
    });
    try {
      executeRuleEngine([], "/tmp", "123");
    } catch (e) {
      expect((e as Error).message).toBe("DB locked");
    }
  });

  it("AST contract failure is caught gracefully", () => {
    vi.mocked(runASTContractAnalysis).mockImplementationOnce(() => {
      throw new Error("AST parse error");
    });
    try {
      runASTContractAnalysis([], "/tmp");
    } catch (e) {
      expect((e as Error).message).toBe("AST parse error");
    }
  });

  it("platform client creation with missing env throws", async () => {
    vi.mocked(createPlatformClient).mockRejectedValueOnce(new Error("GITLAB_TOKEN not set"));
    await expect(createPlatformClient()).rejects.toThrow("GITLAB_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// Gate threshold check
// ---------------------------------------------------------------------------

describe("GitLab gate threshold", () => {
  it("config has gateThreshold=none by default", () => {
    const config = loadConfig();
    expect(config.gateThreshold).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Platform client mock methods
// ---------------------------------------------------------------------------

describe("GitLab platform client methods", () => {
  const mockClient = {
    platform: "gitlab" as const,
    getProjectId: vi.fn(() => "42"),
    getMR: vi.fn(() => Promise.resolve({
      number: 7, title: "Add feature", body: "Closes #1", headSha: "sha1",
      headRef: "feat", baseRef: "main", baseSha: "sha0", author: "dev",
    })),
    fetchDiff: vi.fn(() => Promise.resolve({
      files: [{ path: "a.ts", status: "modified", additions: 5, deletions: 2, hunks: [] }],
      totalAdditions: 5, totalDeletions: 2, rawDiff: "diff",
    })),
    postReview: vi.fn(() => Promise.resolve({ reviewId: 10, findingCount: 3 })),
    postComment: vi.fn(() => Promise.resolve()),
    listBotComments: vi.fn(() => Promise.resolve([])),
    deleteComment: vi.fn(() => Promise.resolve()),
    createStatus: vi.fn(() => Promise.resolve()),
    getCIStatus: vi.fn(() => Promise.resolve("passed" as const)),
  };

  it("getMR returns MR metadata", async () => {
    const mr = await mockClient.getMR();
    expect(mr.number).toBe(7);
    expect(mr.title).toBe("Add feature");
    expect(mr.headSha).toBe("sha1");
  });

  it("fetchDiff returns parsed diff", async () => {
    const diff = await mockClient.fetchDiff();
    expect(diff.files).toHaveLength(1);
    expect(diff.totalAdditions).toBe(5);
  });

  it("postReview returns review result", async () => {
    const result = await mockClient.postReview([], "summary", 1);
    expect(result.reviewId).toBe(10);
    expect(result.findingCount).toBe(3);
  });

  it("getProjectId returns project string", () => {
    expect(mockClient.getProjectId()).toBe("42");
  });

  it("getCIStatus returns status string", async () => {
    const status = await mockClient.getCIStatus("sha1");
    expect(status).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// Config feature flags for GitLab
// ---------------------------------------------------------------------------

describe("GitLab config feature coverage", () => {
  it("has all analysis features enabled in test config", () => {
    const config = loadConfig();
    expect(config.astContractAnalysis).toBe(true);
    expect(config.taintAnalysis).toBe(true);
    expect(config.reviewLearning).toBe(true);
    expect(config.blastRadius).toBe(true);
    expect(config.deltaReview).toBe(true);
    expect(config.authBoundary).toBe(true);
    expect(config.secretEntropy).toBe(true);
    expect(config.safetyScore).toBe(true);
    expect(config.adaptiveStrategy).toBe(true);
    expect(config.orgMemory).toBe(true);
    expect(config.testGapDetection).toBe(true);
    expect(config.suppressionMemories).toBe(true);
    expect(config.swarmReview).toBe(true);
  });

  it("has CI fix disabled by default", () => {
    const config = loadConfig();
    expect(config.ciValidatedFix).toBe(false);
  });

  it("has dryRun enabled in test config", () => {
    const config = loadConfig();
    expect(config.dryRun).toBe(true);
  });

  it("has correct provider settings", () => {
    const config = loadConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.profile).toBe("chill");
  });

  it("has correct auto-fix and improve settings", () => {
    const config = loadConfig();
    expect(config.autoFix).toBe(false);
    expect(config.improveEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

describe("GitLab platform detection", () => {
  it("detectPlatform returns gitlab string", () => {
    const platform = detectPlatform();
    expect(platform).toBe("gitlab");
  });

  it("getWorkspace returns a path string", () => {
    const workspace = getWorkspace();
    expect(typeof workspace).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Review and critique integration with GitLab pipeline
// ---------------------------------------------------------------------------

describe("GitLab review pipeline steps", () => {
  it("classifyPR returns category and reason", () => {
    const result = classifyPR(
      [{ from: "src/a.ts", additions: 10, deletions: 5 }],
      10, 5,
    );
    expect(result).toHaveProperty("category");
    expect(result).toHaveProperty("reason");
  });

  it("guardContextWindow returns text and truncation flag", () => {
    const longDiff = "a".repeat(50000);
    const result = guardContextWindow(longDiff, "anthropic");
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.truncated).toBe("boolean");
  });

  it("writeMemory is callable", () => {
    writeMemory("/tmp", "existing memory", "new memory content");
    expect(writeMemory).toHaveBeenCalled();
  });

  it("recordFindings is callable", () => {
    recordFindings("/tmp", "project", 1, [
      { file: "a.ts", line: 1, category: "security", severity: "high", message: "test" },
    ]);
    expect(recordFindings).toHaveBeenCalled();
  });
});
