/**
 * Debug Artifact Detector — detect leftover debugging artifacts in PR diffs.
 *
 * LLMs frequently leave debugging artifacts in production code:
 * - `debugger;` statements
 * - `console.log()` / `console.debug()` in non-test code
 * - `it.only()` / `describe.only()` that break CI suites
 * - Debug/verbose/trace flags left enabled
 *
 * No existing AI code reviewer detects debug artifacts as a category.
 * ESLint `no-debugger` and `no-console` exist but are:
 * 1. Opt-in (most projects don't enable them)
 * 2. Not integrated into PR review context
 * 3. Miss debug flags and test isolation breaks
 *
 * Categories:
 * 1. debugger-statement: `debugger;` left in code
 * 2. console-debug: console.log/debug/info in non-test, non-script files
 * 3. test-isolation-break: it.only, describe.only, it.skip in test files
 * 4. debug-flag-true: debug/verbose/trace/logging flags left enabled
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DebugArtifactCategory =
  | "debugger-statement"
  | "console-debug"
  | "test-isolation-break"
  | "debug-flag-true";

export interface DebugArtifactIssue {
  category: DebugArtifactCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface DebugArtifactResult {
  issues: DebugArtifactIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// debugger; statement
const DEBUGGER_RE = /\bdebugger\s*;/;

// console.log / console.debug / console.info in production code
// console.warn and console.error are acceptable for error reporting
const CONSOLE_DEBUG_RE = /\.(log|debug|info|trace|dir|table|group|groupEnd|time|timeEnd|count|countReset|assert|clear|profile|profileEnd)\s*\(/;
const CONSOLE_WARN_ERROR_RE = /\.(warn|error)\s*\(/;

// Test isolation breaks
const TEST_ONLY_RE = /\b(?:it|test|describe|context|suite)\.(only|skip)\s*\(/;
const FOCUS_BLOCK_RE = /\b(?:fit|fdescribe|xit|xdescribe|xtest|xit)\s*\(/;

// Debug flag patterns: debug/verbose/trace/logging = true
const DEBUG_FLAG_TRUE_RE = /\b(?:debug|verbose|trace|tracing|logging|logLevel|log_level)\s*[:=]\s*(?:true|True|TRUE|'debug'|'verbose'|'trace'|"debug"|"verbose"|"trace")/;

// Debug flag in config object
const DEBUG_CONFIG_TRUE_RE = /(?:debug|verbose|trace|logging|logLevel)\s*:\s*(?:true|True|TRUE)\s*[,;}]/;

// Skip patterns — comments, imports, type declarations
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// Test files — apply stricter test-only rules, relax console rules
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|\/test\/|\/tests\/|\.e2e\.)/;

// Script/CLI/build files — console.log is acceptable here
const SCRIPT_FILE_RE = /(?:\.sh$|\.bash$|Makefile|Dockerfile|\.ps1$|scripts\/|cli\/|bin\/|\.cmd$|\.bat$)/;

// Config files — might legitimately set debug flags
const CONFIG_FILE_RE = /(?:\.env|config\.\w+$|settings\.\w+$|\.yml$|\.yaml$|\.toml$)/;

// Log/test directory files — console expected
const LOGGING_DIR_RE = /(?:\/log|\/logger|\/logging|\/monitor|\/telemetry)\//;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectDebuggerStatements(file: DiffFile): DebugArtifactIssue[] {
  const issues: DebugArtifactIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      if (DEBUGGER_RE.test(trimmed)) {
        issues.push({
          category: "debugger-statement",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Debug statement \`debugger;\` in \`${file.path}:${change.line}\` — LLMs frequently leave debugger statements from iterative debugging; remove before merging`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectConsoleDebug(file: DiffFile): DebugArtifactIssue[] {
  const issues: DebugArtifactIssue[] = [];

  // In test files, console.log is expected (test output)
  if (TEST_FILE_RE.test(file.path)) return issues;
  // In script/CLI files, console.log is acceptable
  if (SCRIPT_FILE_RE.test(file.path)) return issues;
  // In logging utility files, console is expected
  if (LOGGING_DIR_RE.test(file.path)) return issues;

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Check for console.<debug-method>()
      if (/\bconsole/.test(content) && CONSOLE_DEBUG_RE.test(content) && !CONSOLE_WARN_ERROR_RE.test(content)) {
        const methodMatch = content.match(/\bconsole\.(\w+)\s*\(/);
        const method = methodMatch?.[1] || "log";

        issues.push({
          category: "console-debug",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Debug logging \`console.${method}()\` in \`${file.path}:${change.line}\` — LLMs add console.log for debugging; use structured logger (pino, winston, bunyan) or remove before merging`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectTestIsolationBreaks(file: DiffFile): DebugArtifactIssue[] {
  const issues: DebugArtifactIssue[] = [];

  // Only check test files
  if (!TEST_FILE_RE.test(file.path)) return issues;

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // it.only / describe.only / it.skip
      if (TEST_ONLY_RE.test(trimmed)) {
        const match = trimmed.match(/\b(it|test|describe|context|suite)\.(only|skip)\s*\(/);
        if (match) {
          const [, block, modifier] = match;
          const severity = modifier === "only" ? "critical" as const : "warning" as const;
          const impact = modifier === "only"
            ? "runs only this test, hiding failures in all other tests"
            : "skips this test, hiding its failures";

          issues.push({
            category: "test-isolation-break",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Test isolation break \`${block}.${modifier}()\` in \`${file.path}:${change.line}\` — LLMs add .only to focus debugging then forget to remove it; this ${impact}; remove .${modifier} before merging`,
            severity,
          });
        }
      }

      // fit / fdescribe / xit / xdescribe — Mocha/Jest focused/excluded tests
      if (FOCUS_BLOCK_RE.test(trimmed)) {
        const match = trimmed.match(/\b(fit|fdescribe|xit|xdescribe|xtest|xit)\s*\(/);
        if (match) {
          const [block] = match;
          const isFocus = block.startsWith("f");
          const severity = isFocus ? "critical" as const : "warning" as const;
          const impact = isFocus
            ? "focused test runs only this test, hiding failures in all other tests"
            : "excluded test skips this test, hiding its failures";

          issues.push({
            category: "test-isolation-break",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Test isolation break \`${block}()\` in \`${file.path}:${change.line}\` — LLMs use focused/excluded tests during debugging then forget to revert; this ${impact}; use regular it/describe before merging`,
            severity,
          });
        }
      }
    }
  }

  return issues;
}

function detectDebugFlagTrue(file: DiffFile): DebugArtifactIssue[] {
  const issues: DebugArtifactIssue[] = [];

  // Config files are expected to set debug flags
  if (CONFIG_FILE_RE.test(file.path)) return issues;
  // Test files may intentionally set debug for test scenarios
  if (TEST_FILE_RE.test(file.path)) return issues;

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // debug = true / verbose: true / logging: true
      if (DEBUG_FLAG_TRUE_RE.test(trimmed)) {
        const match = trimmed.match(/\b(\w+)\s*[:=]\s*(true|True|TRUE|'debug'|'verbose'|'trace'|"debug"|"verbose"|"trace")/);
        const flag = match?.[1] || "debug";

        issues.push({
          category: "debug-flag-true",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Debug flag \`${flag}\` set to true in \`${file.path}:${change.line}\` — LLMs enable debug/verbose flags for testing then forget to disable; this may leak sensitive data in logs or hurt performance in production`,
          severity: "warning",
        });
      }

      // Config object: debug: true,
      if (DEBUG_CONFIG_TRUE_RE.test(trimmed)) {
        const match = trimmed.match(/(\w+)\s*:\s*(true|True|TRUE)\s*[,;]/);
        const flag = match?.[1] || "debug";

        // Avoid double-flagging if already caught by DEBUG_FLAG_TRUE_RE
        const alreadyMatched = DEBUG_FLAG_TRUE_RE.test(trimmed);
        if (alreadyMatched) continue;

        issues.push({
          category: "debug-flag-true",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Debug flag \`${flag}: true\` in \`${file.path}:${change.line}\` — LLMs enable debug/verbose flags for testing then forget to disable; this may expose sensitive data in production logs`,
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

function dedupIssues(issues: DebugArtifactIssue[]): DebugArtifactIssue[] {
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

function buildDebugArtifactContext(result: DebugArtifactResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Debug Artifacts (${result.issues.length})\n`;
  ctx += "This PR may contain leftover debugging artifacts — LLMs add these during iterative development:\n\n";

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

function buildDebugArtifactBodySummary(result: DebugArtifactResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Debug Artifact Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Debug artifacts leak sensitive data and break CI suites. LLMs add them during iterative debugging and frequently forget to remove them before committing.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run debug artifact detection on diff files.
 * Zero LLM cost.
 */
export function detectDebugArtifacts(diffFiles: DiffFile[]): DebugArtifactResult {
  const allIssues: DebugArtifactIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectDebuggerStatements(file));
    allIssues.push(...detectConsoleDebug(file));
    allIssues.push(...detectTestIsolationBreaks(file));
    allIssues.push(...detectDebugFlagTrue(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: DebugArtifactResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildDebugArtifactContext(result);
  result.bodySummary = buildDebugArtifactBodySummary(result);

  if (issues.length > 0) {
    core.info(`Debug artifact detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
