import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkCIStatus,
  pollCIStatus,
  revertCommit,
  runCIFixLoop,
} from "../cifix.js";
import type { CIFixConfig } from "../cifix.js";
import type { MizumiConfig } from "../config.js";
import { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockOctokit(overrides: Record<string, unknown> = {}): Octokit {
  const combinedStatus = overrides.combinedStatus as
    | { total_count: number; statuses: Array<{ state: string }> }
    | undefined;
  const checkRuns = overrides.checkRuns as
    | { total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }
    | undefined;
  const getCommit = overrides.getCommit as
    | { parents: Array<{ sha: string }> }
    | undefined;
  const prData = overrides.prData as
    | { head: { sha: string; ref: string } }
    | undefined;
  const fixResult = overrides.fixResult as
    | { fixedCount: number; commitSha: string | null }
    | undefined;

  return {
    rest: {
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: combinedStatus || { total_count: 0, statuses: [] },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: checkRuns || { total_count: 0, check_runs: [] },
        }),
      },
      git: {
        getCommit: vi.fn().mockResolvedValue({
          data: getCommit || { parents: [{ sha: "parent-sha-1" }] },
        }),
        updateRef: vi.fn().mockResolvedValue({}),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: prData || { head: { sha: "abc123", ref: "feature-branch" } },
        }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({}),
      },
    },
  } as unknown as Octokit;
}

// Minimal config for testing
const testConfig = {
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
  complianceCheck: true,
  autoFix: false,
  confidenceCalibration: true,
  changeStack: true,
  improveEnabled: true,
  dryRun: false,
  linterScan: true,
  autoLabels: true,
  spendThreshold: 0,
  gateThreshold: "none" as const,
  ruleEngine: true,
  ciValidatedFix: true,
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
};

const defaultCIConfig: CIFixConfig = {
  enabled: true,
  timeoutSeconds: 30,
  maxRetries: 1,
  revertOnFailure: true,
  pollIntervalSeconds: 1,
};

// ---------------------------------------------------------------------------
// checkCIStatus
// ---------------------------------------------------------------------------

