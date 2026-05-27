/**
 * PR Breaking Change Radar — detect code-level breaking changes in PRs.
 *
 * No AI code reviewer detects breaking changes at the code level. oasdiff
 * covers OpenAPI schema diffs, but nobody flags: removed exports, renamed
 * public functions, new required parameters, return type narrowing, changed
 * thrown exceptions, or deleted public methods. These are the #1 cause of
 * downstream breakage.
 *
 * Mizumi scans diff hunks for 6 breaking change categories:
 * 1. Removed export: an exported symbol is deleted or unexported
 * 2. Renamed export: an exported symbol is renamed
 * 3. New required parameter: a function gains a parameter without a default
 * 4. Return type narrowing: a function's return becomes more specific
 * 5. Changed thrown exceptions: new exception types thrown
 * 6. Deleted public method: a class method is removed
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeCategory =
  | "removed-export"
  | "renamed-export"
  | "new-required-param"
  | "return-type-narrowing"
  | "changed-thrown-exceptions"
  | "deleted-public-method";

export interface BreakingChange {
  /** Category of breaking change */
  category: ChangeCategory;
  /** File where the change occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** Symbol name affected */
  symbol: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = will break consumers, warning = may break consumers */
  severity: "critical" | "warning";
}

export interface BreakingChangeRadarResult {
  /** All detected breaking changes */
  changes: BreakingChange[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Removed exports: lines like `- export function foo`, `- export class Bar`
const REMOVED_EXPORT_RE = /^-\s*export\s+(function|class|const|let|var|interface|type|enum|default)\s+/;

// Deleted public methods: lines like `-   public foo(`, `-   async public bar(`
const DELETED_PUBLIC_METHOD_RE = /^-\s*(public\s+|static\s+public\s+|public\s+static\s+|async\s+public\s+)(\w+)\s*\(/;


// Changed return types: `-   function foo(): OldType` vs `+   function foo(): NewType`
const RETURN_TYPE_CHANGE_RE_OLD = /^-\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)[^(]*\([^)]*\)\s*:\s*(\w+)/;
const RETURN_TYPE_CHANGE_RE_NEW = /^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)[^(]*\([^)]*\)\s*:\s*(\w+)/;

// New thrown exceptions: `+   throw new CustomError` in public functions
const NEW_THROW_RE = /^\+\s*throw\s+new\s+(\w+)/;

// Renamed exports: `- export function oldName` + `+ export function newName` in same file
const EXPORT_FUNC_RE = /^(?:-|\+)\s*export\s+(?:async\s+)?function\s+(\w+)/;
const EXPORT_CONST_RE = /^(?:-|\+)\s*export\s+(?:const|let|var)\s+(\w+)/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectRemovedExports(file: DiffFile): BreakingChange[] {
  const changes: BreakingChange[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "delete") continue;
      const content = change.content;
      const match = content.match(REMOVED_EXPORT_RE);
      if (match) {
        const kind = match[1];
        const nameMatch = content.match(/export\s+\w+\s+(\w+)/);
        const symbol = nameMatch ? nameMatch[1] : "unknown";

        // Check if it was re-added (renamed case detected separately)
        changes.push({
          category: "removed-export",
          file: file.path,
          line: change.line,
          symbol,
          description: `Removed export \`${symbol}\` (${kind}) in \`${file.path}:${change.line}\` — downstream consumers will break`,
          severity: "critical",
        });
      }
    }
  }

  return changes;
}

function detectDeletedPublicMethods(file: DiffFile): BreakingChange[] {
  const changes: BreakingChange[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "delete") continue;
      const content = change.content;
      const match = content.match(DELETED_PUBLIC_METHOD_RE);
      if (match) {
        const symbol = match[2];
        changes.push({
          category: "deleted-public-method",
          file: file.path,
          line: change.line,
          symbol,
          description: `Deleted public method \`${symbol}\` in \`${file.path}:${change.line}\` — callers will break`,
          severity: "critical",
        });
      }
    }
  }

  return changes;
}

