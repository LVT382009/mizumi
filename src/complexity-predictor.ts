/**
 * PR Complexity Predictor — estimate review time and complexity score.
 *
 * Competitive gap: No AI code reviewer estimates how long a PR will take
 * to review. DeepSource has a 5-dimension report card but no time estimate.
 * CodeRabbit shows file stats but no complexity prediction. This is an
 * entirely unclaimed feature space.
 *
 * Approach: Multi-signal weighted model combining:
 * - Lines changed + files changed (basic size signal)
 * - Cross-file dependency count (from blast-radius import graph)
 * - Taint trace count (from taint analysis — security-sensitive code is harder to review)
 * - New function/class count (from test-gap symbol detection)
 * - Architecture change penalty (modifying API/interface files vs internals)
 *
 * Weights derived from empirical PR review time baselines:
 *   simple bug fix = 1x, new feature = 2x, architecture change = 3x, security = 4x
 *
 * Zero LLM cost — runs on deterministic signals already computed by other modules.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplexityResult {
  /** Complexity score 1-10 (1=trivial, 10=very complex) */
  score: number;
  /** Estimated review time in minutes */
  estimatedMinutes: number;
  /** Breakdown of contributing factors */
  factors: ComplexityFactor[];
  /** Category label */
  category: "trivial" | "simple" | "moderate" | "complex" | "critical";
  /** Context string for LLM injection */
  contextText: string;
}

export interface ComplexityFactor {
  /** Factor name */
  name: string;
  /** Weighted contribution to the score (0-10) */
  contribution: number;
  /** Human-readable description */
  description: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base review time for a 1-line trivial change (minutes) */
const BASE_REVIEW_MINUTES = 2;

/** Additional minutes per line changed */
const MINUTES_PER_LINE = 0.15;

/** Additional minutes per file changed */
const MINUTES_PER_FILE = 1.5;

/** Architecture change multiplier (API/interface changes cost more) */
const ARCH_CHANGE_MULTIPLIER = 1.8;

/** Security-sensitive change multiplier */
const SECURITY_MULTIPLIER = 1.5;

/** Interface / API file patterns (architecture-level changes) */
const ARCH_FILE_PATTERNS = [
  /\/api\//i,
  /\/interfaces?\//i,
  /\/types?\//i,
  /\/contracts?\//i,
  /\/schemas?\//i,
  /\/protocol/i,
  /\.d\.ts$/,
  /index\.[tj]s$/,
  /mod\.[tj]s$/,
];

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Check if a file path looks like an architecture-level file */
function isArchitectureFile(filePath: string): boolean {
  return ARCH_FILE_PATTERNS.some((p) => p.test(filePath));
}

/** Count new exported symbols in added diff lines */
function countNewExports(diffFiles: DiffFile[]): number {
  let count = 0;
  for (const file of diffFiles) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;
        if (/export\s+(async\s+)?function\s+\w+/.test(change.content)) count++;
        if (/export\s+(default\s+)?class\s+\w+/.test(change.content)) count++;
        if (/export\s+(const|let)\s+\w+\s*=\s*(async\s*)?\(/.test(change.content)) count++;
      }
    }
  }
  return count;
}

/**
 * Compute PR complexity score and estimated review time.
 *
 * @param diffFiles Files changed in this PR
 * @param totalAdditions Total lines added
 * @param totalDeletions Total lines deleted
 * @param crossFileDeps Number of cross-file dependencies (from blast-radius)
 * @param taintTraces Number of taint traces (from taint analysis)
 */
