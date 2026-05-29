/**
 * Spec Drift Detector — detect when implementation diverges from
 * specification, API contracts, or declared interfaces.
 *
 * LLMs implement code that appears to satisfy a spec but actually
 * drifts from the contract: exported functions whose signatures
 * don't match the declared types, TODO/FIXME markers where the spec
 * requires implementation, interface methods that exist but are never
 * called, and exported symbols that have no corresponding import
 * anywhere.
 *
 * Categories:
 * 1. unimplemented-spec: TODO/FIXME/HACK/stub patterns in functions
 *    that match interface declarations or exported types
 * 2. spec-implementation-mismatch: exported function signatures that
 *    differ from declared interfaces/types
 * 3. orphaned-spec: exported symbols (functions, classes, types) that
 *    are never imported or referenced in other files
 * 4. contract-erosion: narrowed return types, widened parameter types,
 *    or missing error handling compared to declared contracts
 *
 * Zero LLM cost — pattern + cross-file analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecDriftCategory =
  | "unimplemented-spec"
  | "spec-implementation-mismatch"
  | "orphaned-spec"
  | "contract-erosion";

export interface SpecDriftIssue {
  category: SpecDriftCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface SpecDriftResult {
  issues: SpecDriftIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^[-+]/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;
const TODO_LINE_RE = /\b(?:TODO|FIXME|HACK)\b/i;

// Stub/unimplemented patterns
const STUB_PATTERNS = [
  /\bTODO\b.*(?:implement|fill|replace|placeholder|stub)/i,
  /\bFIXME\b.*(?:implement|replace|hack|workaround)/i,
  /\bHACK\b/i,
  /\breturn\s+(?:null|undefined|0|"")\s*;?\s*\/\/\s*(?:todo|fixme|implement)/i,
  /\bthrow\s+new\s+Error\s*\(\s*['"](?:NotImplemented|TODO|not implemented)/i,
  /return\s+\[\]\s*;\s*\/\/\s*(?:todo|placeholder)/i,
  /return\s+{}\s*;\s*\/\/\s*(?:todo|placeholder)/i,
];

// ---------------------------------------------------------------------------
// Detection: unimplemented-spec
// ---------------------------------------------------------------------------

function detectUnimplementedSpec(diffFiles: DiffFile[]): SpecDriftIssue[] {
  const issues: SpecDriftIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      // Skip comment/type lines, but NOT TODO/FIXME/HACK lines
      if (SKIP_LINE_RE.test(change.content) && !TODO_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      for (const re of STUB_PATTERNS) {
        if (re.test(trimmed)) {
          issues.push({
            category: "unimplemented-spec",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Unimplemented spec in \`${file.path}:${change.line}\` — LLMs leave TODO/FIXME/stub markers where the spec requires implementation; shipped stub code passes type checks but fails at runtime; implement the actual logic or mark as explicitly deferred with a tracking issue`,
            severity: "critical",
          });
          break;
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Signature mismatch detection
// Track async function names and check if they use await in return statements

const ASYNC_FUNC_RE = /\basync\s+function\s+(\w+)\s*\(/;

function detectSpecMismatch(diffFiles: DiffFile[]): SpecDriftIssue[] {
  const issues: SpecDriftIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    // Track async function context with brace depth
    let insideAsyncFunc = false;
    let braceDepth = 0;

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      // Detect async function declaration
      if (ASYNC_FUNC_RE.test(trimmed)) {
        insideAsyncFunc = true;
        braceDepth = 0;
      }

      if (insideAsyncFunc) {
        braceDepth += (trimmed.match(/\{/g) || []).length;
        braceDepth -= (trimmed.match(/\}/g) || []).length;

        // Check for return without await in this line
        if (/\breturn\s+(?!await\b)\w/i.test(trimmed) && !/\bawait\s+/.test(trimmed)) {
          issues.push({
            category: "spec-implementation-mismatch",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Spec mismatch in \`${file.path}:${change.line}\`: async function returning without await — LLMs declare async signatures but implement synchronous returns; verify the implementation matches the declared contract`,
            severity: "warning",
          });
        }

        if (braceDepth <= 0 && trimmed.includes("}")) {
          insideAsyncFunc = false;
        }
      }
    }
  }

  return issues;
}

// Detection: orphaned-spec
// ---------------------------------------------------------------------------

function detectOrphanedSpec(diffFiles: DiffFile[]): SpecDriftIssue[] {
  const issues: SpecDriftIssue[] = [];

  // Collect all exported symbols from added lines
  const exportedSymbols = new Map<string, { file: string; line: number; code: string }>();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      const trimmed = stripPrefix(change.content);

      // Detect exported functions/classes/constants
      const exportMatch = trimmed.match(
        /(?:export\s+(?:default\s+)?)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/
      );
      if (exportMatch) {
        exportedSymbols.set(exportMatch[1], {
          file: file.path,
          line: change.line,
          code: trimmed,
        });
      }
    }
  }

  // Check if each exported symbol is referenced in ANY other file
  // (including removed/normal lines is overkill — just check added lines in the PR)
  const referencedSymbols = new Set<string>();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const allChanges = file.hunks.flatMap((h) => h.changes);

    for (const change of allChanges) {
      const trimmed = stripPrefix(change.content);
      // Skip type-only imports and declarations
      if (/^\s*(?:import\s+type|export\s+type)\s/.test(trimmed)) continue;

      for (const [symbol] of exportedSymbols) {
        // Skip self-references (symbol defined in same line)
        const defLine = exportedSymbols.get(symbol)!;
        if (defLine.file === file.path && defLine.line === change.line) continue;

        // Check if symbol is referenced (not just defined)
        const refPattern = new RegExp(`\\b${symbol}\\b`);
        if (refPattern.test(trimmed) && !trimmed.includes(`function ${symbol}`) && !trimmed.includes(`class ${symbol}`) && !trimmed.includes(`const ${symbol} =`) && !trimmed.includes(`interface ${symbol}`) && !trimmed.includes(`type ${symbol} =`) && !trimmed.includes(`enum ${symbol}`)) {
          referencedSymbols.add(symbol);
        }
      }
    }
  }

  // Flag exported symbols that are never referenced
  for (const [symbol, info] of exportedSymbols) {
    if (!referencedSymbols.has(symbol)) {
      // Skip common patterns that are intentionally orphaned
      const isLikelyEntry = info.file.includes("index") || info.file.includes("main") || info.file.includes("mod");
      const isDefaultExport = info.code.includes("export default");
      const isTypeExport = info.code.includes("interface ") || info.code.includes("type ");

      if (!isLikelyEntry && !isDefaultExport && !isTypeExport) {
        issues.push({
          category: "orphaned-spec",
          file: info.file,
          line: info.line,
          code: info.code,
          description: `Orphaned export \`${symbol}\` in \`${info.file}:${info.line}\` is not referenced by any other file in this PR — LLMs generate "defensive exports" that create API surface without consumers; unused exports increase bundle size and maintenance burden; remove if not needed or add explicit consumers`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: contract-erosion
// ---------------------------------------------------------------------------

const CONTRACT_EROSION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Widened parameter type (any replacing specific type)
  { re: /:\s+any\b/g, label: "widened parameter/return type to `any`" },
  // Optional chaining on method that may need required access
  { re: /\?\.\w+\s*\(/, label: "optional chaining on method that may need required access" },
  // Empty catch block (swallows errors contract says should propagate)
  { re: /\bcatch\s*\(\s*\w+\s*\)\s*\{\s*\}/, label: "empty catch block swallows errors from declared contract" },
  // Non-null assertion (!) without null check
  { re: /\w+!\.\w+/, label: "non-null assertion without preceding null check" },
];

function detectContractErosion(diffFiles: DiffFile[]): SpecDriftIssue[] {
  const issues: SpecDriftIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      for (const { re, label } of CONTRACT_EROSION_PATTERNS) {
        // Reset lastIndex for global regexes
        if (re.global) re.lastIndex = 0;
        if (re.test(trimmed)) {
          // Skip test files for contract erosion
          if (file.path.includes("test") || file.path.includes("spec") || file.path.includes("__tests__")) {
            continue;
          }

          // Extra check: only flag `any` in function signatures
          if (label.includes("any") && !/:\s*any/.test(trimmed)) continue;

          issues.push({
            category: "contract-erosion",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Contract erosion in \`${file.path}:${change.line}\`: ${label} — LLMs weaken contracts by widening types, adding optional chaining where required access was intended, swallowing errors, or adding non-null assertions; these changes compile but violate the semantic contract`,
            severity: "warning",
          });
          break;
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: SpecDriftIssue[]): SpecDriftIssue[] {
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

function buildSpecDriftContext(result: SpecDriftResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Spec Drift Detection (${result.issues.length})\n`;
  ctx += "This PR shows implementation-spec divergence — LLMs implement code that appears to satisfy the spec but actually drifts:\n\n";

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

function buildSpecDriftBodySummary(result: SpecDriftResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Spec Drift Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLMs implement code that appears to satisfy the spec but actually drifts — stub markers where implementation is needed, signatures that don't match declared types, exports without consumers, and contracts weakened by widened types or swallowed errors. Review each finding to ensure the implementation matches the intended specification.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run spec drift detection on diff files. Zero LLM cost. */
export function detectSpecDrift(diffFiles: DiffFile[]): SpecDriftResult {
  const allIssues: SpecDriftIssue[] = [];

  allIssues.push(...detectUnimplementedSpec(diffFiles));
  allIssues.push(...detectSpecMismatch(diffFiles));
  allIssues.push(...detectOrphanedSpec(diffFiles));
  allIssues.push(...detectContractErosion(diffFiles));

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: SpecDriftResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildSpecDriftContext(result);
  result.bodySummary = buildSpecDriftBodySummary(result);

  if (issues.length > 0) {
    core.info(`Spec drift detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