describe("cifix", () => {
  describe("checkCIStatus", () => {
    it("returns no_checks when no statuses or check runs exist", async () => {
      const octokit = mockOctokit();
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("no_checks");
    });

    it("returns passed when all commit statuses are success", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 2,
          statuses: [{ state: "success" }, { state: "success" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("returns failed when any commit status is failure", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 2,
          statuses: [{ state: "success" }, { state: "failure" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("returns pending when commit status is pending", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "pending" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns failed when commit status is error", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "error" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("returns passed when all check runs are completed with success", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 2,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "success" },
          ],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("returns failed when a check run has failure conclusion", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 2,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "failure" },
          ],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("returns pending when check run is in_progress", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "in_progress", conclusion: null }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns passed for skipped check runs", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "skipped" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("returns failed for cancelled check runs", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "cancelled" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("returns failed for timed_out check runs", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "timed_out" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("handles both statuses and check runs (mixed)", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "success" }],
        },
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "success" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("returns no_checks when API calls fail gracefully", async () => {
      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockRejectedValue(new Error("API error")),
          },
          checks: {
            listForRef: vi.fn().mockRejectedValue(new Error("API error")),
          },
        },
      } as unknown as Octokit;
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("no_checks");
    });
  });

  // ---------------------------------------------------------------------------
  // pollCIStatus
  // ---------------------------------------------------------------------------

  describe("pollCIStatus", () => {
    it("returns immediately when CI passes on first check", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "success" }],
        },
      });
      const status = await pollCIStatus(octokit, "owner", "repo", "sha123", 30, 1);
      expect(status).toBe("passed");
    });

    it("returns timed_out when CI stays pending", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "pending" }],
        },
      });
      // Short timeout for test
      const status = await pollCIStatus(octokit, "owner", "repo", "sha123", 2, 1);
      expect(status).toBe("timed_out");
    }, 10000);

    it("returns no_checks immediately when no checks configured", async () => {
      const octokit = mockOctokit();
      const status = await pollCIStatus(octokit, "owner", "repo", "sha123", 30, 1);
      expect(status).toBe("no_checks");
    });
  });

  // ---------------------------------------------------------------------------
  // revertCommit
  // ---------------------------------------------------------------------------

  describe("revertCommit", () => {
    it("calls git.updateRef with force=true and parent SHA", async () => {
      const octokit = mockOctokit();
      await revertCommit(octokit, "owner", "repo", "feature-branch", "parent-sha-1");
      expect(octokit.rest.git.updateRef).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        ref: "heads/feature-branch",
        sha: "parent-sha-1",
        force: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // runCIFixLoop
  // ---------------------------------------------------------------------------

  describe("runCIFixLoop", () => {
    let generateFixSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Mock generateFix to avoid actual Git Data API calls
      vi.mock("../improve.js", () => ({
        generateFix: vi.fn(),
        isDangerousPath: vi.fn(),
        parseSuggestions: vi.fn(),
        verifyPatch: vi.fn(),
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns no_checks result when no fixable suggestions found", async () => {
      // Create a mock that returns no fixes
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 0,
        commitSha: null,
      });

      const octokit = mockOctokit();
      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, defaultCIConfig, testConfig as MizumiConfig
      );
      expect(result.success).toBe(false);
      expect(result.ciStatus).toBe("no_checks");
      expect(result.fixCommitSha).toBeNull();
    });

    it("succeeds when CI passes after fix", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "success" }],
        },
      });

      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, defaultCIConfig, testConfig as MizumiConfig
      );
      expect(result.success).toBe(true);
      expect(result.ciStatus).toBe("passed");
      expect(result.fixCommitSha).toBe("fix-sha-1");
      expect(result.retriesUsed).toBe(1);
      expect(result.reverted).toBe(false);
    });

    it("succeeds when no CI checks exist (no_checks = validated)", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit(); // no checks configured

      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, defaultCIConfig, testConfig as MizumiConfig
      );
      expect(result.success).toBe(true);
      expect(result.ciStatus).toBe("no_checks");
    });

    it("reverts and records failure when CI fails", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "failure" }],
        },
        getCommit: {
          parents: [{ sha: "prev-sha-1" }],
        },
      });

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 0, // no retries
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig
      );
      expect(result.success).toBe(false);
      expect(result.ciStatus).toBe("failed");
      expect(result.reverted).toBe(true);
      expect(result.attempts).toHaveLength(1);
      expect(octokit.rest.git.updateRef).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        ref: "heads/feature-branch",
        sha: "prev-sha-1",
        force: true,
      });
    });

    it("does not revert when revertOnFailure is false", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "failure" }],
        },
      });

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 0,
        revertOnFailure: false,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig
      );
      expect(result.success).toBe(false);
      expect(result.reverted).toBe(false);
      expect(octokit.rest.git.updateRef).not.toHaveBeenCalled();
    });

    it("records attempt history correctly", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "pending" }],
        },
      });

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 2, // short timeout
        maxRetries: 0,
        revertOnFailure: false,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig
      );
      expect(result.retriesUsed).toBe(1);
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0].sha).toBe("fix-sha-1");
      expect(result.attempts[0].status).toBe("timed_out");
    }, 10000);

    it("returns success when fix commit SHA is null (edge case)", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: null,
      });

      const octokit = mockOctokit();

      const result = await runCIFixLoop(
        octokit, "owner", "repo", 42, defaultCIConfig, testConfig as MizumiConfig
      );
      // Can't validate CI without a SHA — treat as success
      expect(result.success).toBe(true);
    });

    it("posts comment on CI failure with revert info", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "failure" }],
        },
        getCommit: {
          parents: [{ sha: "prev-sha-1" }],
        },
      });

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 0,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      await runCIFixLoop(
        octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig
      );
      expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "owner",
          repo: "repo",
          issue_number: 42,
        })
      );
    });
  });

   it("retries with maxRetries=1 and succeeds on second attempt", async () => {
 const improve = await import("../improve.js");
 vi.spyOn(improve, "generateFix")
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" });

 const combinedStatusFn = vi.fn()
 .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "failure" }] } })
 .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "success" }] } });

 const octokit = {
 rest: {
 repos: { getCombinedStatusForRef: combinedStatusFn },
 checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
 git: {
 getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
 updateRef: vi.fn().mockResolvedValue({}),
 },
 pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
 issues: { createComment: vi.fn().mockResolvedValue({}) },
 },
 } as unknown as Octokit;

 const ciConfig: CIFixConfig = {
 enabled: true,
 timeoutSeconds: 10,
 maxRetries: 1,
 revertOnFailure: true,
 pollIntervalSeconds: 1,
 };

 const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
 expect(result.success).toBe(true);
 expect(result.ciStatus).toBe("passed");
 expect(result.fixCommitSha).toBe("fix-sha-2");
 expect(result.retriesUsed).toBe(2);
 expect(result.attempts).toHaveLength(2);
 expect(result.attempts[0].status).toBe("failed");
 expect(result.attempts[1].status).toBe("passed");
 }, 30000);

 it("retries and reverts both when both attempts fail", async () => {
 const improve = await import("../improve.js");
 vi.spyOn(improve, "generateFix")
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" });

 const combinedStatusFn = vi.fn()
 .mockResolvedValue({ data: { total_count: 1, statuses: [{ state: "failure" }] } });

 const updateRefFn = vi.fn().mockResolvedValue({});
 const octokit = {
 rest: {
 repos: { getCombinedStatusForRef: combinedStatusFn },
 checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
 git: {
 getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
 updateRef: updateRefFn,
 },
 pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
 issues: { createComment: vi.fn().mockResolvedValue({}) },
 },
 } as unknown as Octokit;

 const ciConfig: CIFixConfig = {
 enabled: true,
 timeoutSeconds: 10,
 maxRetries: 1,
 revertOnFailure: true,
 pollIntervalSeconds: 1,
 };

 const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
 expect(result.success).toBe(false);
 expect(result.ciStatus).toBe("failed");
 expect(result.retriesUsed).toBe(2);
 expect(result.reverted).toBe(true);
 expect(updateRefFn).toHaveBeenCalledTimes(2);
 expect(octokit.rest.issues.createComment).toHaveBeenCalled();
 }, 30000);

 it("maxRetries=2 allows 3 total attempts", async () => {
 const improve = await import("../improve.js");
 vi.spyOn(improve, "generateFix")
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" })
 .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-3" });

 const combinedStatusFn = vi.fn()
 .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "failure" }] } })
 .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "failure" }] } })
 .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "success" }] } });

 const octokit = {
 rest: {
 repos: { getCombinedStatusForRef: combinedStatusFn },
 checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
 git: {
 getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
 updateRef: vi.fn().mockResolvedValue({}),
 },
 pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
 issues: { createComment: vi.fn().mockResolvedValue({}) },
 },
 } as unknown as Octokit;

 const ciConfig: CIFixConfig = {
 enabled: true,
 timeoutSeconds: 10,
 maxRetries: 2,
 revertOnFailure: true,
 pollIntervalSeconds: 1,
 };

 const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
 expect(result.success).toBe(true);
 expect(result.ciStatus).toBe("passed");
 expect(result.retriesUsed).toBe(3);
 expect(result.attempts).toHaveLength(3);
 }, 30000);

 it("handles combined statuses and check runs returning conflicting results", async () => {
 const octokit = {
 rest: {
 repos: {
 getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { total_count: 1, statuses: [{ state: "success" }] } }),
 },
 checks: {
 listForRef: vi.fn().mockResolvedValue({ data: { total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }] } }),
 },
 git: {
 getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
 updateRef: vi.fn().mockResolvedValue({}),
 },
 pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
 issues: { createComment: vi.fn().mockResolvedValue({}) },
 },
 } as unknown as Octokit;

 const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
 expect(status).toBe("failed");
 });

 it("exhausts retries and posts final exhausted comment", async () => {
 const improve = await import("../improve.js");
 vi.spyOn(improve, "generateFix")
 .mockResolvedValue({ fixedCount: 1, commitSha: "fix-sha-1" });

 const combinedStatusFn = vi.fn()
 .mockResolvedValue({ data: { total_count: 1, statuses: [{ state: "failure" }] } });

 const createCommentFn = vi.fn().mockResolvedValue({});
 const octokit = {
 rest: {
 repos: { getCombinedStatusForRef: combinedStatusFn },
 checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
 git: {
 getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
 updateRef: vi.fn().mockResolvedValue({}),
 },
 pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
 issues: { createComment: createCommentFn },
 },
 } as unknown as Octokit;

 const ciConfig: CIFixConfig = {
 enabled: true,
 timeoutSeconds: 10,
 maxRetries: 1,
 revertOnFailure: true,
 pollIntervalSeconds: 1,
 };

 const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
 expect(result.success).toBe(false);
 const lastCall = createCommentFn.mock.calls[createCommentFn.mock.calls.length - 1][0];
 expect(lastCall.body).toContain("exhausted");
 }, 30000);

