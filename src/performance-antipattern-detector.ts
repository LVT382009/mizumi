/**
 * Performance Anti-Pattern Detector — detect performance regressions in PR diffs.
 *
 * No AI code reviewer flags performance anti-patterns at PR review time.
 * Amazon CodeGuru has limited N+1 detection for Java only (not in PR diffs).
 * CodeRabbit, Copilot, and Sourcery all miss: N+1 query patterns, synchronous
 * I/O in async functions, waterfall awaits that should be Promise.all(), and
 * unnecessary re-renders in frontend code.
 *
 * Mizumi scans added lines for 4 performance anti-pattern categories:
 * 1. N+1 query: query/find/execute called inside a loop
 * 2. Sync-in-async: readFileSync/writeFileSync/existsSync in async functions
 * 3. Waterfall-await: sequential awaits that could be Promise.all()
 * 4. Unnecessary-await: await on already-resolved values (constants, sync functions)
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PerfAntiPatternCategory =
  | "n-plus-1-query"
  | "sync-in-async"
  | "waterfall-await"
  | "unnecessary-await";

export interface PerfAntiPatternIssue {
  /** Category of the issue */
  category: PerfAntiPatternCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = sync-in-async/n+1, warning = waterfall/unnecessary-await */
  severity: "critical" | "warning";
}

