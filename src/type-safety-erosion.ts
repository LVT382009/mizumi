/**
 * Type Safety Erosion Detector — detect type safety regressions in PR diffs.
 *
 * No AI code reviewer flags type safety erosion. CodeRabbit, Copilot,
 * CodeGuru, and Sourcery all miss: `as` type assertions that bypass the
 * type checker, `any` types that create escape hatches, @ts-ignore and
 * @ts-expect-error directives that suppress errors, and eslint-disable
 * comments that silence lint rules. These accumulate over time, turning
 * a strict TypeScript project into an effectively untyped one.
 *
 * Mizumi scans added lines for 4 erosion categories:
 * 1. Type assertions: `value as Type`, `<Type>value`
 * 2. Any type usage: `: any`, `as any`, `<any>`
 * 3. TS directives: @ts-ignore, @ts-expect-error, @ts-nocheck
 * 4. Lint suppression: eslint-disable, eslint-disable-next-line
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErosionCategory =
  | "type-assertion"
  | "any-type"
  | "ts-directive"
  | "lint-suppression";

export interface TypeErosionIssue {
  /** Category of the issue */
  category: ErosionCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = ts-ignore/nocheck, warning = assertions/any/suppressions */
  severity: "critical" | "warning";
}

export interface TypeErosionResult {
  /** All detected type erosion issues */
  issues: TypeErosionIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Type assertions: x as Type, <Type>x (not JSX)
const AS_ASSERTION_RE = /\bas\s+[A-Z]\w+/;

// Any type usage: : any, as any, <any>, any inside generics (e.g. Record<string, any>)
const ANY_TYPE_RE = /:\s*any\b|\bas\s+any\b|<any>|\bany\b(?=[>\],\s])/;

// TS directives
const TS_IGNORE_RE = /@ts-ignore/;
const TS_EXPECT_ERROR_RE = /@ts-expect-error/;
const TS_NOCHECK_RE = /@ts-nocheck/;

// Lint suppression
const ESLINT_DISABLE_RE = /eslint-disable(?:-next-line)?(?:\s|$)/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectTypeAssertions(file: DiffFile): TypeErosionIssue[] {
  const issues: TypeErosionIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      const content = change.content;
      if (!AS_ASSERTION_RE.test(content)) continue;

      // Skip type assertion imports (import X as Y is not an erosion)
      if (/import\s+.*\s+as\s+/.test(content)) continue;

      const trimmed = content.replace(/^\+/, "").trim();
      const match = trimmed.match(/\bas\s+([A-Z]\w+)/);
      const targetType = match ? match[1] : "unknown";

      issues.push({
        category: "type-assertion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Type assertion \`as ${targetType}\` in \`${file.path}:${change.line}\` — bypasses type checker, consider type-safe alternatives`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectAnyType(file: DiffFile): TypeErosionIssue[] {
  const issues: TypeErosionIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      const content = change.content;
      if (!ANY_TYPE_RE.test(content)) continue;

      // Skip comments mentioning any
      const trimmed = content.replace(/^\+/, "").trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

      issues.push({
        category: "any-type",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `\`any\` type used in \`${file.path}:${change.line}\` — creates type escape hatch, prefer specific types or \`unknown\``,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectTSDirectives(file: DiffFile): TypeErosionIssue[] {
  const issues: TypeErosionIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      if (TS_NOCHECK_RE.test(content)) {
        issues.push({
          category: "ts-directive",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `@ts-nocheck in \`${file.path}:${change.line}\` — disables type checking for entire file, critical type safety risk`,
          severity: "critical",
        });
      } else if (TS_IGNORE_RE.test(content)) {
        issues.push({
          category: "ts-directive",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `@ts-ignore in \`${file.path}:${change.line}\` — suppresses type error without fixing it, prefer @ts-expect-error or type-safe alternatives`,
          severity: "critical",
        });
      } else if (TS_EXPECT_ERROR_RE.test(content)) {
        // ts-expect-error is better than ts-ignore (fails if error is fixed)
        // but still worth flagging as a warning
        issues.push({
          category: "ts-directive",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `@ts-expect-error in \`${file.path}:${change.line}\` — suppresses type error; acceptable if temporary, but should have a tracking issue`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectLintSuppressions(file: DiffFile): TypeErosionIssue[] {
  const issues: TypeErosionIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      const content = change.content;
      if (!ESLINT_DISABLE_RE.test(content)) continue;

      const trimmed = content.replace(/^\+/, "").trim();

      issues.push({
        category: "lint-suppression",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `ESLint suppression in \`${file.path}:${change.line}\` — disables lint rule, consider fixing the underlying issue instead`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: TypeErosionIssue[]): TypeErosionIssue[] {
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

function buildErosionContext(result: TypeErosionResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Type Safety Erosion (${result.issues.length})\n`;
  ctx += "This PR may erode type safety:\n\n";

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

function buildErosionBodySummary(result: TypeErosionResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Type Safety Erosion</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Type safety erosion accumulates silently. Prefer type-safe alternatives over assertions, \`any\`, and error suppression.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run type safety erosion detection on diff files.
 * Zero LLM cost.
 */
export function detectTypeSafetyErosion(diffFiles: DiffFile[]): TypeErosionResult {
  const allIssues: TypeErosionIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectTypeAssertions(file));
    allIssues.push(...detectAnyType(file));
    allIssues.push(...detectTSDirectives(file));
    allIssues.push(...detectLintSuppressions(file));
  }

  const issues = dedupIssues(allIssues);

  // Sort: critical first, then by file
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: TypeErosionResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildErosionContext(result);
  result.bodySummary = buildErosionBodySummary(result);

  if (issues.length > 0) {
    core.info(`Type safety erosion: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
