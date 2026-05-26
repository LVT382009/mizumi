/**
 * Cross-PR Finding Persistence — competitive gap #5.
 *
 * Persist findings organization-wide across PRs. When the same issue
 * (same file:category:message pattern) appears in different PRs, surface
 * "This same issue was found in 3 other PRs this month" so teams see
 * systemic patterns rather than treating each PR in isolation.
 *
 * No other AI code reviewer tracks findings across PRs. CodeRabbit,
 * CodeGuru, and Sourcery are all PR-scoped — they have no concept of
 * "this issue keeps appearing across the org."
 *
 * Implementation:
 * 1. Lightweight JSON store: category → file pattern → message hash → PR list
 * 2. On each review, persist findings and check for cross-PR recurrence
 * 3. Inject recurrence context: "Same issue in 3 other PRs" into LLM prompt
 * 4. Add cross-PR summary to review body (optional, controlled by config)
 *
 * Zero LLM cost. Uses the same filesystem-based JSON store approach as
 * finding-lifecycle.ts but with cross-PR indexing instead of per-PR snapshots.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossPRFingerprint {
  /** category + normalized file path first directory + message hash */
  key: string;
  category: string;
  /** Just the first directory segment for broad matching */
  fileArea: string;
  messageHash: string;
}

export interface CrossPREntry {
  /** PR key: "owner/repo#prNumber" */
  prKey: string;
  /** Timestamp */
  timestamp: number;
  /** Finding severity */
  severity: string;
  /** Full file path */
  file: string;
  /** Finding message (truncated) */
  message: string;
}

export interface CrossPRIndex {
  /** Map of fingerprint key → entries across PRs */
  patterns: Record<string, CrossPREntry[]>;
}