export interface PerfAntiPatternResult {
  /** All detected performance anti-pattern issues */
  issues: PerfAntiPatternIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// N+1: loop construct — keyword loops at line start, method chains anywhere
const LOOP_KEYWORD_RE = /^\+\s*(?:for|while)\s*\(/;
const LOOP_METHOD_RE = /\.\s*(?:forEach|map|filter|reduce|flatMap|some|every|find)\s*\(/;
const QUERY_IN_LOOP_RE = /\b(?:query|execute|find|findById|findOne|save|remove|deleteOne|updateOne|create|aggregate|fetch|axios|readFile|writeFile)\s*\(/;

// Sync I/O in async context
const SYNC_IO_RE = /\b(readFileSync|writeFileSync|appendFileSync|existsSync|statSync|mkdirSync|rmSync|readdirSync|copyFileSync|accessSync|readlinkSync|symlinkSync|unlinkSync|renameSync|realpathSync|chownSync|chmodSync|lobSync)\s*\(/;
const ASYNC_CONTEXT_RE = /\basync\b/;

// Waterfall await: sequential awaits on separate lines that could be parallel
// We detect pairs of `const x = await` on consecutive added lines
const AWAIT_ASSIGN_RE = /^\+\s*(?:const|let|var)\s+\w+\s*=\s*await\s+/;

// Unnecessary await: awaiting a non-promise (constant, sync function, number)
const UNNECESSARY_AWAIT_RE = /await\s+(?:undefined|null|true|false|\d+|['"][^'"]*['"]|new\s+Map|new\s+Set|new\s+Date|Object\.|Array\.|Math\.|JSON\.|parseInt|parseFloat|isNaN|String\(|Number\(|Boolean\()/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectNPlus1Queries(file: DiffFile): PerfAntiPatternIssue[] {
  const issues: PerfAntiPatternIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change.type !== "add") continue;

    if (!LOOP_KEYWORD_RE.test(change.content) && !LOOP_METHOD_RE.test(change.content)) continue;

    // Look at next 10 lines for a query call inside the loop
    for (let j = i + 1; j < Math.min(i + 11, changes.length); j++) {
      const next = changes[j];
      if (next.type !== "add") continue;

      const nextTrimmed = next.content.replace(/^\+/, "").trim();
      // If we hit a closing brace at same or lesser indent, loop body is done
      if (nextTrimmed.startsWith("}") || nextTrimmed === "});") break;

      if (QUERY_IN_LOOP_RE.test(next.content)) {
        issues.push({
          category: "n-plus-1-query",
          file: file.path,
          line: next.line,
          code: nextTrimmed,
          description: `Query inside loop in \`${file.path}:${next.line}\` — potential N+1 query pattern; consider batching or using Promise.all()`,
          severity: "critical",
        });
        break; // Only flag first query per loop
      }
    }
  }

  return issues;
}

function detectSyncInAsync(file: DiffFile): PerfAntiPatternIssue[] {
  const issues: PerfAntiPatternIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  let inAsyncFunction = false;
  let asyncIndent = -1;

  for (const change of changes) {
    if (change.type !== "add") continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Track async function scope
    if (ASYNC_CONTEXT_RE.test(content) && /\bfunction\b|=>|=>\s*\{/.test(content)) {
      inAsyncFunction = true;
      const indent = content.match(/^(\+)?(\s*)/);
      asyncIndent = indent ? indent[0].length : 0;
    }

    // Detect sync I/O call
    if (SYNC_IO_RE.test(content)) {
      const syncCall = content.match(SYNC_IO_RE);
      const funcName = syncCall ? syncCall[1] : "syncIO";

      // Flag if we're in an async function, or if the line itself is in async context
      // (we check conservatively: flag sync IO in any context as a perf concern)
      if (inAsyncFunction || ASYNC_CONTEXT_RE.test(content)) {
        issues.push({
          category: "sync-in-async",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Synchronous I/O \`${funcName}()\` in async context in \`${file.path}:${change.line}\` — blocks the event loop; use the async version instead`,
          severity: "critical",
        });
      } else {
        // Even outside async, sync IO in Node.js is a warning
        issues.push({
          category: "sync-in-async",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Synchronous I/O \`${funcName}() \` in \`${file.path}:${change.line}\` — blocks the event loop; consider async alternative`,
          severity: "warning",
        });
      }
    }

    // Reset async scope when exiting function
    if (trimmed === "}" && inAsyncFunction) {
      const currentIndent = content.replace(/^\+/, "").search(/\S/);
      if (currentIndent >= 0 && currentIndent <= asyncIndent) {
        inAsyncFunction = false;
      }
    }
  }

  return issues;
}

function detectWaterfallAwaits(file: DiffFile): PerfAntiPatternIssue[] {
  const issues: PerfAntiPatternIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length - 1; i++) {
    const current = addedChanges[i];
    const next = addedChanges[i + 1];

    // Both lines must be `const x = await ...`
    if (!AWAIT_ASSIGN_RE.test(current.content)) continue;
    if (!AWAIT_ASSIGN_RE.test(next.content)) continue;

    // Check they're in the same block (close line numbers)
    if (Math.abs(next.line - current.line) > 2) continue;

    // Check the awaited calls are independent (different sources)
    const currentAwait = current.content.match(/await\s+(\w+)/);
    const nextAwait = next.content.match(/await\s+(\w+)/);
    if (currentAwait && nextAwait && currentAwait[1] === nextAwait[1]) {
      // Same function called twice — might be intentional (pagination etc)
      continue;
    }

    const currentTrimmed = current.content.replace(/^\+/, "").trim();
    const nextTrimmed = next.content.replace(/^\+/, "").trim();

    issues.push({
      category: "waterfall-await",
      file: file.path,
      line: current.line,
      code: currentTrimmed + "\n" + nextTrimmed,
      description: `Sequential awaits in \`${file.path}:${current.line}-${next.line}\` — if independent, use Promise.all() for parallel execution`,
      severity: "warning",
    });

    i++; // Skip the next line since we already flagged it
  }

  return issues;
}

function detectUnnecessaryAwaits(file: DiffFile): PerfAntiPatternIssue[] {
  const issues: PerfAntiPatternIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      if (UNNECESSARY_AWAIT_RE.test(content)) {
        issues.push({
          category: "unnecessary-await",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Unnecessary await on non-promise value in \`${file.path}:${change.line}\` — awaiting a synchronous value adds microtask overhead`,
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

function dedupIssues(issues: PerfAntiPatternIssue[]): PerfAntiPatternIssue[] {
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

function buildPerfContext(result: PerfAntiPatternResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Performance Anti-Patterns (${result.issues.length})\n`;
  ctx += "This PR may introduce performance anti-patterns:\n\n";

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

function buildPerfBodySummary(result: PerfAntiPatternResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Performance Anti-Patterns</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*N+1 queries and sync I/O cause production latency. Waterfall awaits waste concurrency.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run performance anti-pattern detection on diff files.
 * Zero LLM cost.
 */
export function detectPerformanceAntiPatterns(diffFiles: DiffFile[]): PerfAntiPatternResult {
  const allIssues: PerfAntiPatternIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectNPlus1Queries(file));
    allIssues.push(...detectSyncInAsync(file));
    allIssues.push(...detectWaterfallAwaits(file));
    allIssues.push(...detectUnnecessaryAwaits(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: PerfAntiPatternResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildPerfContext(result);
  result.bodySummary = buildPerfBodySummary(result);

  if (issues.length > 0) {
    core.info(`Performance anti-pattern detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
