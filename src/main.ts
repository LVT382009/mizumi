/**
 * Mizumi â€” Self-Learning PR Review Agent
 * Action entrypoint: parse event â†’ rules â†’ review â†’ critique â†’ post â†’ memory
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
import { recordFindings, computeSuppressedPatterns, applyNoiseReduction, readFeedbackStore, categoryAcceptanceRates } from "./feedback.js";
import { generateDescription, parseCommand } from "./describe.js";
import { detectSlop } from "./slop.js";
import { generateFix } from "./improve.js";
import { generateTests } from "./testgen.js";
import { checkAndMarkDelivery, checkAndMarkSha } from "./idempotency.js";
import { runAgentContextGathering } from "./agent.js";
import { runLinters, runDependencyAudit } from "./linter.js";
import { applyLabels } from "./labels.js";
import { createRateLimiter } from "./ratelimit.js";
import { calibrateConfidence } from "./calibrate.js";
import { checkCompliance, formatCompliance } from "./compliance.js";
import { processReactionApprovals } from "./autofix.js";
import { persistLearningData } from "./persist.js";
import { postGateStatus, postPendingGate } from "./gate.js";
import { countMizumiReviews, getLatestFindings, createOrUpdateSpendComment } from "./helpers.js";
import { executeRuleEngine } from "./rule-engine.js";
import { runCIFixLoop } from "./cifix.js";
import { runASTContractAnalysis } from "./ast-contracts.js";
import { generateBehavioralSummary, shouldRunBehavioralAnalysis, formatBehavioralSummary } from "./behavioral.js";
import { loadCodeowners, matchOwnership, applyOwnershipToFindings, buildOwnershipSummary } from "./ownership.js";
import { computeDeltaReview, recordReviewedSha, formatDeltaSummary } from "./delta.js";
import { discoverADRs, buildADRContext, checkADRViolations } from "./adr.js";
import { runTaintAnalysis, buildTaintContext } from "./taint.js";
import { runReviewLearning, buildLearningContext, applyNegativeRules } from "./review-learning.js";
import { runBlastRadiusAnalysis, buildBlastRadiusContext } from "./blast-radius.js";
import { checkSpecCompliance, buildSpecComplianceContext } from "./spec-compliance.js";
import { runAuthBoundaryAnalysis, buildAuthBoundaryContext } from "./auth-boundary.js";
import { buildFatigueDashboard, formatFatigueDashboard } from "./fatigue-dashboard.js";
import { runEntropyAnalysis, buildEntropyContext } from "./secret-entropy.js";
import { runAttributionAnalysis, applyAttributionConfidence, buildAttributionContext } from "./attribution.js";
import { computeSafetyScore, postSafetyScore } from "./safety-score.js";
import { fetchBusinessContext, parseMCPEndpoints } from "./business-context.js";
import { runOrgMemoryRetrieval, recordPRHistory, pruneOldHistory } from "./org-memory.js";
import { runTestGapDetection } from "./test-gap.js";
import { runSuppressionMemories } from "./suppression-memories.js";

const RetryingOctokit = Octokit.plugin(retry);

async function run(): Promise<void> {
  try {
    const config = loadConfig();
  let manualInstructions = "";
    const ctx = github.context;
    const token = process.env.GITHUB_TOKEN || core.getInput("github_token");

    if (!token) {
      core.setFailed("GITHUB_TOKEN is required");
      return;
    }

    const octokit = new RetryingOctokit({ auth: token });
  // Rate limiter for provider API calls
  const rateLimiter = createRateLimiter(config.provider);

    const prNumber = getPrNumber(ctx);
    if (!prNumber) {
      core.info("No PR number found â€” skipping review");
      return;
    }

    const owner = ctx.repo.owner;
    const repo = ctx.repo.repo;
    const isManualTrigger = ctx.eventName === "issue_comment";

    core.info(`Mizumi reviewing ${owner}/${repo}#${prNumber} with ${config.provider}/${config.model}`);
  if (config.dryRun) core.info("DRY RUN: review will be logged but not posted");

  // 0. Workspace + idempotency checks
  const workspace = process.env.GITHUB_WORKSPACE || ".";
  const headSha = ctx.payload.pull_request?.head?.sha || ctx.sha;
  const deliveryId = (ctx.payload as any).delivery_id || "";

// 0-gate. Post pending gate status (shows "review in progress" in checks UI)
if (config.gateThreshold !== "none" && !config.dryRun) {
  await postPendingGate(octokit, owner, repo, headSha, prNumber);
}

  // Handle /mizumi subcommands
  if (isManualTrigger) {
    const cmd = parseCommand(ctx.payload.comment?.body || "");
    if (cmd?.command === "describe") {
      core.info("Running /mizumi describe...");
      const diff = await fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      await rateLimiter.acquire();
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
      await rateLimiter.acquire();
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

    // Capture custom instructions from /mizumi review [instructions]
    if (cmd?.command === "review" && cmd.args) {
      manualInstructions = cmd.args;
      core.info("Custom review instructions: " + manualInstructions);
    }
  }

    // Respect auto_review: false â€” only run on manual /mizumi trigger
    if (!config.autoReview && !isManualTrigger) {
      core.info("auto_review is false â€” skipping. Use /mizumi to trigger.");
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
    core.info("Duplicate webhook delivery â€” skipping");
    return;
  }
  if (!isManualTrigger && checkAndMarkSha(workspace, headSha)) {
    core.info(`Already reviewed SHA ${headSha.slice(0, 7)} â€” skipping. Use /mizumi to force.`);
    return;
  }

    // 0b. Process ðŸ‘ reaction auto-fixes before running new review
  if (config.autoFix) {
    try {
      const autoFixed = await processReactionApprovals(octokit, owner, repo, prNumber, config);
      if (autoFixed > 0) {
        core.info(`Auto-fixed ${autoFixed} suggestion(s) via ðŸ‘ reaction approval`);
        core.setOutput("auto_fixed", autoFixed);
      }
    } catch (e) {
      core.warning("Auto-fix processing failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }


// 0c. CI-validated fix loop (apply fixes, verify CI, revert on failure)
if (config.ciValidatedFix && config.improveEnabled) {
  try {
    core.info("Running CI-validated fix loop...");
    const ciResult = await runCIFixLoop(octokit, owner, repo, prNumber, {
      enabled: config.ciValidatedFix,
      timeoutSeconds: config.ciFixTimeout,
      maxRetries: config.ciFixMaxRetries,
      revertOnFailure: config.ciFixRevertOnFailure,
      pollIntervalSeconds: 30,
    }, config);
    const ciSuccess = ciResult.success;
    const ciRetries = ciResult.retriesUsed;
    const ciReverted = ciResult.reverted;
    const ciStatus = ciResult.ciStatus;
    core.info("CI fix loop: success=" + ciSuccess + ", retries=" + ciRetries + ", reverted=" + ciReverted + ", ciStatus=" + ciStatus);
  } catch (e) {
    core.warning("CI fix loop failed: " + (e instanceof Error ? e.message : String(e)));
  }
} else if (config.ciValidatedFix && !config.improveEnabled) {
  core.warning("ci_validated_fix requires improve_enabled=true. Enable both to use CI-validated fixes.");
}

// 1. Fetch and parse diff
    const diff = await fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
    core.info(`Diff: ${diff.files.length} files, +${diff.totalAdditions}/-${diff.totalDeletions}`);


  // 1b. Incremental delta review - only review NEW diff since last Mizumi review
  let deltaBody = "";
  if (config.deltaReview) {
    try {
      const deltaResult = await computeDeltaReview(
        octokit, owner, repo, prNumber, headSha, diff, workspace, config.excludePatterns,
      );
      if (deltaResult.isIncremental && deltaResult.incrementalDiff) {
        if (deltaResult.incrementalDiff.files.length === 0) {
          core.info("Delta review: no new changes since last review - skipping");
          return;
        }
        core.info(`Delta review: incremental ${deltaResult.incrementalDiff.files.length} files, ${deltaResult.savings.percentSaved}% token savings`);
        diff.files = deltaResult.incrementalDiff.files;
        diff.totalAdditions = deltaResult.incrementalDiff.totalAdditions;
        diff.totalDeletions = deltaResult.incrementalDiff.totalDeletions;
        diff.rawDiff = deltaResult.incrementalDiff.rawDiff;
        deltaBody = formatDeltaSummary(deltaResult);
      } else {
        core.info("Delta review: full review (no previous SHA or non-incremental)");
      }
    } catch (e) {
      core.warning("Delta review failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }
    if (diff.files.length === 0) {
      core.info("No changed files after exclusions â€” skipping review");
      return;
    }

    // 2. Classify PR type (heuristic â€” zero LLM cost)
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

// 2c. Slop detection â€” skip deep review for low-quality AI-generated PRs
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

  // 4a-pre. ADR discovery (needed for both rule check and context injection)
 const adrs = discoverADRs(workspace);

 // 4a. Run persistent rule engine (custom + auto-discovered rules)
  let engineFindings: import("./rules.js").RuleFinding[] = [];
  try {
    const engineResult = executeRuleEngine(diff.files, workspace, `${owner}/${repo}`);
    engineFindings = engineResult.findings;
    core.info(`Rule engine: ${engineResult.findings.length} finding(s), ${engineResult.rulesUsed} rule(s) used, ${engineResult.discoveredNew} discovered, ${engineResult.decayed} decayed`);

  // 4a1b. ADR enforcement - check code against architecture decision records
  let adrViolations: import("./adr.js").ADRViolation[] = [];
  if (adrs.length > 0) {
    try {
      adrViolations = checkADRViolations(diff.files, adrs);
      if (adrViolations.length > 0) {
        engineFindings = [...engineFindings, ...adrViolations.map(v => ({
          file: v.file, line: v.line, severity: v.severity,
          category: v.category, message: v.message, rule: v.rule,
        }))];
        core.info("ADR violations: " + adrViolations.length);
      }
    } catch (e) {
      core.warning("ADR enforcement failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }  } catch (e) {
    core.warning(`Rule engine failed: ${e instanceof Error ? e.message : String(e)}`);
  }
// 4a2. AST cross-file contract analysis
let astViolations: import("./ast-contracts.js").ContractViolation[] = [];
if (config.astContractAnalysis) {
  try {
    const astResult = runASTContractAnalysis(diff.files, workspace);
    astViolations = astResult.violations;
    if (astViolations.length > 0) {
      core.info("AST contracts: " + astResult.violations.length + " violation(s), " + astResult.filesAnalyzed + " files analyzed");
    } else {
      core.info("AST contracts: no violations (" + astResult.filesAnalyzed + " files analyzed)");
    }
  } catch (e) {
    core.warning("AST contract analysis failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

 // 4a3. Taint analysis - data flow from untrusted sources to security sinks
 let taintResult: import("./taint.js").TaintResult | null = null;
 if (config.taintAnalysis) {
 try {
   taintResult = runTaintAnalysis(diff.files);
 } catch (e) {
   core.warning("Taint analysis failed: " + (e instanceof Error ? e.message : String(e)));
 }
 }

 // 4a4. Review-to-review learning — auto-suppress dismissed patterns
 let learningResult: import("./review-learning.js").LearningResult | null = null;
 if (config.reviewLearning) {
 try {
   learningResult = runReviewLearning(workspace);
 } catch (e) {
   core.warning("Review learning failed: " + (e instanceof Error ? e.message : String(e)));
 }
 }

// 4a5. Blast radius - compute which unchanged files are transitively impacted
let blastResult: import("./blast-radius.js").BlastRadiusResult | null = null;
if (config.blastRadius) {
try {
blastResult = runBlastRadiusAnalysis(diff.files);
} catch (e) {
core.warning("Blast radius analysis failed: " + (e instanceof Error ? e.message : String(e)));
}
}

// 4a6. Spec compliance - extract acceptance criteria from linked issues
let specComplianceResults: import("./spec-compliance.js").SpecComplianceResult[] = [];
if (config.specCompliance) {
try {
const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
specComplianceResults = await checkSpecCompliance(
octokit, owner, repo, prData.body || "", prData.title || "", diff.files, config
);
if (specComplianceResults.length > 0) core.info(`Spec compliance: ${specComplianceResults.length} issue(s) checked`);
} catch (e) {
core.warning("Spec compliance check failed: " + (e instanceof Error ? e.message : String(e)));
}
}

// 4a10. Business context integration - fetch Jira/Linear ticket context
let businessContextResult: import("./business-context.js").BusinessContextResult | null = null;
if (config.businessContext) {
  try {
    const mcpEndpoints = parseMCPEndpoints();
    if (mcpEndpoints.length > 0) {
      const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      businessContextResult = await fetchBusinessContext(
        prData.body || "", prData.title || "", mcpEndpoints
      );
      if (businessContextResult.totalTickets > 0) {
        core.info("Business context: " + businessContextResult.totalTickets + " ticket(s) fetched");
      }
    }
  } catch (e) {
    core.warning("Business context fetch failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// 4a11. Organizational memory — retrieve similar past PRs by file path overlap
let orgMemoryResult: import("./org-memory.js").OrgMemoryResult | null = null;
if (config.orgMemory) {
  try {
    orgMemoryResult = runOrgMemoryRetrieval(
      workspace, `${owner}/${repo}`,
      diff.files.map((f) => f.path),
      prNumber
    );
    if (orgMemoryResult.similarPRs.length > 0) {
      core.info("Org memory: " + orgMemoryResult.similarPRs.length + " similar PR(s) found (total indexed: " + orgMemoryResult.totalIndexed + ")");
    }
    // Prune entries older than 180 days
    pruneOldHistory(workspace, `${owner}/${repo}`, 180);
  } catch (e) {
    core.warning("Org memory retrieval failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// 4a12. Test gap detection - flag production files without test changes
let testGapResult: import('./test-gap.js').TestGapResult | null = null;
if (config.testGapDetection) {
  try {
    const _tgr = runTestGapDetection(diff.files, workspace);
    testGapResult = _tgr;
    if (_tgr.gaps.length > 0) {
      core.info('Test gap detection: ' + _tgr.gaps.length + ' untested change(s) (' + Math.round(_tgr.coverageRatio * 100) + '% coverage ratio)');
    }
  } catch (e) {
    core.warning('Test gap detection failed: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// 4a7. Auth boundary analysis - detect routes without authentication
let authBoundaryResult: import("./auth-boundary.js").AuthBoundaryResult | null = null;
if (config.authBoundary) {
try {
authBoundaryResult = runAuthBoundaryAnalysis(diff.files);
// Merge auth boundary findings as engine findings (like taint analysis)
for (const f of authBoundaryResult.findings) {
engineFindings.push({
  file: f.file,
  line: f.line,
  severity: f.severity,
  category: "security",
  message: `Unauthenticated ${f.method.toUpperCase()} ${f.route} (${f.framework}) — no auth middleware/guard detected`,
  rule: "auth-boundary",
});
}
} catch (e) {
core.warning("Auth boundary analysis failed: " + (e instanceof Error ? e.message : String(e)));
}
}

// 4a8. Fatigue dashboard — build per-category acceptance/trend metrics from feedback store
let fatigueDashboardBody = "";
if (config.fatigueDashboard) {
  try {
    const feedbackStore = readFeedbackStore(workspace);
    const suppressed = computeSuppressedPatterns(feedbackStore);
    const fatigueResult = buildFatigueDashboard(workspace, suppressed);
    if (fatigueResult.categories.length > 0) {
      fatigueDashboardBody = formatFatigueDashboard(fatigueResult);
      core.info(`Fatigue dashboard: ${fatigueResult.categories.length} categories, ${fatigueResult.totalFindings} findings, ${fatigueResult.overallAcceptance}% acceptance`);
    }
  } catch (e) {
    core.warning("Fatigue dashboard failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// 4a9. Entropy-based secret detection — Shannon entropy on string literals
let entropyResult: import("./secret-entropy.js").EntropyResult | null = null;
if (config.secretEntropy) {
  try {
    entropyResult = runEntropyAnalysis(diff.files);
    for (const f of entropyResult.findings) {
      engineFindings.push({
        file: f.file,
        line: f.line,
        severity: f.severity,
        category: "security",
        message: `Possible hardcoded secret (entropy=${f.entropy.toFixed(1)}, ${f.reason}) — snippet: ${f.snippet}`,
        rule: "entropy-secret",
      });
    }
  } catch (e) {
    core.warning("Entropy analysis failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// 4b. Run linter pre-scan (deterministic, zero LLM cost)
 let linterFindings: import("./linter.js").LinterFinding[] = [];
 try {
   linterFindings = runLinters(workspace, diff.files.map((f) => f.path));
   if (linterFindings.length > 0) core.info(`Linters: ${linterFindings.length} finding(s)`);
 } catch (e) {
   core.warning(`Linter scan failed: ${e instanceof Error ? e.message : String(e)}`);
 }

 // 4c. Run dependency vulnerability audit (npm audit / pip-audit)
 try {
   const depFindings = runDependencyAudit(workspace);
   if (depFindings.length > 0) {
     linterFindings.push(...depFindings);
     core.info(`Dependency audit: ${depFindings.length} CVE finding(s)`);
   }
 } catch (e) {
   core.debug(`Dependency audit skipped: ${e instanceof Error ? e.message : String(e)}`);
 }

    // 5. Build context (diff + memory + rules + PR metadata + classification)
    const preLearningWeights = computeLearningWeights(workspace, owner + "/" + repo);
const preFeedbackStore = readFeedbackStore(workspace);
const preAcceptanceRates = categoryAcceptanceRates(preFeedbackStore);
const preAttributionResult = runAttributionAnalysis(workspace);
const context = await buildContext(octokit, owner, repo, prNumber, diff, workspace, prClassification, {
  learningWeights: preLearningWeights,
  acceptanceRates: preAcceptanceRates,
});

// 5b. Progressive skill loading â€” inject matching skills into rules context
const skills = loadSkills(workspace, diff.files.map((f) => f.path));
if (manualInstructions) {
    context.rulesContent += `\n\n## Manual Review Instructions\n${manualInstructions}`;
  }
  
// 5c. ADR context injection - inject ADR context into review
const adrContextStr = buildADRContext(adrs);
if (adrContextStr) {
  context.rulesContent += String.raw`

${adrContextStr}`;
  core.info(String.raw`ADR enforcement: ${adrs.length} ADR(s) discovered, ${adrs.filter(a => a.status === "accepted").length} active`);
}
// 5c2. Taint context injection - inject data flow traces into review context
if (taintResult && taintResult.traces.length > 0) {
  const taintContextStr = buildTaintContext(taintResult);
  if (taintContextStr) {
    context.rulesContent += `

${taintContextStr}`;
  }
}

// 5c3. Learning context injection
if (learningResult && learningResult.newRules.length > 0) {
  const learningContextStr = buildLearningContext(learningResult);
  if (learningContextStr) {
    context.rulesContent += `

${learningContextStr}`;
  }
}

// 5c4. Blast radius context injection
if (blastResult && blastResult.totalImpact > 0) {
const blastCtxStr = buildBlastRadiusContext(blastResult);
if (blastCtxStr) {
context.rulesContent += `

${blastCtxStr}`;
}
}

// 5c5. Spec compliance context injection
if (specComplianceResults.length > 0) {
const specCtxStr = buildSpecComplianceContext(specComplianceResults);
if (specCtxStr) {
context.rulesContent += `

${specCtxStr}`;
}
}

// 5c6. Auth boundary context injection
if (authBoundaryResult && authBoundaryResult.unprotectedRoutes > 0) {
const authCtxStr = buildAuthBoundaryContext(authBoundaryResult);
if (authCtxStr) {
context.rulesContent += `

${authCtxStr}`;
}
}

// 5c7. Entropy analysis context injection
if (entropyResult && entropyResult.findings.length > 0) {
  const entropyCtxStr = buildEntropyContext(entropyResult);
  if (entropyCtxStr) {
    context.rulesContent += `

${entropyCtxStr}`;
  }
}

// 5c8. Attribution context injection
if (preAttributionResult && preAttributionResult.reliableCategories > 0) {
    const attrCtxStr = buildAttributionContext(preAttributionResult);
    if (attrCtxStr) {
      context.rulesContent += `

${attrCtxStr}`;
    }
  }

  // 5c9. Business context injection
  if (businessContextResult && businessContextResult.contextText) {
    context.rulesContent += `

${businessContextResult.contextText}`;
  }

  
// 5c10. Organizational memory context injection
if (orgMemoryResult && orgMemoryResult.contextText) {
  context.rulesContent += `

${orgMemoryResult.contextText}`;
}

if (skills.loaded) context.rulesContent += `

## Project Skills
${skills.loaded}`;

    // 5c11. Test gap detection context injection
if (testGapResult && testGapResult.contextText) {
  context.rulesContent += `

${testGapResult.contextText}`;
}

// 6. Build position hint for LLM
    const positionHint = buildPositionHint(diff.files);

  // 6b. Guard context window â€” truncate diff if it exceeds modelâ€™s limit
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

    // 7. Run review (first pass â€” LLM)
    // 6c. Agent context gathering â€” explore codebase with tools for cross-file context
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
      classification,
      context.learningContent,
    );
  core.info(`First pass: ${review.comments.length} findings, decision=${review.decision} (${reviewUsage.inputTokens + reviewUsage.outputTokens} tokens)`);

    // 8. Self-critique (second pass â€” cheaper model)
    core.info("Running self-critique pass...");
    await rateLimiter.acquire();
const filtered = await runCritique(review, config);
    core.info(`After critique: ${filtered.comments.length} findings (threshold=${config.confidenceThreshold})`);

    // 8b. Apply learning weights from past feedback
const learningWeights = computeLearningWeights(workspace, owner + "/" + repo);
if (Object.keys(learningWeights).length > 0) {
  core.info("Learning weights: " + JSON.stringify(learningWeights));
  const adjusted = applyLearningWeights(filtered.comments, learningWeights);
  filtered.comments = adjusted as typeof filtered.comments;
}

// 8b2. Adaptive noise reduction â€” suppress repeatedly-dismissed patterns
    try {
      const feedbackStore = readFeedbackStore(workspace);
      const suppressed = computeSuppressedPatterns(feedbackStore);
      if (suppressed.size > 0) {
        core.info(`Adaptive noise: ${suppressed.size} suppressed patterns â€” ${[...suppressed].join(", ")}`);
        filtered.comments = applyNoiseReduction(filtered.comments, suppressed) as typeof filtered.comments;
  // Apply review-to-review learning (negative rules from dismissed patterns)
  if (learningResult && learningResult.newRules.length > 0) {
    filtered.comments = applyNegativeRules(filtered.comments, learningResult.newRules) as typeof filtered.comments;
  }
        const reduced = filtered.comments.filter((c) => c.confidence < config.confidenceThreshold).length;
        if (reduced > 0) core.info(`Adaptive noise: ${reduced} findings confidence-reduced below threshold`);
      }
    } catch {
      // Non-critical
    }


  // 8b3. Attribution-driven confidence adjustment
  // Attribution already computed at step 5
  try {
    // Use preAttributionResult from step 5
    if (preAttributionResult && preAttributionResult.reliableCategories > 0) {
      filtered.comments = applyAttributionConfidence(filtered.comments, preAttributionResult) as typeof filtered.comments;
    }
  } catch {
    // Non-critical
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
    // Rule findings are always posted â€” they're deterministic and high-confidence
    const mergedComments = [
      ...ruleFindings.map((r) => ({
    file: r.file,
    line: r.line,
    severity: r.severity as "critical" | "high" | "medium" | "low",
    category: r.category as "security" | "compliance" | "performance" | "bug" | "style" | "architecture",
    message: r.message,
    suggestion: undefined as string | undefined,
    confidence: 100, // Deterministic = always 100 confidence
  })),
  ...engineFindings.map((r) => ({
    file: r.file,
    line: r.line,
    severity: r.severity as "critical" | "high" | "medium" | "low",
    category: r.category as "security" | "compliance" | "performance" | "bug" | "style" | "architecture",
    message: r.message,
    suggestion: undefined as string | undefined,
    confidence: 85, // Rule engine findings
  })),
      ...filtered.comments,
    ];

    
// 9-sup. Apply suppression memories — auto-filter findings that humans have previously dismissed
let suppressionResult: import("./suppression-memories.js").SuppressionResult | null = null;
if (config.suppressionMemories) {
  try {
    const { filtered: supFiltered, result: supResult } = runSuppressionMemories(
      workspace, `${owner}/${repo}`, mergedComments
    );
    suppressionResult = supResult;
    mergedComments.length = 0;
    mergedComments.push(...supFiltered);
    if (supResult.suppressedCount > 0) {
      core.info("Suppression memories: " + supResult.suppressedCount + " finding(s) auto-suppressed");
    }
  } catch (e) {
    core.warning("Suppression memory filter failed: " + (e instanceof Error ? e.message : String(e)));
  }
}
const mergedReview = { ...filtered, comments: mergedComments };

// 9-sup-ctx. Log suppression context for observability
if (suppressionResult && suppressionResult.contextText) {
  core.info("Suppression memory context: " + suppressionResult.suppressedCount + " finding(s) suppressed");
}

// 9-own. CODEOWNERS-aware routing (tag owning teams, boost confidence)
let ownershipBody = "";
if (config.ownershipRouting) {
  try {
    const ownershipRules = loadCodeowners(workspace);
    if (ownershipRules.length > 0) {
      const ownership = matchOwnership(diff.files, ownershipRules);
      mergedReview.comments = applyOwnershipToFindings(mergedReview.comments, ownership);
      ownershipBody = buildOwnershipSummary(ownership);
      if (ownershipBody) core.info("Ownership: " + ownershipRules.length + " rule(s), " + ownership.filter(o => o.owners.length > 0).length + " file(s) matched");
    }
  } catch (e) {
    core.warning("Ownership routing failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// 9a. Behavioral diff summary (describe WHAT the code DOES differently)
let behavioralBody = "";
if (config.behavioralSummary && shouldRunBehavioralAnalysis(diff.files)) {
  try {
    const behavioralResult = await generateBehavioralSummary(diff.rawDiff, diff.files, config);
    behavioralBody = formatBehavioralSummary(behavioralResult);
    core.info("Behavioral summary: " + behavioralResult.headline);
  } catch (e) {
    core.warning("Behavioral summary failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

    // 9b. Cleanup outdated bot comments (reviewdog stale-comment pattern)
  const currentFindings = mergedReview.comments.map((c) => ({
    file: c.file, line: c.line, message: c.message,
  }));
  const deletedCount = await cleanupOutdatedComments(
    octokit, owner, repo, prNumber, currentFindings
  );
  if (deletedCount > 0) core.info(`Cleaned up ${deletedCount} outdated comment(s)`);

 // 10. Post review (skip in dry-run mode)
 if (config.dryRun) {
   core.info("DRY RUN: Skipping review post. Findings:");
   for (const c of mergedReview.comments) {
     core.info(`  [${c.severity}] ${c.file}:${c.line} â€” ${c.category}: ${c.message.slice(0, 200)}`);
   }
   core.setOutput("review_id", 0);
   core.setOutput("finding_count", mergedReview.comments.length);
   core.setOutput("risk_score", mergedReview.riskScore);
 } else {
   core.info("Posting review...");
   const result = await postReview(
     octokit, owner, repo, prNumber, headSha, mergedReview, lineMap, config,
     diff.files
   );
   core.info(`Review posted: id=${result.reviewId}, findings=${result.findingCount}, risk=${result.riskScore}`);
// Post behavioral summary as a separate comment
if (behavioralBody) {
  try {
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: behavioralBody,
    });
  } catch (e) {
    core.warning("Behavioral summary comment failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

  // Post fatigue dashboard as a separate comment
  if (fatigueDashboardBody) {
    try {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: fatigueDashboardBody,
      });
    } catch (e) {
      core.warning("Fatigue dashboard comment failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }


// Post ownership summary as a separate comment
if (ownershipBody) {
  try {
      const ownershipComment = `<!-- mizumi-ownership-marker -->
## Ownership Coverage

${ownershipBody}
---
*Posted by Mizumi*`;
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: ownershipComment,
    });
  } catch (e) {
    core.warning("Ownership summary comment failed: " + (e instanceof Error ? e.message : String(e)));
  }
// Post delta review summary as a separate comment
if (deltaBody) {
  try {
    const deltaComment = `<!-- mizumi-delta-marker -->
## Incremental Review

${deltaBody}
---
*Posted by Mizumi*`;
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body: deltaComment,
    });
  } catch (e) {
    core.warning("Delta summary comment failed: " + (e instanceof Error ? e.message : String(e)));
  }
}
// Record last-reviewed SHA for delta review
if (config.deltaReview) {
  try {
    recordReviewedSha(workspace, owner, repo, prNumber, headSha);
  } catch (e) {
    core.warning("Failed to record reviewed SHA: " + (e instanceof Error ? e.message : String(e)));
  }
}
}
   // 10a. Set action outputs
   core.setOutput("review_id", result.reviewId);
   core.setOutput("finding_count", result.findingCount);
   core.setOutput("risk_score", result.riskScore);
  // Compliance output
 if (complianceResults.length > 0) {
 const topCompliance = complianceResults[0].compliance;
 core.setOutput("compliance", topCompliance);
 const complianceBody = formatCompliance(complianceResults);
 if (complianceBody) {
 await octokit.rest.issues.createComment({
 owner, repo, issue_number: prNumber, body: complianceBody,
 });
 }
 } else {
 core.setOutput("compliance", "none");

 }

 // 10b. Auto-label PR based on findings (runs regardless of compliance)
 if (config.autoLabels) {
   try {
     await applyLabels(octokit, owner, repo, prNumber, mergedReview.comments, mergedReview.riskScore);
   } catch (e: any) {
     core.warning("Auto-labeling failed: " + (e?.message || String(e)));
   }
 }
 }

  // 10c. Idempotency already marked atomically at step 0

// 10b-gate. Post commit status for merge gate (enforceable via branch protection)
if (config.gateThreshold !== "none" && !config.dryRun) {
  try {
    const gateResult = await postGateStatus({
      octokit, owner, repo, headSha, prNumber,
      findings: mergedReview.comments,
      riskScore: mergedReview.riskScore,
      threshold: config.gateThreshold,
      findingCount: mergedReview.comments.length,
    });
    core.info(`Merge gate: ${gateResult} (threshold=${config.gateThreshold})`);
  } catch (e) {
    core.warning("Gate status post failed: " + (e instanceof Error ? e.message : String(e)));
  }

  // 10b-gate2. Post safety score as a separate commit status
  if (config.safetyScore && !config.dryRun) {
    try {
      const safetyInput = {
        findings: mergedReview.comments.map((c) => ({ severity: c.severity, category: c.category })),
        riskScore: mergedReview.riskScore,
        blastRadiusFiles: blastResult?.totalImpact ?? diff.files.length,
        attribution: preAttributionResult,
      };
      const safetyResult = computeSafetyScore(safetyInput);
      await postSafetyScore(octokit, owner, repo, headSha, prNumber, safetyResult.score);
      core.info("Safety score: " + safetyResult.score + "/100 (findingPenalty=" + safetyResult.factors.findingPenalty + ", blastRadius=" + safetyResult.factors.blastRadiusPenalty + ", attribution=" + safetyResult.factors.attributionAdjustment + ", risk=" + safetyResult.factors.riskAdjustment + ")");
    } catch (e) {
      core.warning("Safety score post failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}

// 10b. Track spend
const spendEntry = createSpendEntry(
  `${owner}/${repo}`, prNumber,
  config.provider, config.model,
  { inputTokens: reviewUsage.inputTokens, outputTokens: reviewUsage.outputTokens, cachedInputTokens: reviewUsage.cachedInputTokens }, classification.tier,
  mergedReview.comments.length, mergedReview.riskScore
);
appendSpendEntry(workspace, spendEntry);

// 10e. Spend dashboard comment when threshold exceeded
if (config.spendThreshold > 0 && spendEntry.totalTokens > config.spendThreshold && !config.dryRun) {
  try {
    const allEntries = readSpendLog(workspace);
    const recentEntries = allEntries.filter((e: import("./spend.js").SpendEntry) => e.repo === `${owner}/${repo}`);
    const digest = formatSpendDigest(recentEntries);
    const dashboardBody = `<!-- mizumi-spend-marker -->\n## Spend Dashboard\n\n${digest}\n\n*Threshold: ${config.spendThreshold.toLocaleString()} tokens â€” this review used ${spendEntry.totalTokens.toLocaleString()} tokens.*\n\n---\n*Posted by Mizumi*`;
    await createOrUpdateSpendComment(octokit, owner, repo, prNumber, dashboardBody);
    core.info(`Spend dashboard posted: ${spendEntry.totalTokens} tokens exceeded threshold of ${config.spendThreshold}`);
  } catch (e) {
    core.warning("Spend dashboard comment failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

// 10d. Record findings for emoji feedback tracking
recordFindings(workspace, `${owner}/${repo}`, prNumber,
  mergedReview.comments.map((c) => ({ file: c.file, line: c.line, category: c.category, severity: c.severity, message: c.message }))
);

    // 11. Update memory â€” learn from this review
    const memoryUpdate = filtered.comments
      .filter((c) => c.severity === "critical" || c.severity === "high")
      .map((c) => `- [${c.severity}] ${c.file}:${c.line} â€” ${c.category}: ${c.message}`)
      .join("\n");

    // Record suggestions to SQLite for feedback tracking
for (const c of mergedReview.comments) {
  recordSuggestion(workspace, owner + "/" + repo, c.file, c.line, c.category, c.severity, c.message);
}

// 10d2. Record PR into organizational memory index
if (config.orgMemory) {
  try {
    const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    recordPRHistory(
      workspace, `${owner}/${repo}`, prNumber,
      prData.title || "",
      diff.files.map((f) => f.path),
      mergedReview.comments.map((c) => ({ category: c.category, severity: c.severity, message: c.message })),
      mergedReview.riskScore
    );
  } catch (e) {
    core.warning("Org memory record failed: " + (e instanceof Error ? e.message : String(e)));
  }
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

  // Always exit 0 â€” never fail the build by default
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

void run().catch((e) => { core.setFailed(`Fatal: ${e}`); process.exit(0); });

