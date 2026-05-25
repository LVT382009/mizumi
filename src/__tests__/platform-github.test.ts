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

  it("createStatus calls repos.createCommitStatus", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.createStatus("sha1", "success", "All checks passed", "mizumi/review");
    expect(opts.octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "sha1", state: "success" }),
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

  it("getCIStatus returns pending when check run is in_progress", async () => {
    const opts = makeOpts();
    (opts.octokit.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] },
    });
    const client = new GitHubPlatformClient(opts);
    const status = await client.getCIStatus("sha1");
    expect(status).toBe("pending");
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

  it("deleteComment calls deleteReviewComment", async () => {
    const opts = makeOpts();
    const client = new GitHubPlatformClient(opts);
    await client.deleteComment(999);
    expect(opts.octokit.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 999 }),
    );
  });
});