function detectNewRequiredParams(file: DiffFile): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const oldSignatures = new Map<string, { line: number; paramCount: number; hasDefaults: boolean }>();
  const newSignatures = new Map<string, { line: number; paramCount: number; hasDefaults: boolean }>();

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      const content = change.content;

      // Parse function signatures for parameter counts
      const funcMatch = content.match(/^(?:-|\+)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
      if (!funcMatch) continue;

      const name = funcMatch[1];
      const params = funcMatch[2];
      const paramList = params.split(",").map((p) => p.trim()).filter(Boolean);
      const hasDefaults = paramList.some((p) => p.includes("=") || p.startsWith("..."));
      const paramCount = paramList.length;

      if (content.startsWith("-")) {
        oldSignatures.set(name, { line: change.line, paramCount, hasDefaults });
      } else if (content.startsWith("+")) {
        newSignatures.set(name, { line: change.line, paramCount, hasDefaults });
      }
    }
  }

  // Compare old and new signatures
  for (const [name, newSig] of newSignatures) {
    const oldSig = oldSignatures.get(name);
    if (!oldSig) continue;
    if (newSig.paramCount > oldSig.paramCount) {
      // New parameters added — check if they have defaults
      const addedParams = newSig.paramCount - oldSig.paramCount;

      // Get the new signature's content to check for defaults on added params
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type !== "add") continue;
          const content = change.content;
          const funcMatch = content.match(/^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
          if (!funcMatch || funcMatch[1] !== name) continue;

          const params = funcMatch[2].split(",").map((p) => p.trim()).filter(Boolean);
          // Get the added params (the ones beyond old param count)
          const addedParamList = params.slice(oldSig.paramCount);
          const allHaveDefaults = addedParamList.every((p) => p.includes("=") || p.startsWith("..."));

          if (!allHaveDefaults) {
            changes.push({
              category: "new-required-param",
              file: file.path,
              line: change.line,
              symbol: name,
              description: `Function \`${name}\` in \`${file.path}:${change.line}\` gained ${addedParams} parameter(s) without defaults — existing callers will break`,
              severity: "critical",
            });
          } else {
            changes.push({
              category: "new-required-param",
              file: file.path,
              line: change.line,
              symbol: name,
              description: `Function \`${name}\` in \`${file.path}:${change.line}\` gained ${addedParams} parameter(s) with defaults — low risk but may indicate API evolution`,
              severity: "warning",
            });
          }
        }
      }
    }
  }

  return changes;
}

function detectReturnTypeChanges(file: DiffFile): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const oldReturns = new Map<string, { type: string; line: number }>();
  const newReturns = new Map<string, { type: string; line: number }>();

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      const content = change.content;
      const oldMatch = content.match(RETURN_TYPE_CHANGE_RE_OLD);
      if (oldMatch) oldReturns.set(oldMatch[1], { type: oldMatch[2], line: change.line });
      const newMatch = content.match(RETURN_TYPE_CHANGE_RE_NEW);
      if (newMatch) newReturns.set(newMatch[1], { type: newMatch[2], line: change.line });
    }
  }

  for (const [name, newRet] of newReturns) {
    const oldRet = oldReturns.get(name);
    if (!oldRet || oldRet.type === newRet.type) continue;

    changes.push({
      category: "return-type-narrowing",
      file: file.path,
      line: newRet.line,
      symbol: name,
      description: `Return type of \`${name}\` changed from \`${oldRet.type}\` to \`${newRet.type}\` in \`${file.path}\` — may break consumers expecting \`${oldRet.type}\``,
      severity: "warning",
    });
  }

  return changes;
}

function detectNewThrownExceptions(file: DiffFile): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const oldThrows = new Set<string>();
  const newThrows = new Map<string, { line: number; symbol: string }>();

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      const content = change.content;
      if (content.startsWith("-")) {
        const throwMatch = content.match(/^-\s*throw\s+new\s+(\w+)/);
        if (throwMatch) oldThrows.add(throwMatch[1]);
      }
      if (content.startsWith("+")) {
        const throwMatch = content.match(NEW_THROW_RE);
        if (throwMatch) {
          newThrows.set(throwMatch[1], { line: change.line, symbol: throwMatch[1] });
        }
      }
    }
  }

  for (const [exceptionType, info] of newThrows) {
    if (!oldThrows.has(exceptionType)) {
      changes.push({
        category: "changed-thrown-exceptions",
        file: file.path,
        line: info.line,
        symbol: exceptionType,
        description: `New exception type \`${exceptionType}\` thrown in \`${file.path}:${info.line}\` — callers may not handle this`,
        severity: "warning",
      });
    }
  }

  return changes;
}

