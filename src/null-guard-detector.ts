/**
 * Null Guard / Defensive Access Detector — detect missing null/undefined
 * checks before property access in PR diffs.
 *
 * No AI code reviewer detects missing null guards at PR review time.
 * TypeScript's strictNullChecks helps, but many codebases don't enable it,
 * and even with it, optional chaining gaps and assertion-based access
 * create runtime crash risks:
 * - user.address.zip when address is null → TypeError
 * - data.items[0].name when items is empty → TypeError
 * - config.db.host when db is undefined → TypeError
 * - response.data?.user.name when data could be null (only data is guarded)
 *
 * These bugs cause production crashes. Static analysis tools can detect
 * some cases, but they require full type information. Mizumi uses
 * pattern-based detection on diff content — zero type checker needed.
 *
 * Mizumi scans added lines for 4 null guard gap categories:
 * 1. Deep property access without guard: a.b.c without a?.b?.c
 * 2. Array index access without length check: arr[0].x without arr.length check
 * 3. Optional chain coverage gap: a?.b.c where c could also be null
 * 4. Assertive access on optional: value!.prop on potentially null value
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NullGuardCategory =
  | "deep-access-without-guard"
  | "array-index-without-check"
  | "optional-chain-coverage-gap"
  | "assertive-access-on-optional";

export interface NullGuardIssue {
  /** Category of the issue */
  category: NullGuardCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = assertive-access/deep-access, warning = array-index/optional-chain-gap */
  severity: "critical" | "warning";
}

