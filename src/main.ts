/**
 * Mizumi — Self-Learning PR Review Agent
 * Action entrypoint: parse event → rules → review → critique → post → memory
 *
 * Philosophy: Exit code 0 always. Build-breaking is opt-in.
 * Error messages belong in the PR, not the Actions log.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { loadConfig } from "./config.js";
import { fetchDiff } from "./diff.js";
import { buildLineMapFromRawDiff, buildPositionHint } from "./linemap.js";
import { buildContext } from "./context.js";
import { runReview } from "./review.js";
import { runCritique } from "./critique.js";
import { postReview } from "./post.js";
import { writeMemory } from "./memory.js";
import { runRules } from "./rules.js";

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

    // 2. Build line map from raw diff (diff0 pattern — most accurate)
    const lineMap = buildLineMapFromRawDiff(diff.rawDiff);

    // 3. Run deterministic rules (zero LLM cost, never hallucinates)
    const ruleFindings = runRules(diff.files);
    core.info(`Rules: ${ruleFindings.length} deterministic findings`);

    // 4. Build context (diff + memory + rules + PR metadata)
    const workspace = process.env.GITHUB_WORKSPACE || ".";
    const context = await buildContext(octokit, owner, repo, prNumber, diff, workspace);

    // 5. Build position hint for LLM
    const positionHint = buildPositionHint(diff.files);

    // 6. Run review (first pass — LLM)
    core.info("Running review pass...");
    const review = await runReview(
      context.diffText,
      positionHint,
      context.memoryContent,
      context.rulesContent,
      config
    );
    core.info(`First pass: ${review.comments.length} findings, decision=${review.decision}`);

    // 7. Self-critique (second pass — cheaper model)
    core.info("Running self-critique pass...");
    const filtered = await runCritique(review, config);
    core.info(`After critique: ${filtered.comments.length} findings (threshold=${config.confidenceThreshold})`);

    // 8. Merge deterministic rule findings into LLM findings
    // Rule findings are always posted — they're deterministic and high-confidence
    const mergedComments = [
      ...ruleFindings.map((r) => ({
        file: r.file,
        line: r.line,
        severity: r.severity as "critical" | "high" | "medium",
        category: r.category as "security" | "compliance",
        message: r.message,
        suggestion: undefined as string | undefined,
        confidence: 100, // Deterministic = always 100 confidence
      })),
      ...filtered.comments,
    ];

    const mergedReview = { ...filtered, comments: mergedComments };

    // 9. Post review
    const headSha = ctx.payload.pull_request?.head?.sha || ctx.sha;
    core.info("Posting review...");
    const result = await postReview(
      octokit, owner, repo, prNumber, headSha, mergedReview, diff.files, config
    );
    core.info(`Review posted: id=${result.reviewId}, findings=${result.findingCount}, risk=${result.riskScore}`);

    // 10. Update memory — learn from this review
    const memoryUpdate = filtered.comments
      .filter((c) => c.severity === "critical" || c.severity === "high")
      .map((c) => `- [${c.severity}] ${c.file}:${c.line} — ${c.category}: ${c.message}`)
      .join("\n");

    writeMemory(workspace, context.memoryContent, memoryUpdate);

    // Always exit 0 — never fail the build by default
    core.info("Mizumi review complete");
  } catch (error) {
    core.error(`Mizumi error: ${error instanceof Error ? error.message : String(error)}`);
    core.setOutput("finding_count", 0);
    core.setOutput("risk_score", 0);
  }
}

function getPrNumber(ctx: typeof github.context): number | null {
  if (ctx.payload.pull_request?.number) {
    return ctx.payload.pull_request.number;
  }

  if (ctx.payload.issue?.pull_request) {
    const comment = ctx.payload.comment?.body || "";
    if (comment.startsWith("/mizumi")) {
      return ctx.payload.issue.number;
    }
  }

  return null;
}

run();
