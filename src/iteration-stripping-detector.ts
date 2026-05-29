/**
 * Iteration Security Stripping Detector — detect when LLM-driven
 * refactoring removes security controls that existed in prior code.
 *
 * The IEEE-ISTAS paper (arxiv 2506.11022v2) found a 37.6% increase
 * in critical vulnerabilities after just 5 LLM iterations. The CSA
 * 2026 report found privilege escalation paths rose 322% and
 * architectural design flaws rose 153% while syntax errors dropped
 * 76% — the "illusion of improvement" where code LOOKS better but
 * is actually LESS secure.
 *
 * This detector analyzes removed lines in PR diffs to detect
 * security controls being stripped: auth decorators, validation
 * guards, parameterized queries, sanitization calls, and specific
 * exception handling replaced by broad catch.
 *
 * Categories:
 * 1. auth-decorator-stripped: auth/login_required decorators removed
 * 2. validation-guard-stripped: input validation checks removed
 * 3. parameterization-loss: parameterized queries replaced with concat
 * 4. error-handling-weakened: specific catch replaced with broad/pass
 *
 * Zero LLM cost — pattern analysis on removed diff lines.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IterationStrippingCategory =
  | "auth-decorator-stripped"
  | "validation-guard-stripped"
  | "parameterization-loss"
  | "error-handling-weakened";

export interface IterationStrippingIssue {
  category: IterationStrippingCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface IterationStrippingResult {
  issues: IterationStrippingIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^[-+]/, "").trim();
}

function getRemovedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "delete");
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const SKIP_LINE_RE = /^[-+]\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// Category 1: Auth decorators being removed
const AUTH_DECORATOR_PATTERNS = [
  /@(?:login_required|require_auth|authenticate|authorized|require_(?:login|auth|permission|admin|role)|auth_decorator|protected|requireScope|hasRole|preAuthorize|RolesAllowed|DenyAll|PermitAll)\b/i,
  /@(?:UseGuards|AuthGuard)\s*\(\s*\w+\s*\)/i,
  /@requires?\s+(?:auth|login|role|permission|admin|scope)\b/i,
  /@check\s*(?:auth|login|permission|role)\b/i,
  // Flask-style decorators
  /@app\.before_request\b/i,
  // Middleware auth patterns
  /(?:app|router)\.(?:use|all)\s*\(\s*(?:auth|authenticate|verifyToken|checkAuth|isAuthenticated)\b/i,
];

// Category 2: Input validation guards being removed
const VALIDATION_GUARD_PATTERNS = [
  /\bif\s*\([^)]*(?:!?\s*(?:isValid|validate|check|verify|sanitize|escape|isAuthenticated|isAuthorized|isAllowed|isPermitted|hasPermission|hasRole)\w*)[^)]*\)\s*\{?/i,
  /\b(?:validate|check|verify|sanitize|escape|validateInput|checkInput|verifyInput|sanitizeInput|escapeInput)\w*\s*\(/i,
  /\breturn\s+(?:res|response|ctx)\.(?:status\s*\(\s*(?:400|401|403|422)\s*\)|sendStatus\s*\(\s*(?:400|401|403|422)\s*\))/i,
  /\bthrow\s+new\s+(?:Validation|Auth|Permission|Forbidden|Unauthorized)Error\b/i,
];

// Category 3: Parameterized query being replaced with string concat
const PARAMETERIZED_QUERY_PATTERNS = [
  /\b(?:execute|query|run)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*\[/i,
  /\b(?:execute|query|run)\s*\(\s*['"`][^'"`]*['"`]\s*,\s*\w+\s*\)/i,
  /\bcursor\.execute\s*\(\s*['"`][^'"`]*/i,
  /(?:prepare|stmt)\s*\(/i,
  /\b(?:parameterized|param|bind)\w*\s*\(/i,
];

// Category 4: Error handling being weakened
// Removed specific catch, added broad catch/pass nearby
const SPECIFIC_CATCH_PATTERNS = [
  /\bcatch\s*\(\s*(?:\w+\s*:\s*)?(?:ValueError|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError)\b/i,
  /\bcatch\s*\(\s*(?:\w+\s*:\s*)?(?:ValidationError|AuthError|PermissionError|ForbiddenError|UnauthorizedError|NotFoundError|ConflictError)\b/i,
  /\bcatch\s*\(\s*\w+\s*:\s*(?!Error\b|any\b|unknown\b)\w+Error\b/i,
  /\bcatch\s*\(\s*\w+\s+(?:as|:)\s+(?!Error|Exception|Throwable|any|unknown)\w+/i,
  /\bexcept\s+(?:ValueError|TypeError|KeyError|AttributeError|ImportError|LookupError|OSError|IOError|HTTPError|URLError|RequestException)\b/i,
];

// Added patterns that indicate weakening
const WEAKENED_CATCH_PATTERNS = [
  /\bcatch\s*\(\s*\w+(?:\s*:\s*(?:Error|any|unknown|Exception|Throwable))?\s*\)\s*\{\s*\}/i,
  /\bcatch\s*\(\s*\w+\s*\)\s*\{\s*\}/,
  /\bexcept\s*(?:Exception|BaseException|Error|Throwable)\s*:\s*pass\b/i,
  /\bexcept\s*(?:Exception|BaseException|Error)\b[^:]*:\s*\n?\s*(?:pass|logging|console|logger)/i,
  /\bcatch\b[^{]*\{\s*(?:console|logger|log)\.\w+\s*\([^)]*\)\s*;\s*\}/i,
];

// ---------------------------------------------------------------------------
// Detection: auth-decorator-stripped
// ---------------------------------------------------------------------------

function detectAuthDecoratorStripped(file: DiffFile): IterationStrippingIssue[] {
  const issues: IterationStrippingIssue[] = [];
  const removed = getRemovedChanges(file);

  for (const change of removed) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of AUTH_DECORATOR_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "auth-decorator-stripped",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Auth decorator stripped in \`${file.path}:${change.line}\` — LLM refactoring removes authentication/authorization decorators during "simplification"; CSA 2026: privilege escalation paths rose 322% in AI-iterated code; IEEE-ISTAS: 37.6% critical vuln increase after 5 iterations; restore the auth decorator or provide equivalent protection`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: validation-guard-stripped
// ---------------------------------------------------------------------------

function detectValidationGuardStripped(file: DiffFile): IterationStrippingIssue[] {
  const issues: IterationStrippingIssue[] = [];
  const removed = getRemovedChanges(file);

  for (const change of removed) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of VALIDATION_GUARD_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "validation-guard-stripped",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Validation guard stripped in \`${file.path}:${change.line}\` — LLM refactoring removes input validation during "cleanup"; IEEE-ISTAS case study: "iterations progressively removed bounds checking → unsafe memory reuse"; restore the validation check or document why it's no longer needed`,
          severity: "warning",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: parameterization-loss
// ---------------------------------------------------------------------------

function detectParameterizationLoss(file: DiffFile): IterationStrippingIssue[] {
  const issues: IterationStrippingIssue[] = [];
  const removed = getRemovedChanges(file);
  const added = getAddedChanges(file);

  // Check if parameterized queries were removed
  let hadParameterization = false;
  for (const change of removed) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of PARAMETERIZED_QUERY_PATTERNS) {
      if (re.test(trimmed)) {
        hadParameterization = true;
        break;
      }
    }
    if (hadParameterization) break;
  }

  // Check if string concatenation queries were added
  if (hadParameterization) {
    const STRING_CONCAT_QUERY_RE = /(?:query|execute|run|sql)\s*\(\s*['"`][^'"`]*\$\{|(?:query|execute|run|sql)\s*\(\s*['"`][^'"`]*\+\s*\w+|f['"`][^'"`]*SELECT|f['"`][^'"`]*INSERT|f['"`][^'"`]*UPDATE|f['"`][^'"`]*DELETE/i;

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);
      if (file.path.includes("test") || file.path.includes("__tests__")) continue;

      if (STRING_CONCAT_QUERY_RE.test(trimmed)) {
        issues.push({
          category: "parameterization-loss",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Parameterization lost in \`${file.path}:${change.line}\`: parameterized query removed, string concatenation query added — IEEE-ISTAS case study: "removed parameterization → string concatenation queries → insufficient input validation"; this is a direct SQL injection introduction; restore parameterized queries`,
          severity: "critical",
        });
        break;
      }
    }
  }

  // Also flag removed parameterized queries even without replacement evidence
  for (const change of removed) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of PARAMETERIZED_QUERY_PATTERNS) {
      if (re.test(trimmed)) {
        // Only flag if there's no corresponding add
        const alreadyFlagged = issues.some(
          (iss) => iss.category === "parameterization-loss" && iss.file === file.path
        );
        if (!alreadyFlagged) {
          issues.push({
            category: "parameterization-loss",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Parameterized query removed in \`${file.path}:${change.line}\` — parameterized SQL removed without clear replacement; verify the new code uses equivalent parameterization; IEEE-ISTAS: "removed parameterization → string concatenation queries → injection vulnerabilities"`,
            severity: "warning",
          });
        }
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: error-handling-weakened
// ---------------------------------------------------------------------------

function detectErrorHandlingWeakened(file: DiffFile): IterationStrippingIssue[] {
  const issues: IterationStrippingIssue[] = [];
  const removed = getRemovedChanges(file);
  const added = getAddedChanges(file);

  let hadSpecificCatch = false;
  for (const change of removed) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of SPECIFIC_CATCH_PATTERNS) {
      if (re.test(trimmed)) {
        hadSpecificCatch = true;
        break;
      }
    }
    if (hadSpecificCatch) break;
  }

  // Check if broad catch/pass was added
  if (hadSpecificCatch) {
    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);
      if (file.path.includes("test") || file.path.includes("__tests__")) continue;

      for (const re of WEAKENED_CATCH_PATTERNS) {
        if (re.test(trimmed)) {
          issues.push({
            category: "error-handling-weakened",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Error handling weakened in \`${file.path}:${change.line}\`: specific exception catch replaced with broad catch/pass — LLM refactoring replaces targeted error handling with generic catch-and-ignore; CSA 2026: "architectural design flaws rose 153%" as LLMs iterate; restore specific exception handling to prevent silent failures`,
            severity: "warning",
          });
          break;
        }
      }
      if (issues.length > 0) break;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: IterationStrippingIssue[]): IterationStrippingIssue[] {
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

function buildIterationStrippingContext(result: IterationStrippingResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Iteration Security Stripping Detection (${result.issues.length})\n`;
  ctx += "This PR removes security controls — LLM-driven refactoring strips auth decorators, validation guards, and parameterization:\n\n";

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

function buildIterationStrippingBodySummary(result: IterationStrippingResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Iteration Security Stripping Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLM refactoring strips security controls during iteration — auth decorators removed, validation guards deleted, parameterized queries replaced with string concatenation, specific error handling replaced with broad catch/pass. IEEE-ISTAS: 37.6% critical vulnerability increase after 5 iterations. CSA 2026: privilege escalation +322%, design flaws +153%. Review each removal carefully.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run iteration security stripping detection on diff files. Zero LLM cost. */
export function detectIterationStripping(diffFiles: DiffFile[]): IterationStrippingResult {
  const allIssues: IterationStrippingIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectAuthDecoratorStripped(file));
    allIssues.push(...detectValidationGuardStripped(file));
    allIssues.push(...detectParameterizationLoss(file));
    allIssues.push(...detectErrorHandlingWeakened(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: IterationStrippingResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildIterationStrippingContext(result);
  result.bodySummary = buildIterationStrippingBodySummary(result);

  if (issues.length > 0) {
    core.info(`Iteration stripping detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
