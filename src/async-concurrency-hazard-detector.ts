/**
 * Async Concurrency Hazard Detector — detect race conditions and
 * concurrency bugs in PR diffs.
 *
 * No AI code reviewer detects concurrency hazards at PR review time.
 * SonarQube S3984 flags "throw inside async" but not TOCTOU, shared
 * mutable state races, flag-flip races, or unbounded Promise.all.
 * ESLint's require-atomic-updates (partially) covers some shared-state
 * cases but is disabled by default and has many false positives.
 *
 * Concurrency bugs are the hardest class of bug to diagnose in production:
 * they are non-deterministic, reproduce only under load, and leave no
 * stack trace. Catching them at PR review time is high-value.
 *
 * Mizumi scans added lines for 4 concurrency hazard categories:
 * 1. TOCTOU: synchronous check then async use (check stale after await)
 * 2. Shared mutable state: module-level let/var read+written in async
 * 3. Race on flag flip: boolean flag check-then-set before async work
 * 4. Unbounded Promise.all: Promise.all on dynamic/large arrays
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConcurrencyHazardCategory =
  | "toctou"
  | "shared-mutable-state"
  | "race-on-flag"
  | "unbounded-promise-all";

export interface ConcurrencyHazardIssue {
  /** Category of the issue */
  category: ConcurrencyHazardCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = toctou/race-on-flag, warning = shared-state/unbounded-promise-all */
  severity: "critical" | "warning";
}

