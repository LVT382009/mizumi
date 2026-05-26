/**
 * Review Priority Scoring — per-finding relevance signal for developer triage.
 *
 * Each finding gets a priority score (1-10) that combines multiple zero-cost
 * signals so developers can focus on what matters most. No AI reviewer
 * computes per-finding priority today — CodeRabbit sorts by file order,
 * Copilot has no sorting, CodeGuru severity-only.
 *
 * Priority formula (weighted sum, normalized to 1-10):
 *   severity weight:   critical=10, high=8, medium=5, low=2, nitpick=1
 *   confidence factor:  confidence / 100 (0-1 scale)
 *   category weight:    security=1.5x, bug=1.3x, performance=1.1x, others=1.0x
 *   ownership boost:    +2 if finding is in CODEOWNERS-owned path
 *   intent alignment:   +2 if finding category matches change intent (security finding in security PR)
 *   recurrence boost:   +1 per cross-PR recurrence (capped at +3)
 *
 * Zero LLM cost. All inputs are deterministic signals already computed
 * by other Mizumi modules.
 */
import type { ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriorityInput {
  finding: ReviewCommentType;
  /** Whether the file is in an owned CODEOWNERS path */
  isOwned?: boolean;
  /** Change intent of the file (from intent-classifier) */
  fileIntent?: string;
  /** Number of other PRs with same pattern (from cross-PR persistence) */
  recurrenceCount?: number;
}

export interface PrioritizedFinding {
  finding: ReviewCommentType;
  priority: number;
  /** Human-readable priority level */
  priorityLevel: "critical" | "high" | "medium" | "low";
  /** Breakdown of the score for transparency */
  breakdown: PriorityBreakdown;
}

export interface PriorityBreakdown {
  severityScore: number;
  confidenceFactor: number;
  categoryMultiplier: number;
  ownershipBoost: number;
  intentBoost: number;
  recurrenceBoost: number;
  rawScore: number;
}

export interface PriorityResult {
  findings: PrioritizedFinding[];
  /** Average priority across all findings */
  averagePriority: number;
  /** Context text for LLM prompt (sorted findings with priority labels) */
  contextText: string;
  /** Review body summary (priority distribution table) */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 10,
  high: 8,
  medium: 5,
  low: 2,
  nitpick: 1,
};

const CATEGORY_MULTIPLIER: Record<string, number> = {
  security: 1.5,
  bug: 1.3,
  performance: 1.1,
  style: 0.8,
  architecture: 1.0,
  compliance: 1.2,
};

const INTENT_CATEGORY_MAP: Record<string, string[]> = {
  security: ["security"],
  bugfix: ["bug"],
  perf: ["performance"],
};

const MAX_RECURRENCE_BOOST = 3;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Compute priority score for a single finding. */
export function computePriority(input: PriorityInput): PrioritizedFinding {
  const { finding, isOwned, fileIntent, recurrenceCount } = input;

  // 1. Severity base score
  const severityScore = SEVERITY_WEIGHT[finding.severity] ?? 3;

  // 2. Confidence factor (0-1)
  const confidenceFactor = (finding.confidence ?? 50) / 100;

  // 3. Category multiplier
  const categoryMultiplier = CATEGORY_MULTIPLIER[finding.category] ?? 1.0;

  // 4. Ownership boost (+2 if in owned path)
  const ownershipBoost = isOwned ? 2 : 0;

  // 5. Intent alignment boost (+2 if finding category matches change intent)
  let intentBoost = 0;
  if (fileIntent) {
    const alignedCategories = INTENT_CATEGORY_MAP[fileIntent];
    if (alignedCategories && alignedCategories.includes(finding.category)) {
      intentBoost = 2;
    }
  }

  // 6. Recurrence boost (+1 per cross-PR recurrence, capped at 3)
  const recurrenceBoost = Math.min(recurrenceCount ?? 0, MAX_RECURRENCE_BOOST);

  // Raw score: severity * confidence * category + ownership + intent + recurrence
  const rawScore = (severityScore * confidenceFactor * categoryMultiplier)
    + ownershipBoost + intentBoost + recurrenceBoost;

  // Normalize to 1-10 scale
  // Max without boosts: 10 * 1.0 * 1.5 = 15
  // Max with all boosts: 10 * 1.0 * 1.5 + 2 + 2 + 3 = 24
  // Use 15 as denominator so base severity+confidence scores fill 1-10 range
  // then add boost points directly (capped at 10)
  const baseNormalized = (severityScore * confidenceFactor * categoryMultiplier / 15) * 7;
  const priority = Math.max(1, Math.min(10, Math.round(baseNormalized + ownershipBoost + intentBoost + recurrenceBoost)));

  let priorityLevel: PrioritizedFinding["priorityLevel"];
  if (priority >= 8) priorityLevel = "critical";
  else if (priority >= 6) priorityLevel = "high";
  else if (priority >= 3) priorityLevel = "medium";
  else priorityLevel = "low";

  return {
    finding,
    priority,
    priorityLevel,
    breakdown: {
      severityScore,
      confidenceFactor,
      categoryMultiplier,
      ownershipBoost,
      intentBoost,
      recurrenceBoost,
      rawScore,
    },
  };
}

/** Compute priority scores for all findings and sort by priority descending. */
export function prioritizeFindings(inputs: PriorityInput[]): PriorityResult {
  const scored = inputs.map(computePriority);
  scored.sort((a, b) => b.priority - a.priority);

  const averagePriority = scored.length > 0
    ? Math.round(scored.reduce((s, f) => s + f.priority, 0) / scored.length * 10) / 10
    : 0;

  return {
    findings: scored,
    averagePriority,
    contextText: buildPriorityContext(scored, averagePriority),
    bodySummary: buildPriorityBodySummary(scored, averagePriority),
  };
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildPriorityContext(findings: PrioritizedFinding[], avg: number): string {
  if (findings.length === 0) return "";

  let ctx = `## Priority-Triaged Findings (avg priority ${avg}/10)\n`;
  ctx += "Findings sorted by priority score. Focus on critical/high first:\n\n";

  for (const f of findings.slice(0, 10)) {
    const badge = f.priorityLevel === "critical" ? "[CRITICAL]"
      : f.priorityLevel === "high" ? "[HIGH]"
      : f.priorityLevel === "medium" ? "[MED]"
      : "[LOW]";
    ctx += `- ${badge} P${f.priority} ${f.finding.file}:${f.finding.line} — ${f.finding.category}: ${f.finding.message.substring(0, 80)}\n`;
  }

  if (findings.length > 10) {
    ctx += `\n... and ${findings.length - 10} more findings.\n`;
  }

  return ctx.trim() + "\n";
}

function buildPriorityBodySummary(findings: PrioritizedFinding[], avg: number): string {
  if (findings.length === 0) return "";

  const critical = findings.filter(f => f.priorityLevel === "critical").length;
  const high = findings.filter(f => f.priorityLevel === "high").length;
  const medium = findings.filter(f => f.priorityLevel === "medium").length;
  const low = findings.filter(f => f.priorityLevel === "low").length;

  let body = `<details><summary><strong>Priority Triage</strong> — avg ${avg}/10</summary>\n\n`;
  body += "| Level | Count | Action |\n|-------|-------|--------|\n";
  body += `| :rotating_light: Critical | ${critical} | Fix before merge |\n`;
  body += `| :red_circle: High | ${high} | Fix soon |\n`;
  body += `| :orange_circle: Medium | ${medium} | Review if time |\n`;
  body += `| :white_circle: Low | ${low} | Optional |\n\n`;
  body += "*Priority combines severity, confidence, ownership, intent alignment, and recurrence.*\n</details>\n";

  return body;
}
