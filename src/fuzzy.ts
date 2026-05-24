/**
 * Fuzzy dedup — prevents near-duplicate review comments on re-reviews.
 * Uses rapid-fuzzy (Rust+WASM) for 569x faster matching than JS alternatives.
 *
 * Implementation plan 2.11: tokenSetRatio > 0.85 = duplicate.
 * rapid-fuzzy v2.0.0 returns 0-1 range (NOT 0-100 like Python RapidFuzz).
 */
import * as core from "@actions/core";
import { tokenSetRatioMany } from "rapid-fuzzy";
import { ReviewCommentType } from "./review.js";

const DUPLICATE_THRESHOLD = 0.85;
const STALE_THRESHOLD = 0.70;

export interface ExistingComment {
  id: number;
  file: string;
  line: number;
  body: string;
}

/**
 * Filter out findings that are near-duplicates of existing bot comments.
 * Uses tokenSetRatio for semantic similarity (order-independent token matching).
 */
export function deduplicateFindings(
  newFindings: ReviewCommentType[],
  existing: ExistingComment[]
): ReviewCommentType[] {
  if (existing.length === 0) return newFindings;

  const existingMessages = existing.map((c) => stripMarker(c.body));

  const kept: ReviewCommentType[] = [];
  let dupesSkipped = 0;

  for (const finding of newFindings) {
    const scores = tokenSetRatioMany(finding.message, existingMessages, DUPLICATE_THRESHOLD);
    const isDuplicate = scores.some((s) => s >= DUPLICATE_THRESHOLD);
    if (isDuplicate) {
      dupesSkipped++;
    } else {
      kept.push(finding);
    }
  }

  if (dupesSkipped > 0) {
    core.info(`Fuzzy dedup: skipped ${dupesSkipped} near-duplicate finding(s)`);
  }

  return kept;
}

/**
 * Find existing comments that are stale — they no longer match
 * any of the current findings and should be cleaned up.
 */
export function findStaleComments(
  currentFindings: ReviewCommentType[],
  existing: ExistingComment[]
): ExistingComment[] {
  if (existing.length === 0 || currentFindings.length === 0) return [];

  const findingMessages = currentFindings.map((f) => f.message);
  const stale: ExistingComment[] = [];

  for (const comment of existing) {
    const body = stripMarker(comment.body);
    if (!body) continue;

    const scores = tokenSetRatioMany(body, findingMessages, STALE_THRESHOLD);
    if (scores.every((s) => s < STALE_THRESHOLD)) {
      stale.push(comment);
    }
  }

  return stale;
}

/** Remove HTML marker and formatting from comment body for comparison. */
function stripMarker(body: string): string {
  return body
    .replace(/<!-- mizumi-review-marker -->/g, "")
    .replace(/\*\*\[\w+\]\s*\w+\*\*:\s*/g, "")
    .replace(/```suggestion[\s\S]*?```/g, "")
    .replace(/\[Open in VS Code\].*/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();
}
