/**
 * Finding Dedup Engine — merge overlapping findings from multiple sources.
 *
 * When a PR is reviewed by multiple sources (chunk review, swarm specialists,
 * cached results, rule engine), the same issue may appear multiple times.
 * This module deduplicates by:
 *   1. Exact match: same file + line + category + message hash
 *   2. Proximity merge: same file + category within N lines → keep highest severity
 *   3. Fuzzy message: same file + line + category + similar message (Levenshtein)
 *
 * No competitor does intelligent cross-source finding dedup.
 * CodeRabbit and Copilot just concatenate all sources with no merging.
 * Mizumi keeps the highest-severity, highest-confidence version.
 *
 * Zero LLM cost. Pure heuristic.
 */
import type { ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeverityLevel = "critical" | "high" | "medium" | "low" | "nitpick";

export interface DedupSource {
  name: string;
  findings: ReviewCommentType[];
}

export interface DedupResult {
  /** Merged findings after dedup */
  findings: ReviewCommentType[];
  /** Stats about what was deduped */
  stats: {
    inputCount: number;
    outputCount: number;
    duplicatesRemoved: number;
    proximityMerges: number;
    sourceBreakdown: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<SeverityLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  nitpick: 1,
};

function severityRank(s: string): number {
  return SEVERITY_ORDER[s as SeverityLevel] ?? 0;
}

function higherSeverity(a: string, b: string): string {
  return severityRank(a) >= severityRank(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/** Exact fingerprint: file + line + category + message hash */
function exactFingerprint(f: ReviewCommentType): string {
  return `${f.file}::${f.line}::${f.category}::${simpleHash(f.message)}`;
}

/** Proximity key: file + category (for nearby-line merging) */
function proximityKey(f: ReviewCommentType): string {
  return `${f.file}::${f.category}`;
}

/** Simple non-cryptographic hash (FNV-1a 32-bit) */
function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Levenshtein distance (for fuzzy message matching)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

/** Are two messages similar enough to be considered the same finding? */
function messagesSimilar(a: string, b: string, threshold: number = 0.7): boolean {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  const dist = levenshtein(a, b);
  const similarity = 1 - dist / maxLen;
  return similarity >= threshold;
}

// ---------------------------------------------------------------------------
// Merge two findings — keep the better version
// ---------------------------------------------------------------------------

function mergeFindings(a: ReviewCommentType, b: ReviewCommentType): ReviewCommentType {
  // Keep higher severity
  const severity = higherSeverity(a.severity, b.severity) as SeverityLevel;
  // Keep higher confidence
  const confidence = Math.max(a.confidence, b.confidence);
  // Keep longer message (more detail)
  const message = a.message.length >= b.message.length ? a.message : b.message;
  // Keep suggestion if available
  const suggestion = a.suggestion || b.suggestion;
  // Keep earlier endLine if set
  const endLine = a.endLine ?? b.endLine;

  return {
    file: a.file,
    line: a.line,
    endLine,
    severity,
    category: a.category,
    message,
    suggestion,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_PROXIMITY_LINES = 5;
const DEFAULT_FUZZY_THRESHOLD = 0.7;

export interface DedupOptions {
  /** Merge findings within N lines of each other (same file + category) */
  proximityLines?: number;
  /** Similarity threshold for fuzzy message matching (0-1) */
  fuzzyThreshold?: number;
}

/**
 * Deduplicate findings from multiple sources.
 *
 * Strategy:
 * 1. Exact dedup: same file + line + category + message hash
 * 2. Proximity merge: same file + category within proximityLines
 * 3. Fuzzy match: same file + line + category + similar message
 */
export function dedupFindings(
  sources: DedupSource[],
  options: DedupOptions = {},
): DedupResult {
  const proximityLines = options.proximityLines ?? DEFAULT_PROXIMITY_LINES;
  const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;

  let inputCount = 0;
  const sourceBreakdown: Record<string, number> = {};
  const allFindings: ReviewCommentType[] = [];

  for (const source of sources) {
    inputCount += source.findings.length;
    sourceBreakdown[source.name] = source.findings.length;
    allFindings.push(...source.findings);
  }

  // Phase 1: Exact dedup (same fingerprint)
  const seen = new Map<string, ReviewCommentType>();
  let duplicatesRemoved = 0;
  for (const f of allFindings) {
    const fp = exactFingerprint(f);
    const existing = seen.get(fp);
    if (existing) {
      seen.set(fp, mergeFindings(existing, f));
      duplicatesRemoved++;
    } else {
      seen.set(fp, f);
    }
  }

  // Phase 2: Proximity merge (same file + category within N lines)
  let proximityMerges = 0;
  const byProximity = new Map<string, ReviewCommentType[]>();
  for (const f of Array.from(seen.values())) {
    const key = proximityKey(f);
    if (!byProximity.has(key)) byProximity.set(key, []);
    byProximity.get(key)!.push(f);
  }

  const proximityMerged: ReviewCommentType[] = [];
  for (const [, group] of Array.from(byProximity.entries())) {
    // Sort by line number
    group.sort((a, b) => a.line - b.line);
    const merged: ReviewCommentType[] = [];
    for (const f of group) {
      // Check if this can merge with the last finding in the merged list
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        if (Math.abs(f.line - last.line) <= proximityLines && f.category === last.category && f.file === last.file && messagesSimilar(last.message, f.message, fuzzyThreshold * 0.8)) {
          merged[merged.length - 1] = mergeFindings(last, f);
          proximityMerges++;
          continue;
        }
      }
      merged.push(f);
    }
    proximityMerged.push(...merged);
  }

  // Phase 3: Fuzzy message dedup (same file + line + category, similar message)
  const finalFindings: ReviewCommentType[] = [];
  const fuzzySeen: ReviewCommentType[] = [];
  for (const f of proximityMerged) {
    let isDupe = false;
    for (const existing of fuzzySeen) {
      if (
        existing.file === f.file &&
        existing.line === f.line &&
        existing.category === f.category &&
        messagesSimilar(existing.message, f.message, fuzzyThreshold)
      ) {
        // Replace with merged version
        const idx = fuzzySeen.indexOf(existing);
        fuzzySeen[idx] = mergeFindings(existing, f);
        isDupe = true;
        duplicatesRemoved++;
        break;
      }
    }
    if (!isDupe) {
      fuzzySeen.push(f);
    }
  }
  finalFindings.push(...fuzzySeen);

  const outputCount = finalFindings.length;
  return {
    findings: finalFindings,
    stats: {
      inputCount,
      outputCount,
      duplicatesRemoved,
      proximityMerges,
      sourceBreakdown,
    },
  };
}

/**
 * Format dedup stats for logging.
 */
export function formatDedupStats(stats: DedupResult["stats"]): string {
  const dedupRate = stats.inputCount > 0
    ? Math.round(((stats.inputCount - stats.outputCount) / stats.inputCount) * 100)
    : 0;
  const sources = Object.entries(stats.sourceBreakdown)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  return `Finding dedup: ${stats.inputCount}→${stats.outputCount} (${dedupRate}% reduction, ${stats.duplicatesRemoved} exact dupes, ${stats.proximityMerges} proximity merges) | sources: ${sources}`;
}

/**
 * Temporary proximity line count for testing.
 */
export { DEFAULT_PROXIMITY_LINES, DEFAULT_FUZZY_THRESHOLD, levenshtein, messagesSimilar, simpleHash };
