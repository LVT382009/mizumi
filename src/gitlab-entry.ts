/**
 * GitLab CI entry point — runs Mizumi review on GitLab MRs.
 *
 * This is the parallel of main.ts for GitLab CI/CD pipelines.
 * Uses the platform abstraction layer so core review logic stays shared.
 *
 * Usage in .gitlab-ci.yml:
 *   mizumi-review:
 *     image: node:24
 *     script:
 *       - npx mizumi-gitlab
 *     variables:
 *       GITLAB_TOKEN: $CI_JOB_TOKEN  (or a personal access token)
 */
import * as core from "@actions/core";
import { createPlatformClient, detectPlatform, getWorkspace } from "./platform.js";
import type { InlineComment } from "./platform.js";
import { loadConfig } from "./config.js";
import { classifyDiff, guardContextWindow } from "./router.js";
import { classifyPR } from "./classifier.js";
import { buildLineMapFromRawDiff, buildPositionHint } from "./linemap.js";
import { runReview } from "./review.js";
import { runCritique } from "./critique.js";
import { runRules } from "./rules.js";
import { executeRuleEngine } from "./rule-engine.js";
import { runASTContractAnalysis } from "./ast-contracts.js";
import { detectSlop } from "./slop.js";
import { calibrateConfidence } from "./calibrate.js";
import { createSpendEntry, appendSpendEntry } from "./spend.js";
import { recordSuggestion } from "./db.js";
import { recordFindings, readFeedbackStore, computeSuppressedPatterns, applyNoiseReduction } from "./feedback.js";
import { writeMemory, readMemory, loadSkills } from "./memory.js";

