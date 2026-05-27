/**
 * Dead Code Detector — detect unreachable code, unused variables, and empty
 * catch blocks in PR diffs.
 *
 * No AI code reviewer flags dead code at the diff level. CodeRabbit, Copilot,
 * CodeGuru, and Sourcery all miss: unreachable statements after return/throw,
 * variables that are declared but never read, and empty catch blocks that
 * silently swallow errors. These are the #1 source of misleading coverage
 * and hidden bugs.
 *
 * Mizumi scans added lines for 3 dead code categories:
 * 1. Unreachable code: statements after return, throw, break, continue
 * 2. Unused variables: const/let declarations with no subsequent reference
 * 3. Empty catch blocks: catch (e) {} with no error handling
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeadCodeCategory =
  | "unreachable-code"
  | "unused-variable"
  | "empty-catch";

export interface DeadCodeIssue {
  /** Category of the issue */
  category: DeadCodeCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** Symbol or code snippet affected */
  symbol: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = empty catch/swallowed errors, warning = unreachable/unused */
  severity: "critical" | "warning";
}

export interface DeadCodeResult {
  /** All detected dead code issues */
  issues: DeadCodeIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Unreachable: a line after return/throw/break/continue at the same indent
const TERMINATING_RE = /^\+\s*(return\b|throw\b|break\b|continue\b)/;

// Unused variable declarations
const VAR_DECL_RE = /^\+\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/;

// Empty catch blocks — catch may appear after } on the same line
const EMPTY_CATCH_RE = /catch\s*\([^)]*\)\s*\{\s*\}/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectUnreachableCode(file: DiffFile): DeadCodeIssue[] {
  const issues: DeadCodeIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length - 1; i++) {
    const current = addedChanges[i];
    if (!TERMINATING_RE.test(current.content)) continue;

    const currentIndent = getIndent(current.content);

    // Check subsequent added lines at the same or deeper indent
    for (let j = i + 1; j < addedChanges.length; j++) {
      const next = addedChanges[j];
      const nextIndent = getIndent(next.content);

      // If next line is at a shallower indent, we've left the block
      if (nextIndent < currentIndent) break;

      // Same or deeper indent = unreachable
      // Skip blank lines and closing braces
      const trimmed = next.content.replace(/^\+\s*/, "").trim();
      if (!trimmed || trimmed === "}" || trimmed.startsWith("//")) continue;

      issues.push({
        category: "unreachable-code",
        file: file.path,
        line: next.line,
        symbol: trimmed.substring(0, 40),
        description: `Unreachable code after \`${current.content.replace(/^\+\s*/, "").trim().split(/\s/)[0]}\` in \`${file.path}:${next.line}\` — this code will never execute`,
        severity: "warning",
      });

      // Only report first unreachable line after each terminator
      break;
    }
  }

  return issues;
}

function detectUnusedVariables(file: DiffFile): DeadCodeIssue[] {
  const issues: DeadCodeIssue[] = [];
  const allContent = file.hunks.flatMap((h) => h.changes).map((c) => c.content);
  const addedContent = allContent.filter((c) => c.startsWith("+"));

  // Collect all declared variable names from added lines
  const declarations: { name: string; line: number; content: string }[] = [];
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      const match = change.content.match(VAR_DECL_RE);
      if (match) {
        const name = match[1];
        // Skip common false positives: destructured params, exported symbols
        if (change.content.includes("export ")) continue;
        if (change.content.includes("{") && change.content.includes("}")) continue; // destructuring
        declarations.push({ name, line: change.line, content: change.content });
      }
    }
  }

  // For each declaration, check if the name is referenced in any added line
  // (excluding the declaration itself and avoiding partial matches)
  for (const decl of declarations) {
    const name = decl.name;
    // Skip very short names (i, j, k, e, ex — common loop/error vars)
    if (name.length <= 1) continue;
    // Skip underscore-prefixed (intentionally unused convention)
    if (name.startsWith("_")) continue;

    let isUsed = false;
    for (const line of addedContent) {
      if (line === decl.content) continue; // Skip the declaration line itself
      // Check for word-boundary match
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
      if (re.test(line)) {
        isUsed = true;
        break;
      }
    }

    if (!isUsed) {
      issues.push({
        category: "unused-variable",
        file: file.path,
        line: decl.line,
        symbol: name,
        description: `Variable \`${name}\` declared but never used in \`${file.path}:${decl.line}\` — consider removing dead code`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectEmptyCatchBlocks(file: DiffFile): DeadCodeIssue[] {
  const issues: DeadCodeIssue[] = [];

  for (const hunk of file.hunks) {
    const changes = hunk.changes;

    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change.type !== "add") continue;
      const content = change.content;

      // Pattern 1: single-line empty catch: catch (e) {}
      if (EMPTY_CATCH_RE.test(content)) {
        issues.push({
          category: "empty-catch",
          file: file.path,
          line: change.line,
          symbol: "catch",
          description: `Empty catch block in \`${file.path}:${change.line}\` — errors are silently swallowed, consider logging or rethrowing`,
          severity: "critical",
        });
        continue;
      }

      // Pattern 2: catch (e) { on its own line, followed by } on next added line
      const catchOpenMatch = content.match(/catch\s*\([^)]*\)\s*\{\s*$/);
      if (catchOpenMatch) {
        // Look ahead for the next added line — if it's just }, it's empty
        for (let j = i + 1; j < changes.length; j++) {
          if (changes[j].type !== "add") continue;
          const nextTrimmed = changes[j].content.replace(/^\+/, "").trim();
          if (nextTrimmed === "}") {
            issues.push({
              category: "empty-catch",
              file: file.path,
              line: change.line,
              symbol: "catch",
              description: `Empty catch block in \`${file.path}:${change.line}\` — errors are silently swallowed, consider logging or rethrowing`,
              severity: "critical",
            });
          }
          break; // Only check the next added line
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getIndent(line: string): number {
  // Strip only the '+' diff prefix (1 char), keep the actual code indentation
  const stripped = line.startsWith("+") ? line.slice(1) : line;
  const indent = stripped.match(/^(\s*)/);
  return indent ? indent[1].length : 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: DeadCodeIssue[]): DeadCodeIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}:${issue.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildDeadCodeContext(result: DeadCodeResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Dead Code Detection (${result.issues.length})\n`;
  ctx += "This PR may introduce dead code:\n\n";

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

function buildDeadCodeBodySummary(result: DeadCodeResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Dead Code Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | Symbol | File | Line | Severity |\n";
  body += "|----------|--------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.symbol}\` | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Dead code reduces readability and can mask bugs. Empty catch blocks silently swallow errors.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run dead code detection on diff files.
 * Zero LLM cost.
 */
export function detectDeadCode(diffFiles: DiffFile[]): DeadCodeResult {
  const allIssues: DeadCodeIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectUnreachableCode(file));
    allIssues.push(...detectUnusedVariables(file));
    allIssues.push(...detectEmptyCatchBlocks(file));
  }

  const issues = dedupIssues(allIssues);

  // Sort: critical first, then by file
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: DeadCodeResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildDeadCodeContext(result);
  result.bodySummary = buildDeadCodeBodySummary(result);

  if (issues.length > 0) {
    core.info(`Dead code detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
