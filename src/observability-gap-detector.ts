/**
 * Observability Gap Detector — detect missing logging/metrics/tracing in
 * error paths and significant code paths in PR diffs.
 *
 * No AI code reviewer flags observability gaps at PR review time. SonarQube
 * detects empty catch blocks (S108) but not "logged at info instead of error"
 * or "no metrics for this failure path." CodeRabbit occasionally comments on
 * missing logging via AI (non-deterministic), but no tool has a dedicated
 * detector. The difference between "code works" and "code is debuggable in
 * production" is observability.
 *
 * Mizumi scans added lines for 4 observability gap categories:
 * 1. Silent catch: catch block with only console.log/inspect (not error/warn)
 * 2. Throw without log: throw new Error() without prior logger/metric in block
 * 3. Unlogged route: API route handler without any logging/metrics/tracing
 * 4. Missing error metadata: catch that logs error but without context/metadata
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObservabilityGapCategory =
  | "silent-catch"
  | "throw-without-log"
  | "unlogged-route"
  | "missing-error-metadata";

export interface ObservabilityGapIssue {
  /** Category of the issue */
  category: ObservabilityGapCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = throw-without-log, warning = silent-catch/unlogged-route/missing-metadata */
  severity: "critical" | "warning";
}

export interface ObservabilityGapResult {
  /** All detected observability gap issues */
  issues: ObservabilityGapIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Observability-producing patterns (legitimate error handling)
const LOG_ERROR_RE = /\.(?:error|fatal|critical|alert|emergency)\s*\(/;
const LOG_WARN_RE = /\.warn\s*\(/;
const SENTRY_RE = /Sentry\.\s*(?:captureException|captureMessage|captureEvent|withScope|addBreadcrumb)\s*\(/;
const METRICS_RE = /\.(?:increment|decrement|gauge|histogram|timing|counter|meter)\s*\(/;
const TRACE_RE = /\.span|\.trace|\.recordException|\.setAttribute|\.addEvent\s*\(/;

// Weak observability patterns (not sufficient for error paths)
const CONSOLE_LOG_RE = /\.log\s*\(/;
const CONSOLE_INSPECT_RE = /\.inspect\s*\(/;
const CONSOLE_DEBUG_RE = /\.debug\s*\(/;
const CONSOLE_INFO_RE = /\.info\s*\(/;

// Catch block detection
const CATCH_RE = /catch\s*\([^)]*\)\s*\{/;
const CATCH_INLINE_RE = /catch\s*\([^)]*\)\s*\{[^}]*\}/;

// Throw patterns
const THROW_RE = /^\+\s*throw\b/;
const THROW_NEW_RE = /throw\s+new\s+\w*Error/;

// Route handler patterns (Express, Fastify, Koa, Hapi, NestJS)
const ROUTE_HANDLER_RE = /\.(?:get|post|put|patch|delete|head|options|use|all)\s*\(\s*['"]/;
const MIDDLEWARE_RE = /\.(?:use|all)\s*\(/;

// Lines to skip
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectSilentCatches(file: DiffFile): ObservabilityGapIssue[] {
  const issues: ObservabilityGapIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change.type !== "add") continue;

    const content = change.content;

    // Single-line catch: catch (e) { console.log(e); }
    if (CATCH_INLINE_RE.test(content)) {
      const innerMatch = content.match(/\{([^}]*)\}/);
      if (innerMatch) {
        const inner = innerMatch[1].trim();
        if (!inner) continue; // empty catch is handled by dead-code-detector
        // Check if inner content has only weak observability
        const hasStrong = LOG_ERROR_RE.test(inner) || LOG_WARN_RE.test(inner) || METRICS_RE.test(inner) || TRACE_RE.test(inner) || SENTRY_RE.test(inner);
        const hasWeak = CONSOLE_LOG_RE.test(inner) || CONSOLE_INSPECT_RE.test(inner) || CONSOLE_DEBUG_RE.test(inner) || CONSOLE_INFO_RE.test(inner);
        if (hasWeak && !hasStrong) {
          const trimmed = content.replace(/^\+/, "").trim();
          issues.push({
            category: "silent-catch",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Catch block with only console.log/debug in \`${file.path}:${change.line}\` — use logger.error() or logger.warn() for production observability`,
            severity: "warning",
          });
        }
      }
      continue;
    }

    // Multi-line catch block
    if (CATCH_RE.test(content)) {
      // Collect the catch block content
      let hasStrong = false;
      let hasWeak = false;
      let blockLines: string[] = [];

      for (let j = i + 1; j < Math.min(i + 15, changes.length); j++) {
        const next = changes[j];
        const nextContent = next.content.replace(/^\+/, "").trim();
        if (nextContent === "}" || nextContent === "});") break;

        blockLines.push(nextContent);

        if (LOG_ERROR_RE.test(next.content) || LOG_WARN_RE.test(next.content) || METRICS_RE.test(next.content) || TRACE_RE.test(next.content) || SENTRY_RE.test(next.content)) {
          hasStrong = true;
        }
        if (CONSOLE_LOG_RE.test(next.content) || CONSOLE_DEBUG_RE.test(next.content) || CONSOLE_INFO_RE.test(next.content)) {
          hasWeak = true;
        }
      }

      if (hasWeak && !hasStrong && blockLines.length > 0) {
        const trimmed = content.replace(/^\+/, "").trim();
        issues.push({
          category: "silent-catch",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Catch block with only console.log/debug/info in \`${file.path}:${change.line}\` — use logger.error() or logger.warn() for production observability`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectThrowWithoutLog(file: DiffFile): ObservabilityGapIssue[] {
  const issues: ObservabilityGapIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (!THROW_RE.test(change.content)) continue;
    if (!THROW_NEW_RE.test(change.content)) continue;

    // Look backward for logging before this throw (within 5 added lines)
    let hasPriorLog = false;
    for (let j = Math.max(0, i - 5); j < i; j++) {
      const prev = addedChanges[j];
      if (LOG_ERROR_RE.test(prev.content) || LOG_WARN_RE.test(prev.content) || METRICS_RE.test(prev.content) || TRACE_RE.test(prev.content) || SENTRY_RE.test(prev.content)) {
        hasPriorLog = true;
        break;
      }
    }

    if (!hasPriorLog) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "throw-without-log",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Throw without prior logging in \`${file.path}:${change.line}\` — log before throwing for production observability; errors caught upstream may be swallowed`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectUnloggedRoutes(file: DiffFile): ObservabilityGapIssue[] {
  const issues: ObservabilityGapIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (SKIP_LINE_RE.test(change.content)) continue;
    if (!ROUTE_HANDLER_RE.test(change.content) && !MIDDLEWARE_RE.test(change.content)) continue;

    // Found a route handler — look ahead for logging/metrics/tracing
    let hasObservability = false;
    for (let j = i + 1; j < Math.min(i + 20, addedChanges.length); j++) {
      const next = addedChanges[j];
      if (LOG_ERROR_RE.test(next.content) || LOG_WARN_RE.test(next.content) || LOG_ERROR_RE.test(next.content) || METRICS_RE.test(next.content) || TRACE_RE.test(next.content) || SENTRY_RE.test(next.content) || CONSOLE_LOG_RE.test(next.content) || CONSOLE_INFO_RE.test(next.content)) {
        hasObservability = true;
        break;
      }
      // If we hit another handler or closing, stop
      if (/^\+\s*\}\s*[;,]\s*$/.test(next.content) || ROUTE_HANDLER_RE.test(next.content)) break;
    }

    if (!hasObservability) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "unlogged-route",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Route handler without logging in \`${file.path}:${change.line}\` — add request logging or metrics for production debuggability`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectMissingErrorMetadata(file: DiffFile): ObservabilityGapIssue[] {
  const issues: ObservabilityGapIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change.type !== "add") continue;

    // Pattern: logger.error("message") without error object or context
    // Matches: logger.error("some message")  or  log.error("message")
    // Does NOT match: logger.error("msg", err) or logger.error({ err }, "msg")
    const weakLogMatch = change.content.match(/(?:logger|log|Logger)\.\s*(?:error|warn|fatal|critical|alert|emergency)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (weakLogMatch) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "missing-error-metadata",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Error log without context object in \`${file.path}:${change.line}\` — include error object and metadata for structured logging (e.g., logger.error("msg", { err, requestId }))`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: ObservabilityGapIssue[]): ObservabilityGapIssue[] {
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

function buildObservabilityContext(result: ObservabilityGapResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Observability Gaps (${result.issues.length})\n`;
  ctx += "This PR may lack observability:\n\n";

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

function buildObservabilityBodySummary(result: ObservabilityGapResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Observability Gap Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Silent catches and missing logs make production incidents take hours instead of minutes to diagnose.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run observability gap detection on diff files.
 * Zero LLM cost.
 */
export function detectObservabilityGaps(diffFiles: DiffFile[]): ObservabilityGapResult {
  const allIssues: ObservabilityGapIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectSilentCatches(file));
    allIssues.push(...detectThrowWithoutLog(file));
    allIssues.push(...detectUnloggedRoutes(file));
    allIssues.push(...detectMissingErrorMetadata(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ObservabilityGapResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildObservabilityContext(result);
  result.bodySummary = buildObservabilityBodySummary(result);

  if (issues.length > 0) {
    core.info(`Observability gap detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