async function runGitLab(): Promise<void> {
  try {
    const config = loadConfig();
    const platform = detectPlatform();
    const workspace = getWorkspace();

    core.info(`Mizumi GitLab review — platform=${platform}`);

    const client = await createPlatformClient();
    core.info(`Platform client: ${client.platform}, project=${client.getProjectId()}`);

    // Fetch MR metadata
    const mr = await client.getMR();
    core.info(`Reviewing MR !${mr.number}: ${mr.title}`);

    // 1. Fetch and parse diff
    const diff = await client.fetchDiff();
    core.info(`Diff: ${diff.files.length} files, +${diff.totalAdditions}/-${diff.totalDeletions}`);

    if (diff.files.length === 0) {
      core.info("No changed files — skipping review");
      return;
    }

    // 2. Classify PR + diff tier
    const prClassification = classifyPR(
      diff.files.map((f) => ({ from: f.path, additions: f.additions, deletions: f.deletions })),
      diff.totalAdditions, diff.totalDeletions,
    );
    core.info(`PR classification: ${prClassification.category} (${prClassification.reason})`);

    const classification = classifyDiff(
      diff.totalAdditions + diff.totalDeletions,
      diff.files.length,
      diff.files.map((f) => f.path),
      config,
    );
    core.info(`Classification: ${classification.tier} (${classification.reason})`);

    // 2c. Slop detection
    const slopResult = detectSlop(
      diff.rawDiff, diff.totalAdditions, diff.totalDeletions,
      diff.files.length, diff.files.map((f) => f.path),
    );

    // 3. Rule engine (deterministic)
    const ruleFindings = runRules(diff.files);
    core.info(`Rules: ${ruleFindings.length} deterministic findings`);

    // 3b. Persistent rule engine
    let engineFindings: import("./rules.js").RuleFinding[] = [];
    try {
      const engineResult = executeRuleEngine(diff.files, workspace, client.getProjectId());
      engineFindings = engineResult.findings;
      core.info(`Rule engine: ${engineResult.findings.length} finding(s)`);
    } catch (e) {
      core.warning(`Rule engine failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3c. AST contract analysis
    let astViolations: import("./ast-contracts.js").ContractViolation[] = [];
    if (config.astContractAnalysis) {
      try {
        const astResult = runASTContractAnalysis(diff.files, workspace);
        astViolations = astResult.violations;
        core.info(`AST contracts: ${astViolations.length} violation(s)`);
      } catch (e) {
        core.warning(`AST analysis failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 4. Build line map
    buildLineMapFromRawDiff(diff.rawDiff);

    // 5. Load skills
    const skills = loadSkills(workspace, diff.files.map((f) => f.path));

    // 6. Build position hint and guard context
    const positionHint = buildPositionHint(diff.files);

    // Build simplified context (no Octokit for buildContext — skip ghost content)
    const memoryContent = readMemory(workspace);
    let rulesContent = skills.loaded || "";
    let diffText = diff.rawDiff;

    const guarded = guardContextWindow(diffText, config.provider);
    if (guarded.truncated) core.warning(`Diff truncated: ${guarded.estimatedTokens} tokens`);
    diffText = guarded.text;

    if (slopResult.isSlop) {
      diffText += `\n\n## Slop Detection\nThis MR appears to contain low-quality AI-generated code (score: ${slopResult.score}/100).`;
    }

    // 7. Run review (LLM)
    core.info("Running review pass...");
    const { output: review, usage: reviewUsage } = await runReview(
      diffText, positionHint, memoryContent, rulesContent, "", config, classification,
    );
    core.info(`Review: ${review.comments.length} findings, decision=${review.decision}`);

    // 8. Self-critique
    core.info("Running self-critique pass...");
    const filtered = await runCritique(review, config);
    core.info(`After critique: ${filtered.comments.length} findings`);

    // 8b. Adaptive noise reduction
    try {
      const feedbackStore = readFeedbackStore(workspace);
      const suppressed = computeSuppressedPatterns(feedbackStore);
      if (suppressed.size > 0) {
        filtered.comments = applyNoiseReduction(filtered.comments, suppressed) as typeof filtered.comments;
      }
    } catch { /* non-critical */ }

    // 8c. Confidence calibration
    if (config.confidenceCalibration) {
      try {
        const calibrated = await calibrateConfidence(filtered, config);
        if (calibrated) filtered.comments = calibrated as typeof filtered.comments;
      } catch (e) {
        core.warning(`Calibration failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 9. Merge all findings
    const mergedComments = [
      ...ruleFindings.map((r) => ({
        file: r.file, line: r.line,
        severity: r.severity as "critical" | "high" | "medium" | "low",
        category: r.category as "security" | "compliance" | "performance" | "bug" | "style" | "architecture",
        message: r.message, suggestion: undefined as string | undefined,
        confidence: 100,
      })),
      ...engineFindings.map((r) => ({
        file: r.file, line: r.line,
        severity: r.severity as "critical" | "high" | "medium" | "low",
        category: r.category as "security" | "compliance" | "performance" | "bug" | "style" | "architecture",
        message: r.message, suggestion: undefined as string | undefined,
        confidence: 85,
      })),
      ...filtered.comments,
    ];

    // 10. Post review via platform client
    const inlineComments: InlineComment[] = mergedComments.map((c) => ({
      path: c.file,
      line: c.line,
      body: c.message,
      severity: c.severity,
      confidence: c.confidence,
      category: c.category,
      suggestion: c.suggestion,
    }));

    const summary = `## Mizumi Review\n\n**Risk Score:** ${filtered.riskScore}/5\n**Findings:** ${mergedComments.length}\n**Decision:** ${review.decision}`;

    if (config.dryRun) {
      core.info("DRY RUN: Skipping review post");
      core.setOutput("finding_count", mergedComments.length);
      core.setOutput("risk_score", filtered.riskScore);
    } else {
      core.info("Posting review via GitLab discussions...");
      const result = await client.postReview(inlineComments, summary, filtered.riskScore);
      core.info(`Review posted: findings=${result.findingCount}`);
      core.setOutput("review_id", result.reviewId);
      core.setOutput("finding_count", result.findingCount);
      core.setOutput("risk_score", filtered.riskScore);
    }

    // 11. Record spend + learning data
    const spendEntry = createSpendEntry(
      client.getProjectId(), mr.number,
      config.provider, config.model,
      { inputTokens: reviewUsage.inputTokens, outputTokens: reviewUsage.outputTokens, cachedInputTokens: reviewUsage.cachedInputTokens },
      classification.tier, mergedComments.length, filtered.riskScore,
    );
    appendSpendEntry(workspace, spendEntry);

    recordFindings(workspace, client.getProjectId(), mr.number,
      mergedComments.map((c) => ({ file: c.file, line: c.line, category: c.category, severity: c.severity, message: c.message }))
    );

    for (const c of mergedComments) {
      recordSuggestion(workspace, client.getProjectId(), c.file, c.line, c.category, c.severity, c.message);
    }

    const memoryUpdate = filtered.comments
      .filter((c) => c.severity === "critical" || c.severity === "high")
      .map((c) => `- [${c.severity}] ${c.file}:${c.line} — ${c.category}: ${c.message}`)
      .join("\n");
    writeMemory(workspace, memoryContent, memoryUpdate);

    // 12. Merge gate status
    if (config.gateThreshold !== "none" && !config.dryRun) {
      try {
        const state = filtered.riskScore >= 4 ? "failure" : "success";
        await client.createStatus(mr.headSha, state, `Mizumi: risk=${filtered.riskScore}, findings=${mergedComments.length}`, "mizumi-review");
      } catch (e) {
        core.warning(`Gate status failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    core.info("Mizumi GitLab review complete");
  } catch (error) {
    core.error(`Mizumi GitLab error: ${error instanceof Error ? (error.stack || error.message) : String(error)}`);
    core.setOutput("review_id", 0);
    core.setOutput("finding_count", 0);
    core.setOutput("risk_score", -1);
  }
}

void runGitLab().catch(() => { process.exit(0); });