function detectRenamedExports(file: DiffFile): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const removedExports: { name: string; line: number }[] = [];
  const addedExports: { name: string; line: number }[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      const content = change.content;
      const funcMatch = content.match(EXPORT_FUNC_RE);
      if (funcMatch) {
        if (content.startsWith("-")) removedExports.push({ name: funcMatch[1], line: change.line });
        if (content.startsWith("+")) addedExports.push({ name: funcMatch[1], line: change.line });
        continue;
      }
      const constMatch = content.match(EXPORT_CONST_RE);
      if (constMatch) {
        if (content.startsWith("-")) removedExports.push({ name: constMatch[1], line: change.line });
        if (content.startsWith("+")) addedExports.push({ name: constMatch[1], line: change.line });
      }
    }
  }

  // If an export was removed and a similar-named export was added, it's likely a rename
  // Heuristic: Levenshtein distance <= 3 or common prefix of >= 3 chars
  for (const removed of removedExports) {
    for (const added of addedExports) {
      if (removed.name === added.name) continue;
      if (isLikelyRename(removed.name, added.name)) {
        changes.push({
          category: "renamed-export",
          file: file.path,
          line: added.line,
          symbol: `${removed.name} → ${added.name}`,
          description: `Export renamed from \`${removed.name}\` to \`${added.name}\` in \`${file.path}\` — consumers using \`${removed.name}\` will break`,
          severity: "critical",
        });
      }
    }
  }

  return changes;
}

function isLikelyRename(oldName: string, newName: string): boolean {
  // Common prefix >= 3 chars and same length ± 2
  let prefix = 0;
  const minLen = Math.min(oldName.length, newName.length);
  for (let i = 0; i < minLen; i++) {
    if (oldName[i] === newName[i]) prefix++;
    else break;
  }
  if (prefix >= 3 && Math.abs(oldName.length - newName.length) <= 2) return true;

  // Simple edit distance ≤ 2 for short names
  if (oldName.length <= 6 && newName.length <= 6) {
    return editDistance(oldName, newName) <= 2;
  }

  return false;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Deduplication + rename suppression
// ---------------------------------------------------------------------------

function dedupChanges(changes: BreakingChange[]): BreakingChange[] {
  const seen = new Set<string>();
  // If we have both "removed-export X" and "renamed-export X → Y", drop the removed one
  const renamedSymbols = new Set(
    changes.filter((c) => c.category === "renamed-export").map((c) => c.symbol.split(" → ")[0])
  );

  return changes.filter((c) => {
    // Suppress removed-export if there's a corresponding rename
    if (c.category === "removed-export" && renamedSymbols.has(c.symbol)) return false;
    const key = `${c.category}:${c.file}:${c.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildRadarContext(result: BreakingChangeRadarResult): string {
  if (result.changes.length === 0) return "";

  const critical = result.changes.filter((c) => c.severity === "critical");
  const warnings = result.changes.filter((c) => c.severity === "warning");

  let ctx = `## Breaking Change Radar (${result.changes.length})\n`;
  ctx += "This PR may introduce breaking changes:\n\n";

  if (critical.length > 0) {
    ctx += "### Breaking\n";
    for (const c of critical.slice(0, 10)) {
      ctx += `- ${c.description}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const c of warnings.slice(0, 10)) {
      ctx += `- ${c.description}\n`;
    }
  }

  return ctx.trim();
}

function buildRadarBodySummary(result: BreakingChangeRadarResult): string {
  if (result.changes.length === 0) return "";

  let body = `<details><summary><strong>Breaking Change Radar</strong> — ${result.changes.length} detected</summary>\n\n`;
  body += "| Category | Symbol | File | Severity |\n";
  body += "|----------|--------|------|----------|\n";

  for (const c of result.changes.slice(0, 15)) {
    const catLabel = c.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${c.symbol}\` | \`${c.file}\` | ${c.severity} |\n`;
  }

  if (result.changes.length > 15) {
    body += `| ... | | | ${result.changes.length - 15} more |\n`;
  }

  body += `\n*Breaking changes require consumer updates before merging.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run breaking change radar on diff files.
 * Zero LLM cost.
 */
export function detectBreakingChanges(diffFiles: DiffFile[]): BreakingChangeRadarResult {
  const allChanges: BreakingChange[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allChanges.push(...detectRemovedExports(file));
    allChanges.push(...detectDeletedPublicMethods(file));
    allChanges.push(...detectNewRequiredParams(file));
    allChanges.push(...detectReturnTypeChanges(file));
    allChanges.push(...detectNewThrownExceptions(file));
    allChanges.push(...detectRenamedExports(file));
  }

  const changes = dedupChanges(allChanges);

  // Sort: critical first, then by file
  changes.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: BreakingChangeRadarResult = {
    changes,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildRadarContext(result);
  result.bodySummary = buildRadarBodySummary(result);

  if (changes.length > 0) {
    core.info(`Breaking change radar: ${changes.length} detected (${changes.filter((c) => c.severity === "critical").length} critical)`);
  }

  return result;
}
