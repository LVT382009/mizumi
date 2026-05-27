import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldRunBehavioralAnalysis, formatBehavioralSummary, generateBehavioralSummary } from "../behavioral.js";
import type { BehavioralSummaryType } from "../behavioral.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Mocks for generateBehavioralSummary LLM call tests
// ---------------------------------------------------------------------------

const mockGenerateObject = vi.fn();

vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => mockGenerateObject(...args),
}));

vi.mock("../models.js", () => ({
  createModel: vi.fn().mockReturnValue("mock-model"),
}));

vi.mock("../sanitize.js", () => ({
  sanitizeInput: vi.fn((s: string) => s),
}));

vi.mock("../config.js", () => ({
  requireApiKey: vi.fn().mockReturnValue("test-key"),
}));

// ---------------------------------------------------------------------------
// shouldRunBehavioralAnalysis
// ---------------------------------------------------------------------------

describe("shouldRunBehavioralAnalysis", () => {
  it("returns false for less than 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 50, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 30, deletions: 5, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns false for 3 files but < 50 total lines", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 8, deletions: 2, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 5, deletions: 1, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns true for 3+ files with 50+ total lines", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 30, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 25, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 20, deletions: 5, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for many files but very small changes", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`, status: "modified" as const, additions: 1, deletions: 0, hunks: [],
    }));
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns true for exactly 50 lines across 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 20, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 3, deletions: 2, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for exactly 49 lines across 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 20, deletions: 9, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 3, deletions: 2, hunks: [] },
    ];
    // Total: 49 lines — just below threshold
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("counts additions and deletions separately", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 25, deletions: 0, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 0, deletions: 25, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 1, deletions: 0, hunks: [] },
    ];
    // Total: 51 lines (25+0+0+25+1+0)
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for empty files array", () => {
    expect(shouldRunBehavioralAnalysis([])).toBe(false);
  });

  it("returns false for single file with many lines", () => {
    const files = [
      { path: "big.ts", status: "modified" as const, additions: 500, deletions: 200, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns false for 2 files with many lines each", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 200, deletions: 100, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 150, deletions: 50, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns true for exactly 3 files with exactly 50 lines", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 10, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 10, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 10, deletions: 0, hunks: [] },
    ];
    // 10+10 + 10+10 + 10+0 = 50
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for 3 files with 49 lines total", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 10, deletions: 9, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 10, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 10, deletions: 0, hunks: [] },
    ];
    // 10+9 + 10+10 + 10+0 = 49
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateBehavioralSummary — LLM call path
// ---------------------------------------------------------------------------

describe("generateBehavioralSummary", () => {
  const mockConfig = {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-20250514",
    baseUrl: "",
    profile: "assertive" as const,
    maxComments: 10,
    language: "en",
    selfCritique: false,
    confidenceThreshold: 0.7,
    autoReview: false,
    autoPauseAfter: 0,
    excludePatterns: [],
    tierRouting: false,
    smallDiffThreshold: 200,
    securityPaths: [],
    complianceCheck: false,
    autoFix: false,
    confidenceCalibration: false,
    changeStack: false,
    improveEnabled: false,
    dryRun: false,
    linterScan: false,
    autoLabels: false,
    spendThreshold: 0,
    gateThreshold: "none" as const,
    ruleEngine: false,
    ciValidatedFix: false,
    ciFixTimeout: 0,
    ciFixMaxRetries: 0,
    ciFixRevertOnFailure: false,
    astContractAnalysis: false,
    behavioralSummary: true,
    ownershipRouting: false,
    deltaReview: false,
    taintAnalysis: false,
    reviewLearning: false,
    blastRadius: false,
    specCompliance: false,
    authBoundary: false,
    fatigueDashboard: false,
    secretEntropy: false,
    safetyScore: false,
    adaptiveStrategy: false,
    businessContext: false,
    orgMemory: false,
    testGapDetection: false,
    suppressionMemories: false,
    swarmReview: false,
    complexityPrediction: false,
    prSplitSuggestions: false,
    findingLifecycle: false,
    intentClassification: false,
    depImpactAnalysis: false,
    threadContinuity: false,
    crossPRPersistence: false,
    sarifExport: false,
    reviewPriority: false,
    defenseFramework: false,
    checksApi: false,
    repoHealth: false,
    chunkReview: false,
    reviewCache: false,
    findingDedup: false,
    pipelineParallel: false,
  };

  const sampleDiffFiles: DiffFile[] = [
    { path: "src/auth/login.ts", status: "modified", additions: 30, deletions: 10, hunks: [] },
    { path: "src/auth/token.ts", status: "added", additions: 50, deletions: 0, hunks: [] },
    { path: "src/middleware.ts", status: "modified", additions: 20, deletions: 5, hunks: [] },
  ];

  const sampleOutput: BehavioralSummaryType = {
    headline: "Replaces session auth with JWT token auth",
    changes: [
      {
        type: "replaced",
        area: "authentication",
        description: "Session auth replaced with JWT tokens",
        impact: "high",
        files: ["src/auth/login.ts", "src/auth/token.ts"],
      },
    ],
    riskAreas: ["Token refresh"],
    testingFocus: "Verify JWT token issuance and refresh",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls createModel with config", async () => {
    const { createModel } = await import("../models.js");
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    await generateBehavioralSummary("diff text", sampleDiffFiles, mockConfig);

    expect(createModel).toHaveBeenCalledWith(mockConfig);
  });

  it("calls sanitizeInput on diff text", async () => {
    const { sanitizeInput } = await import("../sanitize.js");
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    await generateBehavioralSummary("raw diff content", sampleDiffFiles, mockConfig);

    expect(sanitizeInput).toHaveBeenCalled();
  });

  it("truncates diff text to 40000 characters", async () => {
    const { sanitizeInput } = await import("../sanitize.js");
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    const longDiff = "a".repeat(50000);
    await generateBehavioralSummary(longDiff, sampleDiffFiles, mockConfig);

    // sanitizeInput gets called with the first 40000 chars
    expect(sanitizeInput).toHaveBeenCalledWith(longDiff.slice(0, 40000));
  });

  it("passes diff text shorter than 40000 chars untruncated", async () => {
    const { sanitizeInput } = await import("../sanitize.js");
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    const shortDiff = "short diff";
    await generateBehavioralSummary(shortDiff, sampleDiffFiles, mockConfig);

    expect(sanitizeInput).toHaveBeenCalledWith(shortDiff);
  });

  it("formats file summary as path: +N/-N (status)", async () => {
    mockGenerateObject.mockImplementation(async (opts: Record<string, unknown>) => {
      // Capture the prompt for inspection
      const prompt = opts.prompt as string;
      expect(prompt).toContain("src/auth/login.ts: +30/-10 (modified)");
      expect(prompt).toContain("src/auth/token.ts: +50/-0 (added)");
      expect(prompt).toContain("src/middleware.ts: +20/-5 (modified)");
      return { object: sampleOutput };
    });

    await generateBehavioralSummary("diff", sampleDiffFiles, mockConfig);
  });

  it("calls generateObject with correct parameters", async () => {
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    await generateBehavioralSummary("diff text", sampleDiffFiles, mockConfig);

    expect(mockGenerateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mock-model",
        maxOutputTokens: 1536,
      }),
    );
  });

  it("includes system prompt in generateObject call", async () => {
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    await generateBehavioralSummary("diff text", sampleDiffFiles, mockConfig);

    const callArg = mockGenerateObject.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.system).toContain("senior engineer");
    expect(callArg.system).toContain("behavioral");
  });

  it("returns the LLM output as BehavioralSummaryType", async () => {
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    const result = await generateBehavioralSummary("diff text", sampleDiffFiles, mockConfig);

    expect(result.headline).toBe("Replaces session auth with JWT token auth");
    expect(result.changes).toHaveLength(1);
    expect(result.riskAreas).toContain("Token refresh");
  });

  it("propagates error when LLM call fails", async () => {
    mockGenerateObject.mockRejectedValue(new Error("LLM service unavailable"));

    await expect(
      generateBehavioralSummary("diff text", sampleDiffFiles, mockConfig),
    ).rejects.toThrow("LLM service unavailable");
  });

  it("includes file summary section in prompt", async () => {
    mockGenerateObject.mockImplementation(async (opts: Record<string, unknown>) => {
      const prompt = opts.prompt as string;
      expect(prompt).toContain("File summary:");
      return { object: sampleOutput };
    });

    await generateBehavioralSummary("diff text", sampleDiffFiles, mockConfig);
  });

  it("includes diff content in prompt", async () => {
    const { sanitizeInput } = await import("../sanitize.js");
    mockGenerateObject.mockResolvedValue({ object: sampleOutput });

    await generateBehavioralSummary("the actual diff content", sampleDiffFiles, mockConfig);

    const callArg = mockGenerateObject.mock.calls[0][0] as Record<string, unknown>;
    const prompt = callArg.prompt as string;
    // The sanitized diff should appear in the prompt
    expect(prompt).toContain("the actual diff content");
  });
});

// ---------------------------------------------------------------------------
// formatBehavioralSummary
// ---------------------------------------------------------------------------

describe("formatBehavioralSummary", () => {
  const sampleSummary: BehavioralSummaryType = {
    headline: "Adds OAuth2 PKCE flow and replaces session auth with token auth",
    changes: [
      {
        type: "replaced",
        area: "authentication",
        description: "Session-based authentication replaced with JWT token-based authentication",
        impact: "high",
        files: ["src/auth/session.ts", "src/auth/token.ts", "src/middleware.ts"],
      },
      {
        type: "added",
        area: "security",
        description: "OAuth2 PKCE flow added for public clients",
        impact: "medium",
        files: ["src/auth/pkce.ts", "src/auth/oauth.ts"],
      },
      {
        type: "removed",
        area: "error handling",
        description: "Legacy cookie-based error redirect removed",
        impact: "low",
        files: ["src/errors/redirect.ts"],
      },
    ],
    riskAreas: ["Session management", "Token refresh flow", "Cookie fallback"],
    testingFocus: "Verify JWT tokens are properly issued and refreshed, and that PKCE challenge/verifier pairs work for OAuth flows",
  };

  it("includes the headline in the summary tag", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain(sampleSummary.headline);
  });

  it("includes all change types with correct emoji", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("🟡");
    expect(result).toContain("🟢");
    expect(result).toContain("🔴");
  });

  it("includes impact badges", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("⚠️");
    expect(result).toContain("📋");
    expect(result).toContain("✏️");
  });

  it("includes file references", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("`src/auth/session.ts`");
    expect(result).toContain("`src/auth/token.ts`");
  });

  it("includes risk areas", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("Session management");
    expect(result).toContain("Token refresh flow");
  });

  it("includes testing focus", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("JWT tokens");
  });

  it("wraps content in details/summary block", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("<details>");
    expect(result).toContain("</details>");
    expect(result).toContain("<summary>");
  });

  it("formats replaced changes correctly", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Replaced**");
  });

  it("formats added changes correctly", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Added**");
  });

  it("formats removed changes correctly", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Removed**");
  });

  it("handles summary with no risk areas", () => {
    const noRisk: BehavioralSummaryType = {
      ...sampleSummary,
      riskAreas: [],
    };
    const result = formatBehavioralSummary(noRisk);
    expect(result).not.toContain("**Risk Areas:**");
  });

  it("handles modified and refactored change types", () => {
    const summary: BehavioralSummaryType = {
      headline: "Refactors data layer",
      changes: [
        { type: "modified", area: "data access", description: "Query timeout increased from 5s to 30s", impact: "medium", files: ["src/db/queries.ts"] },
        { type: "refactored", area: "caching", description: "Cache layer moved from Redis to in-memory LRU", impact: "low", files: ["src/cache/redis.ts", "src/cache/lru.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Check query performance under load",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("**Modified**");
    expect(result).toContain("**Refactored**");
    expect(result).toContain("⚪");
  });

  it("handles summary with single change", () => {
    const single: BehavioralSummaryType = {
      headline: "Adds rate limiting",
      changes: [
        { type: "added", area: "API", description: "Rate limiting middleware added", impact: "high", files: ["src/middleware/rate-limit.ts"] },
      ],
      riskAreas: ["Performance"],
      testingFocus: "Load test with concurrent requests",
    };
    const result = formatBehavioralSummary(single);
    expect(result).toContain("**Added**");
    expect(result).toContain("Rate limiting middleware added");
    expect(result).toContain("**Risk Areas:** Performance");
  });

  it("capitalizes change type labels", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Replaced**");
    expect(result).toContain("**Added**");
    expect(result).toContain("**Removed**");
    // Should NOT contain lowercase versions as bold labels
    expect(result).not.toContain("**replaced**");
    expect(result).not.toContain("**added**");
  });

  it("formats change descriptions as blockquotes", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("> Session-based authentication replaced");
  });

  it("formats file references in sup tags", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("<sup>");
    expect(result).toContain("</sup>");
  });

  it("formats each file with backticks", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("`src/auth/pkce.ts`");
    expect(result).toContain("`src/auth/oauth.ts`");
  });

  it("handles high impact badge for high-impact changes", () => {
    const high: BehavioralSummaryType = {
      headline: "Test",
      changes: [
        { type: "added", area: "core", description: "Big change", impact: "high", files: ["a.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test everything",
    };
    const result = formatBehavioralSummary(high);
    expect(result).toContain("⚠️");
  });

  it("handles summary with 5 changes", () => {
    const many: BehavioralSummaryType = {
      headline: "Major refactor",
      changes: [
        { type: "added", area: "a", description: "Add a", impact: "high", files: ["a.ts"] },
        { type: "removed", area: "b", description: "Remove b", impact: "high", files: ["b.ts"] },
        { type: "replaced", area: "c", description: "Replace c", impact: "medium", files: ["c.ts"] },
        { type: "modified", area: "d", description: "Modify d", impact: "medium", files: ["d.ts"] },
        { type: "refactored", area: "e", description: "Refactor e", impact: "low", files: ["e.ts"] },
      ],
      riskAreas: ["a", "b", "c"],
      testingFocus: "Everything",
    };
    const result = formatBehavioralSummary(many);
    expect(result).toContain("**Added**");
    expect(result).toContain("**Removed**");
    expect(result).toContain("**Replaced**");
    expect(result).toContain("**Modified**");
    expect(result).toContain("**Refactored**");
  });

  it("includes multiple risk areas in comma-separated list", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("Session management, Token refresh flow, Cookie fallback");
  });

  it("handles empty changes array", () => {
    const empty: BehavioralSummaryType = {
      headline: "Empty PR",
      changes: [],
      riskAreas: [],
      testingFocus: "Nothing to test",
    };
    const result = formatBehavioralSummary(empty);
    expect(result).toContain("Empty PR");
  });

  it("wraps content in details block for collapsible display", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>");
    expect(result).toContain("Behavioral");
  });

  it("handles very long headline", () => {
    const long: BehavioralSummaryType = {
      headline: "This is a very long headline that describes a complex refactoring of the entire authentication and authorization system including OAuth2, SAML, and custom token-based approaches across multiple microservices",
      changes: [
        { type: "added", area: "auth", description: "Complex auth", impact: "high", files: ["a.ts"] },
      ],
      riskAreas: ["Auth"],
      testingFocus: "Test auth flows",
    };
    const result = formatBehavioralSummary(long);
    expect(result).toContain("OAuth2");
  });

  it("handles change with many files", () => {
    const manyFiles: BehavioralSummaryType = {
      headline: "Renames package",
      changes: [
        {
          type: "refactored",
          area: "package",
          description: "Package renamed",
          impact: "medium",
          files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        },
      ],
      riskAreas: [],
      testingFocus: "Re-import check",
    };
    const result = formatBehavioralSummary(manyFiles);
    expect(result).toContain("`src/a.ts`");
    expect(result).toContain("`src/e.ts`");
  });

  it("handles very long area name", () => {
    const longArea: BehavioralSummaryType = {
      headline: "Refactors subsystem",
      changes: [
        {
          type: "modified",
          area: "authentication-authorization-and-access-control-management-subsystem",
          description: "Auth flow updated",
          impact: "high",
          files: ["src/auth/main.ts"],
        },
      ],
      riskAreas: [],
      testingFocus: "Test auth",
    };
    const result = formatBehavioralSummary(longArea);
    expect(result).toContain("authentication-authorization");
  });

  it("handles files with special characters in paths", () => {
    const special: BehavioralSummaryType = {
      headline: "Updates modules",
      changes: [
        {
          type: "modified",
          area: "utils",
          description: "Helper utilities updated",
          impact: "medium",
          files: ["src/utils/string.helper.ts", "src/utils/data_parser.ts", "src/utils/@scope/module.ts"],
        },
      ],
      riskAreas: [],
      testingFocus: "Check utility outputs",
    };
    const result = formatBehavioralSummary(special);
    expect(result).toContain("`src/utils/string.helper.ts`");
    expect(result).toContain("`src/utils/data_parser.ts`");
    expect(result).toContain("`src/utils/@scope/module.ts`");
  });

  it("handles change with empty files array", () => {
    const emptyFiles: BehavioralSummaryType = {
      headline: "Config change",
      changes: [
        { type: "modified", area: "config", description: "Environment vars changed", impact: "medium", files: [] },
      ],
      riskAreas: [],
      testingFocus: "Verify env vars",
    };
    const result = formatBehavioralSummary(emptyFiles);
    expect(result).toContain("Config change");
    expect(result).toContain("**Modified**");
  });

  it("handles change with single file", () => {
    const singleFile: BehavioralSummaryType = {
      headline: "Single file change",
      changes: [
        { type: "added", area: "API", description: "New endpoint", impact: "high", files: ["src/api/new.ts"] },
      ],
      riskAreas: ["API stability"],
      testingFocus: "Test new endpoint",
    };
    const result = formatBehavioralSummary(singleFile);
    expect(result).toContain("`src/api/new.ts`");
  });

  it("handles high impact badge for all changes", () => {
    const allHigh: BehavioralSummaryType = {
      headline: "Critical changes",
      changes: [
        { type: "added", area: "core", description: "Core feature", impact: "high", files: ["a.ts"] },
        { type: "replaced", area: "data", description: "Data layer swap", impact: "high", files: ["b.ts"] },
        { type: "removed", area: "legacy", description: "Legacy removed", impact: "high", files: ["c.ts"] },
      ],
      riskAreas: ["Everything"],
      testingFocus: "Full regression",
    };
    const result = formatBehavioralSummary(allHigh);
    const warningCount = (result.match(/⚠️/g) || []).length;
    expect(warningCount).toBe(3);
  });

  it("handles all changes same type", () => {
    const allAdded: BehavioralSummaryType = {
      headline: "New features",
      changes: [
        { type: "added", area: "a", description: "Feature a", impact: "high", files: ["a.ts"] },
        { type: "added", area: "b", description: "Feature b", impact: "medium", files: ["b.ts"] },
        { type: "added", area: "c", description: "Feature c", impact: "low", files: ["c.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test all new features",
    };
    const result = formatBehavioralSummary(allAdded);
    const addedCount = (result.match(/\*\*Added\*\*/g) || []).length;
    expect(addedCount).toBe(3);
  });

  it("handles summary with no testing focus text", () => {
    const noFocus: BehavioralSummaryType = {
      headline: "Minor change",
      changes: [
        { type: "modified", area: "ui", description: "Button color changed", impact: "low", files: ["ui.ts"] },
      ],
      riskAreas: [],
      testingFocus: "",
    };
    const result = formatBehavioralSummary(noFocus);
    expect(result).toContain("**Testing Focus:**");
    // Testing focus section exists but is empty
  });

  it("handles very short headline", () => {
    const short: BehavioralSummaryType = {
      headline: "Fix",
      changes: [
        { type: "modified", area: "bug", description: "Fixed null pointer", impact: "medium", files: ["fix.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Re-test",
    };
    const result = formatBehavioralSummary(short);
    expect(result).toContain("Fix");
    expect(result).toContain("<summary>");
  });

  it("handles risk areas with special characters", () => {
    const specialRisk: BehavioralSummaryType = {
      headline: "Security update",
      changes: [
        { type: "modified", area: "auth", description: "Auth updated", impact: "high", files: ["a.ts"] },
      ],
      riskAreas: ["OAuth2/PKCE-flow", "token-refresh (auto)", "session<->cookie bridge"],
      testingFocus: "Test all auth paths",
    };
    const result = formatBehavioralSummary(specialRisk);
    expect(result).toContain("OAuth2/PKCE-flow");
    expect(result).toContain("token-refresh (auto)");
  });

  it("renders medium impact badge as clipboard", () => {
    const summary: BehavioralSummaryType = {
      headline: "Medium impact test",
      changes: [
        { type: "added", area: "x", description: "Medium impact change", impact: "medium", files: ["x.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("📋");
  });

  it("renders low impact badge as pencil", () => {
    const summary: BehavioralSummaryType = {
      headline: "Low impact test",
      changes: [
        { type: "added", area: "x", description: "Low impact change", impact: "low", files: ["x.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("✏️");
  });

  it("renders replaced emoji as yellow circle", () => {
    const summary: BehavioralSummaryType = {
      headline: "Replace test",
      changes: [
        { type: "replaced", area: "x", description: "Replaced something", impact: "medium", files: ["x.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("🟡");
  });

  it("renders added emoji as green circle", () => {
    const summary: BehavioralSummaryType = {
      headline: "Add test",
      changes: [
        { type: "added", area: "x", description: "Added something", impact: "low", files: ["x.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("🟢");
  });

  it("renders removed emoji as red circle", () => {
    const summary: BehavioralSummaryType = {
      headline: "Remove test",
      changes: [
        { type: "removed", area: "x", description: "Removed something", impact: "high", files: ["x.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("🔴");
  });

  it("renders modified and refactored as white circles", () => {
    const summary: BehavioralSummaryType = {
      headline: "Modify test",
      changes: [
        { type: "modified", area: "x", description: "Modified something", impact: "medium", files: ["x.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("⚪");
  });

  it("summary with all 5 change types at once", () => {
    const allFive: BehavioralSummaryType = {
      headline: "Full spectrum changes",
      changes: [
        { type: "added", area: "a", description: "New feature", impact: "high", files: ["a.ts"] },
        { type: "removed", area: "b", description: "Old feature gone", impact: "high", files: ["b.ts"] },
        { type: "replaced", area: "c", description: "Swapped implementation", impact: "medium", files: ["c.ts"] },
        { type: "modified", area: "d", description: "Behavior changed", impact: "medium", files: ["d.ts"] },
        { type: "refactored", area: "e", description: "Same result new code", impact: "low", files: ["e.ts"] },
      ],
      riskAreas: ["Integration", "Regression"],
      testingFocus: "All paths",
    };
    const result = formatBehavioralSummary(allFive);
    expect(result).toContain("🟢");
    expect(result).toContain("🔴");
    expect(result).toContain("🟡");
    expect(result).toContain("⚪");
    // Two white circles for modified + refactored
    const whiteCount = (result.match(/⚪/g) || []).length;
    expect(whiteCount).toBe(2);
  });

  it("ends output with closing details tag", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result.trimEnd()).toMatch(/<\/details>\s*$/);
  });

  it("formats area name in italics", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("*authentication*");
    expect(result).toContain("*security*");
    expect(result).toContain("*error handling*");
  });
});
