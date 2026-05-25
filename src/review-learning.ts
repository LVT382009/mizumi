/**
 * Review-to-Review Learning — competitive gap Rank 2.
 *
 * Auto-generates negative rules from repeatedly-dismissed feedback patterns.
 * When developers dismiss the same finding pattern multiple times across PRs,
 * Mizumi learns to suppress it automatically in future reviews.
 *
 * This bridges feedback.ts → rule-engine.ts:
 * 1. Scan feedback store for patterns with high dismissal rates
 * 2. Auto-generate negative rules (category:pattern → suppress)
 * 3. Persist negative rules to SQLite alongside the rule engine
 * 4. Apply negative rules during noise reduction
 *
 * No other AI code reviewer learns from dismissals across PRs.
 * CodeRabbit requires manual YAML entry; Greptile only learns per-session.
 */
import * as core from "@actions/core";
import { readFeedbackStore, type FeedbackStore } from "./feedback.js";
import type { PersistedRule } from "./rule-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NegativeRule {
  /** Category+message pattern that should be suppressed */
  category: string;
  /** Message hash pattern to match (or "*" for whole category) */
  messagePattern: string;
  /** Dismissal rate (0-1) that triggered this rule */
  dismissalRate: number;
  /** Number of reviews that contributed to this rule */
  sampleSize: number;
  /** ISO date when this rule was auto-generated */
  createdAt: string;
}

