/**
 * Error Handling Gap Detector — detect missing error handling in PR diffs.
 *
 * No AI code reviewer flags error handling gaps at PR review time. CodeRabbit,
 * Copilot, CodeGuru, and Sourcery all miss: promise chains without .catch(),
 * async functions called without await or .catch(), and catch blocks that
 * swallow errors without logging or rethrowing. These cause unhandled promise
 * rejections and silent failures in production.
 *
 * Mizumi scans added lines for 3 error handling gap categories:
 * 1. Unhandled promise: .then() without .catch(), Promise without handler
 * 2. Missing await: async function calls without await/.catch()
 * 3. Swallowed error: catch blocks with empty or trivial bodies
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorHandlingCategory =
  | "unhandled-promise"
  | "missing-await"
  | "swallowed-error";

export interface ErrorHandlingIssue {
  /** Category of the issue */
  category: ErrorHandlingCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = missing await/unhandled promise, warning = swallowed error */
  severity: "critical" | "warning";
}

export interface ErrorHandlingResult {
  /** All detected error handling issues */
  issues: ErrorHandlingIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// .then() without a following .catch()
const THEN_WITHOUT_CATCH_RE = /\.then\s*\(/;

// .finally() without a preceding .catch()
const FINALLY_WITHOUT_CATCH_RE = /\.finally\s*\(/;

// Promise that is created but not chained (no .then/.catch/await)
const FLOATING_PROMISE_RE = /(?:new\s+Promise|Promise\.\w+)\s*\(/;

// void expression discarding a promise: void somePromise
const VOID_PROMISE_RE = /\bvoid\s+\S+/;

// Catch blocks that only have trivial/no-op content
const TRIVIAL_CATCH_RE = /catch\s*\([^)]*\)\s*\{[\s;]*\}/;

// catch(e) { e; } — catch body with only a variable reference
const VAR_REF_ONLY_RE = /^\w+;?\s*$/;

// Redis async operations: redis.get(), client.set(), etc.
const REDIS_ASYNC_RE = /\b(redis|client)\.\s*(get|set|del|exists|incr|decr|hget|hset|hdel|lpush|rpush|sadd|srem|zadd|zrem|publish|subscribe|ping|flushdb|flushall)\s*\(/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectUnhandledPromises(file: DiffFile): ErrorHandlingIssue[] {
  const issues: ErrorHandlingIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip comments and imports
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (/^\+\s*import\s/.test(content)) continue;
    if (trimmed.startsWith("}")) continue;

    // Detect .then() without .catch()
    // Skip if the line also has .finally() — handled by FINALLY_WITHOUT_CATCH below
    if (THEN_WITHOUT_CATCH_RE.test(content) && !FINALLY_WITHOUT_CATCH_RE.test(content)) {
      // Check if the same line or the next added line has .catch()
      const hasNextCatch = content.includes(".catch(");
      if (hasNextCatch) continue;

      // Check the next line for .catch()
      const changeIdx = addedChanges.indexOf(change);
      let lineHasCatch = false;
      for (let j = changeIdx + 1; j < Math.min(changeIdx + 3, addedChanges.length); j++) {
        if (addedChanges[j].content.includes(".catch(")) {
          lineHasCatch = true;
          break;
        }
      }
      if (lineHasCatch) continue;

      issues.push({
        category: "unhandled-promise",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Promise chain with .then() but no .catch() in \`${file.path}:${change.line}\` — unhandled rejection possible, add .catch() or use await with try/catch`,
        severity: "critical",
      });
    }

    // Detect floating promises (new Promise or Promise.* without handler)
    if (FLOATING_PROMISE_RE.test(content) && !content.includes("await") && !content.includes(".then(") && !content.includes(".catch(") && !content.includes("return")) {
      // Skip if it's a return or assignment with await
      if (/=\s*await/.test(content)) continue;
      if (/return\s+new\s+Promise/.test(content)) continue;

      issues.push({
        category: "unhandled-promise",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Promise created but not handled in \`${file.path}:${change.line}\` — add await, .then()/.catch(), or assign to a variable`,
        severity: "critical",
      });
    }

    // Detect .finally() without .catch() — rejection still unhandled
    if (FINALLY_WITHOUT_CATCH_RE.test(content) && !content.includes(".catch(")) {
      const changeIdx = addedChanges.indexOf(change);
      let lineHasCatch = false;
      for (let j = Math.max(0, changeIdx - 3); j < Math.min(changeIdx + 3, addedChanges.length); j++) {
        if (addedChanges[j].content.includes(".catch(")) {
          lineHasCatch = true;
          break;
        }
      }
      if (!lineHasCatch) {
        issues.push({
          category: "unhandled-promise",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Promise chain with .finally() but no .catch() in \`${file.path}:${change.line}\` — .finally() does not handle rejections, add .catch()`,
          severity: "critical",
        });
      }
    }

    // Detect void expression discarding a promise: void somePromise
    if (VOID_PROMISE_RE.test(trimmed) && trimmed.startsWith("void ")) {
      issues.push({
        category: "unhandled-promise",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Promise discarded with void expression in \`${file.path}:${change.line}\` — void does not handle rejections, use .catch() or await with try/catch`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectMissingAwait(file: DiffFile): ErrorHandlingIssue[] {
  const issues: ErrorHandlingIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Skip comments and imports
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (/^\+\s*import\s/.test(content)) continue;
      if (trimmed.startsWith("}")) continue;

      // Skip lines that already have await
      if (/\bawait\b/.test(content)) continue;
      // Skip lines that are async function declarations
      if (/\basync\s+function\b/.test(content) || /\basync\s*\(/.test(content) || /\basync\s+/.test(content) && /=>/.test(content)) continue;
      // Skip lines that are return statements
      if (/\breturn\b/.test(content)) continue;
      // Skip lines in try/catch
      if (/\btry\s*\{/.test(content)) continue;
      // Skip lines that are assignments to variables that will be awaited later
      if (/\bconst\b.*=\s*(?:fetch|axios)/.test(content) && !content.includes("await")) {
        // This is likely a missing await
      } else if (/\bconst\b.*=.*Promise/.test(content)) {
        // Promise assigned to variable — might be intentionally deferred
        continue;
      }

      // Detect known async function calls without await
      const asyncMatch = content.match(/\b(fetch|axios\.\w+|readFile|writeFile|mkdir|rm|readdir|copyFile|pipeline|query|execute|connect|disconnect|find|findById|findOne|save|remove|deleteOne|updateOne|create|aggregate|bulkWrite)\s*\(/);
      if (asyncMatch) {
        // Skip if inside .then() or .catch() callback
        if (/\.then\s*\(/.test(content) || /\.catch\s*\(/.test(content)) continue;
        // Skip if the line has = (... which means it might be assigned
        if (/=\s*\(\s*$/.test(content)) continue;

        issues.push({
          category: "missing-await",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Async function \`${asyncMatch[1]}() \` called without await in \`${file.path}:${change.line}\` — result is a Promise, not the actual value; add await or handle rejection`,
          severity: "critical",
        });
      }

      // Detect Redis async operations without await
      if (REDIS_ASYNC_RE.test(content)) {
        // Skip if inside .then() or .catch() callback
        if (/\.then\s*\(/.test(content) || /\.catch\s*\(/.test(content)) continue;

        issues.push({
          category: "missing-await",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Redis async operation without await in \`${file.path}:${change.line}\` — result is a Promise, add await or handle rejection`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectSwallowedErrors(file: DiffFile): ErrorHandlingIssue[] {
  const issues: ErrorHandlingIssue[] = [];

  for (const hunk of file.hunks) {
    const changes = hunk.changes;

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change.type !== "add") continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Single-line empty catch: catch (e) {} — flagged by dead-code-detector
      if (TRIVIAL_CATCH_RE.test(content)) continue;

      // Check for catch blocks with trivial content (just a comment or console.log)
      const catchOpenMatch = content.match(/catch\s*\([^)]*\)\s*\{\s*$/);
      if (catchOpenMatch) {
        // Look at the next added line(s) for the catch body
        let bodyLines: string[] = [];
        for (let j = i + 1; j < changes.length; j++) {
          if (changes[j].type !== "add") continue;
          const nextTrimmed = changes[j].content.replace(/^\+/, "").trim();
          if (nextTrimmed === "}") break;
          bodyLines.push(nextTrimmed);
          if (bodyLines.length >= 5) break;
        }

        if (bodyLines.length > 0) {
          const allComments = bodyLines.every((l) => l.startsWith("//") || l.startsWith("/*") || l.startsWith("*"));
          const allVarRef = bodyLines.every((l) => VAR_REF_ONLY_RE.test(l))
            && !bodyLines.some((l) => /\bthrow\b/.test(l));
          if (allComments) {
            issues.push({
              category: "swallowed-error",
              file: file.path,
              line: change.line,
              code: trimmed,
              description: `Catch block body only contains comments in \`${file.path}:${change.line}\` — error is caught but not handled, add logging or rethrow`,
              severity: "warning",
            });
          } else if (allVarRef) {
            issues.push({
              category: "swallowed-error",
              file: file.path,
              line: change.line,
              code: trimmed,
              description: `Catch block body only references the error variable in \`${file.path}:${change.line}\` — error is caught but not handled, add logging or rethrow`,
              severity: "warning",
            });
          }
        }
      }

      // Inline catch with only comment body: catch (e) { /* ignored */ }
      const inlineCatch = content.match(/catch\s*\([^)]*\)\s*\{\s*\/\*[^*]*\*+\/?\s*\}/);
      if (inlineCatch) {
        issues.push({
          category: "swallowed-error",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Catch block body is only a comment in \`${file.path}:${change.line}\` — error is caught but not handled, add logging or rethrow`,
          severity: "warning",
        });
      }

      // catch (e) { console.log(e) } — logs but doesn't propagate
      const logOnlyCatch = content.match(/catch\s*\([^)]*\)\s*\{\s*console\.(log|debug|info)\s*\([^)]*\)\s*;?\s*\}/);
      if (logOnlyCatch) {
        issues.push({
          category: "swallowed-error",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Catch block only logs error in \`${file.path}:${change.line}\` — error is logged but not propagated; consider logging at warning/error level and rethrowing or adding monitoring`,
          severity: "warning",
        });
      }

      // Inline catch with only variable reference: catch (e) { e; }
      const varRefCatch = content.match(/catch\s*\([^)]*\)\s*\{\s*\w+;?\s*\}/);
      if (varRefCatch && !content.includes("throw") && !content.includes("console.error") && !content.includes("logger.error")) {
        const bodyMatch = content.match(/catch\s*\([^)]*\)\s*\{\s*(\w+;?)\s*\}/);
        if (bodyMatch) {
          issues.push({
            category: "swallowed-error",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Catch block body is only a variable reference in \`${file.path}:${change.line}\` — error is caught but not handled, add logging or rethrow`,
            severity: "warning",
          });
        }
      }

      // .on('unhandledRejection', ...) with empty handler
      const emptyErrorHandler = content.match(/\.on\s*\(\s*['"]unhandledRejection['"]\s*,/);
      if (emptyErrorHandler && content.includes("{}")) {
        issues.push({
          category: "swallowed-error",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Empty unhandledRejection handler in \`${file.path}:${change.line}\` — errors will be silently discarded, add proper handling`,
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

function dedupIssues(issues: ErrorHandlingIssue[]): ErrorHandlingIssue[] {
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

function buildErrorHandlingContext(result: ErrorHandlingResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Error Handling Gaps (${result.issues.length})\n`;
  ctx += "This PR may have error handling gaps:\n\n";

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

function buildErrorHandlingBodySummary(result: ErrorHandlingResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Error Handling Gap Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Unhandled promises and missing awaits cause production incidents. Swallowed errors mask bugs.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run error handling gap detection on diff files.
 * Zero LLM cost.
 */
export function detectErrorHandlingGaps(diffFiles: DiffFile[]): ErrorHandlingResult {
  const allIssues: ErrorHandlingIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectUnhandledPromises(file));
    allIssues.push(...detectMissingAwait(file));
    allIssues.push(...detectSwallowedErrors(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ErrorHandlingResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildErrorHandlingContext(result);
  result.bodySummary = buildErrorHandlingBodySummary(result);

  if (issues.length > 0) {
    core.info(`Error handling gap detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
