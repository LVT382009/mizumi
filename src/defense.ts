/**
 * Prompt Injection Defense Framework — multi-layer defense-in-depth.
 *
 * No AI code review tool has an explicit prompt injection defense layer.
 * Mizumi is the first. This module formalizes the existing sanitize/screen
 * into a named architecture with content provenance tags and behavioral monitoring.
 *
 * Three layers:
 *   1. Input Sanitization (sanitizeInput) — strips injection payload before LLM
 *   2. Output Screening (screenOutput) — prevents secret exfiltration via comments
 *   3. Content Provenance — tags content by trust level (user/retrieved/generated)
 *
 * References:
 *   - PromptArmor: LLM-as-filter (>99% detection, +200-600ms latency)
 *   - PromptGuard: 4-layer framework (67% reduction)
 *   - Multi-Model Voting: 60-75% reduction at 2-5x cost
 *   - 2026 research: "prompt injection cannot be fully prevented, so bound the blast radius"
 */
import { sanitizeInput, screenOutput } from "./sanitize.js";
import type { ReviewResponseType } from "./review.js";

/** Content trust level — how much to trust a content source */
export type TrustLevel = "user" | "retrieved" | "generated";

/** Provenance tag for a content segment */
export interface ProvenanceTag {
  source: TrustLevel;
  label: string;
  timestamp: string;
}

/**
 * Tag content with its provenance (trust level).
 * - "user": PR title, description, diff — highest risk, least trusted
 * - "retrieved": MEMORY.md, rules files, agent context — medium risk
 * - "generated": LLM output, review comments — lowest risk for injection
 */
export function tagProvenance(content: string, source: TrustLevel, label: string): string {
  const tag = `[provenance:${source}:${label}]`;
  return `${tag}\n${content}\n[/provenance:${source}:${label}]`;
}

/**
 * Strip provenance tags from content (for final output).
 */
export function stripProvenance(content: string): string {
  return content.replace(/\[\/?provenance:\w+:[^\]]+\]\n?/g, "");
}

/**
 * Full input defense pipeline — sanitize + provenance tag.
 * Run on all untrusted content before it enters the LLM context window.
 */
export function defendInput(raw: string, source: TrustLevel, label: string): string {
  const sanitized = sanitizeInput(raw);
  return tagProvenance(sanitized, source, label);
}

/**
 * Full output defense pipeline — screen + validate.
 * Run on all LLM output before it goes to GitHub.
 */
export function defendOutput(text: string): string {
  return screenOutput(text);
}

/**
 * Validate that a review output meets structural expectations.
 * Detects "behavioral anomalies" — suspicious changes in output shape
 * that could indicate a prompt injection got through.
 */
export function validateReviewOutput(review: ReviewResponseType): {
  valid: boolean;
  anomalies: string[];
} {
  const anomalies: string[] = [];

  // Anomaly: risk score outside valid range
  if (review.riskScore < 1 || review.riskScore > 5) {
    anomalies.push(`risk score ${review.riskScore} outside valid range [1,5]`);
  }

  // Anomaly: decision doesn't match severity of findings
  const hasCriticalOrHigh = review.comments.some(
    (c) => c.severity === "critical" || c.severity === "high"
  );
  if (review.decision === "approve" && hasCriticalOrHigh) {
    anomalies.push("approve decision despite critical/high findings");
  }

  // Anomaly: confidence out of range
  const outOfRange = review.comments.filter(
    (c) => c.confidence < 0 || c.confidence > 100
  );
  if (outOfRange.length > 0) {
    anomalies.push(`${outOfRange.length} finding(s) with confidence outside [0,100]`);
  }

  // Anomaly: empty file path
  const emptyFiles = review.comments.filter(
    (c) => !c.file || c.file.trim().length === 0
  );
  if (emptyFiles.length > 0) {
    anomalies.push(`${emptyFiles.length} finding(s) with empty file path`);
  }

  // Anomaly: line number <= 0
  const invalidLines = review.comments.filter((c) => c.line <= 0);
  if (invalidLines.length > 0) {
    anomalies.push(`${invalidLines.length} finding(s) with line number <= 0`);
  }

  // Anomaly: suspiciously many findings (potential comment flooding)
  if (review.comments.length > 50) {
    anomalies.push(`${review.comments.length} findings (potential comment flooding)`);
  }

  return { valid: anomalies.length === 0, anomalies };
}

/**
 * Defense report — summary of what was filtered/flagged.
 * Useful for debugging and transparency.
 */
export interface DefenseReport {
  inputFiltered: number;
  outputRedacted: number;
  anomalies: string[];
  layersApplied: string[];
}

const NO_ISSUES: DefenseReport = {
  inputFiltered: 0,
  outputRedacted: 0,
  anomalies: [],
  layersApplied: ["input-sanitization", "output-screening", "provenance-tagging"],
};

/**
 * Create an empty defense report.
 */
export function emptyDefenseReport(): DefenseReport {
  return { ...NO_ISSUES };
}
