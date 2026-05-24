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
import { postReview, cleanupOutdatedComments } from "./post.js";
import { writeMemory, readMemory, autoGenerateSkills, loadSkills } from "./memory.js";
import { runRules } from "./rules.js";
import { classifyPR } from "./classifier.js";
import { createSpendEntry, appendSpendEntry, readSpendLog, formatSpendDigest } from "./spend.js";
import { computeLearningWeights, applyLearningWeights, recordSuggestion } from "./db.js";
import { recordFindings } from "./feedback.js";
import { generateDescription, parseCommand } from "./describe.js";
import { detectSlop } from "./slop.js";
import { generateFix } from "./improve.js";
import { generateTests } from "./testgen.js";
import { checkAndMarkDelivery, checkAndMarkSha } from "./idempotency.js";
import { runAgentContextGathering } from "./agent.js";
import { calibrateConfidence } from "./calibrate.js";
import { checkCompliance, formatCompliance } from "./compliance.js";
import { processReactionApprovals } from "./autofix.js";
import { persistLearningData } from "./persist.js";

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

  // 0. Workspace + idempotency checks
  const workspace = process.env.GITHUB_WORKSPACE || ".";
  const headSha = ctx.payload.pull_request?.head?.sha || ctx.sha;
  const deliveryId = (ctx.payload as any).delivery_id || "";

  // Handle /mizumi subcommands
  if (isManualTrigger) {
    const cmd = parseCommand(ctx.payload.comment?.body || "");
    if (cmd?.command === "describe") {
      core.info("Running /mizumi describe...");
      const diff = await fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      const description = await generateDescription(
        diff.rawDiff.slice(0, 50000), pr.title || "", pr.body || "", config,
    diff.files
      );
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: description,
      });
      core.info("Description posted");
      return;
    }
    if (cmd?.command === "improve") {
      if (!config.improveEnabled) {
        await octokit.rest.issues.createComment({
          owner, repo, issue_number: prNumber,
          body: "/mizumi improve is disabled. Set improve_enabled: true in your workflow to enable.",
        });
        return;
      }
      core.info("Running /mizumi improve...");
      const result = await generateFix(octokit, owner, repo, prNumber, config);
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber,
        body: result.fixedCount > 0
          ? `Applied ${result.fixedCount} suggestion(s) (${result.commitSha?.slice(0, 7)})`
          : "No fixable suggestions found",
      });
      return;
    }
    if (cmd?.command === "test") {
      core.info("Running /mizumi test...");
      const diff = await fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
      const recentFindings = await getLatestFindings(octokit, owner, repo, prNumber);
      const testOutput = await generateTests(diff.rawDiff.slice(0, 30000), recentFindings, config);
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: testOutput });
      return;
    }
    if (cmd?.command === "spend") {
      core.info("Running /mizumi spend...");
      const entries = readSpendLog(workspace);
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: formatSpendDigest(entries) });
      return;
    }
  }

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


  if (checkAndMarkDelivery(workspace, deliveryId)) {
    core.info("Duplicate webhook delivery — skipping");
    return;
  }
  if (!isManualTrigger && checkAndMarkSha(workspace, headSha)) {
    core.info(`Already reviewed SHA ${headSha.slice(0, 7)} — skipping. Use /mizumi to force.`);
    return;
  }

    // 0b. Process 👍 reaction auto-fixes before running new review
  if (config.autoFix) {
    try {
      const autoFixed = await processReactionApprovals(octokit, owner, repo, prNumber, config);
      if (autoFixed > 0) {
        core.info(`Auto-fixed ${autoFixed} suggestion(s) via 👍 reaction approval`);
        core.setOutput("auto_fixed", autoFixed);
      }
    } catch (e) {
      core.warning("Auto-fix processing failed: " + (e instanceof Error ? e.message : String(e)));
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
    const context = await buildContext(octokit, owner, repo, prNumber, diff, workspace, prClassification);

// 5b. Progressive skill loading — inject matching skills into rules context
const skills = loadSkills(workspace, diff.files.map((f) => f.path));
if (skills.loaded) context.rulesContent += `

## Project Skills
${skills.loaded}`;

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
    // 6c. Agent context gathering — explore codebase with tools for cross-file context
let agentContext = "";
if (classification.tier !== "light") {
  try {
    core.info("Running agent context gathering...");
    agentContext = await runAgentContextGathering(
      context.diffText, config, octokit, owner, repo, headSha, classification
    );
    if (agentContext) {
      context.ghostContent += "\n\n## Agent-Explored Context\n" + agentContext;
    }
  } catch (e) {
    core.warning("Agent context failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

core.info("Running review pass...");
    const { output: review, usage: reviewUsage } = await runReview(
      context.diffText,
      positionHint,
      context.memoryContent,
      context.rulesContent,
      context.ghostContent,
      config,
      classification
    );
  core.info(`First pass: ${review.comments.length} findings, decision=${review.decision} (${reviewUsage.inputTokens + reviewUsage.outputTokens} tokens)`);

    // 8. Self-critique (second pass — cheaper model)
    core.info("Running self-critique pass...");
    const filtered = await runCritique(review, config);
    core.info(`After critique: ${filtered.comments.length} findings (threshold=${config.confidenceThreshold})`);

    // 8b. Apply learning weights from past feedback
const learningWeights = computeLearningWeights(workspace, owner + "/" + repo);
if (Object.keys(learningWeights).length > 0) {
  core.info("Learning weights: " + JSON.stringify(learningWeights));
  const adjusted = applyLearningWeights(filtered.comments, learningWeights);
  filtered.comments = adjusted as typeof filtered.comments;
}

// 8c. Confidence calibration + compliance check (parallel)
let complianceResults: import("./compliance.js").ComplianceResult[] = [];
if (config.confidenceCalibration || config.complianceCheck) {
  const calibrationPromise = config.confidenceCalibration
    ? calibrateConfidence(filtered, config).catch((e) => {
        core.warning("Calibration failed: " + (e instanceof Error ? e.message : String(e)));
        return null;
      })
    : Promise.resolve(null);

  const compliancePromise = config.complianceCheck
    ? (async () => {
        try {
          const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
          const diffSummary = diff.files.map((f) => f.path + ": +" + f.additions + "/-" + f.deletions).join("\n");
          return checkCompliance(
            octokit, owner, repo, prNumber,
            prData.body || "", prData.title || "",
            diffSummary, config
          );
        } catch (e) {
          core.warning("Compliance check failed: " + (e instanceof Error ? e.message : String(e)));
          return [];
        }
      })()
    : Promise.resolve([]);

  const [calibrated, compliance] = await Promise.all([calibrationPromise, compliancePromise]);

  if (calibrated) {
    const highCount = calibrated.filter((c) => c.calibratedConfidence === "high").length;
    const lowCount = calibrated.filter((c) => c.calibratedConfidence === "low").length;
    core.info("Calibration: " + highCount + " high, " + (calibrated.length - highCount - lowCount) + " medium, " + lowCount + " low");
    filtered.comments = calibrated as typeof filtered.comments;
  }

  complianceResults = compliance;
  if (complianceResults.length > 0) {
    core.info("Compliance: " + complianceResults.length + " issue(s) checked");
  }
}

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

    // 9b. Cleanup outdated bot comments (reviewdog stale-comment pattern)
  const currentFindings = mergedReview.comments.map((c) => ({
    file: c.file, line: c.line, message: c.message,
  }));
  const deletedCount = await cleanupOutdatedComments(
    octokit, owner, repo, prNumber, currentFindings
  );
  if (deletedCount > 0) core.info(`Cleaned up ${deletedCount} outdated comment(s)`);

  // 10. Post review
    core.info("Posting review...");
    const result = await postReview(
      octokit, owner, repo, prNumber, headSha, mergedReview, lineMap, config,
    diff.files
    );
    core.info(`Review posted: id=${result.reviewId}, findings=${result.findingCount}, risk=${result.riskScore}`);

// 10a. Set action outputs
core.setOutput("review_id", result.reviewId);
core.setOutput("finding_count", result.findingCount);
core.setOutput("risk_score", result.riskScore);
  // Compliance output
  if (complianceResults.length > 0) {
    const topCompliance = complianceResults[0].compliance;
    core.setOutput("compliance", topCompliance);
  } else {
    core.setOutput("compliance", "none");
  // Post compliance results as a comment if any
  if (complianceResults.length > 0) {
    const complianceBody = formatCompliance(complianceResults);
    if (complianceBody) {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: complianceBody,
      });
    }
  }
  }

  // 10c. Idempotency already marked atomically at step 0

// 10b. Track spend
const spendEntry = createSpendEntry(
  `${owner}/${repo}`, prNumber,
  config.provider, config.model,
  { inputTokens: reviewUsage.inputTokens, outputTokens: reviewUsage.outputTokens, cachedInputTokens: reviewUsage.cachedInputTokens }, classification.tier,
  result.findingCount, result.riskScore
);
appendSpendEntry(workspace, spendEntry);

// 10d. Record findings for emoji feedback tracking
recordFindings(workspace, `${owner}/${repo}`, prNumber,
  mergedReview.comments.map((c) => ({ file: c.file, line: c.line, category: c.category, severity: c.severity, message: c.message }))
);

    // 11. Update memory — learn from this review
    const memoryUpdate = filtered.comments
      .filter((c) => c.severity === "critical" || c.severity === "high")
      .map((c) => `- [${c.severity}] ${c.file}:${c.line} — ${c.category}: ${c.message}`)
      .join("\n");

    // Record suggestions to SQLite for feedback tracking
for (const c of mergedReview.comments) {
  recordSuggestion(workspace, owner + "/" + repo, c.file, c.line, c.category, c.severity, c.message);
}

writeMemory(workspace, context.memoryContent, memoryUpdate);

// 11b. Auto-generate skills from recurring patterns
const updatedMemory = readMemory(workspace);
const generatedSkills = autoGenerateSkills(updatedMemory, workspace);
if (generatedSkills.length > 0) core.info(`Auto-generated ${generatedSkills.length} skill(s)`);

    // 11c. Persist learning data back to repo (survives between Action runs)
  try {
    const defaultBranch = github.context.payload.repository?.default_branch || "main";
    const persistResult = await persistLearningData(octokit, owner, repo, defaultBranch, workspace);
    if (persistResult.committed) {
      core.info("Learning data persisted: " + persistResult.filesPushed + " file(s), sha=" + persistResult.commitSha);
    }
  } catch (e) {
    core.warning("Learning persistence failed: " + (e instanceof Error ? e.message : String(e)));
  }

  // Always exit 0 — never fail the build by default
    core.info("Mizumi review complete");
  } catch (error) {
    core.error(`Mizumi error: ${error instanceof Error ? (error.stack || error.message) : String(error)}`);
    core.setOutput("review_id", 0);
    core.setOutput("finding_count", 0);
    core.setOutput("risk_score", -1);
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

  while (page <= 10) { // Max 10 pages (1000 comments) to prevent runaway
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
    per_page: 100,
  });

  count += reviews.filter((r) => r.body?.includes(MARKER)).length;

  return count;
}

async function getLatestFindings(
  octokit: Octokit, owner: string, repo: string, prNumber: number
): Promise<Array<{ file: string; line: number; severity: string; category: string; message: string; suggestion?: string }>> {
  const findings: Array<{ file: string; line: number; severity: string; category: string; message: string; suggestion?: string }> = [];
  const { data: comments } = await octokit.rest.pulls.listReviewComments({
    owner, repo, pull_number: prNumber, per_page: 100, sort: "created", direction: "desc",
  });
  for (const c of comments.slice(0, 20)) {
    if (!c.body?.includes(MARKER)) continue;
    const seveMatch = c.body.match(/\*\*Severity:\*\*\s*(\w+)/);
    const catMatch = c.body.match(/\*\*Category:\*\*\s*(\w+)/);
    const sugMatch = c.body.match(/```suggestion\n([\s\S]*?)```/);
    findings.push({
      file: c.path, line: c.line ?? 0,
      severity: seveMatch?.[1]?.toLowerCase() || "medium",
      category: catMatch?.[1]?.toLowerCase() || "bug",
      message: c.body.replace(/<[^>]*>/g, "").slice(0, 200).trim(),
      suggestion: sugMatch?.[1]?.replace(/\n$/, ""),
    });
  }
  return findings;
}

void run().catch((e) => { core.setFailed(`Fatal: ${e}`); process.exit(0); });
