import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAcceptanceCriteria,
  parseTaskListStatus,
  extractKeywords,
  keywordInDiff,
  isNonCodeCriterion,
  buildSpecComplianceContext,
  checkSpecCompliance,
} from "../spec-compliance.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
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
    object: { status: "met", evidence: "found in diff" },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHunk(changes: Array<{ type: "add" | "delete" | "normal"; content: string; line: number }>) {
  return {
    oldStart: 1, oldLines: changes.length, newStart: 1, newLines: changes.length,
    content: "",
    changes: changes.map((c) => ({
      type: c.type, content: c.content, line: c.line,
      oldLine: c.type === "normal" ? c.line : c.type === "delete" ? c.line : 0,
    })),
  };
}

function makeDiffFile(path: string, addedLines: string[]): DiffFile {
  return {
    path, status: "modified" as const, additions: addedLines.length, deletions: 0,
    hunks: [makeHunk(addedLines.map((content, i) => ({ type: "add" as const, content, line: i + 1 })))],
  };
}

// ---------------------------------------------------------------------------
// parseAcceptanceCriteria
// ---------------------------------------------------------------------------

describe("parseAcceptanceCriteria", () => {
  it("extracts task list items", () => {
    const body = "- [ ] Add login endpoint\n- [ ] Validate JWT tokens\n- [ ] Write unit tests";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("Add login endpoint");
    expect(result[1]).toBe("Validate JWT tokens");
    expect(result[2]).toBe("Write unit tests");
  });

  it("extracts checked task list items too", () => {
    const body = "- [x] Add login endpoint\n- [ ] Validate JWT tokens";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("Add login endpoint");
    expect(result[1]).toBe("Validate JWT tokens");
  });

  it("deduplicates task list items", () => {
    const body = "- [ ] Add login\n- [ ] Add login";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(1);
  });

  it("returns empty for empty body", () => {
    expect(parseAcceptanceCriteria("")).toEqual([]);
  });

  it("extracts numbered list items under AC heading", () => {
    const body = "## Acceptance Criteria\n\n1. User can log in\n2. JWT is validated\n3. Session expires after 30min\n\n## Notes\nOther stuff";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("User can log in");
    expect(result[2]).toBe("Session expires after 30min");
  });

  it("extracts bullet list items under AC heading", () => {
    const body = "### AC:\n\n- User can log in\n- JWT is validated\n\n### Other\nNot AC stuff";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(2);
  });

  it("prefers task lists over AC heading sections", () => {
    const body = "### Acceptance Criteria\n\n1. Heading item\n\n- [ ] Task list item";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Task list item");
  });

  it("falls back to numbered lists in body when no task lists or AC heading", () => {
    const body = "Some intro\n\n1. First requirement for the feature\n2. Second requirement for the feature\n\nSome outro";
    const result = parseAcceptanceCriteria(body);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to bullet lists in body", () => {
    const body = "Some intro\n\n- First requirement that is long enough\n- Second requirement that is long enough\n\nOutro";
    const result = parseAcceptanceCriteria(body);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("skips very short bullet items (< 6 chars)", () => {
    const body = "- Fix\n- Implement the user authentication flow";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Implement the user authentication flow");
  });

  it("handles Definition of Done heading", () => {
    const body = "## Definition of Done\n\n1. Code is reviewed\n2. Tests pass\n3. Deployed to staging";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(3);
  });

  it("handles DoD heading abbreviation", () => {
    const body = "## DoD\n\n- Code reviewed\n- Tests written and passing";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(2);
  });

  it("handles Requirements heading", () => {
    const body = "## Requirements:\n\n1. Must validate input\n2. Must return 200 on success";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(2);
  });

  it("handles mixed case AC heading", () => {
    const body = "## ACCEPTANCE CRITERIA\n\n1. Must work";
    const result = parseAcceptanceCriteria(body);
    expect(result).toHaveLength(1);
  });

  it("returns empty when no lists or tasks found", () => {
    const body = "This is a bug report.\n\nThe app crashes on startup.\n\nPlease fix.";
    expect(parseAcceptanceCriteria(body)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseTaskListStatus
// ---------------------------------------------------------------------------

describe("parseTaskListStatus", () => {
  it("parses checked and unchecked task items", () => {
    const body = "- [x] Done item\n- [ ] Not done item\n- [X] Also done";
    const result = parseTaskListStatus(body);
    expect(result).toHaveLength(3);
    expect(result[0].checked).toBe(true);
    expect(result[1].checked).toBe(false);
    expect(result[2].checked).toBe(true);
  });

  it("returns empty for empty body", () => {
    expect(parseTaskListStatus("")).toEqual([]);
  });

  it("deduplicates task items", () => {
    const body = "- [ ] Same text\n- [ ] Same text";
    const result = parseTaskListStatus(body);
    expect(result).toHaveLength(1);
  });

  it("ignores non-task-list lines", () => {
    const body = "1. Numbered item\n- Bullet item\n- [ ] Task item";
    const result = parseTaskListStatus(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Task item");
  });
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe("extractKeywords", () => {
  it("extracts camelCase identifiers", () => {
    const result = extractKeywords("Add loginUser function");
    expect(result).toContain("loginUser");
  });

  it("extracts UPPER_SNAKE identifiers", () => {
    const result = extractKeywords("Set MAX_RETRIES constant");
    expect(result).toContain("MAX_RETRIES");
  });

  it("extracts path-like identifiers", () => {
    const result = extractKeywords("Update src/auth/login.ts");
    expect(result).toContain("src/auth/login.ts");
  });

  it("extracts kebab-case identifiers", () => {
    const result = extractKeywords("Add rate-limiter middleware");
    expect(result).toContain("rate-limiter");
  });

  it("skips short keywords (< 3 chars)", () => {
    const result = extractKeywords("Add id field");
    // "id" is 2 chars, should be skipped
    expect(result).not.toContain("id");
  });

  it("skips common stop words", () => {
    const result = extractKeywords("The user should be able to get all items");
    expect(result).not.toContain("the");
    expect(result).not.toContain("all");
    expect(result).not.toContain("get");
  });

  it("deduplicates case-insensitively", () => {
    const result = extractKeywords("Use AuthService and authservice");
    // Both map to "authservice" lowercase
    const lowercased = result.map((k) => k.toLowerCase());
    const unique = new Set(lowercased);
    expect(unique.size).toBe(lowercased.length);
  });

  it("returns empty for text with no identifiers", () => {
    const result = extractKeywords("it is a on to do");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// keywordInDiff
// ---------------------------------------------------------------------------

describe("keywordInDiff", () => {
  it("finds keyword in added line", () => {
    const files = [makeDiffFile("src/auth.ts", ["export function loginUser() {}"])];
    const result = keywordInDiff("loginUser", files);
    expect(result.found).toBe(true);
    expect(result.file).toBe("src/auth.ts");
  });

  it("is case-insensitive", () => {
    const files = [makeDiffFile("src/auth.ts", ["const MAX_RETRIES = 5;"])];
    const result = keywordInDiff("max_retries", files);
    expect(result.found).toBe(true);
  });

  it("returns not found for missing keyword", () => {
    const files = [makeDiffFile("src/app.ts", ["const x = 42;"])];
    const result = keywordInDiff("loginUser", files);
    expect(result.found).toBe(false);
  });

  it("only searches added lines, not deleted or context", () => {
    const file: DiffFile = {
      path: "src/app.ts", status: "modified", additions: 0, deletions: 1,
      hunks: [makeHunk([{ type: "delete", content: "function loginUser() {}", line: 1 }])],
    };
    const result = keywordInDiff("loginUser", [file]);
    expect(result.found).toBe(false);
  });

  it("searches across multiple files", () => {
    const files = [
      makeDiffFile("src/a.ts", ["const x = 1;"]),
      makeDiffFile("src/b.ts", ["const loginUser = true;"]),
    ];
    const result = keywordInDiff("loginUser", files);
    expect(result.found).toBe(true);
    expect(result.file).toBe("src/b.ts");
  });

  it("returns empty for empty diff", () => {
    const result = keywordInDiff("loginUser", []);
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNonCodeCriterion
// ---------------------------------------------------------------------------

describe("isNonCodeCriterion", () => {
  it("detects deploy criteria", () => {
    expect(isNonCodeCriterion("Deploy to staging")).toBe(true);
  });

  it("detects production criteria", () => {
    expect(isNonCodeCriterion("Test in production environment")).toBe(true);
  });

  it("detects manual criteria", () => {
    expect(isNonCodeCriterion("Manual testing required")).toBe(true);
  });

  it("detects approval criteria", () => {
    expect(isNonCodeCriterion("Code review approval from team lead")).toBe(true);
  });

  it("detects monitoring criteria", () => {
    expect(isNonCodeCriterion("Set up monitoring and alerts")).toBe(true);
  });

  it("detects documentation criteria", () => {
    expect(isNonCodeCriterion("Update documentation with new API")).toBe(true);
  });

  it("does not flag code criteria", () => {
    expect(isNonCodeCriterion("Add JWT validation middleware")).toBe(false);
  });

  it("does not flag simple feature criteria", () => {
    expect(isNonCodeCriterion("Implement user login endpoint")).toBe(false);
  });

  it("detects SLA criteria", () => {
    expect(isNonCodeCriterion("Meet 99.9% SLA for uptime")).toBe(true);
  });

  it("detects changelog criteria", () => {
    expect(isNonCodeCriterion("Update changelog with breaking changes")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSpecComplianceContext
// ---------------------------------------------------------------------------

describe("buildSpecComplianceContext", () => {
  it("returns empty string for empty results", () => {
    expect(buildSpecComplianceContext([])).toBe("");
  });

  it("formats single issue with criteria", () => {
    const results = [{
      issueNumber: 42,
      issueTitle: "Add auth",
      criteria: [
        { text: "Add login endpoint", isTaskList: true, isChecked: false, status: "met" as const, evidence: "Keyword found in src/auth.ts" },
        { text: "Validate JWT", isTaskList: true, isChecked: false, status: "unaddressed" as const, evidence: "" },
      ],
      summary: "1/2 criteria met",
      coverage: 50,
    }];
    const ctx = buildSpecComplianceContext(results);
    expect(ctx).toContain("Spec Compliance");
    expect(ctx).toContain("#42");
    expect(ctx).toContain("Add auth");
    expect(ctx).toContain("50%");
    expect(ctx).toContain("[PASS]");
    expect(ctx).toContain("[FAIL]");
    expect(ctx).toContain("src/auth.ts");
  });

  it("formats non-code criteria with [SKIP]", () => {
    const results = [{
      issueNumber: 7,
      issueTitle: "Release v2",
      criteria: [
        { text: "Deploy to staging", isTaskList: false, isChecked: false, status: "non-code" as const, evidence: "Manual verification needed" },
      ],
      summary: "0/0 criteria met (+1 non-code)",
      coverage: 0,
    }];
    const ctx = buildSpecComplianceContext(results);
    expect(ctx).toContain("[SKIP]");
    expect(ctx).toContain("Deploy to staging");
  });

  it("formats partially-met criteria with [WARN]", () => {
    const results = [{
      issueNumber: 10,
      issueTitle: "Fix bug",
      criteria: [
        { text: "Fix null pointer", isTaskList: false, isChecked: false, status: "partially-met" as const, evidence: "Added null check but missing fallback" },
      ],
      summary: "1/1 criteria met",
      coverage: 100,
    }];
    const ctx = buildSpecComplianceContext(results);
    expect(ctx).toContain("[WARN]");
    expect(ctx).toContain("Added null check but missing fallback");
  });

  it("formats multiple issues", () => {
    const results = [
      { issueNumber: 1, issueTitle: "A", criteria: [{ text: "X", isTaskList: false, isChecked: false, status: "met" as const, evidence: "" }], summary: "1/1", coverage: 100 },
      { issueNumber: 2, issueTitle: "B", criteria: [{ text: "Y", isTaskList: false, isChecked: false, status: "unaddressed" as const, evidence: "" }], summary: "0/1", coverage: 0 },
    ];
    const ctx = buildSpecComplianceContext(results);
    expect(ctx).toContain("#1");
    expect(ctx).toContain("#2");
  });

  it("includes evidence when present", () => {
    const results = [{
      issueNumber: 5,
      issueTitle: "Test",
      criteria: [
        { text: "Add unit test", isTaskList: false, isChecked: false, status: "met" as const, evidence: "Found in src/test.ts" },
      ],
      summary: "1/1", coverage: 100,
    }];
    const ctx = buildSpecComplianceContext(results);
    expect(ctx).toContain("Found in src/test.ts");
  });
});

// ---------------------------------------------------------------------------
// Integration: checkSpecCompliance
// ---------------------------------------------------------------------------

describe("checkSpecCompliance", () => {
  const mockOctokit = {
    rest: {
      issues: {
        get: vi.fn(),
      },
    },
  } as unknown as import("@octokit/rest").Octokit;

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
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty when no issue refs in PR body", async () => {
    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "No issues referenced", "Bug fix", [], mockConfig
    );
    expect(result).toEqual([]);
  });

  it("fetches referenced issue and parses AC with keyword match", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        body: "- [ ] Add loginUser endpoint\n- [ ] Write integration tests",
        title: "Auth feature",
        pull_request: undefined,
      },
    });

    const diffFiles = [makeDiffFile("src/auth.ts", ["export function loginUser() {}"])];
    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Fixes #42", "Auth PR", diffFiles, mockConfig
    );

    expect(result).toHaveLength(1);
    expect(result[0].issueNumber).toBe(42);
    expect(result[0].issueTitle).toBe("Auth feature");
    expect(result[0].criteria).toHaveLength(2);
    // First criterion should match via keyword
    expect(result[0].criteria[0].status).toBe("met");
  });

  it("skips referenced PRs (only checks issues)", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        body: "Some text",
        title: "A PR",
        pull_request: {},
      },
    });

    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Fixes #10", "PR", [], mockConfig
    );
    expect(result).toEqual([]);
  });

  it("handles API error gracefully", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API rate limit")
    );

    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Closes #99", "Fix PR", [], mockConfig
    );
    // Should not throw, returns empty (warning logged)
    // The function catches the error internally
    expect(result.length).toBeLessThanOrEqual(0);
  });

  it("returns empty when issue body has no AC", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        body: "This is just a description with no lists.",
        title: "Bug",
        pull_request: undefined,
      },
    });

    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Fixes #5", "Fix", [], mockConfig
    );
    // No AC parsed from free text
    expect(result).toEqual([]);
  });

  it("computes coverage correctly for mixed criteria", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        body: "- [ ] Add loginUser function\n- [ ] Deploy to staging\n- [ ] Add rateLimiter",
        title: "Feature",
        pull_request: undefined,
      },
    });

    const diffFiles = [makeDiffFile("src/auth.ts", ["function loginUser() {}", "const rateLimiter = {}"])];
    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Fixes #20", "Feature PR", diffFiles, mockConfig
    );

    expect(result).toHaveLength(1);
    // loginUser: met, deploy: non-code, rateLimiter: met
    const codeCriteria = result[0].criteria.filter((c) => c.status !== "non-code");
    const metCriteria = codeCriteria.filter((c) => c.status === "met");
    expect(metCriteria.length).toBe(codeCriteria.length); // Both code criteria met
  });

  it("extracts issue refs from closes/fixes/resolves patterns", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        body: "- [ ] Add endpoint",
        title: "Issue",
        pull_request: undefined,
      },
    });

    const result = await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Resolves #7", "PR", [], mockConfig
    );
    expect(mockOctokit.rest.issues.get).toHaveBeenCalledWith({
      owner: "owner", repo: "repo", issue_number: 7,
    });
  });

  it("limits to 3 issues maximum", async () => {
    (mockOctokit.rest.issues.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        body: "- [ ] Add feature",
        title: "Issue",
        pull_request: undefined,
      },
    });

    await checkSpecCompliance(
      mockOctokit, "owner", "repo", "Fixes #1, closes #2, resolves #3, fixes #4, closes #5",
      "PR", [], mockConfig
    );
    // Should only call get for 3 issues
    expect(mockOctokit.rest.issues.get).toHaveBeenCalledTimes(3);
  });
});
