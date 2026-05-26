/**
 * Semantic Change Intent Classification — competitive gap #3.
 *
 * Automatically label each diff file by intent: refactor, bugfix, feature,
 * security, perf, dead_code, test, docs, config. This lets reviewers triage
 * by risk — security patches get deep scrutiny, dead code removal gets
 * skimmed — and enables intent-aware noise gating.
 *
 * No other AI code reviewer classifies change intent. CodeRabbit groups
 * by file area but doesn't label intent; others just summarize.
 *
 * Implementation: heuristic-based classification using:
 * 1. File path patterns (test files → test intent, docs → docs intent)
 * 2. Change ratio signals (addition-heavy → feature, deletion-heavy → dead_code/refactor)
 * 3. Keyword detection in paths and diff content
 * 4. File status (deleted → dead_code, renamed → refactor)
 *
 * Zero LLM cost — purely heuristic.
 */
import type { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeIntent =
  | "feature"
  | "bugfix"
  | "refactor"
  | "security"
  | "perf"
  | "dead_code"
  | "test"
  | "docs"
  | "config"
  | "chore";

export interface FileIntent {
  file: string;
  intent: ChangeIntent;
  confidence: number;
  signals: string[];
}

export interface IntentResult {
  fileIntents: FileIntent[];
  /** Summary counts per intent */
  intentCounts: Record<ChangeIntent, number>;
  /** Dominant intent for the overall PR */
  dominantIntent: ChangeIntent;
  /** Context text for LLM prompt injection */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const INTENT_PRIORITY: ChangeIntent[] = [
  "security", "bugfix", "perf", "feature", "refactor",
  "dead_code", "test", "docs", "config", "chore",
];




// Path-based signals (checked first)
const PATH_SIGNALS: Array<{ pattern: RegExp; intent: ChangeIntent; signal: string; weight: number }> = [
  // Test files
  { pattern: /\/__tests__\/|\.test\.|\.spec\.|^tests?\//i, intent: "test", signal: "test file path", weight: 0.9 },
  { pattern: /\.stories\.|\.stories\/|\.visualspec\./i, intent: "test", signal: "story file", weight: 0.85 },
  // Documentation
  { pattern: /\.md$|\.rst$|\.adoc$|\/docs?\//i, intent: "docs", signal: "doc file path", weight: 0.9 },
  { pattern: /CHANGELOG|HISTORY|RELEASE_NOTES/i, intent: "docs", signal: "changelog file", weight: 0.85 },
  // Config files
  { pattern: /\.yml$|\.yaml$|\.json$|\.toml$|\.ini$|\.env/i, intent: "config", signal: "config file extension", weight: 0.7 },
  { pattern: /tsconfig|webpack|babel|eslint|prettier|jest|vite|rollup/i, intent: "config", signal: "tool config file", weight: 0.8 },
  { pattern: /Dockerfile|docker-compose|\.dockerignore/i, intent: "config", signal: "container config", weight: 0.75 },
  { pattern: /\.github\/workflows\//i, intent: "config", signal: "CI workflow", weight: 0.8 },
  // Security-sensitive paths
  { pattern: /\/auth\/|\/crypto\/|\/security\/|\/ssl\/|\/cert/i, intent: "security", signal: "security path", weight: 0.65 },
  { pattern: /password|secret|token|credential|key/i, intent: "security", signal: "security keyword in path", weight: 0.6 },
  // Performance-related
  { pattern: /\/perf\/|\/benchmark|\/cache\/|\.bench\./i, intent: "perf", signal: "performance path", weight: 0.7 },
  // Dead code signals
  { pattern: /deprecated|legacy|unused|obsolete/i, intent: "dead_code", signal: "deletion keyword in path", weight: 0.5 },
];

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

function classifyFile(file: DiffFile): FileIntent {
  const scores = new Map<ChangeIntent, { score: number; signals: string[] }>();
  for (const intent of INTENT_PRIORITY) {
    scores.set(intent, { score: 0, signals: [] });
  }

  // 1. Path-based signals
  for (const ps of PATH_SIGNALS) {
    if (ps.pattern.test(file.path)) {
      const entry = scores.get(ps.intent)!;
      entry.score += ps.weight;
      entry.signals.push(ps.signal);
    }
  }

  // 2. File status signals
  if (file.status === "deleted") {
    const dc = scores.get("dead_code")!;
    dc.score += 0.7;
    dc.signals.push("file deleted");
  }
  if (file.status === "renamed") {
    const rf = scores.get("refactor")!;
    rf.score += 0.5;
    rf.signals.push("file renamed");
  }
  if (file.status === "added") {
    const ft = scores.get("feature")!;
    ft.score += 0.3;
    ft.signals.push("new file added");
  }

  // 3. Change ratio signals
  const totalLines = file.additions + file.deletions;
  if (totalLines > 0) {
    const addRatio = file.additions / totalLines;
    const delRatio = file.deletions / totalLines;

    if (addRatio > 0.85 && file.additions > 10) {
      const ft = scores.get("feature")!;
      ft.score += 0.4;
      ft.signals.push("addition-heavy (" + Math.round(addRatio * 100) + "% additions)");
    }

    if (delRatio > 0.85 && file.deletions > 5) {
      const dc = scores.get("dead_code")!;
      dc.score += 0.5;
      dc.signals.push("deletion-heavy (" + Math.round(delRatio * 100) + "% deletions)");
    }

    // Roughly equal additions/deletions → likely refactor
    if (addRatio > 0.35 && addRatio < 0.65 && totalLines > 5) {
      const rf = scores.get("refactor")!;
      rf.score += 0.3;
      rf.signals.push("balanced add/delete ratio");
    }
  }

  // 4. Hunk content keyword detection (always check hunks)
  const contentSignals: Array<{ keywords: RegExp; intent: ChangeIntent; signal: string; weight: number }> = [
    { keywords: /fix|bug|patch|workaround|hotfix|regression/i, intent: "bugfix", signal: "bugfix keywords", weight: 0.4 },
    { keywords: /sanitize|escape|validate|XSS|CSRF|injection|encrypt|decrypt|hash|salt/i, intent: "security", signal: "security keywords in diff", weight: 0.5 },
    { keywords: /cache|memoize|optimize|benchmark|latency|throughput|pool/i, intent: "perf", signal: "perf keywords in diff", weight: 0.45 },
    { keywords: /remove|delete|clean\s*up|strip|unused|deprecated/i, intent: "dead_code", signal: "removal keywords in diff", weight: 0.35 },
    { keywords: /refactor|rename|extract|move|reorganize|consolidate/i, intent: "refactor", signal: "refactor keywords in diff", weight: 0.4 },
  ];

  const addedLines = file.hunks
    .flatMap(h => h.changes)
    .filter(c => c.type === "add")
    .map(c => c.content)
    .join(" ");

  for (const cs of contentSignals) {
    if (cs.keywords.test(addedLines)) {
      const entry = scores.get(cs.intent)!;
      entry.score += cs.weight;
      entry.signals.push(cs.signal);
    }
  }

  // 5. Special: small config changes
  if (file.additions <= 5 && file.deletions <= 5) {
    const cfg = scores.get("config")!;
    if (cfg.score > 0) {
      cfg.score += 0.2;
      cfg.signals.push("small config change");
    } else {
      const chore = scores.get("chore")!;
      chore.score += 0.15;
      chore.signals.push("small change");
    }
  }

  // Select highest-scoring intent
  let bestIntent: ChangeIntent = "chore";
  let bestScore = 0;

  // Priority tiebreak: higher-priority intents win when scores are close
  for (const intent of INTENT_PRIORITY) {
    const entry = scores.get(intent)!;
    if (entry.score > bestScore) {
      bestScore = entry.score;
      bestIntent = intent;
      bestScore = entry.score;
    }
  }

  // If no signals fired at all, default to "chore"
  if (bestScore === 0) {
    bestIntent = "chore";
    bestScore = 0.1;
  }

  return {
    file: file.path,
    intent: bestIntent,
    confidence: Math.min(bestScore, 1),
    signals: scores.get(bestIntent)!.signals,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify change intent for all diff files.
 * Zero LLM cost — purely heuristic.
 */
export function classifyIntents(diffFiles: DiffFile[]): IntentResult {
  const fileIntents = diffFiles.map(f => classifyFile(f));

  // Count intents
  const intentCounts: Record<ChangeIntent, number> = {
    feature: 0, bugfix: 0, refactor: 0, security: 0, perf: 0,
    dead_code: 0, test: 0, docs: 0, config: 0, chore: 0,
  };
  for (const fi of fileIntents) {
    intentCounts[fi.intent]++;
  }

  // Dominant intent: the one with the most files (ties broken by priority)
  let dominantIntent: ChangeIntent = "chore";
  let dominantCount = 0;
  for (const intent of INTENT_PRIORITY) {
    if (intentCounts[intent] > dominantCount) {
      dominantCount = intentCounts[intent];
      dominantIntent = intent;
    }
  }

  return {
    fileIntents,
    intentCounts,
    dominantIntent,
    contextText: buildIntentContext(fileIntents, dominantIntent),
    bodySummary: buildIntentBodySummary(fileIntents, intentCounts, dominantIntent),
  };
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildIntentContext(fileIntents: FileIntent[], dominantIntent: ChangeIntent): string {
  const nonChore = fileIntents.filter(f => f.intent !== "chore");
  if (nonChore.length === 0) return "";

  let ctx = `## Change Intent Classification (dominant: ${dominantIntent})\n`;
  ctx += "The following files are classified by change intent. ";
  ctx += "Prioritize review attention by intent risk:\n";
  ctx += "- **security/bugfix**: high-risk, requires deep line-by-line review\n";
  ctx += "- **feature/perf**: medium-risk, review logic correctness\n";
  ctx += "- **refactor**: low-risk, focus on behavioral preservation\n";
  ctx += "- **dead_code/test/docs/config/chore**: skim review acceptable\n\n";

  for (const fi of nonChore.slice(0, 12)) {
    ctx += `- \`${fi.file}\` → **${fi.intent}** (confidence: ${Math.round(fi.confidence * 100)}%)\n`;
  }

  if (nonChore.length > 12) {
    ctx += `\n... and ${nonChore.length - 12} more files.\n`;
  }

  return ctx.trim() + "\n";
}

function buildIntentBodySummary(
  fileIntents: FileIntent[],
  intentCounts: Record<ChangeIntent, number>,
  dominantIntent: ChangeIntent,
): string {
  const nonZero = Object.entries(intentCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  if (nonZero.length === 0) return "";

  let body = `<details><summary><strong>Change Intent</strong> — ${dominantIntent}</summary>\n\n`;
  body += "| Intent | Files |\n|--------|-------|\n";

  for (const [intent, count] of nonZero) {
    body += `| ${intent} | ${count} |\n`;
  }

  body += "\n";

  // List security/bugfix files explicitly (they need attention)
  const highRisk = fileIntents.filter(f => f.intent === "security" || f.intent === "bugfix");
  if (highRisk.length > 0) {
    body += "**High-risk changes requiring deep review:**\n";
    for (const f of highRisk) {
      body += `- \`${f.file}\` (${f.intent}) — ${f.signals.join(", ")}\n`;
    }
    body += "\n";
  }

  body += `</details>\n`;
  return body;
}