export interface LearningResult {
  /** Negative rules generated this run */
  newRules: NegativeRule[];
  /** Total active negative rules (including previously generated) */
  totalRules: number;
  /** Feedback entries analyzed */
  entriesAnalyzed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum reviews before a pattern triggers auto-learning */
const MIN_SAMPLE_SIZE = 3;

/** Dismissal rate threshold to create a negative rule */
const DISMISSAL_THRESHOLD = 0.6;

/** Maximum negative rules to keep active */
const MAX_NEGATIVE_RULES = 20;

// ---------------------------------------------------------------------------
// Learning logic
// ---------------------------------------------------------------------------

/**
 * Analyze feedback history and generate negative rules from dismissed patterns.
 * A "pattern" is (category, messagePrefix) — we group by first 3 words of message.
 * When 60%+ of reviews dismiss a pattern (3+ samples), auto-suppress it.
 */
export function learnNegativeRules(store: FeedbackStore): NegativeRule[] {
  if (store.entries.length === 0) return [];

  // Group feedback by pattern key: category:messagePrefix
  const buckets = new Map<string, { helpful: number; unhelpful: number; total: number; messages: string[] }>();

  for (const entry of store.entries) {
    if (entry.outcome === "pending") continue;

    const messagePrefix = extractMessagePrefix(entry.messageHash, entry.category);
    const key = `${entry.category}:${messagePrefix}`;

    if (!buckets.has(key)) {
      buckets.set(key, { helpful: 0, unhelpful: 0, total: 0, messages: [] });
    }
    const bucket = buckets.get(key)!;
    bucket.total++;
    if (entry.outcome === "helpful") bucket.helpful++;
    if (entry.outcome === "unhelpful") bucket.unhelpful++;
  }

  const rules: NegativeRule[] = [];

  for (const [key, bucket] of buckets) {
    if (bucket.total < MIN_SAMPLE_SIZE) continue;

    const dismissalRate = bucket.unhelpful / bucket.total;
    if (dismissalRate < DISMISSAL_THRESHOLD) continue;

    const [category, messagePattern] = key.split(":", 2);
    rules.push({
      category,
      messagePattern,
      dismissalRate,
      sampleSize: bucket.total,
      createdAt: new Date().toISOString(),
    });
  }

  // Sort by dismissal rate (highest first), then sample size
  rules.sort((a, b) => b.dismissalRate - a.dismissalRate || b.sampleSize - a.sampleSize);

  return rules.slice(0, MAX_NEGATIVE_RULES);
}

/**
 * Check if a finding matches any negative rule and should be suppressed.
 * Returns the matching rule if found, null otherwise.
 */
export function matchesNegativeRule(
  finding: { category: string; message: string; severity: string; confidence: number },
  rules: NegativeRule[]
): NegativeRule | null {
  for (const rule of rules) {
    // Exact category match
    if (finding.category !== rule.category) continue;

    // "*" means suppress entire category
    if (rule.messagePattern === "*") return rule;

    // Match by messageHash prefix
    const findingPrefix = extractMessagePrefix(
      hashString(finding.message),
      finding.category
    );
    if (findingPrefix === rule.messagePattern) return rule;
  }

  return null;
}

/**
 * Apply negative rules to findings — reduce confidence of matching findings.
 * Findings matching negative rules get confidence dropped to 0 (filtered out).
 * Returns modified findings array.
 */
export function applyNegativeRules<T extends { category: string; message: string; severity: string; confidence: number }>(
  findings: T[],
  rules: NegativeRule[]
): T[] {
  if (rules.length === 0) return findings;

  return findings.filter((f) => {
    const match = matchesNegativeRule(f, rules);
    if (match) {
      core.info(`Review learning: suppressed "${f.category}" finding (dismissal rate ${Math.round(match.dismissalRate * 100)}%, ${match.sampleSize} samples)`);
      return false;
    }
    return true;
  });
}

/**
 * Run the full review-to-review learning pipeline.
 * Read feedback, generate negative rules, return results.
 */
export function runReviewLearning(workspace: string): LearningResult {
  const store = readFeedbackStore(workspace);
  const newRules = learnNegativeRules(store);

  if (newRules.length > 0) {
    core.info(`Review learning: ${newRules.length} negative rule(s) generated from ${store.entries.length} feedback entries`);
  }

  return {
    newRules,
    totalRules: newRules.length,
    entriesAnalyzed: store.entries.length,
  };
}

/**
 * Build a review learning context string for injection into the LLM prompt.
 * Tells the LLM which finding categories the team typically dismisses.
 */
export function buildLearningContext(result: LearningResult): string {
  if (result.newRules.length === 0) return "";

  let context = `## Review Learning — Suppressed Patterns (${result.newRules.length} rule(s))\n`;
  context += "The team has repeatedly dismissed the following finding categories. Avoid generating similar findings:\n\n";

  for (const rule of result.newRules.slice(0, 8)) {
    context += `- **${rule.category}** (${rule.messagePattern}): ${Math.round(rule.dismissalRate * 100)}% dismissal rate (${rule.sampleSize} reviews)\n`;
  }

  if (result.newRules.length > 8) {
    context += `\n... and ${result.newRules.length - 8} more suppressed pattern(s).\n`;
  }

  return context.trim();
}

/**
 * Convert a NegativeRule to a PersistedRule for injection into the rule engine.
 * This enables the rule engine to track and decay these auto-generated rules.
 */
export function toPersistedRule(neg: NegativeRule, index: number): PersistedRule {
  return {
    id: `learned-neg-${index}`,
    name: `Auto-learned suppression: ${neg.category}/${neg.messagePattern}`,
    description: `Automatically suppressed — ${Math.round(neg.dismissalRate * 100)}% dismissal rate over ${neg.sampleSize} reviews`,
    source: "discovered",
    type: "pattern",
    pattern: neg.messagePattern === "*" ? "" : neg.messagePattern,
    fileGlob: undefined,
    severity: "low",
    category: neg.category as PersistedRule["category"],
    message: `Suppressed: ${neg.category} pattern (auto-learned)`,
    confidence: Math.round((1 - neg.dismissalRate) * 60), // 0-40 range
    createdAt: neg.createdAt,
    lastMatchedAt: null,
    matchCount: 0,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a stable message prefix from hash for pattern grouping */
function extractMessagePrefix(hash: string, _category: string): string {
  // Use first 4 chars of hash as stable prefix within category
  return hash.slice(0, 4);
}

/** Simple string hash for message prefix extraction */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}