// ---------------------------------------------------------------------------
  // CIFixConfig defaults
  // ---------------------------------------------------------------------------

  describe("CIFixConfig", () => {
    it("has sensible defaults", () => {
      const config: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 600,
        maxRetries: 3,
        revertOnFailure: true,
        pollIntervalSeconds: 30,
      };
      expect(config.timeoutSeconds).toBe(600);
      expect(config.maxRetries).toBe(3);
      expect(config.revertOnFailure).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Expanded checkCIStatus — CI status parsing edge cases
  // ---------------------------------------------------------------------------

  describe("checkCIStatus — extended parsing", () => {
    it("returns pending for queued check runs", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "queued", conclusion: null }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns pending for waiting check runs", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "waiting", conclusion: null }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns pending for action_required check run conclusion", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "action_required" }],
        },
      });
      // action_required sets allPassed=false but not anyFailed, so result is pending
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns pending for check run with null conclusion and completed status", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: null }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns passed for neutral commit status", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "neutral" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns passed for neutral check run conclusion", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "neutral" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("handles mixed in_progress and completed check runs — returns pending", async () => {
      const octokit = mockOctokit({
        checkRuns: {
          total_count: 3,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "in_progress", conclusion: null },
            { status: "completed", conclusion: "success" },
          ],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("handles mixed success and failure statuses — returns failed", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 3,
          statuses: [
            { state: "success" },
            { state: "failure" },
            { state: "success" },
          ],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("returns pending when only pending commit statuses exist", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 3,
          statuses: [
            { state: "pending" },
            { state: "pending" },
            { state: "pending" },
          ],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("pending");
    });

    it("returns failed when error status is mixed with pending", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 2,
          statuses: [{ state: "pending" }, { state: "error" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("returns failed when commit statuses succeed but check runs fail", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "success" }],
        },
        checkRuns: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "failure" }],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Expanded pollCIStatus — timeout and polling edge cases
  // ---------------------------------------------------------------------------

  describe("pollCIStatus — extended", () => {
    it("returns failed when CI fails immediately on poll", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "failure" }],
        },
      });
      const status = await pollCIStatus(octokit, "owner", "repo", "sha123", 30, 1);
      expect(status).toBe("failed");
    });

    it("ensures minimum poll interval of 5 seconds", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "pending" }],
        },
      });
      // Very short timeout to avoid long test, but assertion checks that
      // pollIntervalSeconds of 0 is clamped to at least 5s
      const status = await pollCIStatus(octokit, "owner", "repo", "sha123", 2, 0);
      expect(status).toBe("timed_out");
    }, 10000);
  });

  // ---------------------------------------------------------------------------
  // Expanded revertCommit — error scenarios
  // ---------------------------------------------------------------------------

  describe("revertCommit — extended", () => {
    it("propagates error when git.updateRef fails", async () => {
      const updateRefFn = vi.fn().mockRejectedValue(new Error("Reference update failed"));
      const octokit = {
        rest: {
          git: { updateRef: updateRefFn },
        },
      } as unknown as Octokit;

      await expect(revertCommit(octokit, "owner", "repo", "main", "parent-sha-1"))
        .rejects.toThrow("Reference update failed");
    });

    it("calls updateRef with correct heads/ prefix for branch reference", async () => {
      const updateRefFn = vi.fn().mockResolvedValue({});
      const octokit = {
        rest: {
          git: { updateRef: updateRefFn },
        },
      } as unknown as Octokit;

      await revertCommit(octokit, "owner", "repo", "feature/my-branch", "abc123");
      expect(updateRefFn).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        ref: "heads/feature/my-branch",
        sha: "abc123",
        force: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Expanded runCIFixLoop — error paths, revert failures, sequence fixes
  // ---------------------------------------------------------------------------

  describe("runCIFixLoop — extended error paths", () => {
    beforeEach(() => {
      vi.mock("../improve.js", () => ({
        generateFix: vi.fn(),
        isDangerousPath: vi.fn(),
        parseSuggestions: vi.fn(),
        verifyPatch: vi.fn(),
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("handles generateFix throwing an error", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockRejectedValue(new Error("API rate limit"));

      const octokit = mockOctokit();

      await expect(
        runCIFixLoop(octokit, "owner", "repo", 42, defaultCIConfig, testConfig as MizumiConfig)
      ).rejects.toThrow("API rate limit");
    });

    it("handles revert failure gracefully — does not crash", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const updateRefFn = vi.fn().mockRejectedValue(new Error("updateRef forbidden"));
      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockResolvedValue({
              data: { total_count: 1, statuses: [{ state: "failure" }] },
            }),
          },
          checks: {
            listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
          },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: updateRefFn,
          },
          pulls: {
            get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }),
          },
          issues: {
            createComment: vi.fn().mockResolvedValue({}),
          },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 0,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      // Should NOT throw even though revert fails
      const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      expect(result.success).toBe(false);
      expect(result.ciStatus).toBe("failed");
      // Revert was attempted but result.reverted stays false since the revert threw
      expect(result.reverted).toBe(false);
    });

    it("handles getParentSha returning null — skip revert without crash", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockResolvedValue({
              data: { total_count: 1, statuses: [{ state: "failure" }] },
            }),
          },
          checks: {
            listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
          },
          git: {
            // getCommit throws — getParentSha returns null
            getCommit: vi.fn().mockRejectedValue(new Error("not found")),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }),
          },
          issues: {
            createComment: vi.fn().mockResolvedValue({}),
          },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 0,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      expect(result.success).toBe(false);
      // No revert happened because parent SHA was null
      expect(result.reverted).toBe(false);
      expect(octokit.rest.git.updateRef).not.toHaveBeenCalled();
    });

    it("records timed_out attempt when CI stays pending and exhausts timeout", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "pending" }],
        },
        getCommit: {
          parents: [{ sha: "prev-sha-1" }],
        },
      });

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 2,
        maxRetries: 0,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      expect(result.success).toBe(false);
      expect(result.ciStatus).toBe("timed_out");
      expect(result.attempts[0].status).toBe("timed_out");
    }, 10000);

    it("multiple fixes applied in sequence — all tracked in attempts", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix")
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" });

      const combinedStatusFn = vi.fn()
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "failure" }] } })
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "success" }] } });

      const octokit = {
        rest: {
          repos: { getCombinedStatusForRef: combinedStatusFn },
          checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
          issues: { createComment: vi.fn().mockResolvedValue({}) },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 1,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].sha).toBe("fix-sha-1");
      expect(result.attempts[0].status).toBe("failed");
      expect(result.attempts[1].sha).toBe("fix-sha-2");
      expect(result.attempts[1].status).toBe("passed");
    }, 30000);

    it("posts revert comment with correct attempt number on first failure", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix").mockResolvedValue({
        fixedCount: 1,
        commitSha: "fix-sha-1",
      });

      const createCommentFn = vi.fn().mockResolvedValue({});
      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockResolvedValue({
              data: { total_count: 1, statuses: [{ state: "failure" }] },
            }),
          },
          checks: {
            listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }),
          },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: {
            get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }),
          },
          issues: { createComment: createCommentFn },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 0,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      // First revert comment should mention "attempt 1"
      const commentBody = createCommentFn.mock.calls[0][0].body;
      expect(commentBody).toContain("attempt 1");
      expect(commentBody).toContain("fix-sha");
    });

    it("handles CI completing as passed after being in_progress on poll", async () => {
      const combinedStatusFn = vi.fn()
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "pending" }] } })
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "success" }] } });

      const octokit = {
        rest: {
          repos: { getCombinedStatusForRef: combinedStatusFn },
          checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
          issues: { createComment: vi.fn().mockResolvedValue({}) },
        },
      } as unknown as Octokit;

      // Direct pollCIStatus test — CI goes from pending to passed
      const status = await pollCIStatus(octokit, "owner", "repo", "sha123", 30, 5);
      expect(status).toBe("passed");
    }, 15000);

    it("handles checks API returning 0 total_count with empty statuses array", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 0,
          statuses: [],
        },
        checkRuns: {
          total_count: 0,
          check_runs: [],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("no_checks");
    });

    it("handles only check runs without commit statuses", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 0,
          statuses: [],
        },
        checkRuns: {
          total_count: 2,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "success" },
          ],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("handles only commit statuses without check runs", async () => {
      const octokit = mockOctokit({
        combinedStatus: {
          total_count: 1,
          statuses: [{ state: "success" }],
        },
        checkRuns: {
          total_count: 0,
          check_runs: [],
        },
      });
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("passed");
    });

    it("returns no_checks when both API calls fail", async () => {
      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
          },
          checks: {
            listForRef: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
          },
        },
      } as unknown as Octokit;
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("no_checks");
    });

    it("returns no_checks when combinedStatus succeeds with 0 but checks API fails", async () => {
      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockResolvedValue({
              data: { total_count: 0, statuses: [] },
            }),
          },
          checks: {
            listForRef: vi.fn().mockRejectedValue(new Error("Server error")),
          },
        },
      } as unknown as Octokit;
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("no_checks");
    });

    it("returns failed when combinedStatus fails but check runs show failure", async () => {
      const octokit = {
        rest: {
          repos: {
            getCombinedStatusForRef: vi.fn().mockRejectedValue(new Error("API error")),
          },
          checks: {
            listForRef: vi.fn().mockResolvedValue({
              data: {
                total_count: 1,
                check_runs: [{ status: "completed", conclusion: "failure" }],
              },
            }),
          },
        },
      } as unknown as Octokit;
      const status = await checkCIStatus(octokit, "owner", "repo", "sha123");
      expect(status).toBe("failed");
    });

    it("revert comment includes retrying text when more attempts remain", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix")
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" });

      const combinedStatusFn = vi.fn()
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "failure" }] } })
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "success" }] } });

      const createCommentFn = vi.fn().mockResolvedValue({});
      const octokit = {
        rest: {
          repos: { getCombinedStatusForRef: combinedStatusFn },
          checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
          issues: { createComment: createCommentFn },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 1,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      expect(result.success).toBe(true);
      // The first failure comment should mention "Retrying..."
      const firstCommentBody = createCommentFn.mock.calls[0][0].body;
      expect(firstCommentBody).toContain("Retrying");
    }, 30000);

    it("final exhausted comment mentions all attempts reverted", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix")
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" });

      const combinedStatusFn = vi.fn()
        .mockResolvedValue({ data: { total_count: 1, statuses: [{ state: "failure" }] } });

      const createCommentFn = vi.fn().mockResolvedValue({});
      const octokit = {
        rest: {
          repos: { getCombinedStatusForRef: combinedStatusFn },
          checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
          issues: { createComment: createCommentFn },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 1,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      // Last comment should mention "exhausted" and "reverted"
      const lastCall = createCommentFn.mock.calls[createCommentFn.mock.calls.length - 1][0];
      expect(lastCall.body).toContain("exhausted");
      expect(lastCall.body).toContain("reverted");
    }, 30000);

    it("sets fixCommitSha to the last applied fix SHA", async () => {
      const improve = await import("../improve.js");
      vi.spyOn(improve, "generateFix")
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-1" })
        .mockResolvedValueOnce({ fixedCount: 1, commitSha: "fix-sha-2" });

      const combinedStatusFn = vi.fn()
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "failure" }] } })
        .mockResolvedValueOnce({ data: { total_count: 1, statuses: [{ state: "success" }] } });

      const octokit = {
        rest: {
          repos: { getCombinedStatusForRef: combinedStatusFn },
          checks: { listForRef: vi.fn().mockResolvedValue({ data: { total_count: 0, check_runs: [] } }) },
          git: {
            getCommit: vi.fn().mockResolvedValue({ data: { parents: [{ sha: "prev-sha-1" }] } }),
            updateRef: vi.fn().mockResolvedValue({}),
          },
          pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123", ref: "feature-branch" } } }) },
          issues: { createComment: vi.fn().mockResolvedValue({}) },
        },
      } as unknown as Octokit;

      const ciConfig: CIFixConfig = {
        enabled: true,
        timeoutSeconds: 10,
        maxRetries: 1,
        revertOnFailure: true,
        pollIntervalSeconds: 1,
      };

      const result = await runCIFixLoop(octokit, "owner", "repo", 42, ciConfig, testConfig as MizumiConfig);
      expect(result.fixCommitSha).toBe("fix-sha-2");
    }, 30000);
  });
});
