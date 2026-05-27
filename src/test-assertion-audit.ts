/**
 * Test Assertion Quality Audit — evaluate whether test assertions actually
 * validate intended behavior.
 *
 * No AI code reviewer audits test assertion quality. CodeRabbit, Copilot,
 * CodeGuru, and Sourcery all check "do tests exist?" but never ask "do
 * tests actually test anything?" The Qodo 90-repo study confirmed weak
 * assertions are endemic — `expect(x).toBeDefined()` passes on anything,
 * zero-assertion tests give false confidence, and tests that never reach
 * failure paths mask real bugs.
 *
 * Mizumi audits test files for:
 * 1. Weak assertions: toBeDefined, toBeTruthy, toBeFalsy, toBeNull,
 *    toBe(null), toBe(undefined) — these pass too easily
 * 2. Zero-assertion files: test files with no expect() calls at all
 * 3. Empty describe/it blocks: test scaffolding with no content
 * 4. Assertion-free tests: it() blocks with code but no assertions
 * 5. Tautological assertions: expect(true).toBe(true), expect(1).toBe(1)
 *
 * Zero LLM cost — pure regex/pattern analysis on test file content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssertionCategory =
  | "weak-assertion"
  | "zero-assertion-file"
  | "empty-block"
  | "assertion-free-test"
  | "tautological-assertion";

export interface WeakAssertion {
  /** Category of the issue */
  category: AssertionCategory;
  /** File path */
  file: string;
  /** Line number (1-based) or 0 if not applicable */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = zero-assertion/masks bugs, medium = weak assertion */
  severity: "critical" | "medium";
}

export interface AssertionAuditResult {
  /** All detected assertion quality issues */
  issues: WeakAssertion[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const WEAK_MATCHER_PATTERNS = [
  /expect\s*\([^)]*\)\s*\.\s*toBeDefined\s*\(\)/g,
  /expect\s*\([^)]*\)\s*\.\s*toBeTruthy\s*\(\)/g,
  /expect\s*\([^)]*\)\s*\.\s*toBeFalsy\s*\(\)/g,
  /expect\s*\([^)]*\)\s*\.\s*toBeNull\s*\(\)/g,
  /expect\s*\([^)]*\)\s*\.\s*toBe\s*\(\s*null\s*\)/g,
  /expect\s*\([^)]*\)\s*\.\s*toBe\s*\(\s*undefined\s*\)/g,
];

const TAUTOLOGICAL_PATTERNS = [
  /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/g,
  /expect\s*\(\s*false\s*\)\s*\.\s*toBe\s*\(\s*false\s*\)/g,
  /expect\s*\(\s*1\s*\)\s*\.\s*toBe\s*\(\s*1\s*\)/g,
  /expect\s*\(\s*0\s*\)\s*\.\s*toBe\s*\(\s*0\s*\)/g,
];

