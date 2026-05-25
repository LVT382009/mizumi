/**
 * PR Safety Score — composite 0-100 score posted as commit status.
 *
 * Competitive gap (P2-E): Only Greptile has a 0-5 PR safety score.
 * This provides a richer 0-100 composite that aggregates:
 * - Finding count and severity distribution (primary signal)
 * - Blast radius size (more impacted files = less safe)
 * - Attribution dismissal rate (high dismissal = more trustworthy)
 * - Risk score from the LLM review
 *
 * Base score: 100 (perfectly safe)
 * Penalties: critical findings -25, high -10, medium -5, low -2, nitpick -1
 * Blast radius: >5 impacted files -5, >10 -10
 * Attribution: >60% dismissal for a reliable category +5 (learned, less noisy)
 *
 * The score is posted as a SEPARATE commit status ("Mizumi Safety Score")
 * alongside the gate status. This gives maintainers a quantitative signal
 * even when the gate is disabled.
 */
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import type { AttributionResult } from "./attribution.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SafetyScoreInput {
  findings: Array<{ severity: string; category: string }>;
  riskScore: number;
  blastRadiusFiles: number;
  attribution: AttributionResult | null;
}

export interface SafetyScoreResult {
  score: number;
  factors: {
    findingPenalty: number;
    blastRadiusPenalty: number;
    attributionAdjustment: number;
    riskAdjustment: number;
  };
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

const SEVERITY_PENALTY: Record<string, number> = {
  critical: 25,
  high: 10,
  medium: 5,
  low: 2,
  nitpick: 1,
};

/** Compute the safety score from review signals */
export function computeSafetyScore(input: SafetyScoreInput): SafetyScoreResult {
  let score = 100;

  // 1. Finding penalties
  let findingPenalty = 0;
  for (const f of input.findings) {
    findingPenalty += SEVERITY_PENALTY[f.severity] || 1;
  }
  score -= findingPenalty;

  // 2. Blast radius penalty
  let blastRadiusPenalty = 0;
  if (input.blastRadiusFiles > 10) blastRadiusPenalty = 10;
  else if (input.blastRadiusFiles > 5) blastRadiusPenalty = 5;
  score -= blastRadiusPenalty;

  // 3. Attribution adjustment — high dismissal rates mean the system
  //    learned to suppress noise, so findings are more trustworthy
  let attributionAdjustment = 0;
  if (input.attribution) {
    const highDismissal = input.attribution.categories.filter(
      (c) => c.isReliable && c.dismissalRate > 0.6
    );
    // Each well-learned suppression category makes remaining findings
    // more trustworthy (fewer false positives expected)
    attributionAdjustment = Math.min(highDismissal.length * 2, 10);
    score += attributionAdjustment;
  }

  // 4. Risk score adjustment — high risk scores reduce the safety score
  let riskAdjustment = 0;
  if (input.riskScore >= 4) riskAdjustment = -10;
  else if (input.riskScore >= 3) riskAdjustment = -5;
  score += riskAdjustment;

  return {
    score: Math.max(0, Math.min(100, score)),
    factors: {
      findingPenalty,
      blastRadiusPenalty,
      attributionAdjustment,
      riskAdjustment,
    },
  };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

const SAFETY_SCORE_CONTEXT = "Mizumi Safety Score";

/** Post the safety score as a commit status */
export async function postSafetyScore(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  prNumber: number,
  score: number
): Promise<void> {
  const state = score >= 70 ? "success" : score >= 40 ? "pending" : "failure";
  const description = `Safety: ${score}/100`;

  try {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state,
      target_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      description,
      context: SAFETY_SCORE_CONTEXT,
    });
    core.info(`Safety score: ${score}/100 (${state})`);
  } catch (e) {
    core.warning(`Failed to post safety score: ${e instanceof Error ? e.message : String(e)}`);
  }
}
