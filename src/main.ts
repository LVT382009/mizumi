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
import { classifyDiff, guardContextWindow } from "./router.js";
import { buildLineMapFromRawDiff, buildPositionHint } from "./linemap.js";
import { buildContext } from "./context.js";
import { runReview } from "./review.js";
import { runCritique } from "./critique.js";
import { postReview } from "./post.js";
import { writeMemory } from "./memory.js";
import { runRules } from "./rules.js";
import { classifyPR } from "./classifier.js";
import { detectSlop } from "./slop.js";

const MARKER = "<!-- mizumi-review-marker -->";
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
    const isManualTrigger = ctx.eventName === "issue_comment";

    core.info(`Mizumi reviewing ${owner}/${repo}#${prNumber} with ${config.provider}/${config.model}`);

    // Respect auto_review: false — only run on manual /mizumi trigger
    if (!config.autoReview && !isManualTrigger) {
      core.info("auto_review is false — skipping. Use /mizumi to trigger.");
      return;
    }

    // Auto-pause check: skip review if too many reviews already on this PR
    if (!isManualTrigger && config.autoPauseAfter > 0) {
      const reviewCount = await countMizumiReviews(octokit, owner, repo, prNumber);
      if (reviewCount >= config.autoPauseAfter) {
        core.info(`Auto-paused: ${reviewCount} reviews already posted (limit=${config.autoPauseAfter}). Use /mizumi to resume.`);
        return;
      }
    }

    // 1. Fetch and parse diff
    const diff = await fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
    core.info(`Diff: ${diff.files.length} files, +${diff.totalAdditions}/-${diff.totalDeletions}`);

    if (diff.files.length === 0) {
      core.info("No changed files after exclusions — skipping review");
      return;
    }

    // 2. Classify PR type (heuristic — zero LLM cost)
  const prClassification = classifyPR(
    diff.files.map((f) => ({ from: f.path, additions: f.additions, deletions: f.deletions })),
    diff.totalAdditions,
    diff.totalDeletions
  );
  core.info(`PR classification: ${prClassification.category} (${prClassification.reason})`);

  // 2b. Classify diff tier for model routing (light/standard/thorough)
  const classification = classifyDiff(
    diff.totalAdditions + diff.totalDeletions,
    diff.files.length,
    diff.files.map((f) => f.path),
    config
  );
  core.info(`Classification: ${classification.tier} (${classification.reason})`);

// 2c. Slop detection — skip deep review for low-quality AI-generated PRs
const slopResult = detectSlop(
  diff.rawDiff, diff.totalAdditions, diff.totalDeletions,
  diff.files.length, diff.files.map((f) => f.path),
);
if (slopResult.isSlop) {
  core.info(`Slop detected: score=${slopResult.score}, reasons: ${slopResult.reasons.join(", ")}`);
}

  // 3. Build line map from raw diff (validates which lines can receive comments)
    const lineMap = buildLineMapFromRawDiff(diff.rawDiff);

    // 4. Run deterministic rules (zero LLM cost, never hallucinates)
    const ruleFindings = runRules(diff.files);
    core.info(`Rules: ${ruleFindings.length} deterministic findings`);

    // 5. Build context (diff + memory + rules + PR metadata + classification)
    const workspace = process.env.GITHUB_WORKSPACE || ".";
    const context = await buildContext(octokit, owner, repo, prNumber, diff, workspace, prClassification);

    // 6. Build position hint for LLM
    const positionHint = buildPositionHint(diff.files);

  // 6b. Guard context window — truncate diff if it exceeds model’s limit
  const guarded = guardContextWindow(context.diffText, config.provider);
  if (guarded.truncated) {
    core.warning(`Diff truncated: ${guarded.estimatedTokens} tokens (exceeds context limit for ${config.provider})`);
  }
  context.diffText = guarded.text;

if (slopResult.isSlop) {
  context.diffText += `

## Slop Detection
This PR appears to contain low-quality AI-generated code (score: ${slopResult.score}/100). Reasons: ${slopResult.reasons.join("; ")}. Focus review on structural issues rather than line-by-line quality.`;
}

    // 7. Run review (first pass — LLM)
    core.info("Running review pass...");
    const review = await runReview(
      context.diffText,
      positionHint,
      context.memoryContent,
      context.rulesContent,
      context.ghostContent,
      config,
      classification
    );
    core.info(`First pass: ${review.comments.length} findings, decision=${review.decision}`);

    // 8. Self-critique (second pass — cheaper model)
    core.info("Running self-critique pass...");
    const filtered = await runCritique(review, config);
    core.info(`After critique: ${filtered.comments.length} findings (threshold=${config.confidenceThreshold})`);

    // 9. Merge deterministic rule findings into LLM findings
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

    // 10. Post review
    const headSha = ctx.payload.pull_request?.head?.sha || ctx.sha;
    core.info("Posting review...");
    const result = await postReview(
      octokit, owner, repo, prNumber, headSha, mergedReview, lineMap, config
    );
    core.info(`Review posted: id=${result.reviewId}, findings=${result.findingCount}, risk=${result.riskScore}`);

    // 11. Update memory — learn from this review
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

async function countMizumiReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number> {
  let count = 0;
  let page = 1;

  while (true) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    });

    count += comments.filter((c) => c.body?.includes(MARKER)).length;

    if (comments.length < 100) break;
    page++;
  }

  // Also count PR reviews that contain mizumi marker
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
  });

  count += reviews.filter((r) => r.body?.includes(MARKER)).length;

  return count;
}

run();
