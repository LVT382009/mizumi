/**
 * Mizumi — Self-Learning PR Review Agent
 * Action entrypoint: parse event → review → post
 *
 * Philosophy: Exit code 0 always. Build-breaking is opt-in.
 * Error messages belong in the PR, not the Actions log.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { loadConfig } from "./config.js";
import { fetchDiff, buildPositionMap } from "./diff.js";
import { buildPositionHint } from "./linemap.js";
import { buildContext } from "./context.js";
import { runReview } from "./review.js";
import { runCritique } from "./critique.js";
import { postReview } from "./post.js";
import { writeMemory } from "./memory.js";
import { buildReviewBody } from "./post.js";

const RetryingOctokit = Octokit.plugin(retry);

async function run(): Promise<void> {
  try {
    const config = loadConfig();
    const ctx = github.context;
    const token = process.env.GITHUB_TOKEN || core.getInput("github_token");

    if (!token) {
      core.setFailed("GITHUB_TOKEN is required");
      return;
    }

    const octokit = new RetryingOctokit({ auth: token });

    // Determine PR number from event
    const prNumber = getPrNumber(ctx);
    if (!prNumber) {
      core.info("No PR number found — skipping review");
      return;
    }

    const owner = ctx.repo.owner;
    const repo = ctx.repo.repo;

    core.info(`Mizumi reviewing ${owner}/${repo}#${prNumber} with ${config.provider}/${config.model}`);

    // 1. Fetch and parse diff
    const diff = await fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
    core.info(`Diff: ${diff.files.length} files, +${diff.totalAdditions}/-${diff.totalDeletions}`);

    if (diff.files.length === 0) {
      core.info("No changed files after exclusions — skipping review");
      return;
    }

    // 2. Build context (diff + memory + rules)
    const workspace = process.env.GITHUB_WORKSPACE || ".";
    const context = await buildContext(octokit, owner, repo, prNumber, diff, workspace);

    // 3. Build position hint for LLM
    const positionHint = buildPositionHint(diff.files);

    // 4. Run review (first pass)
    core.info("Running review pass...");
    const review = await runReview(
      context.diffText,
      positionHint,
      context.memoryContent,
      context.rulesContent,
      config
    );
    core.info(`First pass: ${review.comments.length} findings, decision=${review.decision}`);

    // 5. Self-critique (second pass)
    core.info("Running self-critique pass...");
    const filtered = await runCritique(review, config);
    core.info(`After critique: ${filtered.comments.length} findings (threshold=${config.confidenceThreshold})`);

    // 6. Post review
    const headSha = ctx.payload.pull_request?.head?.sha || ctx.sha;
    core.info("Posting review...");
    const result = await postReview(octokit, owner, repo, prNumber, headSha, filtered, diff.files, config);
    core.info(`Review posted: id=${result.reviewId}, findings=${result.findingCount}, risk=${result.riskScore}`);

    // 7. Update memory with learning from this review
    const memoryUpdate = filtered.comments
      .filter((c) => c.severity === "critical" || c.severity === "high")
      .map((c) => `- [${c.severity}] ${c.file}:${c.line} — ${c.category}: ${c.message}`)
      .join("\n");

    writeMemory(workspace, context.memoryContent, memoryUpdate);

    // 8. Always exit 0 — never fail the build
    core.info("Mizumi review complete");
  } catch (error) {
    // Philosophy: error messages belong in the PR, not the Actions log
    // But if we can't even post to the PR, at least log it
    core.error(`Mizumi error: ${error instanceof Error ? error.message : String(error)}`);
    // Still exit 0 — never fail the build by default
    core.setOutput("finding_count", 0);
    core.setOutput("risk_score", 0);
  }
}

function getPrNumber(ctx: typeof github.context): number | null {
  // From pull_request event
  if (ctx.payload.pull_request?.number) {
    return ctx.payload.pull_request.number;
  }

  // From issue_comment event (/mizumi command)
  if (ctx.payload.issue?.pull_request?.number) {
    const comment = ctx.payload.comment?.body || "";
    if (comment.startsWith("/mizumi")) {
      return ctx.payload.issue.number;
    }
  }

  // From workflow_run or other events — try to extract from context
  return null;
}

run();
