/**
 * Magic Number Detector — detect hardcoded numeric/string literals in PR diffs.
 *
 * No AI code reviewer flags magic numbers at PR review time. SonarQube S109
 * detects them at the repo level but not in PR diffs. CodeRabbit, Copilot,
 * and Sourcery all miss them. Magic numbers reduce readability, make code
 * harder to maintain, and are the source of subtle bugs when the same value
 * appears in multiple places.
 *
 * Mizumi scans added lines for 3 magic number categories:
 * 1. Numeric literal: hardcoded numbers (excluding 0, 1, -1, array indices)
 * 2. String literal: hardcoded strings in comparisons/assignments (not imports/comments)
 * 3. Timeout/duration: hardcoded timing values (ms, s) that should be config
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MagicNumberCategory =
  | "numeric-literal"
  | "string-literal"
  | "timeout-duration";

export interface MagicNumberIssue {
  /** Category of the issue */
  category: MagicNumberCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The magic value detected */
  value: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = timeout/duration, warning = numeric/string literals */
  severity: "critical" | "warning";
}

export interface MagicNumberResult {
  /** All detected magic number issues */
  issues: MagicNumberIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Numeric literals: numbers in assignments/comparisons (not in property access, imports, etc.)
const NUMERIC_LITERAL_RE = /(?:[=<>!+\-*/|&?]\s*)(\d{2,})\b/;

// Common safe numbers to skip
const SAFE_NUMBERS = new Set(["0", "1", "-1", "10", "100", "1000", "2", "4", "8", "16", "32", "64", "128", "256", "512", "1024"]);

// String literals in comparisons/assignments (not imports, comments, or console.log)
const STRING_LITERAL_RE = /===?\s*['"][^'"]{3,}['"]|=\s*['"][^'"]{3,}['"]/;

// Timeout/duration values: numbers followed by ms/s unit hints in variable names or comments
const TIMEOUT_RE = /\b(timeout|delay|interval|duration|wait|sleep|retry|backoff|ttl|expire)\w*\s*[=:]\s*\d{2,}/i;

// Lines to skip (comments, imports, type declarations)
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detectNumericLiterals(file: DiffFile): MagicNumberIssue[] {
  const issues: MagicNumberIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      const content = change.content;

      if (SKIP_LINE_RE.test(content)) continue;
      // Skip lines that are only a number (like test assertions)
      if (/^\+\s*\d+\s*$/.test(content)) continue;
      // Skip lines in test files
      if (file.path.includes(".test.") || file.path.includes(".spec.")) continue;

      const match = content.match(NUMERIC_LITERAL_RE);
      if (!match) continue;

      const number = match[1];
      if (SAFE_NUMBERS.has(number)) continue;
      // Skip dates (2024, 2025, 2026)
      if (/^(19|20)\d{2}$/.test(number)) continue;
      // Skip version numbers (e.g., 3.14, node 20)
      if (/version|Version|VERSION/.test(content)) continue;

      issues.push({
        category: "numeric-literal",
        file: file.path,
        line: change.line,
        value: number,
        description: `Magic number \`${number}\` in \`${file.path}:${change.line}\` — consider extracting to a named constant`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectStringLiterals(file: DiffFile): MagicNumberIssue[] {
  const issues: MagicNumberIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      const content = change.content;

      if (SKIP_LINE_RE.test(content)) continue;
      // Skip console.log and string-only lines
      if (/console\.\w+\(|^\+\s*['"]/.test(content)) continue;
      // Skip test files
      if (file.path.includes(".test.") || file.path.includes(".spec.")) continue;

      const match = content.match(STRING_LITERAL_RE);
      if (!match) continue;

      // Extract the string value
      const strMatch = match[0].match(/['"]([^'"]+)['"]/);
      if (!strMatch) continue;
      const strVal = strMatch[1];

      issues.push({
        category: "string-literal",
        file: file.path,
        line: change.line,
        value: `"${strVal.length > 30 ? strVal.slice(0, 27) + "..." : strVal}"`,
        description: `Hardcoded string \`${strVal.length > 30 ? strVal.slice(0, 27) + "..." : strVal}\` in \`${file.path}:${change.line}\` — consider extracting to a named constant`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectTimeoutDurations(file: DiffFile): MagicNumberIssue[] {
  const issues: MagicNumberIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      const content = change.content;

      if (SKIP_LINE_RE.test(content)) continue;
      if (file.path.includes(".test.") || file.path.includes(".spec.")) continue;

      const match = content.match(TIMEOUT_RE);
      if (!match) continue;

      // Extract the number value
      const numMatch = match[0].match(/(\d{2,})/);
      const numVal = numMatch ? numMatch[1] : "unknown";

      issues.push({
        category: "timeout-duration",
        file: file.path,
        line: change.line,
        value: numVal,
        description: `Hardcoded timeout/duration \`${numVal}\` in \`${file.path}:${change.line}\` — extract to a config constant for maintainability`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: MagicNumberIssue[]): MagicNumberIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}:${issue.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildMagicNumberContext(result: MagicNumberResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Magic Number Detection (${result.issues.length})\n`;
  ctx += "This PR introduces magic numbers:\n\n";

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

function buildMagicNumberBodySummary(result: MagicNumberResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Magic Number Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | Value | File | Line | Severity |\n";
  body += "|----------|-------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.value}\` | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Magic numbers reduce readability and make code harder to maintain. Extract values to named constants.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run magic number detection on diff files.
 * Zero LLM cost.
 */
export function detectMagicNumbers(diffFiles: DiffFile[]): MagicNumberResult {
  const allIssues: MagicNumberIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectNumericLiterals(file));
    allIssues.push(...detectStringLiterals(file));
    allIssues.push(...detectTimeoutDurations(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: MagicNumberResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildMagicNumberContext(result);
  result.bodySummary = buildMagicNumberBodySummary(result);

  if (issues.length > 0) {
    core.info(`Magic number detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
