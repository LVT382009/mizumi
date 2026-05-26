/**
 * Finding Lifecycle Tracking — competitive gap #1.
 *
 * Track findings per PR across pushes. When a PR gets a new push, detect
 * which findings from the previous review are still present versus resolved.
 * Surface "3 findings from your last push are still unresolved" so reviewers
 * stop re-raising the same issues and authors see what they missed.
 *
 * No other AI code reviewer tracks finding lifecycle across review iterations.
 * CodeRabbit, CodeGuru, Sourcery, etc. all treat each push as a fresh review.
 *
 * Implementation:
 * 1. Store fingerprinted findings per PR in a lightweight JSON store
 * 2. On re-review, compare new findings against previous iteration
 * 3. Classify as: persisted (still present), resolved (gone), or new
 * 4. Inject lifecycle context into the LLM review prompt
 * 5. Add lifecycle summary to the review body
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import type { ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FindingFingerprint {
  /** Stable identity: file + line + category + message hash */
  key: string;
  file: string;
  line: number;
  category: string;
  severity: string;
  messageHash: string;
}

export interface FindingsSnapshot {
  /** PR key: "owner/repo#prNumber" */
  prKey: string;
  /** SHA that was reviewed */
  sha: string;
  /** Iteration number (1 = first review, 2 = after first push, etc.) */
  iteration: number;
  /** Timestamp */
  timestamp: number;
  /** Fingerprinted findings from this iteration */
  findings: FindingFingerprint[];
}

export interface LifecycleResult {
  /** Findings that persisted from the previous iteration */
  persisted: FindingFingerprint[];
  /** Findings that were resolved between iterations */
  resolved: FindingFingerprint[];
  /** Findings that are new in this iteration */
  newFindings: FindingFingerprint[];
  /** Previous iteration number (0 if first review) */
  previousIteration: number;
  /** Current iteration number */
  currentIteration: number;
  /** Summary text for the review body */
  contextText: string;
}

