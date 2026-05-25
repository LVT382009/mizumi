/**
 * CI-validated fix loop — competitive gap P0-1.
 *
 * After applying a fix via suggestion blocks, polls CI checks on the fix commit.
 * If CI passes: done. If CI fails: revert and optionally retry.
 *
 * No other AI code reviewer (except Macroscope) validates fixes against CI.
 * This gives Mizumi a self-healing loop: fix → verify → revert-if-broken → retry.
 *
 * Reuses: improve.ts (git commit+push), gate.ts (commit status patterns).
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { generateFix } from "./improve.js";
import { MizumiConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CIFixConfig {
  enabled: boolean;
  timeoutSeconds: number;
  maxRetries: number;
  revertOnFailure: boolean;
  pollIntervalSeconds: number;
}

export type CIStatus = "passed" | "failed" | "timed_out" | "pending" | "no_checks";

export interface CIFixResult {
  success: boolean;
  fixCommitSha: string | null;
  retriesUsed: number;
  reverted: boolean;
  ciStatus: CIStatus;
  attempts: Array<{ sha: string; status: CIStatus }>;
}

// ---------------------------------------------------------------------------
// CI status polling
// ---------------------------------------------------------------------------

/**
 * Poll CI status for a commit SHA until checks complete or timeout.
 * Uses both commit statuses (repos.getCombinedStatusForRef) and
 * check runs (checks.listForRef) for comprehensive coverage.
 */
export async function pollCIStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number
): Promise<CIStatus> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const pollMs = Math.max(pollIntervalSeconds * 1000, 5000);

  while (Date.now() < deadline) {
    const status = await checkCIStatus(octokit, owner, repo, sha);

    if (status === "passed" || status === "failed" || status === "no_checks") {
      return status;
    }

    core.info(`CI status: ${status} — polling again in ${pollIntervalSeconds}s`);
    await sleep(pollMs);
  }

  return "timed_out";
}

/**
 * Check the current CI status for a commit SHA.
 * Returns "passed" if all checks succeed, "failed" if any fail,
 * "pending" if checks are still running, or "no_checks" if no checks exist.
 */