export interface ConcurrencyHazardResult {
  /** All detected concurrency hazard issues */
  issues: ConcurrencyHazardIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// TOCTOU: if/while check followed by await on next logical lines
// Detects: if (cache.has(key)) { await cache.get(key) }
//          if (!exists) { await writeFile(...) }
const IF_CHECK_RE = /^\+\s*(?:if|while)\s*\(/;
const ASYNC_AFTER_CHECK_RE = /^\+\s*(?:await|\.then)\b/;

// Common TOCTOU check-then-use pairs
const CHECK_EXISTS_RE = /(?:exists(?:Sync|Async)?|has|includes?|contains?)\s*\(/;
const USE_AFTER_CHECK_RE = /await\s+.*(?:get|read|fetch|open|write|create|delete|remove)\b/;

// Shared mutable state: module-level let/var used in async functions
const MODULE_LEVEL_MUTABLE_RE = /^\+\s*(?:let|var)\s+(\w+)\s*=/;
const ASYNC_FUNC_RE = /async\s+(?:function|\(|[a-zA-Z])/;
const MUTABLE_READ_WRITE_RE = /(\w+)\s*(?:\+\+|--|\+=|-=|\*=|\/=|=)/;

// Race on flag flip: boolean flag check then set before async
const FLAG_CHECK_RE = /if\s*\(\s*!(\w+)\s*\)/;
const COMMON_FLAG_NAMES = /^(?:is|has|can|should|will|did|was|processing|running|loading|busy|locked|active|pending|initialized|connected|ready|done|complete|started|enabled|disabled|cancelled|closed|open)/i;
const DYNAMIC_ARRAY_RE = /Promise\.all\s*\(\s*(?:[\w.]+\.)?(?:map|filter|reduce|flatMap|slice|splice|concat)\s*\(/;
const LARGE_LITERAL_RE = /Promise\.all\s*\(\s*\[/;

// Lines to skip (comments, imports, type declarations)
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectTOCTOU(file: DiffFile): ConcurrencyHazardIssue[] {
  const issues: ConcurrencyHazardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (!IF_CHECK_RE.test(change.content)) continue;
    if (!CHECK_EXISTS_RE.test(change.content)) continue;

    // Look ahead for await/.then within the same block (up to 8 lines)
    let hasAsyncUse = false;
    for (let j = i + 1; j < Math.min(i + 8, addedChanges.length); j++) {
      const next = addedChanges[j];
      // Stop at block boundaries
      if (/^\+\s*\}\s*(?:else|catch|finally|\ [;,])?/.test(next.content)) break;
      if (ASYNC_AFTER_CHECK_RE.test(next.content) || USE_AFTER_CHECK_RE.test(next.content)) {
        hasAsyncUse = true;
        break;
      }
    }

    if (hasAsyncUse) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "toctou",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `TOCTOU race in \`${file.path}:${change.line}\` — condition check followed by async operation; state may change between check and use. Acquire a lock or merge check+use into atomic operation`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectSharedMutableState(file: DiffFile): ConcurrencyHazardIssue[] {
  const issues: ConcurrencyHazardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Collect module-level mutable variables
  const mutableVars = new Map<string, number>();
  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const match = change.content.match(MODULE_LEVEL_MUTABLE_RE);
    if (match) {
      mutableVars.set(match[1], change.line);
    }
  }

  if (mutableVars.size === 0) return issues;

  // Check if any async function reads/writes these mutable vars
  let inAsyncFunc = false;
  let asyncBraceDepth = 0;

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const content = change.content.replace(/^\+/, "").trim();

    if (ASYNC_FUNC_RE.test(content)) {
      inAsyncFunc = true;
      asyncBraceDepth = 0;
    }

    if (inAsyncFunc) {
      // Track brace depth for async function scope
      for (const ch of content) {
        if (ch === "{") asyncBraceDepth++;
        if (ch === "}") asyncBraceDepth--;
      }

      if (asyncBraceDepth <= 0 && content.includes("}")) {
        inAsyncFunc = false;
        continue;
      }

      // Check if mutable var is read or written
      const rwMatch = content.match(MUTABLE_READ_WRITE_RE);
      if (rwMatch && mutableVars.has(rwMatch[1])) {
        // Don't double-report same var+line
        const varName = rwMatch[1];
        const existingLine = mutableVars.get(varName)!;
        if (existingLine !== change.line) {
          const trimmed = change.content.replace(/^\+/, "").trim();
          issues.push({
            category: "shared-mutable-state",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Shared mutable state \`${varName}\` accessed in async context in \`${file.path}:${change.line}\` — concurrent calls may interleave reads/writes. Use atomic operations or mutex`,
            severity: "warning",
          });
        }
      }
    }
  }

  return issues;
}

function detectRaceOnFlag(file: DiffFile): ConcurrencyHazardIssue[] {
  const issues: ConcurrencyHazardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Match: if (!isProcessing) or if (!locked) etc.
    const flagMatch = change.content.match(FLAG_CHECK_RE);
    if (!flagMatch) continue;

    const flagName = flagMatch[1];
    if (!COMMON_FLAG_NAMES.test(flagName)) continue;

    // Look ahead for: flagName = true; then await
    let hasFlagSet = false;
    let hasAwait = false;

    for (let j = i + 1; j < Math.min(i + 10, addedChanges.length); j++) {
      const next = addedChanges[j];
      const nextContent = next.content.replace(/^\+/, "").trim();

      // Stop at block boundary
      if (/^\}\s*(?:else|catch|finally)?/.test(nextContent)) break;

      // Check for flag set
      if (nextContent.includes(`${flagName} = true`) || nextContent.includes(`${flagName} = false`)) {
        hasFlagSet = true;
      }

      // Check for await
      if (/^await\b/.test(nextContent)) {
        hasAwait = true;
      }
    }

    if (hasFlagSet && hasAwait) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "race-on-flag",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Race on flag \`${flagName}\` in \`${file.path}:${change.line}\` — check-then-set pattern before async work; concurrent calls can both pass the check. Use atomic compare-and-swap or mutex`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectUnboundedPromiseAll(file: DiffFile): ConcurrencyHazardIssue[] {
  const issues: ConcurrencyHazardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Dynamic array: Promise.all(items.map(...))
    if (DYNAMIC_ARRAY_RE.test(change.content)) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "unbounded-promise-all",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Unbounded Promise.all with dynamic array in \`${file.path}:${change.line}\` — no concurrency limit; can exhaust connections, memory, or rate limits. Use p-limit or Promise.allSettled with concurrency control`,
        severity: "warning",
      });
      continue;
    }

    // Large literal array: Promise.all([...]) with 5+ items (heuristic)
    if (LARGE_LITERAL_RE.test(change.content)) {
      // Count commas in the same line or look for multi-line array
      const commaCount = (change.content.match(/,/g) || []).length;
      if (commaCount >= 4) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "unbounded-promise-all",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Large Promise.all (${commaCount + 1} items) in \`${file.path}:${change.line}\` — consider batching or using concurrency-limited execution to avoid resource exhaustion`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: ConcurrencyHazardIssue[]): ConcurrencyHazardIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildConcurrencyHazardContext(result: ConcurrencyHazardResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Concurrency Hazards (${result.issues.length})\n`;
  ctx += "This PR may introduce concurrency bugs:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const i of warnings.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }

  return ctx.trim();
}

function buildConcurrencyHazardBodySummary(result: ConcurrencyHazardResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Async Concurrency Hazard Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Concurrency bugs are non-deterministic, reproduce only under load, and leave no stack trace. Catch them at review time.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run async concurrency hazard detection on diff files.
 * Zero LLM cost.
 */
export function detectConcurrencyHazards(diffFiles: DiffFile[]): ConcurrencyHazardResult {
  const allIssues: ConcurrencyHazardIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectTOCTOU(file));
    allIssues.push(...detectSharedMutableState(file));
    allIssues.push(...detectRaceOnFlag(file));
    allIssues.push(...detectUnboundedPromiseAll(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ConcurrencyHazardResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildConcurrencyHazardContext(result);
  result.bodySummary = buildConcurrencyHazardBodySummary(result);

  if (issues.length > 0) {
    core.info(`Concurrency hazard detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