const EXPECT_PATTERN = /expect\s*\(/g;
const IT_PATTERN = /\b(it|test)\s*\(\s*["'`]/g;
const DESCRIBE_PATTERN = /\bdescribe\s*\(\s*["'`]/g;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectWeakAssertions(filePath: string, content: string): WeakAssertion[] {
  const issues: WeakAssertion[] = [];
  const lines = content.split("\n");

  for (const pattern of WEAK_MATCHER_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        const trimmed = line.trim();
        // Skip if it has a .not modifier (e.g., expect(x).not.toBeDefined is a meaningful negation)
        if (/\.\s*not\s*\.\s*(toBeDefined|toBeTruthy|toBeFalsy|toBeNull)/.test(trimmed)) continue;

        const matcher = trimmed.match(/\.\s*(toBeDefined|toBeTruthy|toBeFalsy|toBeNull|toBe)\s*\(/)?.[1] || "weak";
        issues.push({
          category: "weak-assertion",
          file: filePath,
          line: i + 1,
          code: trimmed,
          description: `Weak assertion \`.${matcher}()\` in \`${filePath}:${i + 1}\` — passes too easily, consider a more specific matcher`,
          severity: "medium",
        });
      }
    }
  }

  return issues;
}

function detectTautologicalAssertions(filePath: string, content: string): WeakAssertion[] {
  const issues: WeakAssertion[] = [];
  const lines = content.split("\n");

  for (const pattern of TAUTOLOGICAL_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        issues.push({
          category: "tautological-assertion",
          file: filePath,
          line: i + 1,
          code: lines[i].trim(),
          description: `Tautological assertion in \`${filePath}:${i + 1}\` — always passes, tests nothing`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectZeroAssertionFiles(filePath: string, content: string): WeakAssertion[] {
  const issues: WeakAssertion[] = [];

  EXPECT_PATTERN.lastIndex = 0;
  if (!EXPECT_PATTERN.test(content)) {
    // Check if this is actually a test file (has it/test or describe blocks)
    IT_PATTERN.lastIndex = 0;
    DESCRIBE_PATTERN.lastIndex = 0;
    if (IT_PATTERN.test(content) || DESCRIBE_PATTERN.test(content)) {
      issues.push({
        category: "zero-assertion-file",
        file: filePath,
        line: 0,
        code: "",
        description: `Test file \`${filePath}\` has no \`expect()\` calls — tests provide no actual verification`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectAssertionFreeTests(filePath: string, content: string): WeakAssertion[] {
  const issues: WeakAssertion[] = [];
  const lines = content.split("\n");

  let inItBlock = false;
  let itStart = -1;
  let itName = "";
  let depth = 0;
  let hasExpect = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect it() or test() block start
    const itMatch = line.match(/\b(it|test)\s*\(\s*["'`]([^"'`]+)/);
    if (itMatch && !inItBlock) {
      inItBlock = true;
      itStart = i + 1;
      itName = itMatch[2];
      depth = 0;
      hasExpect = false;
      // Count braces in the same line
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      continue;
    }

    if (inItBlock) {
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }

      if (/expect\s*\(/.test(line)) hasExpect = true;

      if (depth <= 0 && i > 0) {
        // Block ended
        if (!hasExpect && itName) {
          issues.push({
            category: "assertion-free-test",
            file: filePath,
            line: itStart,
            code: `it("${itName}...")`,
            description: `Test \`"${itName}"\` in \`${filePath}:${itStart}\` has no \`expect()\` — may be missing assertions`,
            severity: "critical",
          });
        }
        inItBlock = false;
        itName = "";
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: WeakAssertion[]): WeakAssertion[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}:${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildAuditContext(result: AssertionAuditResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const medium = result.issues.filter((i) => i.severity === "medium");

  let ctx = `## Test Assertion Quality (${result.issues.length} issues)\n`;
  ctx += "This PR may introduce weak or missing test assertions:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical.slice(0, 5)) {
      ctx += `- ${i.description}\n`;
    }
  }
  if (medium.length > 0) {
    ctx += "### Medium\n";
    for (const i of medium.slice(0, 5)) {
      ctx += `- ${i.description}\n`;
    }
  }

  return ctx.trim();
}

function buildAuditBodySummary(result: AssertionAuditResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Test Assertion Quality</strong> — ${result.issues.length} issues</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    const lineStr = i.line > 0 ? String(i.line) : "-";
    body += `| ${catLabel} | \`${i.file}\` | ${lineStr} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Weak or missing assertions give false confidence in test coverage.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run test assertion quality audit on test files in the diff.
 * Zero LLM cost.
 */
export function auditTestAssertions(diffFiles: DiffFile[]): AssertionAuditResult {
  const allIssues: WeakAssertion[] = [];

  for (const file of diffFiles) {
    // Only audit test files
    if (!isTestFile(file.path)) continue;
    if (file.status === "deleted") continue;

    // Get content from hunks
    const content = reconstructContent(file);

    allIssues.push(...detectWeakAssertions(file.path, content));
    allIssues.push(...detectTautologicalAssertions(file.path, content));
    allIssues.push(...detectZeroAssertionFiles(file.path, content));
    allIssues.push(...detectAssertionFreeTests(file.path, content));
  }

  const issues = dedupIssues(allIssues);

  // Sort: critical first, then by file
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: AssertionAuditResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildAuditContext(result);
  result.bodySummary = buildAuditBodySummary(result);

  if (issues.length > 0) {
    core.info(`Test assertion audit: ${issues.length} quality issues detected`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]s$/,
  /\.spec\.[jt]s$/,
  /__tests__\//,
  /test\//,
  /tests\//,
];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

function reconstructContent(file: DiffFile): string {
  const lines: string[] = [];
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      // Strip the +/- prefix for analysis
      const content = change.content;
      lines.push(content);
    }
  }
  return lines.join("\n");
}