export async function checkCIStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string
): Promise<CIStatus> {
  let hasAnyChecks = false;
  let allPassed = true;
  let anyFailed = false;
  let anyPending = false;

  // Check commit statuses (older style: CI services post these)
  try {
    const { data: combined } = await octokit.rest.repos.getCombinedStatusForRef({
      owner, repo, ref: sha,
    });

    if (combined.total_count > 0) {
      hasAnyChecks = true;
    }

    for (const status of combined.statuses) {
      if (status.state === "success") continue;
      if (status.state === "pending" || status.state === "neutral") {
        anyPending = true;
        allPassed = false;
      } else {
        // failure, error
        anyFailed = true;
        allPassed = false;
      }
    }
  } catch (e) {
    core.debug(`Combined status query failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Check check runs (newer style: GitHub Actions, 3rd party check suites)
  try {
    const { data: checks } = await octokit.rest.checks.listForRef({
      owner, repo, ref: sha,
    });

    if (checks.total_count > 0) {
      hasAnyChecks = true;
    }

    for (const check of checks.check_runs) {
      if (check.status === "completed") {
        if (check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped") {
          continue;
        }
        if (check.conclusion === "failure" || check.conclusion === "cancelled" || check.conclusion === "timed_out") {
          anyFailed = true;
          allPassed = false;
        }
        // "action_required" or null — treat as not passed
        allPassed = false;
      } else {
        // queued, in_progress, waiting
        anyPending = true;
        allPassed = false;
      }
    }
  } catch (e) {
    core.debug(`Check runs query failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!hasAnyChecks) return "no_checks";
  if (anyFailed) return "failed";
  if (anyPending) return "pending";
  if (allPassed) return "passed";
  return "pending";
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

/**
 * Revert a commit by pointing the branch ref back to the parent SHA.
 * Uses git.updateRef — the same API used in improve.ts for advancing refs.
 */
export async function revertCommit(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchRef: string,
  parentSha: string
): Promise<void> {
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchRef}`,
    sha: parentSha,
    force: true,
  });
  core.info(`Reverted ${branchRef} to ${parentSha.slice(0, 7)}`);
}

// ---------------------------------------------------------------------------
// Fix loop
// ---------------------------------------------------------------------------

/**
 * Get the parent SHA of a commit (the first parent, for merge commits the mainline).
 */
async function getParentSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  commitSha: string
): Promise<string | null> {
  try {
    const { data: commit } = await octokit.rest.git.getCommit({
      owner, repo, commit_sha: commitSha,
    });
    return commit.parents[0]?.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the full CI-validated fix loop:
 * 1. Apply fix via improve.ts
 * 2. Poll CI status
 * 3. If failed: revert, optionally retry
 * 4. Return result
 */
export async function runCIFixLoop(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  ciConfig: CIFixConfig,
  mizumiConfig: MizumiConfig
): Promise<CIFixResult> {
  const result: CIFixResult = {
    success: false,
    fixCommitSha: null,
    retriesUsed: 0,
    reverted: false,
    ciStatus: "pending",
    attempts: [],
  };

  const maxAttempts = ciConfig.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    core.info(`CI fix loop: attempt ${attempt}/${maxAttempts}`);

    // Get PR head before fix (for potential revert)
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const branchRef = pr.head.ref;

    // 1. Apply fix
    if (attempt > 1) {
      core.info(`CI fix loop: re-applying fix (attempt ${attempt})`);
    }
    const fixResult = await generateFix(octokit, owner, repo, prNumber, mizumiConfig);

    if (fixResult.fixedCount === 0) {
      core.info("CI fix loop: no fixable suggestions found — aborting");
      result.ciStatus = "no_checks";
      return result;
    }

    result.fixCommitSha = fixResult.commitSha;

    if (!fixResult.commitSha) {
      core.info("CI fix loop: fix applied but no commit SHA — cannot validate CI");
      result.success = true;
      return result;
    }

    // 2. Poll CI status
    const ciStatus = await pollCIStatus(
      octokit, owner, repo, fixResult.commitSha,
      ciConfig.timeoutSeconds, ciConfig.pollIntervalSeconds
    );

    result.ciStatus = ciStatus;
    result.attempts.push({ sha: fixResult.commitSha, status: ciStatus });

    if (ciStatus === "passed" || ciStatus === "no_checks") {
      // Success — fix validated (or no CI to validate against)
      result.success = true;
      core.info(`CI fix loop: fix validated (status=${ciStatus})`);
      return result;
    }

    // CI failed or timed out
    core.info(`CI fix loop: attempt ${attempt} result=${ciStatus}`);

    if (ciConfig.revertOnFailure) {
      try {
        const parentSha = await getParentSha(octokit, owner, repo, fixResult.commitSha);
        if (parentSha) {
          await revertCommit(octokit, owner, repo, branchRef, parentSha);
          result.reverted = true;

          await octokit.rest.issues.createComment({
            owner, repo, issue_number: prNumber,
            body: `CI fix attempt ${attempt} ${ciStatus}. Reverted commit ${fixResult.commitSha.slice(0, 7)} back to ${parentSha.slice(0, 7)}.` + (attempt < maxAttempts ? " Retrying..." : ""),
          });
        }
      } catch (e) {
        core.warning(`Revert failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    result.retriesUsed = attempt;

    // If no more retries, break
    if (attempt >= maxAttempts) break;

    // Wait a bit before retry to let any transient CI issues settle
    await sleep(5000);
  }

  // All attempts exhausted
  if (ciConfig.revertOnFailure && result.reverted) {
    try {
      // Post final comment
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber,
        body: `CI fix loop exhausted ${result.retriesUsed} attempt(s). Last CI status: ${result.ciStatus}. All reverted — branch is back to original state.`,
      });
    } catch {
      // Non-critical
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
