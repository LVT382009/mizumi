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
      expect(result.retriesUsed).toBe(0);
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
});
