import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn((name: string) => {
    if (name === "github_token") return "mock-token";
    if (name === "provider") return "anthropic";
    return "";
  }),
  getBooleanInput: vi.fn(),
  isDebug: vi.fn(() => false),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { owner: "test-owner", repo: "test-repo" },
    sha: "abc123def456",
    payload: {
      pull_request: {
        number: 42,
        head: { sha: "head-sha-1", ref: "feature-branch" },
        base: { sha: "base-sha-1", ref: "main" },
        user: { login: "test-user" },
        title: "Test PR",
        body: "Test body",
      },
    },
    eventName: "pull_request",
  },
}));

vi.mock("@octokit/rest", () => {
  const mockOctokit = vi.fn().mockImplementation(() => ({
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            number: 42,
            title: "Test PR",
            body: "Test body",
            head: { sha: "head-sha-1", ref: "feature-branch" },
            base: { sha: "base-sha-1", ref: "main" },
            user: { login: "test-user" },
          },
        }),
        listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        deleteReviewComment: vi.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
      repos: {
        createCommitStatus: vi.fn().mockResolvedValue({}),
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: { total_count: 0, statuses: [] },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { total_count: 0, check_runs: [] },
        }),
      },
    },
  }));
  mockOctokit.plugin = vi.fn().mockReturnValue(mockOctokit);
  return { Octokit: mockOctokit };
});

vi.mock("@octokit/plugin-retry", () => ({
  retry: vi.fn((ctor: any) => ctor),
}));

vi.mock("../diff.js", () => ({
  fetchDiff: vi.fn().mockResolvedValue({
    files: [{ path: "src/a.ts", status: "modified", additions: 10, deletions: 5, hunks: [] }],
    totalAdditions: 10,
    totalDeletions: 5,
    rawDiff: "mock diff",
  }),
}));

vi.mock("../post.js", () => ({
  postReview: vi.fn().mockResolvedValue({
    reviewId: 123,
    findingCount: 2,
    riskScore: 3,
  }),
}));

vi.mock("../linemap.js", () => ({
  buildLineMapFromRawDiff: vi.fn().mockReturnValue(new Map()),
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(() => ({
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
  })),
  requireApiKey: vi.fn(() => "test-key"),
}));

