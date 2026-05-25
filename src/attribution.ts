/**
 * Attribution-Driven Feedback Loop — proportional confidence adjustment
 * based on per-category dismissal rates.
 *
 * Competitive gap (P0-A): Only Sourcery learns from dismissed comments.
 * Mizumi already has feedback.ts + review-learning.ts + adaptive noise.
 * This module enhances the pipeline with:
 * 1. Per-category dismissal rate computation (weighted by recency)
 * 2. Proportional confidence reduction (not a flat 25-point cut)
 * 3. Attribution insights for the fatigue dashboard
 *
 * Instead of hard-suppressing or flat -25, findings get confidence reduced
 * proportionally: 60% dismissal → -30 confidence, 80% → -50, 100% → -75.
 * This preserves edge-case findings while still cutting noise.
 *
 * Data source: feedback.ts store (helpful/unhelpful reactions)
 */
import * as core from "@actions/core";
import { readFeedbackStore, type FeedbackStore } from "./feedback.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryAttribution {
  /** Finding category (security, bug, style, etc.) */
  category: string;
  /** Total resolved feedback entries */
  total: number;
  /** Helpful count */
  helpful: number;
  /** Unhelpful/dismissed count */
  dismissed: number;
  /** Dismissal rate (0-1) */
  dismissalRate: number;
  /** Confidence penalty derived from dismissal rate (0-75) */
  confidencePenalty: number;
  /** Whether this category passes the minimum sample threshold */
  isReliable: boolean;
}

export interface AttributionResult {
  categories: CategoryAttribution[];
  /** Categories with reliable dismissal rates */
  reliableCategories: number;
  /** Total feedback entries analyzed */
  entriesAnalyzed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum samples for statistically reliable dismissal rate */
const MIN_RELIABLE_SAMPLES = 10;

/** Maximum confidence penalty (never reduce by more than this) */
const MAX_PENALTY = 75;

/** Penalty curve: dismissal_rate * PENALTY_MULTIPLIER = confidence penalty */
const PENALTY_MULTIPLIER = 75;

/**
 * Recency decay factor — entries older than 30 days are weighted less.
 * This prevents stale feedback from permanently suppressing categories
 * that may have improved (e.g., after a model upgrade).
 */
const RECENCY_HALF_LIFE_DAYS = 30;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Compute per-category attribution from the feedback store */
export function computeAttribution(store: FeedbackStore): AttributionResult {
  const buckets = new Map<string, { weightedHelpful: number; weightedDismissed: number; rawHelpful: number; rawDismissed: number }>();
  const now = Date.now();

  for (const entry of store.entries) {
    if (entry.outcome === "pending") continue;

    const cat = entry.category;
    if (!buckets.has(cat)) {
      buckets.set(cat, { weightedHelpful: 0, weightedDismissed: 0, rawHelpful: 0, rawDismissed: 0 });
    }
    const bucket = buckets.get(cat)!;

    // Recency weighting — exponential decay
    const entryDate = new Date(entry.createdAt).getTime();
    const ageDays = (now - entryDate) / (1000 * 60 * 60 * 24);
    const recencyWeight = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

    if (entry.outcome === "helpful") {
      bucket.weightedHelpful += recencyWeight;
      bucket.rawHelpful++;
    } else {
      bucket.weightedDismissed += recencyWeight;
      bucket.rawDismissed++;
    }
  }

  const categories: CategoryAttribution[] = [];

  for (const [category, bucket] of buckets) {
    const total = bucket.rawHelpful + bucket.rawDismissed;
    const weightedTotal = bucket.weightedHelpful + bucket.weightedDismissed;
    const dismissalRate = weightedTotal > 0 ? bucket.weightedDismissed / weightedTotal : 0.5;

    // Proportional penalty: only apply when dismissal > 40%
    const confidencePenalty = dismissalRate > 0.4
      ? Math.round(dismissalRate * PENALTY_MULTIPLIER)
      : 0;

    const isReliable = total >= MIN_RELIABLE_SAMPLES;

    categories.push({
      category,
      total,
      helpful: bucket.rawHelpful,
      dismissed: bucket.rawDismissed,
      dismissalRate: Math.round(dismissalRate * 100) / 100,
      confidencePenalty: Math.min(confidencePenalty, MAX_PENALTY),
      isReliable,
    });
  }

  // Sort by dismissal rate (highest first)
  categories.sort((a, b) => b.dismissalRate - a.dismissalRate);

  const reliableCategories = categories.filter((c) => c.isReliable).length;

  return { categories, reliableCategories, entriesAnalyzed: store.entries.length };
}

/**
 * Apply proportional confidence adjustment based on attribution data.
 * Unlike the flat -25 in feedback.ts, this scales with dismissal rate.
 * Categories with <40% dismissal are not penalized at all.
 */
export function applyAttributionConfidence<T extends { category: string; confidence: number }>(
  findings: T[],
  attribution: AttributionResult
): T[] {
  const penaltyMap = new Map<string, { penalty: number; reliable: boolean }>();
  for (const cat of attribution.categories) {
    if (cat.isReliable && cat.confidencePenalty > 0) {
      penaltyMap.set(cat.category, { penalty: cat.confidencePenalty, reliable: cat.isReliable });
    }
  }

  if (penaltyMap.size === 0) return findings;

  let adjusted = 0;
  const result = findings.map((f) => {
    const entry = penaltyMap.get(f.category);
    if (!entry) return f;

    const newConfidence = Math.max(10, f.confidence - entry.penalty);
    if (newConfidence < f.confidence) {
      adjusted++;
      return { ...f, confidence: newConfidence };
    }
    return f;
  });

  if (adjusted > 0) {
    core.info(`Attribution: ${adjusted} findings confidence-adjusted across ${penaltyMap.size} categories`);
  }

  return result;
}

/**
 * Build attribution context for LLM prompt injection.
 * Tells the LLM which categories the team typically dismisses.
 */
export function buildAttributionContext(result: AttributionResult): string {
  const reliable = result.categories.filter((c) => c.isReliable && c.dismissalRate > 0.4);
  if (reliable.length === 0) return "";

  let ctx = `## Team Attribution (from ${result.entriesAnalyzed} feedback entries)\n`;
  ctx += "The team frequently dismisses findings in these categories. ";
  ctx += "Prioritize other finding types or raise the bar for these:\n\n";

  for (const cat of reliable.slice(0, 6)) {
    ctx += `- **${cat.category}**: ${Math.round(cat.dismissalRate * 100)}% dismissal (${cat.dismissed}/${cat.total}) → confidence penalty -${cat.confidencePenalty}\n`;
  }

  return ctx.trim();
}

/** Run the attribution pipeline from the workspace feedback store */
export function runAttributionAnalysis(workspace: string): AttributionResult {
  const store = readFeedbackStore(workspace);
  const result = computeAttribution(store);

  if (result.reliableCategories > 0) {
    core.info(`Attribution: ${result.reliableCategories} reliable categories from ${result.entriesAnalyzed} entries`);
    for (const cat of result.categories.filter((c) => c.isReliable)) {
      core.info(`  ${cat.category}: ${Math.round(cat.dismissalRate * 100)}% dismissal (${cat.total} samples), penalty -${cat.confidencePenalty}`);
    }
  }

  return result;
}