export function computeComplexity(
  diffFiles: DiffFile[],
  totalAdditions: number,
  totalDeletions: number,
  crossFileDeps: number = 0,
  taintTraces: number = 0,
): ComplexityResult {
  const factors: ComplexityFactor[] = [];
  const totalLines = totalAdditions + totalDeletions;
  const fileCount = diffFiles.length;

  // Factor 1: Size — lines changed
  const sizeContrib = Math.min(3, totalLines / 100);
  factors.push({
    name: "size",
    contribution: sizeContrib,
    description: `${totalLines} lines changed across ${fileCount} file(s)`,
  });

  // Factor 2: File spread — many files = more context switching
  const spreadContrib = Math.min(2, fileCount / 10);
  factors.push({
    name: "spread",
    contribution: spreadContrib,
    description: `${fileCount} file(s) modified`,
  });

  // Factor 3: New exports — new API surface area is harder to review
  const newExports = countNewExports(diffFiles);
  const exportContrib = Math.min(2, newExports / 3);
  factors.push({
    name: "new_exports",
    contribution: exportContrib,
    description: `${newExports} new exported symbol(s)`,
  });

  // Factor 4: Architecture changes — modifying API/interface files
  const archFiles = diffFiles.filter((f) => isArchitectureFile(f.path));
  const archContrib = archFiles.length > 0 ? Math.min(1.5, archFiles.length * 0.5) : 0;
  if (archContrib > 0) {
    factors.push({
      name: "architecture",
      contribution: archContrib,
      description: `${archFiles.length} architecture-level file(s) changed: ${archFiles.map((f) => f.path).join(", ")}`,
    });
  }

  // Factor 5: Cross-file dependencies — blast radius signals
  const depContrib = Math.min(1.5, crossFileDeps / 5);
  if (depContrib > 0) {
    factors.push({
      name: "blast_radius",
      contribution: depContrib,
      description: `${crossFileDeps} cross-file dependenc(ies) impacted`,
    });
  }

  // Factor 6: Security taint traces — security-sensitive code needs deeper review
  const secContrib = Math.min(1.5, taintTraces / 3);
  if (secContrib > 0) {
    factors.push({
      name: "security_sensitive",
      contribution: secContrib,
      description: `${taintTraces} taint trace(s) from untrusted sources`,
    });
  }

  // Compute raw score (0-10 scale)
  const rawScore = factors.reduce((sum, f) => sum + f.contribution, 0);
  const score = Math.min(10, Math.max(1, Math.round(rawScore * 10) / 10));

  // Compute estimated review time
  const baseTime = BASE_REVIEW_MINUTES + totalLines * MINUTES_PER_LINE + fileCount * MINUTES_PER_FILE;
  const archMultiplier = archFiles.length > 0 ? ARCH_CHANGE_MULTIPLIER : 1;
  const secMultiplier = taintTraces > 0 ? SECURITY_MULTIPLIER : 1;
  const estimatedMinutes = Math.max(2, Math.round(baseTime * archMultiplier * secMultiplier));

  // Determine category
  let category: ComplexityResult["category"];
  if (score <= 2) category = "trivial";
  else if (score <= 4) category = "simple";
  else if (score <= 6) category = "moderate";
  else if (score <= 8) category = "complex";
  else category = "critical";

  // Build context string
  const contextText = buildComplexityContext(score, estimatedMinutes, category, factors);

  core.info(`Complexity: score=${score}/10, estimated=${estimatedMinutes}min, category=${category}`);

  return { score, estimatedMinutes, factors, category, contextText };
}

/** Build context string for LLM injection and review body */
function buildComplexityContext(
  score: number,
  estimatedMinutes: number,
  category: string,
  factors: ComplexityFactor[],
): string {
  let ctx = `## PR Complexity Assessment\n`;
  ctx += `**Score:** ${score}/10 (${category}) — **Estimated review time:** ~${estimatedMinutes} min\n\n`;
  ctx += `Contributing factors:\n`;

  for (const factor of factors) {
    ctx += `- **${factor.name}**: ${factor.description} (contribution: ${factor.contribution.toFixed(1)})\n`;
  }

  if (score >= 7) {
    ctx += `\n> This PR is complex — consider scheduling dedicated review time and breaking into smaller PRs if possible.\n`;
  }

  return ctx.trim();
}
