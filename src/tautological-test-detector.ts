/**
 * Tautological Test Detector — detect tests that mirror implementation logic.
 *
 * When LLMs generate both code and tests in the same session, the tests
 * share the same flawed mental model as the implementation. Coverage metrics
 * look healthy while real defect detection is near zero. This is uniquely
 * an AI-generation problem — human test authors bring independent judgment.
 *
 * Categories:
 * 1. tautological-assertion: test derives expected value using same logic path
 * 2. fixture-mirror-constant: test fixtures copy impl constants verbatim
 * 3. happy-path-only: AI-generated tests only covering happy path
 * 4. private-helper-in-test: tests importing/calling private implementation helpers
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TautologicalTestCategory =
  | "tautological-assertion"
  | "fixture-mirror-constant"
  | "happy-path-only"
  | "private-helper-in-test";

export interface TautologicalTestIssue {
  category: TautologicalTestCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface TautologicalTestResult {
  issues: TautologicalTestIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^\+/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Test file detection
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|\/test\/|\/tests\/|\.e2e\.)/;

// Assertion patterns
const EXPECT_RE = /\bexpect\s*\(/;
const ASSERT_RE = /\bassert(?:\.strict|\.deep)?\s*\(/;

// Tautological patterns — test re-computes expected using same logic
// e.g., expect(calculate(a, b)).toBe(a + b) — mirror of implementation
const TAUTOLOGICAL_MATH_RE = /expect\s*\(.+?\)\.\w+\s*\(\s*[\w.]+\s*[\+\-\*\/%]\s*[\w.]+\s*\)/;
// Patterns where test calls the same function to compute expected
// e.g., expect(fn(x)).toBe(fn(x)) or expected = fn(x); expect(result).toBe(expected)
const SELF_REFERENCE_RE = /(?:expected|result|actual)\s*=\s*(?:compute|calculate|format|parse|process|transform|validate|convert)\w*\s*\(/;

// Fixture mirroring — copying constants from implementation into test
const CONSTANT_IN_TEST_RE = /(?:const|let)\s+\w+\s*=\s*(?:\d{3,}|['"][\w\-]{10,}['"]|0x[0-9a-fA-F]{4,})\s*;/;

// Known constant patterns that suggest verbatim copy from implementation
const MAGIC_NUMBER_IN_TEST_RE = /expect\s*\(.+?\)\.\w+\s*\(\s*(?:0x[0-9a-fA-F]{4,}|\d{4,})\s*\)/;

// Happy-path-only signals: no error/no-edge-case tests
const ERROR_TEST_RE = /\b(?:error|fail|invalid|reject|throw|catch|negative|edge|boundary|empty|null|undefined|missing|wrong|bad|incorrect)/i;
const ERROR_CASE_RE = /\b(?:it|test|describe)\s*\(\s*['"].*(?:error|fail|invalid|should not|reject|throw|catch|negative|edge|boundary|empty|null|undefined|missing)/i;

// Private helper import patterns
const PRIVATE_HELPER_IMPORT_RE = /import\s+.*\s+from\s+['"]\.\.\/(?:src\/)?(?:lib\/)?(?:internal|private|helpers?|utils(?:\/internal)?)\//;

// Direct private function call patterns — tests that reach into implementation internals
const PRIVATE_METHOD_CALL_RE = /(?:_\w+)\s*\(/;

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// ---------------------------------------------------------------------------
// Detection: tautological-assertion
// ---------------------------------------------------------------------------

function detectTautologicalAssertion(file: DiffFile): TautologicalTestIssue[] {
  const issues: TautologicalTestIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Pattern: expected = compute...(); (doesn't need expect() on same line)
    if (SELF_REFERENCE_RE.test(trimmed)) {
      issues.push({
        category: "tautological-assertion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Test computes expected using same function in \`${file.path}:${change.line}\` — LLMs generate tests that call the same function to compute both actual and expected; if the function is buggy, both sides reproduce the bug; use independently-derived expected values`,
        severity: "warning",
      });
      continue;
    }

    if (!EXPECT_RE.test(trimmed) && !ASSERT_RE.test(trimmed)) continue;

    // Pattern: expect(fn(x)).toBe(math_expression)
    if (TAUTOLOGICAL_MATH_RE.test(trimmed)) {
      issues.push({
        category: "tautological-assertion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Tautological test assertion in \`${file.path}:${change.line}\` — test computes expected value using the same arithmetic as the implementation; if the implementation has a bug, the test reproduces the same bug; hardcode the expected result independently instead`,
        severity: "warning",
      });
    }

    // Pattern: expect(fn(x)).toBe(large_constant) where constant is likely from impl
    if (MAGIC_NUMBER_IN_TEST_RE.test(trimmed)) {
      issues.push({
        category: "tautological-assertion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Test asserts against large magic number in \`${file.path}:${change.line}\` — this value was likely computed by running the implementation and copying the output; derive expected values from test requirements, not implementation output`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: fixture-mirror-constant
// ---------------------------------------------------------------------------

function detectFixtureMirrorConstant(file: DiffFile): TautologicalTestIssue[] {
  const issues: TautologicalTestIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    if (CONSTANT_IN_TEST_RE.test(trimmed)) {
      const constMatch = trimmed.match(/(?:const|let)\s+(\w+)\s*=\s*(.+)/);
      const varName = constMatch?.[1] || "unknown";
      const value = constMatch?.[2] || "";

      // Only flag non-trivial constants (> 4 chars after stripping semicolons)
      const cleanValue = value.replace(/[;'"]+$/, "").trim();
      if (cleanValue.length > 3) {
        issues.push({
          category: "fixture-mirror-constant",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Test fixture \`${varName}\` mirrors implementation constant in \`${file.path}:${change.line}\` — LLMs copy implementation constants verbatim into test files; if the constant is wrong in the implementation, the test mirrors the same wrong value; derive test fixtures from requirements, not source code`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: happy-path-only
// ---------------------------------------------------------------------------

function detectHappyPathOnly(file: DiffFile): TautologicalTestIssue[] {
  const issues: TautologicalTestIssue[] = [];
  const added = getAddedChanges(file);

  // Count test cases and error/edge-case tests
  let totalTestCases = 0;
  let errorEdgeCases = 0;
  let lastTestLine = 0;

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const testMatch = trimmed.match(/\b(?:it|test)\s*\(\s*['"]/);
    if (testMatch) {
      totalTestCases++;
      lastTestLine = change.line;

      if (ERROR_CASE_RE.test(trimmed) || ERROR_TEST_RE.test(trimmed)) {
        errorEdgeCases++;
      }
    }
  }

  // Flag if there are multiple tests but none cover error/edge cases
  if (totalTestCases >= 3 && errorEdgeCases === 0) {
    issues.push({
      category: "happy-path-only",
      file: file.path,
      line: lastTestLine,
      code: `${totalTestCases} test(s), 0 error/edge cases`,
      description: `Test file \`${file.path}\` has ${totalTestCases} cases but no error/edge-case tests — LLMs generate only happy-path tests that mirror the implementation's assumptions; add tests for invalid inputs, error states, boundary values, and null/undefined cases`,
      severity: "warning",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: private-helper-in-test
// ---------------------------------------------------------------------------

function detectPrivateHelperInTest(file: DiffFile): TautologicalTestIssue[] {
  const issues: TautologicalTestIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Import from internal/private source
    if (PRIVATE_HELPER_IMPORT_RE.test(trimmed)) {
      issues.push({
        category: "private-helper-in-test",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Test imports from private/internal module in \`${file.path}:${change.line}\` — LLMs generate tests that call private implementation helpers to compute expected values; this makes tests tautological since they depend on the code under test; test through the public API only`,
        severity: "warning",
      });
    }

    // Calling underscore-prefixed (private convention) functions
    const privateMatches = trimmed.match(PRIVATE_METHOD_CALL_RE);
    if (privateMatches) {
      const alreadyFlagged = issues.some(
        (iss) => iss.category === "private-helper-in-test" && iss.line === change.line
      );
      if (!alreadyFlagged) {
        issues.push({
          category: "private-helper-in-test",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Test calls private function (underscore prefix) in \`${file.path}:${change.line}\` — tests should use the public API; calling private functions creates coupling that prevents independent verification of correctness`,
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

function dedupIssues(issues: TautologicalTestIssue[]): TautologicalTestIssue[] {
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

function buildTautologicalTestContext(result: TautologicalTestResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Tautological Test Detection (${result.issues.length})\n`;
  ctx += "This PR may contain tests that mirror implementation logic — a pattern LLMs frequently produce:\n\n";

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

function buildTautologicalTestBodySummary(result: TautologicalTestResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Tautological Test Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*When LLMs generate both code and tests, the tests share the same flawed mental model as the implementation. Coverage looks healthy but defect detection is near zero. Use independently-derived expected values and test through public APIs only.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run tautological test detection on diff files. Zero LLM cost. */
export function detectTautologicalTests(diffFiles: DiffFile[]): TautologicalTestResult {
  const allIssues: TautologicalTestIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (!TEST_FILE_RE.test(file.path)) continue;

    allIssues.push(...detectTautologicalAssertion(file));
    allIssues.push(...detectFixtureMirrorConstant(file));
    allIssues.push(...detectHappyPathOnly(file));
    allIssues.push(...detectPrivateHelperInTest(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: TautologicalTestResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildTautologicalTestContext(result);
  result.bodySummary = buildTautologicalTestBodySummary(result);

  if (issues.length > 0) {
    core.info(`Tautological test detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
