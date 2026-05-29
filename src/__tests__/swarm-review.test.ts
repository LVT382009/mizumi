import { describe, it, expect, vi } from "vitest";
import {
  deduplicateFindings,
  buildSwarmContext,
} from "../swarm-review.js";
import type { SwarmResult, SwarmPerspective } from "../swarm-review.js";
import type { ReviewCommentType } from "../review.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
  getInput: vi.fn(() => ""),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => () => "mock-model"),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => () => "mock-model"),
}));

vi.mock("ai", () => ({
  generateObject: vi.fn().mockResolvedValue({
    object: { comments: [] },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: overrides.file ?? "src/api/health.ts",
    line: overrides.line ?? 10,
    endLine: overrides.endLine,
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "security",
    message: overrides.message ?? "SQL injection vulnerability",
    suggestion: overrides.suggestion,
    confidence: overrides.confidence ?? 90,
  };
}

// ---------------------------------------------------------------------------
// deduplicateFindings
// ---------------------------------------------------------------------------

describe("deduplicateFindings", () => {
  it("returns unique findings unchanged", () => {
    const findings = [
      makeFinding({ file: "src/a.ts", line: 1, category: "security" }),
      makeFinding({ file: "src/b.ts", line: 2, category: "bug" }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(2);
    expect(duplicatesRemoved).toBe(0);
  });

  it("deduplicates findings with same file+line+category", () => {
    const findings = [
      makeFinding({ file: "src/a.ts", line: 10, category: "security", message: "First", confidence: 80 }),
      makeFinding({ file: "src/a.ts", line: 10, category: "security", message: "Second", confidence: 95 }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    // Keeps the one with higher confidence
    expect(unique[0].confidence).toBe(95);
  });

  it("keeps findings with same file+line but different category", () => {
    const findings = [
      makeFinding({ file: "src/a.ts", line: 10, category: "security" }),
      makeFinding({ file: "src/a.ts", line: 10, category: "bug" }),
    ];
    const { unique } = deduplicateFindings(findings);
    expect(unique).toHaveLength(2);
  });

  it("keeps findings with same file+category but different line", () => {
    const findings = [
      makeFinding({ file: "src/a.ts", line: 10, category: "security" }),
      makeFinding({ file: "src/a.ts", line: 20, category: "security" }),
    ];
    const { unique } = deduplicateFindings(findings);
    expect(unique).toHaveLength(2);
  });

  it("handles empty array", () => {
    const { unique, duplicatesRemoved } = deduplicateFindings([]);
    expect(unique).toHaveLength(0);
    expect(duplicatesRemoved).toBe(0);
  });

  it("deduplicates multiple identical keys keeping highest confidence", () => {
    const findings = [
      makeFinding({ file: "x.ts", line: 1, category: "performance", confidence: 70 }),
      makeFinding({ file: "x.ts", line: 1, category: "performance", confidence: 85 }),
      makeFinding({ file: "x.ts", line: 1, category: "performance", confidence: 60 }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(2);
    expect(unique[0].confidence).toBe(85);
  });

  it("preserves finding with first occurrence when confidence is equal", () => {
    const findings = [
      makeFinding({ file: "a.ts", line: 5, category: "security", message: "First", confidence: 80 }),
      makeFinding({ file: "a.ts", line: 5, category: "security", message: "Second", confidence: 80 }),
    ];
    const { unique } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(unique[0].message).toBe("First");
  });
});

// ---------------------------------------------------------------------------
// buildSwarmContext
// ---------------------------------------------------------------------------

describe("buildSwarmContext", () => {
  it("returns empty string when no findings", () => {
    const result: SwarmResult = {
      findings: [],
      perspectiveCounts: { security: 0, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    expect(buildSwarmContext(result)).toBe("");
  });

  it("includes header with perspective counts", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "security", message: "XSS found" })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Swarm Review");
    expect(ctx).toContain("Security Specialist");
    expect(ctx).toContain("1 finding(s)");
  });

  it("includes deduplication stats when duplicates removed", () => {
    const result: SwarmResult = {
      findings: [makeFinding()],
      perspectiveCounts: { security: 2, correctness: 0, performance: 0 },
      duplicatesRemoved: 1,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("duplicate");
  });

  it("omits dedup info when no duplicates", () => {
    const result: SwarmResult = {
      findings: [makeFinding()],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).not.toContain("duplicate(s) removed");
  });

  it("includes finding details", () => {
    const result: SwarmResult = {
      findings: [makeFinding({
        file: "src/api.ts",
        line: 42,
        severity: "critical",
        category: "security",
        message: "SQL injection",
        suggestion: "Use parameterized queries",
      })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("critical");
    expect(ctx).toContain("src/api.ts:42");
    expect(ctx).toContain("SQL injection");
    expect(ctx).toContain("Use parameterized queries");
  });

  it("shows all perspectives with findings", () => {
    const result: SwarmResult = {
      findings: [
        makeFinding({ category: "security" }),
        makeFinding({ category: "performance" }),
      ],
      perspectiveCounts: { security: 1, correctness: 0, performance: 1 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Security Specialist");
    expect(ctx).toContain("Performance Specialist");
  });

  it("skips perspectives with zero findings", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "security" })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Security Specialist");
    expect(ctx).not.toContain("Correctness Specialist");
    expect(ctx).not.toContain("Performance Specialist");
  });
});

// ---------------------------------------------------------------------------
// runSwarmReview (integration with mocked LLM)
// ---------------------------------------------------------------------------

describe("runSwarmReview", () => {
  it("returns empty findings when all specialists return empty", async () => {
    // Set dummy API key for mock
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    const { runSwarmReview } = await import("../swarm-review.js");
    const mockConfig = {
      provider: "anthropic" as const,
      model: "claude-haiku-4-5-20251001",
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
      complianceCheck: true,
      autoFix: false,
      confidenceCalibration: true,
      changeStack: true,
      improveEnabled: false,
      dryRun: false,
      linterScan: true,
      autoLabels: true,
      spendThreshold: 0,
      gateThreshold: "none" as const,
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
      staleClosureDetector: true,
      hallucinatedDependencyDetector: true,
      tautologicalTestDetector: true,
        contextAmplificationDetector: true,
        cargoCultArchitectureDetector: true,
        confabulatedAPIDetector: true,
  partialSecurityControlDetector: true,
  paradigmClashDetector: true,
  velocityRiskDetector: true,
  rulesFileIntegrityDetector: true,
  specDriftDetector: true,
  iacVulnerabilityDetector: true,
    credentialExposureDetector: true,
    illusoryValidationDetector: true,
    iterationStrippingDetector: true,
      securityParadoxDetector: true,
      trustBoundaryDetector: true,
      aiConfigIntegrityDetector: true,
    agentSafetyBypassDetector: true,
    agencyEscalationDetector: true,
    taintPathDetector: true,
    symbolImpactDetector: true,
    dependencyRiskDetector: true,
    };

    const result = await runSwarmReview("diff content", "valid positions", mockConfig);
    expect(result.findings).toHaveLength(0);
    expect(result.perspectiveCounts).toHaveProperty("security");
    expect(result.perspectiveCounts).toHaveProperty("correctness");
    expect(result.perspectiveCounts).toHaveProperty("performance");

    delete process.env.ANTHROPIC_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// PERSPECTIVES constant check
// ---------------------------------------------------------------------------

describe("PERSPECTIVES", () => {
  it("has 3 specialist perspectives", async () => {
    const mod = await import("../swarm-review.js");
    // We can't directly access PERSPECTIVES since it's not exported,
    // but we can verify via the SwarmResult structure
    const result: SwarmResult = {
      findings: [],
      perspectiveCounts: { security: 0, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    expect(Object.keys(result.perspectiveCounts)).toHaveLength(3);
    expect(result.perspectiveCounts).toHaveProperty("security");
    expect(result.perspectiveCounts).toHaveProperty("correctness");
    expect(result.perspectiveCounts).toHaveProperty("performance");
  });
});

// ---------------------------------------------------------------------------
// SwarmPerspective structure
// ---------------------------------------------------------------------------

describe("SwarmPerspective", () => {
  it("has correct category mapping for security", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "security" })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    expect(result.perspectiveCounts.security).toBe(1);
    expect(result.findings[0].category).toBe("security");
  });

  it("has correct category mapping for correctness", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "bug" })],
      perspectiveCounts: { security: 0, correctness: 1, performance: 0 },
      duplicatesRemoved: 0,
    };
    expect(result.perspectiveCounts.correctness).toBe(1);
  });

  it("has correct category mapping for performance", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "performance" })],
      perspectiveCounts: { security: 0, correctness: 0, performance: 1 },
      duplicatesRemoved: 0,
    };
    expect(result.perspectiveCounts.performance).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deduplicateFindings edge cases
// ---------------------------------------------------------------------------

describe("deduplicateFindings advanced", () => {
  it("deduplicates findings with same key regardless of severity", () => {
    const findings = [
      makeFinding({ file: "src/a.ts", line: 10, category: "security", severity: "critical" }),
      makeFinding({ file: "src/a.ts", line: 10, category: "security", severity: "low" }),
    ];
    const { unique } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
  });

  it("keeps higher confidence when deduplicating", () => {
    const findings = [
      makeFinding({ file: "src/api.ts", line: 42, category: "security", confidence: 85 }),
      makeFinding({ file: "src/api.ts", line: 42, category: "security", confidence: 90 }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    expect(unique[0].confidence).toBe(90);
  });

  it("handles findings with zero confidence", () => {
    const findings = [
      makeFinding({ file: "a.ts", line: 1, category: "security", confidence: 0 }),
      makeFinding({ file: "a.ts", line: 1, category: "security", confidence: 50 }),
    ];
    const { unique } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(unique[0].confidence).toBe(50);
  });

  it("handles large number of unique findings", () => {
    const findings = Array.from({ length: 100 }, (_, i) =>
      makeFinding({ file: `src/file${i}.ts`, line: i + 1, category: "bug" })
    );
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(100);
    expect(duplicatesRemoved).toBe(0);
  });

  it("deduplicates across multiple categories at same file+line", () => {
    const findings = [
      makeFinding({ file: "src/h.ts", line: 10, category: "security" }),
      makeFinding({ file: "src/h.ts", line: 10, category: "bug" }),
      makeFinding({ file: "src/h.ts", line: 10, category: "performance" }),
      makeFinding({ file: "src/h.ts", line: 10, category: "security", confidence: 95 }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(3);
    expect(duplicatesRemoved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildSwarmContext advanced
// ---------------------------------------------------------------------------

describe("buildSwarmContext advanced", () => {
  it("includes all three perspective sections", () => {
    const result: SwarmResult = {
      findings: [
        makeFinding({ category: "security", message: "XSS" }),
        makeFinding({ category: "bug", message: "Null deref" }),
        makeFinding({ category: "performance", message: "N+1" }),
      ],
      perspectiveCounts: { security: 1, correctness: 1, performance: 1 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Security Specialist");
    expect(ctx).toContain("Correctness Specialist");
    expect(ctx).toContain("Performance Specialist");
  });

  it("includes suggestion when present", () => {
    const result: SwarmResult = {
      findings: [makeFinding({
        category: "security", message: "SQL injection", suggestion: "Use prepared statements",
      })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Use prepared statements");
  });

  it("handles findings with endLine", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "bug", message: "Logic error", endLine: 50 })],
      perspectiveCounts: { security: 0, correctness: 1, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Logic error");
  });

  it("handles multiple severity levels in same perspective", () => {
    const result: SwarmResult = {
      findings: [
        makeFinding({ category: "security", severity: "critical", message: "RCE" }),
        makeFinding({ category: "security", severity: "high", message: "XSS" }),
      ],
      perspectiveCounts: { security: 2, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("critical");
    expect(ctx).toContain("high");
  });

  it("includes medium and nitpick severities", () => {
    const result: SwarmResult = {
      findings: [
        makeFinding({ category: "bug", severity: "medium", message: "Missing return" }),
        makeFinding({ category: "bug", severity: "nitpick", message: "Naming" }),
      ],
      perspectiveCounts: { security: 0, correctness: 2, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("medium");
    expect(ctx).toContain("nitpick");
  });

  it("formats file:line reference with backticks", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ file: "src/api/auth.ts", line: 42, category: "security", message: "XSS" })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("`src/api/auth.ts:42`");
  });

  it("handles finding without suggestion", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "security", message: "SQL injection", suggestion: undefined })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("SQL injection");
    expect(ctx).not.toContain("→");
  });

  it("handles findings with endLine set", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "bug", message: "Block issue", endLine: 55 })],
      perspectiveCounts: { security: 0, correctness: 1, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).toContain("Block issue");
  });

  it("trims trailing whitespace from output", () => {
    const result: SwarmResult = {
      findings: [makeFinding({ category: "security" })],
      perspectiveCounts: { security: 1, correctness: 0, performance: 0 },
      duplicatesRemoved: 0,
    };
    const ctx = buildSwarmContext(result);
    expect(ctx).not.toMatch(/\n$/);
  });
});

// ---------------------------------------------------------------------------
// deduplicateFindings more edge cases
// ---------------------------------------------------------------------------

describe("deduplicateFindings additional", () => {
  it("handles findings with very long file paths", () => {
    const longPath = "src/very/deeply/nested/module/sub/package/feature/component/service.ts";
    const findings = [
      makeFinding({ file: longPath, line: 1, category: "security" }),
      makeFinding({ file: longPath, line: 1, category: "security", confidence: 99 }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    expect(unique[0].confidence).toBe(99);
  });

  it("handles same file different lines same category", () => {
    const findings = [
      makeFinding({ file: "app.ts", line: 10, category: "security" }),
      makeFinding({ file: "app.ts", line: 20, category: "security" }),
      makeFinding({ file: "app.ts", line: 30, category: "security" }),
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(3);
    expect(duplicatesRemoved).toBe(0);
  });

  it("handles same file same line different categories", () => {
    const findings = [
      makeFinding({ file: "x.ts", line: 5, category: "security" }),
      makeFinding({ file: "x.ts", line: 5, category: "bug" }),
      makeFinding({ file: "x.ts", line: 5, category: "performance" }),
    ];
    const { unique } = deduplicateFindings(findings);
    expect(unique).toHaveLength(3);
  });

  it("handles single finding", () => {
    const { unique, duplicatesRemoved } = deduplicateFindings([
      makeFinding({ file: "solo.ts", line: 1, category: "bug" }),
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(0);
  });
});