interface LifecycleStore {
  /** Map of prKey → FindingsSnapshot (most recent only) */
  snapshots: Record<string, FindingsSnapshot>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LIFECYCLE_FILENAME = "mizumi-lifecycle.json";
const MAX_SNAPSHOTS = 500;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/** Generate a stable fingerprint key for a finding */
export function fingerprintFinding(finding: ReviewCommentType): FindingFingerprint {
  const messageHash = hashMessage(finding.message);
  return {
    key: `${finding.file}:${finding.line}:${finding.category}:${messageHash}`,
    file: finding.file,
    line: finding.line,
    category: finding.category,
    severity: finding.severity,
    messageHash,
  };
}

/** Simple string hash (same algorithm as feedback.ts) */
function hashMessage(message: string): string {
  let hash = 0;
  for (let i = 0; i < message.length; i++) {
    const chr = message.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function storePath(workspace: string): string {
  return path.join(workspace, ".github", LIFECYCLE_FILENAME);
}

function readStore(workspace: string): LifecycleStore {
  const p = storePath(workspace);
  if (!fs.existsSync(p)) return { snapshots: {} };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as LifecycleStore;
  } catch {
    return { snapshots: {} };
  }
}

function writeStore(workspace: string, store: LifecycleStore): void {
  const p = storePath(workspace);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Evict oldest snapshots if over limit
  const entries = Object.entries(store.snapshots).sort(([, a], [, b]) => a.timestamp - b.timestamp);
  while (entries.length > MAX_SNAPSHOTS) {
    const [key] = entries.shift()!;
    delete store.snapshots[key];
  }

  fs.writeFileSync(p, JSON.stringify(store), "utf-8");
}

function prKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
}

// ---------------------------------------------------------------------------
// Core lifecycle logic
// ---------------------------------------------------------------------------

/**
 * Load previous iteration's findings for prompt context injection.
 * Called BEFORE the review to inject persisted findings into the LLM prompt.
 * Returns the previous snapshot (if any) so it can be passed to trackFindings after.
 */
export function loadPreviousFindings(
  workspace: string,
  owner: string,
  repo: string,
  prNumber: number,
): { previousSnapshot: FindingsSnapshot | null; promptContext: string } {
  const store = readStore(workspace);
  const key = prKey(owner, repo, prNumber);
  const previous = store.snapshots[key] ?? null;

  if (!previous) {
    return { previousSnapshot: null, promptContext: "" };
  }

  // Build prompt context from previous findings
  let ctx = `## Previous Review Findings (iteration ${previous.iteration})\n`;
  ctx += "The following findings were raised in the previous push. ";
  ctx += "If any of these issues appear to still be present, note them briefly rather than re-raising in full:\n\n";

  for (const f of previous.findings.slice(0, 8)) {
    ctx += `- \`${f.file}:${f.line}\` (${f.severity}/${f.category})\n`;
  }

  if (previous.findings.length > 8) {
    ctx += `\n... and ${previous.findings.length - 8} more from the previous iteration.\n`;
  }

  return { previousSnapshot: previous, promptContext: ctx.trim() + "\n" };
}

/**
 * Track findings for a PR and compute lifecycle against previous iteration.
 * This is the main entry point called during each review.
 */
export function trackFindings(
  workspace: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  currentFindings: ReviewCommentType[],
): LifecycleResult {
  const store = readStore(workspace);
  const key = prKey(owner, repo, prNumber);
  const previous = store.snapshots[key];

  const currentFingerprints = currentFindings.map(fingerprintFinding);
  const currentKeys = new Set(currentFingerprints.map(f => f.key));

  if (!previous) {
    // First review — all findings are "new"
    const snapshot: FindingsSnapshot = {
      prKey: key,
      sha: headSha,
      iteration: 1,
      timestamp: Date.now(),
      findings: currentFingerprints,
    };
    store.snapshots[key] = snapshot;
    writeStore(workspace, store);

    return {
      persisted: [],
      resolved: [],
      newFindings: currentFingerprints,
      previousIteration: 0,
      currentIteration: 1,
      contextText: buildContextText([], [], currentFingerprints, 0, 1),
    };
  }

  const previousKeys = new Set(previous.findings.map(f => f.key));

  // Persisted: in both previous and current
  const persisted = previous.findings.filter(f => currentKeys.has(f.key));

  // Resolved: in previous but not in current
  const resolved = previous.findings.filter(f => !currentKeys.has(f.key));

  // New: in current but not in previous
  const newFindings = currentFingerprints.filter(f => !previousKeys.has(f.key));

  const currentIteration = previous.iteration + 1;

  // Update the store with current findings
  const snapshot: FindingsSnapshot = {
    prKey: key,
    sha: headSha,
    iteration: currentIteration,
    timestamp: Date.now(),
    findings: currentFingerprints,
  };
  store.snapshots[key] = snapshot;
  writeStore(workspace, store);

  core.info(`Finding lifecycle: iteration ${currentIteration}, ${persisted.length} persisted, ${resolved.length} resolved, ${newFindings.length} new`);

  return {
    persisted,
    resolved,
    newFindings,
    previousIteration: previous.iteration,
    currentIteration,
    contextText: buildContextText(persisted, resolved, newFindings, previous.iteration, currentIteration),
  };
}

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

function buildContextText(
  persisted: FindingFingerprint[],
  resolved: FindingFingerprint[],
  newFindings: FindingFingerprint[],
  previousIteration: number,
  currentIteration: number,
): string {
  if (currentIteration <= 1 && persisted.length === 0 && resolved.length === 0) {
    // First review — no lifecycle context
    if (newFindings.length === 0) return "";
    return `## Finding Lifecycle (iteration 1)\n${newFindings.length} finding(s) identified.\n`;
  }

  let ctx = `## Finding Lifecycle (iteration ${currentIteration})\n`;

  if (persisted.length > 0) {
    ctx += `\n**${persisted.length} finding(s) persisted** from iteration ${previousIteration}:\n`;
    for (const f of persisted.slice(0, 8)) {
      ctx += `- \`${f.file}:${f.line}\` [${f.severity}/${f.category}\n`;
    }
    if (persisted.length > 8) {
      ctx += `- ... and ${persisted.length - 8} more\n`;
    }
  }

  if (resolved.length > 0) {
    ctx += `\n**${resolved.length} finding(s) resolved** since iteration ${previousIteration}.\n`;
  }

  if (newFindings.length > 0) {
    ctx += `\n**${newFindings.length} new finding(s)** in this iteration.\n`;
  }

  if (persisted.length > 0) {
    ctx += `\n> ${persisted.length} finding(s) from the previous push are still unresolved. Focus on these first.\n`;
  }

  return ctx.trim() + "\n";
}

// ---------------------------------------------------------------------------
// LLM prompt context
// ---------------------------------------------------------------------------

/**
 * Build finding lifecycle context for LLM prompt injection.
 * When findings persist across pushes, the LLM should:
 * - Not re-raise them (they're already known)
 * - Instead, focus on whether the fix attempt was adequate
 */
export function buildLifecyclePromptContext(result: LifecycleResult): string {
  if (result.currentIteration <= 1) return "";
  if (result.persisted.length === 0) return "";

  let ctx = `## Persisted Findings from Previous Review (iteration ${result.previousIteration})\n`;
  ctx += "The following findings were raised in the previous push and still appear unresolved. ";
  ctx += "Do NOT re-raise these same issues. Instead:\n";
  ctx += "- If the author partially addressed them, note what's still missing\n";
  ctx += "- If the author ignored them, add a brief reminder\n";
  ctx += "- If new code introduces the same pattern in a different location, flag that as a new finding\n\n";

  for (const f of result.persisted.slice(0, 6)) {
    ctx += `- \`${f.file}:${f.line}\` (${f.severity}/${f.category})\n`;
  }

  if (result.persisted.length > 6) {
    ctx += `\n... and ${result.persisted.length - 6} more persisted finding(s).\n`;
  }

  return ctx.trim();
}

/**
 * Build the review body section for finding lifecycle.
 * Shows iteration count, persisted/resolved/new breakdown.
 */
export function formatLifecycleSummary(result: LifecycleResult): string {
  if (result.currentIteration <= 1) return "";
  if (result.persisted.length === 0 && result.resolved.length === 0) return "";

  let body = `<details><summary><strong>Finding Lifecycle</strong> — iteration ${result.currentIteration}</summary>\n\n`;
  body += `| Status | Count |\n|--------|-------|\n`;
  body += `| Persisted | ${result.persisted.length} |\n`;
  body += `| Resolved | ${result.resolved.length} |\n`;
  body += `| New | ${result.newFindings.length} |\n\n`;

  if (result.persisted.length > 0) {
    body += `**${result.persisted.length} finding(s) from the previous push are still unresolved.**\n\n`;
    for (const f of result.persisted.slice(0, 5)) {
      body += `- \`${f.file}:${f.line}\` (${f.severity}/${f.category})\n`;
    }
    if (result.persisted.length > 5) {
      body += `- ... and ${result.persisted.length - 5} more\n`;
    }
    body += "\n";
  }

  if (result.resolved.length > 0) {
    body += `**${result.resolved.length} finding(s) resolved.** `;
    body += "Great work addressing these!\n\n";
  }

  body += `</details>\n`;
  return body;
}