export interface CrossPRResult {
  /** Findings that recur across PRs */
  recurringFindings: RecurringFinding[];
  /** Total unique patterns tracked */
  totalPatterns: number;
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

export interface RecurringFinding {
  /** The fingerprint key */
  key: string;
  category: string;
  fileArea: string;
  /** Sample message text */
  sampleMessage: string;
  /** Number of PRs where this pattern appeared */
  prCount: number;
  /** PRs where it appeared (most recent first) */
  prs: Array<{ prKey: string; timestamp: number; severity: string; file: string }>;
  /** Whether the current PR has this pattern too */
  inCurrentPR: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CROSSPR_FILENAME = "mizumi-crosspr.json";
const MAX_ENTRIES_PER_PATTERN = 50;
const MAX_PATTERNS = 1000;
const STALE_DAYS = 30;
const MESSAGE_TRUNCATE = 80;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function extractFileArea(filePath: string): string {
  // Use first directory segment for broad matching:
  // "src/auth/middleware.ts" → "src/auth"
  // "package.json" → "."
  const parts = filePath.split("/");
  if (parts.length > 1) {
    return parts.slice(0, 2).join("/");
  }
  return parts[0] || ".";
}

function hashMessage(message: string): string {
  let hash = 0;
  for (let i = 0; i < message.length; i++) {
    const chr = message.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Generate a cross-PR fingerprint for a finding.
 * Key format: "category:fileArea:messageHash"
 */
export function fingerprintCrossPR(finding: ReviewCommentType): CrossPRFingerprint {
  const fileArea = extractFileArea(finding.file);
  const messageHash = hashMessage(finding.message.substring(0, MESSAGE_TRUNCATE));
  return {
    key: `${finding.category}:${fileArea}:${messageHash}`,
    category: finding.category,
    fileArea,
    messageHash,
  };
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

function storePath(workspace: string): string {
  return path.join(workspace, ".github", CROSSPR_FILENAME);
}

function readStore(workspace: string): CrossPRIndex {
  const p = storePath(workspace);
  if (!fs.existsSync(p)) return { patterns: {} };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as CrossPRIndex;
  } catch {
    return { patterns: {} };
  }
}

function writeStore(workspace: string, store: CrossPRIndex): void {
  const p = storePath(workspace);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Evict stale entries (older than STALE_DAYS)
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, entries] of Object.entries(store.patterns)) {
    const fresh = entries.filter(e => e.timestamp > cutoff);
    if (fresh.length === 0) {
      delete store.patterns[key];
    } else if (fresh.length < entries.length) {
      store.patterns[key] = fresh;
    }
  }

  // Evict patterns over limit (keep most recent)
  const allPatterns = Object.entries(store.patterns)
    .sort(([, a], [, b]) => Math.max(...b.map(e => e.timestamp)) - Math.max(...a.map(e => e.timestamp)));
  if (allPatterns.length > MAX_PATTERNS) {
      store.patterns = Object.fromEntries(allPatterns.slice(0, MAX_PATTERNS));
  }

  // Trim entries per pattern
  for (const [key, entries] of Object.entries(store.patterns)) {
    if (entries.length > MAX_ENTRIES_PER_PATTERN) {
      store.patterns[key] = entries.slice(-MAX_ENTRIES_PER_PATTERN);
    }
  }

  fs.writeFileSync(p, JSON.stringify(store), "utf-8");
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Record findings from a review and check for cross-PR recurrence.
 * This is the main entry point called after each review.
 */
export function trackCrossPRFindings(
  workspace: string,
  prKey: string,
  findings: ReviewCommentType[],
): CrossPRResult {
  const store = readStore(workspace);
  const currentFingerprints = new Map<string, CrossPRFingerprint>();

  // Fingerprint current findings
  for (const finding of findings) {
    const fp = fingerprintCrossPR(finding);
    currentFingerprints.set(fp.key, fp);

    // Add to store
    if (!store.patterns[fp.key]) {
      store.patterns[fp.key] = [];
    }
    store.patterns[fp.key].push({
      prKey,
      timestamp: Date.now(),
      severity: finding.severity,
      file: finding.file,
      message: finding.message.substring(0, MESSAGE_TRUNCATE),
    });
  }

  writeStore(workspace, store);

  // Find recurring patterns (appeared in 2+ PRs including current)
  const recurringFindings: RecurringFinding[] = [];
  for (const [key, fp] of currentFingerprints) {
    const entries = store.patterns[key] || [];
    // Count distinct PRs
    const prSet = new Map<string, CrossPREntry>();
    for (const entry of entries) {
      if (!prSet.has(entry.prKey) || entry.timestamp > prSet.get(entry.prKey)!.timestamp) {
        prSet.set(entry.prKey, entry);
      }
    }
    const prCount = prSet.size;

    if (prCount >= 2) {
      const prs = Array.from(prSet.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5)
        .map(e => ({ prKey: e.prKey, timestamp: e.timestamp, severity: e.severity, file: e.file }));

      recurringFindings.push({
        key,
        category: fp.category,
        fileArea: fp.fileArea,
        sampleMessage: entries[entries.length - 1]?.message || "",
        prCount,
        prs,
        inCurrentPR: true,
      });
    }
  }

  // Also check for patterns NOT in current PR but recurring in other PRs
  for (const [key, entries] of Object.entries(store.patterns)) {
    if (currentFingerprints.has(key)) continue; // Already counted above

    const prSet = new Map<string, CrossPREntry>();
    for (const entry of entries) {
      if (!prSet.has(entry.prKey) || entry.timestamp > prSet.get(entry.prKey)!.timestamp) {
        prSet.set(entry.prKey, entry);
      }
    }
    // Only include if 3+ PRs (higher threshold for patterns not in current PR)
    if (prSet.size >= 3) {
      const prs = Array.from(prSet.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5)
        .map(e => ({ prKey: e.prKey, timestamp: e.timestamp, severity: e.severity, file: e.file }));

      const [category, fileArea] = key.split(":");
      recurringFindings.push({
        key,
        category: category || "unknown",
        fileArea: fileArea || "",
        sampleMessage: entries[entries.length - 1]?.message || "",
        prCount: prSet.size,
        prs,
        inCurrentPR: false,
      });
    }
  }

  // Sort by PR count descending
  recurringFindings.sort((a, b) => b.prCount - a.prCount);

  const result: CrossPRResult = {
    recurringFindings,
    totalPatterns: Object.keys(store.patterns).length,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildCrossPRContext(result);
  result.bodySummary = buildCrossPRBodySummary(result);

  return result;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildCrossPRContext(result: CrossPRResult): string {
  const inCurrentPR = result.recurringFindings.filter(r => r.inCurrentPR);
  if (inCurrentPR.length === 0) return "";

  let ctx = `## Cross-PR Recurring Issues\n`;
  ctx += "The following issue patterns also appeared in other recent PRs. ";
  ctx += "This may indicate a systemic problem worth addressing at a broader level:\n\n";

  for (const r of inCurrentPR.slice(0, 6)) {
    ctx += `- **${r.category}** in \`${r.fileArea}/\` — found in ${r.prCount} PRs`;
    if (r.sampleMessage) {
      ctx += ` ("${r.sampleMessage.substring(0, 60)}")`;
    }
    ctx += "\n";
  }

  if (inCurrentPR.length > 6) {
    ctx += `\n... and ${inCurrentPR.length - 6} more recurring patterns.\n`;
  }

  return ctx.trim() + "\n";
}

function buildCrossPRBodySummary(result: CrossPRResult): string {
  const significant = result.recurringFindings.filter(r => r.prCount >= 2);
  if (significant.length === 0) return "";

  let body = `<details><summary><strong>Cross-PR Patterns</strong> — ${significant.length} recurring</summary>\n\n`;
  body += "| Pattern | Area | PRs | Category |\n|---------|------|-----|----------|\n";

  for (const r of significant.slice(0, 10)) {
    body += `| ${r.sampleMessage.substring(0, 40) || r.key} | \`${r.fileArea}/\` | ${r.prCount} | ${r.category} |\n`;
  }
  if (significant.length > 10) {
    body += `| ... | | ${significant.length - 10} more | |\n`;
  }

  body += `\n*Based on ${result.totalPatterns} tracked patterns across recent reviews.*\n</details>\n`;
  return body;
}
