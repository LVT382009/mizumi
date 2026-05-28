/**
 * Ungated Critical Return Detector — detect discarded validation/auth returns.
 *
 * LLMs generate the correct check call (validateInput(), checkPermission(),
 * isAuthenticated(), saveRecord()) but discard the return value and proceed
 * on the happy path regardless. The call runs, its result is ignored, and the
 * code behaves as if validation always passes.
 *
 * This is the #1 pattern behind LLM-caused auth bypass and data corruption —
 * and it's uniquely LLM because humans who write `const isValid = validate(...)`
 * always add the `if (!isValid)` guard; LLMs add the belt but never buckle it.
 *
 * No existing tool catches it: SonarQube/Codacy flag unused variables, not
 * discarded returns. Error-handling detectors catch missing await and swallowed
 * catch, not sync boolean-discards. Sycophantic stubs return wrong defaults;
 * here the call is correct — it just never gates execution.
 *
 * Categories:
 * 1. discarded-validation-return: validate/check/verify called as bare statement
 * 2. discarded-auth-return: auth/permission checks called as bare statement
 * 3. unguarded-write-path: save/write/insert/delete return discarded
 * 4. assigned-but-ungated: validation result assigned but never used in guard
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UngatedCriticalReturnCategory =
  | "discarded-validation-return"
  | "discarded-auth-return"
  | "unguarded-write-path"
  | "assigned-but-ungated";

export interface UngatedCriticalReturnIssue {
  category: UngatedCriticalReturnCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface UngatedCriticalReturnResult {
  issues: UngatedCriticalReturnIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Validation function name patterns — these return boolean/status that MUST be checked
// NOTE: Auth-specific patterns (checkAuth, verifyAuth, etc.) are handled by AUTH_FUNC_RE first
const VALIDATION_FUNC_RE = /\b(?:validate\w*|assert\w*|ensure\w*|confirm\w*|require\w*|(?:check|verify)(?!Auth)\w*|test\w*|sanitize\w*|normalize\w*)\s*\(/i;

// Auth/permission function name patterns — these gate access
const AUTH_FUNC_RE = /\b(?:isAuth\w*|canAccess\w*|hasPermission\w*|hasRole\w*|hasAccess\w*|isAllowed\w*|isPermitted\w*|isAuthorized\w*|isAuthenticated\w*|authenticate\w*|authorize\w*|checkAuth\w*|verifyAuth\w*|verifyPermission\w*|requireAuth\w*)\s*\(/i;

// Write-path function name patterns — these return success/error that should be checked
const WRITE_PATH_FUNC_RE = /\b(?:save\w*|write\w*|insert\w*|update\w*|delete\w*|remove\w*|destroy\w*|create\w*|push\w*|publish\w*|send\w*|store\w*|persist\w*|commit\w*|upload\w*|flush\w*|fire\w*|emit\w*|dispatch\w*)\s*\(/i;

// Assignment pattern: const/let/var <name> = <call>
const ASSIGNMENT_RE = /^(?:const|let|var)\s+(\w+)\s*=\s*(.+?)\s*;?\s*$/;

// Bare call pattern: just a function call as a statement (result discarded)
const BARE_CALL_RE = /^\s*(\w+)\s*\(/;

// Guard pattern: if/throw/return that references ANY word — check all words against assigned vars
const GUARD_WORDS_RE = /\b(\w+)\b/g;

// Skip patterns — these are NOT ungated returns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\.|\})/;

// Lines that ARE guards — skip them from detection
const GUARD_LINE_RE = /^\+\s*(?:if\s*\(|throw\s|return\s|if\s*\(!|if\s*\()/;

// Known safe bare calls — these are fire-and-forget by design
const KNOWN_FIRE_AND_FORGET_RE = /\b(?:log\w*|console\.\w+|debug\w*|trace\w*|info\w*|warn\w*|error\w*|metric\w*|track\w*|report\w*|notify\w*|emit\w*\.on|addEventListener|removeEventListener|on\(|off\()\s*\(/i;

// Awaited calls — if the result is awaited but not used, that's a different (lesser) issue
const AWAITED_CALL_RE = /\bawait\s+/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectDiscardedValidationReturn(file: DiffFile): UngatedCriticalReturnIssue[] {
  const issues: UngatedCriticalReturnIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Track assigned validation variables for assigned-but-ungated detection
  const assignedVars: Map<string, { line: number; code: string; funcName: string }> = new Map();

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip guard lines (if/throw/return that check a variable)
    if (GUARD_LINE_RE.test(content)) {
      // Check if this guard references any assigned variable — if so, mark it guarded
      const words = trimmed.match(GUARD_WORDS_RE);
      if (words) {
        for (const w of words) {
          assignedVars.delete(w);
        }
      }
      continue;
    }

    // Skip awaited calls — we focus on sync discarded returns
    if (AWAITED_CALL_RE.test(trimmed)) continue;

    // Skip fire-and-forget patterns
    if (KNOWN_FIRE_AND_FORGET_RE.test(trimmed)) continue;

    // Check for assignment: const isValid = validateInput(data)
    const assignMatch = trimmed.match(ASSIGNMENT_RE);
    if (assignMatch) {
      const [, varName, callExpr] = assignMatch;

      // Check if the call expression is a validation/auth/write-path function
      if (VALIDATION_FUNC_RE.test(callExpr)) {
        assignedVars.set(varName, {
          line: change.line,
          code: trimmed,
          funcName: callExpr.match(/(\w+)\s*\(/)?.[1] || "validate",
        });
        continue; // Don't flag bare call if it's assigned
      }
      if (AUTH_FUNC_RE.test(callExpr)) {
        assignedVars.set(varName, {
          line: change.line,
          code: trimmed,
          funcName: callExpr.match(/(\w+)\s*\(/)?.[1] || "auth",
        });
        continue;
      }
      // Write-path with assignment — likely guarded, skip
      continue;
    }

    // Check for bare call (result discarded)
    const bareMatch = trimmed.match(BARE_CALL_RE);
    if (bareMatch) {
      const funcName = bareMatch[1];

      // Validation function called as bare statement — result discarded
      if (VALIDATION_FUNC_RE.test(trimmed)) {
        issues.push({
          category: "discarded-validation-return",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Validation function \`${funcName}()\` called but return value discarded in \`${file.path}:${change.line}\` — LLMs frequently call validate/check functions without guarding on the result, causing silent auth bypass; add \`if (!result)\` guard or assign and check`,
          severity: "critical",
        });
        continue;
      }

      // Auth function called as bare statement — result discarded
      if (AUTH_FUNC_RE.test(trimmed)) {
        issues.push({
          category: "discarded-auth-return",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Auth function \`${funcName}()\` called but return value discarded in \`${file.path}:${change.line}\` — LLMs call isAuthenticated/hasPermission without checking the result, causing auth bypass; add \`if (!result) return\` guard`,
          severity: "critical",
        });
        continue;
      }

      // Write-path function called as bare statement — error return lost
      if (WRITE_PATH_FUNC_RE.test(trimmed)) {
        issues.push({
          category: "unguarded-write-path",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Write-path function \`${funcName}()\` called but return value discarded in \`${file.path}:${change.line}\` — LLMs call save/insert/update without checking for failure; add error handling or assign result`,
          severity: "warning",
        });
        continue;
      }
    }
  }

  // Any assigned variables that weren't consumed by a guard line → assigned-but-ungated
  for (const [varName, info] of assignedVars) {
    issues.push({
      category: "assigned-but-ungated",
      file: file.path,
      line: info.line,
      code: info.code,
      description: `Variable \`${varName}\` assigned result of \`${info.funcName}()\` but never used in a guard (if/throw/return) in \`${file.path}:${info.line}\` — LLMs assign validation results without adding the guard clause; add \`if (!${varName})\` or \`if (${varName} === false)\` check`,
      severity: "warning",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: UngatedCriticalReturnIssue[]): UngatedCriticalReturnIssue[] {
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

function buildUngatedReturnContext(result: UngatedCriticalReturnResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Ungated Critical Returns (${result.issues.length})\n`;
  ctx += "This PR may contain discarded validation/auth returns — LLMs call check functions without guarding on the result:\n\n";

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

function buildUngatedReturnBodySummary(result: UngatedCriticalReturnResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Ungated Critical Return Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Ungated critical returns are the #1 cause of LLM-induced auth bypass — validate/check functions called but their return value discarded, allowing execution to proceed regardless.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run ungated critical return detection on diff files.
 * Zero LLM cost.
 */
export function detectUngatedCriticalReturns(diffFiles: DiffFile[]): UngatedCriticalReturnResult {
  const allIssues: UngatedCriticalReturnIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectDiscardedValidationReturn(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: UngatedCriticalReturnResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildUngatedReturnContext(result);
  result.bodySummary = buildUngatedReturnBodySummary(result);

  if (issues.length > 0) {
    core.info(`Ungated critical return detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