export interface NullGuardResult {
  /** All detected null guard issues */
  issues: NullGuardIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Deep property access: a.b.c (3+ levels of dot access without optional chaining)
const DEEP_ACCESS_RE = /(\w+)\.(\w+)\.(\w+)/;

// Optional chain coverage gap: a?.b.c (guarded first level but not subsequent)
const PARTIAL_OPTIONAL_CHAIN_RE = /\?\.\s*(\w+)\.(\w+)/;

// Non-null assertion: value!.prop
const ASSERTION_ACCESS_RE = /(\w+)!\.(\w+)/;

// Array index access followed by property: arr[0].prop
const ARRAY_INDEX_ACCESS_RE = /(\w+)\[(\d+)\]\.(\w+)/;

// Known nullable patterns (common sources of null/undefined)
const NULLABLE_SOURCE_RE = /\b(?:data|response|result|item|element|node|entry|record|obj|config|options|payload|body|content|value|user|account|profile|session|cache|row|doc|document|entity|resource|parent|child|target|source|ref|header|token|error|match|capture|group)\b/i;

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectDeepAccessWithoutGuard(file: DiffFile): NullGuardIssue[] {
  const issues: NullGuardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Find deep property access: a.b.c without any ?.
    const deepMatch = change.content.match(DEEP_ACCESS_RE);
    if (deepMatch) {
      // Skip if the line uses optional chaining anywhere for this chain
      const chain = `${deepMatch[1]}.${deepMatch[2]}.${deepMatch[3]}`;
      const optionalChain = `${deepMatch[1]}?.${deepMatch[2]}`;
      if (change.content.includes(optionalChain)) continue;

      // Skip if this is in a null check condition on the same or previous line
      const sourceVar = deepMatch[1];
      if (new RegExp(`\\b${sourceVar}\\s*(?:===|!==|==|!=|&&|\\?)`).test(change.content)) continue;

      // Only flag if the source is a known nullable type
      if (NULLABLE_SOURCE_RE.test(sourceVar)) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "deep-access-without-guard",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Deep property access \`${chain}\` without null guard in \`${file.path}:${change.line}\` — \`${deepMatch[2]}\` could be null/undefined, causing TypeError; use optional chaining \`${deepMatch[1]}?.${deepMatch[2]}?.${deepMatch[3]}\``,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectArrayIndexWithoutCheck(file: DiffFile): NullGuardIssue[] {
  const issues: NullGuardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Find array index access followed by property: arr[0].prop
    const arrMatch = change.content.match(ARRAY_INDEX_ACCESS_RE);
    if (arrMatch) {
      const arrName = arrMatch[1];
      const index = arrMatch[2];
      const prop = arrMatch[3];

      // Skip if there's a length check on the same or previous line
      if (change.content.includes(`${arrName}.length`) || change.content.includes(`${arrName}?.[`)) continue;

      // Skip if optional chaining is used: arr?.[0]?.prop
      if (change.content.includes(`${arrName}?.[`) || change.content.includes(`].${prop}`) === false) continue;

      // Only flag for known nullable array sources
      if (NULLABLE_SOURCE_RE.test(arrName)) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "array-index-without-check",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Array index access \`${arrName}[${index}].${prop}\` without length check in \`${file.path}:${change.line}\` — array could be empty, causing TypeError; check \`${arrName}.length > ${index}\` or use optional chaining \`${arrName}?.[${index}]?.${prop}\``,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectOptionalChainCoverageGap(file: DiffFile): NullGuardIssue[] {
  const issues: NullGuardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Find partial optional chain: a?.b.c (guarded first level but subsequent uses .)
    const partialMatch = change.content.match(PARTIAL_OPTIONAL_CHAIN_RE);
    if (partialMatch) {
      const level1 = partialMatch[1];
      const level2 = partialMatch[2];

      // Check if the second level also uses optional chaining
      // If the pattern is a?.b.c (not a?.b?.c), flag it
      const fullPattern = `?.${level1}.${level2}`;
      const safePattern = `?.${level1}?.${level2}`;
      if (!change.content.includes(safePattern) && change.content.includes(fullPattern)) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "optional-chain-coverage-gap",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Partial optional chain \`${level1}?.${level2}\` in \`${file.path}:${change.line}\` — \`${level1}\` is guarded but \`${level2}\` is accessed with \`.\`; use \`${level1}?.${level2}?\` or \`${level1}?.${level2}\` with full optional chaining`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectAssertiveAccessOnOptional(file: DiffFile): NullGuardIssue[] {
  const issues: NullGuardIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Find non-null assertion: value!.prop
    const assertMatch = change.content.match(ASSERTION_ACCESS_RE);
    if (assertMatch) {
      const varName = assertMatch[1];
      const prop = assertMatch[2];

      // Skip if there's a preceding null check for this variable on the same line
      if (new RegExp(`\\b${varName}\\s*(?:&&|!==?\\s*null|!==?\\s*undefined|if\\s*\\()`).test(change.content)) continue;

      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "assertive-access-on-optional",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Non-null assertion \`${varName}!.${prop}\` in \`${file.path}:${change.line}\` — assertion overrides TypeScript null safety; use optional chaining \`${varName}?.${prop}\` or add an explicit null check`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: NullGuardIssue[]): NullGuardIssue[] {
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

function buildNullGuardContext(result: NullGuardResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Null Guard / Defensive Access Gaps (${result.issues.length})\n`;
  ctx += "This PR may have missing null/undefined checks before property access:\n\n";

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

function buildNullGuardBodySummary(result: NullGuardResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Null Guard Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Missing null guards cause production TypeErrors — deep access without optional chaining, unguarded array indices, non-null assertions on optional values.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run null guard / defensive access detection on diff files.
 * Zero LLM cost.
 */
export function detectNullGuardGaps(diffFiles: DiffFile[]): NullGuardResult {
  const allIssues: NullGuardIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectDeepAccessWithoutGuard(file));
    allIssues.push(...detectArrayIndexWithoutCheck(file));
    allIssues.push(...detectOptionalChainCoverageGap(file));
    allIssues.push(...detectAssertiveAccessOnOptional(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: NullGuardResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildNullGuardContext(result);
  result.bodySummary = buildNullGuardBodySummary(result);

  if (issues.length > 0) {
    core.info(`Null guard detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