import { GitHubPlatformClient } from "../platform-github.js";
import type { GitHubClientOptions } from "../platform-github.js";
import { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<GitHubClientOptions> = {}): GitHubClientOptions {
  const octokit = new Octokit({ auth: "test" });
  return {
    octokit,
    owner: "test-owner",
    repo: "test-repo",
    prNumber: 42,
    config: {
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
    },
    headSha: "head-sha-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubPlatformClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports platform as github", () => {
    const client = new GitHubPlatformClient(makeOpts());
    expect(client.platform).toBe("github");
  });

  it("returns project ID as owner/repo", () => {
    const client = new GitHubPlatformClient(makeOpts());
    expect(client.getProjectId()).toBe("test-owner/test-repo");
  });

  it("getMR returns PR metadata", async () => {
    const client = new GitHubPlatformClient(makeOpts());
    const mr = await client.getMR();
    expect(mr.number).toBe(42);
    expect(mr.headSha).toBe("head-sha-1");
    expect(mr.headRef).toBe("feature-branch");
    expect(mr.author).toBe("test-user");
  });

  it("getMR returns title and body", async () => {
    const client = new GitHubPlatformClient(makeOpts());
    const mr = await client.getMR();
    expect(mr.title).toBe("Test PR");
    expect(mr.body).toBe("Test body");
  });

  it("getMR returns baseRef and baseSha", async () => {
    const client = new GitHubPlatformClient(makeOpts());
    const mr = await client.getMR();
    expect(mr.baseRef).toBe("main");
    expect(mr.baseSha).toBe("base-sha-1");
  });

  it("fetchDiff returns parsed diff", async () => {
    const client = new GitHubPlatformClient(makeOpts());
    const diff = await client.fetchDiff();
    expect(diff.files).toHaveLength(1);
    expect(diff.totalAdditions).toBe(10);
  });

  it("postReview returns result", async () => {
    const client = new GitHubPlatformClient(makeOpts());
    const result = await client.postReview(
      [{ path: "src/a.ts", line: 5, severity: "high", category: "bug", body: "Issue", suggestion: undefined, confidence: 90 }],
      "Test summary",
      3,
    );
    expect(result.reviewId).toBe(123);
    expect(result.findingCount).toBe(2);
  });

  it("postComment calls issues.createComment", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.postComment("Test comment");
    expect(opts.octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Test comment" }),
    );
  });

  it("postComment uses correct owner/repo/prNumber", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.postComment("Test");
    expect(opts.octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo", issue_number: 42 }),
    );
  });

  it("createStatus calls repos.createCommitStatus", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.createStatus("sha1", "success", "All checks passed", "mizumi/review");
    expect(opts.octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "sha1", state: "success" }),
    );
  });

  it("createStatus includes PR target_url", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.createStatus("sha1", "success", "desc", "ctx");
    expect(opts.octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        target_url: "https://github.com/test-owner/test-repo/pull/42",
      }),
    );
  });

  it("createStatus passes description and context", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.createStatus("sha1", "failure", "2 findings", "mizumi/gate");
    expect(opts.octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ description: "2 findings", context: "mizumi/gate" }),
    );
  });

  it("getCIStatus returns no_checks when no checks exist", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("no_checks");
  });

  it("getCIStatus returns passed when all statuses are success", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, statuses: [{ state: "success" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("passed");
  });

  it("getCIStatus returns failed when status is failure", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, statuses: [{ state: "failure" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("getCIStatus returns pending when status is pending", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, statuses: [{ state: "pending" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("pending");
  });

  it("getCIStatus returns pending when status is neutral", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, statuses: [{ state: "neutral" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("pending");
  });

  it("getCIStatus returns pending when check run is in_progress", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("pending");
  });

  it("getCIStatus returns failed when check run conclusion is failure", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("getCIStatus returns passed for completed check with success conclusion", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("passed");
  });

  it("getCIStatus returns failed when check conclusion is cancelled", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, check_runs: [{ status: "completed", conclusion: "cancelled" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("getCIStatus returns failed when check conclusion is timed_out", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, check_runs: [{ status: "completed", conclusion: "timed_out" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("getCIStatus skips neutral/skipped check conclusions", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 2, check_runs: [
        { status: "completed", conclusion: "neutral" },
        { status: "completed", conclusion: "skipped" },
      ] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("passed");
  });

  it("getCIStatus handles mixed statuses — failed takes priority", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 2, statuses: [{ state: "success" }, { state: "failure" }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("getCIStatus handles API errors gracefully", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    // No checks found because both API calls failed
    expect(status).toBe("no_checks");
  });

  it("listBotComments returns empty array when no matching comments", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    const comments = await client.listBotComments();
    expect(comments).toEqual([]);
  });

  it("listBotComments finds marked comments", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.pulls.listReviewComments as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: 1, body: "<!-- mizumi-review-marker --> test comment", path: "src/a.ts", line: 5, created_at: "2025-01-01" },
        { id: 2, body: "Regular user comment", path: "src/b.ts", line: 10, created_at: "2025-01-01" },
      ],
    });
    const client = new GitHubPlatformClient(opts);
    const comments = await client.listBotComments();
    expect(comments).toHaveLength(1);
    expect(comments[0].id).toBe(1);
  });

  it("listBotComments returns body, path, line, createdAt", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.pulls.listReviewComments as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { id: 10, body: "<!-- mizumi-review-marker --> finding", path: "src/x.ts", line: 42, created_at: "2025-06-01" },
      ],
    });
    const client = new GitHubPlatformClient(opts);
    const comments = await client.listBotComments();
    expect(comments[0]).toEqual({
      id: 10,
      body: "<!-- mizumi-review-marker --> finding",
      path: "src/x.ts",
      line: 42,
      createdAt: "2025-06-01",
    });
  });

  it("listBotComments paginates when page has 100 comments", async () => {
    const opts = makeOpts();
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: i < 2 ? `<!-- mizumi-review-marker --> comment ${i}` : "user comment",
      path: "src/a.ts",
      line: i,
      created_at: "2025-01-01",
    }));
    const page2 = [
      { id: 200, body: "<!-- mizumi-review-marker --> page2 comment", path: "src/b.ts", line: 1, created_at: "2025-01-01" },
    ];
    (opts.octokit.rest.pulls.listReviewComments as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    const client = new GitHubPlatformClient(opts);
    const comments = await client.listBotComments();
    // 2 from page1 + 1 from page2 = 3 marked comments
    expect(comments).toHaveLength(3);
  });

  it("listBotComments stops pagination at 5 pages", async () => {
    const opts = makeOpts();
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `<<!-- mizumi-review-marker --> comment ${i}`,
      path: "src/a.ts",
      line: i,
      created_at: "2025-01-01",
    }));
    (opts.octokit.rest.pulls.listReviewComments as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ data: fullPage });
    const client = new GitHubPlatformClient(opts);
    const comments = await client.listBotComments();
    // Should stop after 5 pages (page <= 5)
    expect(opts.octokit.rest.pulls.listReviewComments).toHaveBeenCalledTimes(5);
  });

  it("deleteComment calls deleteReviewComment", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.deleteComment(999);
    expect(opts.octokit.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 999 }),
    );
  });

  it("deleteComment passes correct owner/repo", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.deleteComment(555);
    expect(opts.octokit.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "test-owner", repo: "test-repo", comment_id: 555 }),
    );
  });

  it("uses custom owner/repo from options", () => {
    const client = new GitHubPlatformClient(makeOpts({ owner: "acme", repo: "project" }));
    expect(client.getProjectId()).toBe("acme/project");
  });

  it("fetchDiff calls with correct excludePatterns", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.fetchDiff();
    // fetchDiff is mocked, but we can verify it was called
    const { fetchDiff } = await import("../diff.js");
    expect(fetchDiff).toHaveBeenCalledWith(
      opts.octokit,
      "test-owner",
      "test-repo",
      42,
      opts.config.excludePatterns,
    );
  });
});
