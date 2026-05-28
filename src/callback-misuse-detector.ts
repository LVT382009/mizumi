/**
 * Callback Misuse Detector — detect callback/Promise style mixing in PR diffs.
 *
 * LLMs trained on mixed-era codebases frequently misuse callback patterns:
 * - Passing callbacks to Promise-returning functions
 * - Wrapping callback APIs in `new Promise()` when a promise version exists
 * - Ignoring the error parameter in error-first callbacks
 * - Using deprecated callback-style Node.js APIs instead of fs.promises
 *
 * No AI code reviewer detects callback/Promise mixing as a category.
 * ESLint `callback-return` and `prefer-promise-reject-errors` exist but:
 * 1. Are opt-in and rarely enabled
 * 2. Don't detect the specific pattern of wrapping callback APIs in Promise
 * 3. Don't detect using deprecated callback APIs when promise versions exist
 *
 * Categories:
 * 1. callback-promise-mix: passing callback to function that returns Promise
 * 2. promise-callback-wrap: new Promise() wrapper around callback API
 * 3. unhandled-callback-error: error-first callback where error param is ignored
 * 4. deprecated-callback-api: using Node.js callback API instead of promise version
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CallbackMisuseCategory =
  | "callback-promise-mix"
  | "promise-callback-wrap"
  | "unhandled-callback-error"
  | "deprecated-callback-api";

export interface CallbackMisuseIssue {
  category: CallbackMisuseCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface CallbackMisuseResult {
  issues: CallbackMisuseIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Promise-returning functions called with a callback argument
// e.g., fetch(url, callback) — fetch doesn't take a callback
// Pattern: known promise function name with (..., function(...) or (..., (err, result) => {})
const PROMISE_FUNC_RE = /\b(?:fetch|axios\.\w+|readFile|writeFile|mkdir|rm|readdir|copyFile|access|stat|lstat|chmod|chown|link|symlink|unlink|rename|readlink|realpath|mkdtemp|appendFile|open|close|fdatasync|fsync|truncate|ftruncate|write|read|pipe|watchFile|unwatchFile)\s*\(/;

// Callback argument pattern: function(err, ...) or (err, ...) =>
const CALLBACK_ARG_RE = /\(err(?:or)?\s*,/;

// new Promise() wrapping a callback API
const PROMISE_WRAP_RE = /new\s+Promise\s*\(\s*(?:async\s+)?\s*\(\s*(?:resolve|res)\s*,\s*(?:reject|rej)\s*\)\s*=>\s*\{/;

// Inside the Promise wrapper, detect callback API calls
const WRAPPED_CALLBACK_API_RE = /\b(?:fs|child_process|crypto|dns|http|https|net|readline|tls|zlib)\.\w+\s*\(/;

// Error-first callback where error parameter is declared but never used
// Pattern: (err, result) => or function(err, result) — can appear anywhere in the line
const ERROR_FIRST_CALLBACK_RE = /\(err(?:or)?\s*,/;

// Callback body that doesn't reference the error parameter at all
const MISSING_ERROR_CHECK_RE = /\b(?:if|throw)\s+\(?\s*err(?:or)?\b/;

// Also detect require('fs') callback calls
const FS_CALLBACK_RE = /\bfs\.\s*(?:readFile|writeFile|mkdir|readdir|stat|lstat|access|unlink|rename|rmdir|appendFile|open|read|write|close|copyFile|chmod|chown|link|symlink|readlink|realpath|mkdtemp|watchFile|rm)\s*\(/;

// Check if the line has a callback as last argument
const CALLBACK_AS_LAST_ARG_RE = /(?:function\s*\(|=>)\s*\(.*err/;

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectCallbackPromiseMix(file: DiffFile): CallbackMisuseIssue[] {
  const issues: CallbackMisuseIssue[] = [];

  for (const hunk of file.hunks) {
    const changes = hunk.changes.filter((c) => c.type === "add");

    for (const change of changes) {
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Detect: known promise function called with callback argument
      // Pattern: fetch(url, function(err, data) {...}) or fs.readFile(path, (err, data) => {...})
      if (PROMISE_FUNC_RE.test(trimmed) && CALLBACK_ARG_RE.test(trimmed)) {
        const funcMatch = trimmed.match(/(\w+)\s*\(/);
        const funcName = funcMatch?.[1] || "function";

        issues.push({
          category: "callback-promise-mix",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Promise-returning function \`${funcName}()\` called with callback argument in \`${file.path}:${change.line}\` — LLMs mix callback and Promise styles; use await or .then()/.catch() instead of callback`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectPromiseCallbackWrap(file: DiffFile): CallbackMisuseIssue[] {
  const issues: CallbackMisuseIssue[] = [];

  for (const hunk of file.hunks) {
    const changes = hunk.changes.filter((c) => c.type === "add");

    // Look for `new Promise((resolve, reject) => {` followed by callback API calls
    let promiseWrapStartLine: number | null = null;
    let hasCallbackApi = false;
    let wrapCode = "";

    for (const change of changes) {
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      if (PROMISE_WRAP_RE.test(trimmed)) {
        promiseWrapStartLine = change.line;
        wrapCode = trimmed;
        hasCallbackApi = false;
        continue;
      }

      // Check if we're inside a Promise wrapper (loosely — within next 20 lines)
      if (promiseWrapStartLine !== null && change.line <= (promiseWrapStartLine || 0) + 20) {
        if (WRAPPED_CALLBACK_API_RE.test(trimmed)) {
          hasCallbackApi = true;
        }

        // Closing brace of the Promise wrapper
        if (trimmed === "});" || trimmed === "})" || trimmed === "});") {
          if (hasCallbackApi) {
            issues.push({
              category: "promise-callback-wrap",
              file: file.path,
              line: promiseWrapStartLine,
              code: wrapCode,
              description: `Callback API wrapped in \`new Promise()\` in \`${file.path}:${promiseWrapStartLine}\` — LLMs wrap callback APIs in Promises manually; use \`fs.promises.*\` or \`util.promisify()\` instead of hand-rolling Promise wrappers`,
              severity: "warning",
            });
          }
          promiseWrapStartLine = null;
          hasCallbackApi = false;
        }
      }
    }

    // If we found a Promise wrap but no closing, and it has a callback API, still flag it
    if (promiseWrapStartLine !== null && hasCallbackApi) {
      issues.push({
        category: "promise-callback-wrap",
        file: file.path,
        line: promiseWrapStartLine,
        code: wrapCode,
        description: `Callback API wrapped in \`new Promise()\` in \`${file.path}:${promiseWrapStartLine}\` — LLMs wrap callback APIs in Promises manually; use \`fs.promises.*\` or \`util.promisify()\` instead`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectUnhandledCallbackError(file: DiffFile): CallbackMisuseIssue[] {
  const issues: CallbackMisuseIssue[] = [];

  for (const hunk of file.hunks) {
    const changes = hunk.changes.filter((c) => c.type === "add");

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Detect error-first callback: (err, result) => or function(err, result)
      if (ERROR_FIRST_CALLBACK_RE.test(trimmed)) {
        // Look ahead in the callback body for error handling (if/throw error)
        let foundErrorCheck = false;
        let bodyLines: string[] = [];

        for (let j = i + 1; j < Math.min(i + 10, changes.length); j++) {
          const nextTrimmed = changes[j].content.replace(/^\+/, "").trim();
          if (nextTrimmed === "}" || nextTrimmed === "});" || nextTrimmed === "})") break;
          bodyLines.push(nextTrimmed);

          if (MISSING_ERROR_CHECK_RE.test(nextTrimmed)) {
            foundErrorCheck = true;
            break;
          }
        }

        // Also check if the error check is on the same line as the callback
        if (MISSING_ERROR_CHECK_RE.test(trimmed)) {
          foundErrorCheck = true;
        }

        if (!foundErrorCheck) {
          issues.push({
            category: "unhandled-callback-error",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Error-first callback without error handling in \`${file.path}:${change.line}\` — LLMs declare \`err\` parameter but never check it; add \`if (err)\` guard or use Promise-based API with try/catch`,
            severity: "warning",
          });
        }
      }

      // Inline callback: someCallback((err, data) => data)
      // Only flag if it's a one-liner (no opening brace) — multiline ones handled above
      const inlineCallback = trimmed.match(/\(err(?:or)?\s*,\s*\w+\)\s*=>\s*(?!.*err(?:or)?)(?![^{]*\{)/);
      if (inlineCallback && !MISSING_ERROR_CHECK_RE.test(trimmed) && !trimmed.includes("{")) {
        // Make sure we haven't already flagged this line
        const alreadyFlagged = issues.some(
          (iss) => iss.category === "unhandled-callback-error" && iss.line === change.line
        );
        if (!alreadyFlagged) {
          issues.push({
            category: "unhandled-callback-error",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Error-first callback with unused error parameter in \`${file.path}:${change.line}\` — LLMs ignore callback errors; add error handling or use async/await with try/catch`,
            severity: "warning",
          });
        }
      }
    }
  }

  return issues;
}

function detectDeprecatedCallbackApi(file: DiffFile): CallbackMisuseIssue[] {
  const issues: CallbackMisuseIssue[] = [];

  for (const hunk of file.hunks) {
    const changes = hunk.changes.filter((c) => c.type === "add");

    for (const change of changes) {
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Detect fs.*() call with callback as last argument
      if (FS_CALLBACK_RE.test(trimmed)) {
        // Check if it has a callback argument (function or arrow)
        if (CALLBACK_AS_LAST_ARG_RE.test(trimmed) || content.includes("function(") || content.includes("=>")) {
          const funcMatch = trimmed.match(/fs\.(\w+)\s*\(/);
          const funcName = funcMatch?.[1] || "readFile";

          issues.push({
            category: "deprecated-callback-api",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Deprecated callback-style \`fs.${funcName}()\` in \`${file.path}:${change.line}\` — LLMs use callback-style Node.js APIs from training data; use \`await fs.promises.${funcName}()\` or \`const { promisify } = require('util')\` instead`,
            severity: "warning",
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: CallbackMisuseIssue[]): CallbackMisuseIssue[] {
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

function buildCallbackMisuseContext(result: CallbackMisuseResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Callback/Promise Misuse (${result.issues.length})\n`;
  ctx += "This PR may contain callback/Promise style mixing — LLMs trained on mixed-era codebases generate callback-style code in modern async/await codebases:\n\n";

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

function buildCallbackMisuseBodySummary(result: CallbackMisuseResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Callback/Promise Misuse Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Callback/Promise mixing causes unhandled errors, race conditions, and harder-to-read code. LLMs trained on older codebases generate callback patterns when modern async/await is preferred.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run callback misuse detection on diff files.
 * Zero LLM cost.
 */
export function detectCallbackMisuse(diffFiles: DiffFile[]): CallbackMisuseResult {
  const allIssues: CallbackMisuseIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectCallbackPromiseMix(file));
    allIssues.push(...detectPromiseCallbackWrap(file));
    allIssues.push(...detectUnhandledCallbackError(file));
    allIssues.push(...detectDeprecatedCallbackApi(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: CallbackMisuseResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildCallbackMisuseContext(result);
  result.bodySummary = buildCallbackMisuseBodySummary(result);

  if (issues.length > 0) {
    core.info(`Callback misuse detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
