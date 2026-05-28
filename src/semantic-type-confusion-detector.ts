/**
 * Semantic Type Confusion Detector — detect when values of one semantic
 * type are used where a different semantic type is expected in PR diffs.
 *
 * No AI code reviewer detects semantic type confusion. TypeScript's type
 * system catches structural incompatibility, but not semantic mismatch
 * where two values share the same structural type (e.g., both are string
 * or number) but represent different domain concepts. Examples:
 * - userId vs orderId (both strings, but not interchangeable)
 * - priceCents vs priceDollars (both numbers, different units)
 * - email vs phoneNumber (both strings, different formats)
 * - timestamp vs duration (both numbers, different semantics)
 *
 * These bugs are particularly dangerous because they compile without
 * error and produce subtly wrong results at runtime.
 *
 * Mizumi scans added lines for 4 semantic confusion categories:
 * 1. Unit mismatch: variable with unit suffix used where different unit expected
 * 2. Id confusion: different ID types compared/assigned
 * 3. Timestamp/duration swap: timestamp used as duration or vice versa
 * 4. String subtype confusion: email/phone/url/urlPath mixed up
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SemanticTypeConfusionCategory =
  | "unit-mismatch"
  | "id-confusion"
  | "timestamp-duration-swap"
  | "string-subtype-confusion";

export interface SemanticTypeConfusionIssue {
  /** Category of the issue */
  category: SemanticTypeConfusionCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = id-confusion/timestamp-swap, warning = unit-mismatch/string-subtype */
  severity: "critical" | "warning";
}

export interface SemanticTypeConfusionResult {
  /** All detected semantic type confusion issues */
  issues: SemanticTypeConfusionIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Unit suffixes (common in financial, scientific, and systems code)
const UNIT_SUFFIXES = /(?:Cents|Dollars|Millicents|Millis|Seconds|Minutes|Hours|Days|Weeks|Months|Years|Kb|Mb|Gb|Tb|Pb|Kib|Mib|Gib|Pix|Pixels|Meters|Km|Miles|Feet|Inches|Kg|Lb|Oz|Celsius|Fahrenheit|Kelvin|Bps|Kbps|Mbps|Gbps|Hz|Khz|Mhz|Ghz)$/i;

// ID type patterns
const ID_TYPE_RE = /^(?:user|order|product|account|session|transaction|payment|invoice|customer|tenant|project|team|org|repo|branch|commit|build|deploy|release|ticket|message|thread|comment|file|asset|resource|policy|role|permission)Id$/i;

// Timestamp vs duration confusion
const DURATION_VAR_RE = /(?:duration|timeout|delay|interval|ttl|expiry|age|elapsed|latency|uptime|downtime|waitTime|processingTime|responseTime)/i;
const TIMESTAMP_AS_DURATION_RE = /(?:createdAt|updatedAt|startedAt|endedAt|expiresAt)\s*(?:\+|\-|\*|\/|=)\s*(?:\d+|\.)/;
const DURATION_AS_TIMESTAMP_RE = /(?:duration|timeout|delay|interval|ttl)\s*(?:<|>|<=|>=|===|==)\s*(?:Date\.|new Date|Date\.now|\.now\(\))/;

// String subtype patterns

// Lines to skip
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectUnitMismatch(file: DiffFile): SemanticTypeConfusionIssue[] {
  const issues: SemanticTypeConfusionIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Pattern: variable with unit suffix assigned/compared to variable with different unit suffix
    // e.g., priceCents = priceDollars
    const assignMatch = change.content.match(/(\w*(?:Cents|Dollars|Millicents)\w*)\s*(?:===|!==|==|!=|=)\s*(\w*(?:Cents|Dollars|Millicents)\w*)/i);
    if (assignMatch && assignMatch[1] !== assignMatch[2]) {
      const lhs = assignMatch[1];
      const rhs = assignMatch[2];
      const lhsUnit = lhs.match(UNIT_SUFFIXES)?.[0];
      const rhsUnit = rhs.match(UNIT_SUFFIXES)?.[0];
      if (lhsUnit && rhsUnit && lhsUnit.toLowerCase() !== rhsUnit.toLowerCase()) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "unit-mismatch",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Unit mismatch in \`${file.path}:${change.line}\` — ${lhs} (${lhsUnit}) assigned/compared with ${rhs} (${rhsUnit}); convert units before mixing`,
          severity: "warning",
        });
      }
    }

    // Time unit mismatches: seconds vs milliseconds vs minutes
    const timeMatch = change.content.match(/(\w*(?:Seconds|Millis|Minutes|Hours|Days)\w*)\s*(?:===|!==|==|!=|=|<|>|<=|>=)\s*(\w*(?:Seconds|Millis|Minutes|Hours|Days)\w*)/i);
    if (timeMatch && timeMatch[1] !== timeMatch[2]) {
      const lhs = timeMatch[1];
      const rhs = timeMatch[2];
      const lhsUnit = lhs.match(UNIT_SUFFIXES)?.[0];
      const rhsUnit = rhs.match(UNIT_SUFFIXES)?.[0];
      if (lhsUnit && rhsUnit && lhsUnit.toLowerCase() !== rhsUnit.toLowerCase()) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "unit-mismatch",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Time unit mismatch in \`${file.path}:${change.line}\` — ${lhs} (${lhsUnit}) mixed with ${rhs} (${rhsUnit}); explicit unit conversion required`,
          severity: "warning",
        });
      }
    }

    // Storage/data unit mismatches: Kb vs Mb vs Gb
    const storageMatch = change.content.match(/(\w*(?:Kb|Mb|Gb|Tb|Pb|Kib|Mib|Gib)\w*)\s*(?:===|!==|==|!=|=|<|>|<=|>=)\s*(\w*(?:Kb|Mb|Gb|Tb|Pb|Kib|Mib|Gib)\w*)/i);
    if (storageMatch && storageMatch[1] !== storageMatch[2]) {
      const lhs = storageMatch[1];
      const rhs = storageMatch[2];
      const lhsUnit = lhs.match(UNIT_SUFFIXES)?.[0];
      const rhsUnit = rhs.match(UNIT_SUFFIXES)?.[0];
      if (lhsUnit && rhsUnit && lhsUnit.toLowerCase() !== rhsUnit.toLowerCase()) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "unit-mismatch",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Storage unit mismatch in \`${file.path}:${change.line}\` — ${lhs} (${lhsUnit}) mixed with ${rhs} (${rhsUnit}); explicit unit conversion required`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectIdConfusion(file: DiffFile): SemanticTypeConfusionIssue[] {
  const issues: SemanticTypeConfusionIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Pattern: userId === orderId or userId = orderId
    const idMatch = change.content.match(/(\w+Id)\s*(===|!==|==|!=|=)\s*(\w+Id)/i);
    if (idMatch && idMatch[1] !== idMatch[3]) {
      const lhs = idMatch[1];
      const rhs = idMatch[3];
      const lhsType = lhs.match(ID_TYPE_RE);
      const rhsType = rhs.match(ID_TYPE_RE);
      if (lhsType && rhsType && lhs.toLowerCase() !== rhs.toLowerCase()) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "id-confusion",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `ID type confusion in \`${file.path}:${change.line}\` — ${lhs} mixed with ${rhs}; different entity IDs are not interchangeable even if both are strings`,
          severity: "critical",
        });
      }
    }

    // Pattern: function call with wrong ID type
    // e.g., getUser(orderId) — orderId should be userId
    const funcCallMatch = change.content.match(/get(?:User|Order|Product|Account|Session|Transaction|Payment|Invoice|Customer)\s*\(\s*(\w+Id)/i);
    if (funcCallMatch) {
      const argId = funcCallMatch[1];
      const funcPrefix = change.content.match(/get(\w+)\s*\(/i)?.[1]?.toLowerCase();
      const argType = argId.replace(/Id$/i, "").toLowerCase();
      if (funcPrefix && argType && funcPrefix !== argType && funcPrefix !== "" && argType !== "") {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "id-confusion",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Possible ID confusion in \`${file.path}:${change.line}\` — get${funcPrefix}(${argId}); expected ${funcPrefix}Id, got ${argId}`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectTimestampDurationSwap(file: DiffFile): SemanticTypeConfusionIssue[] {
  const issues: SemanticTypeConfusionIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Timestamp used in arithmetic (suggests treating absolute time as duration)
    if (TIMESTAMP_AS_DURATION_RE.test(change.content) && !DURATION_VAR_RE.test(change.content)) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      const tsMatch = change.content.match(/(\w+(?:At|Timestamp))\s*[\+\-\*\/=]/i);
      if (tsMatch) {
        issues.push({
          category: "timestamp-duration-swap",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Timestamp used in arithmetic in \`${file.path}:${change.line}\` — ${tsMatch[1]} is an absolute time, not a duration; use Date differences to compute durations`,
          severity: "warning",
        });
      }
    }

    // Duration compared to Date.now() (suggests treating duration as absolute time)
    if (DURATION_AS_TIMESTAMP_RE.test(change.content)) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      const durMatch = change.content.match(/((?:\w+)?(?:duration|timeout|delay|interval|ttl))\s*[<>=!]+/i);
      if (durMatch) {
        issues.push({
          category: "timestamp-duration-swap",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Duration compared to absolute time in \`${file.path}:${change.line}\` — ${durMatch[1]} is a duration, not a timestamp; compare elapsed time instead`,
          severity: "warning",
        });
      }
    }

    // setTiemout/setInterval with timestamp instead of duration
    const setTimeoutTimestamp = change.content.match(/(?:setTimeout|setInterval)\s*\(\s*(?:async\s+)?(?:\(\)|\w+)\s*,\s*(\w+(?:At|Timestamp|Date|Time))/i);
    if (setTimeoutTimestamp) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "timestamp-duration-swap",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `setTimeout/setInterval with timestamp in \`${file.path}:${change.line}\` — ${setTimeoutTimestamp[1]} appears to be an absolute time, but setTimeout expects a duration in ms`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectStringSubtypeConfusion(file: DiffFile): SemanticTypeConfusionIssue[] {
  const issues: SemanticTypeConfusionIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Email assigned to phone variable or vice versa
    const assignMatch = change.content.match(/(\w*(?:email|eMail|emailAddress|mail)\w*)\s*(?:===|!==|==|!=|=)\s*(\w*(?:phone|phoneNumber|tel|mobile|cell|fax)\w*)/i);
    if (assignMatch) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "string-subtype-confusion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `String subtype confusion in \`${file.path}:${change.line}\` — email mixed with phone number; both are strings but have different formats and validation`,
        severity: "warning",
      });
    }

    // Phone assigned to email
    const phoneEmailMatch = change.content.match(/(\w*(?:phone|phoneNumber|tel|mobile|cell|fax)\w*)\s*(?:===|!==|==|!=|=)\s*(\w*(?:email|eMail|emailAddress|mail)\w*)/i);
    if (phoneEmailMatch) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "string-subtype-confusion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `String subtype confusion in \`${file.path}:${change.line}\` — phone number mixed with email; both are strings but have different formats and validation`,
        severity: "warning",
      });
    }

    // URL used where path expected or vice versa
    const urlPathMatch = change.content.match(/(\w*(?:filePath|dirPath|pathname|basePath)\w*)\s*(?:===|!==|==|!=|=)\s*(\w*(?:url|uri|href|link|endpoint)\w*)/i);
    if (urlPathMatch) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "string-subtype-confusion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `String subtype confusion in \`${file.path}:${change.line}\` — file path mixed with URL; both are strings but have different semantics and security implications`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: SemanticTypeConfusionIssue[]): SemanticTypeConfusionIssue[] {
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

function buildSemanticTypeConfusionContext(result: SemanticTypeConfusionResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Semantic Type Confusion (${result.issues.length})\n`;
  ctx += "This PR may mix semantically different types that share the same structural type:\n\n";

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

function buildSemanticTypeConfusionBodySummary(result: SemanticTypeConfusionResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Semantic Type Confusion Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Semantic type confusion compiles without error but produces subtly wrong results at runtime.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run semantic type confusion detection on diff files.
 * Zero LLM cost.
 */
export function detectSemanticTypeConfusion(diffFiles: DiffFile[]): SemanticTypeConfusionResult {
  const allIssues: SemanticTypeConfusionIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectUnitMismatch(file));
    allIssues.push(...detectIdConfusion(file));
    allIssues.push(...detectTimestampDurationSwap(file));
    allIssues.push(...detectStringSubtypeConfusion(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: SemanticTypeConfusionResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildSemanticTypeConfusionContext(result);
  result.bodySummary = buildSemanticTypeConfusionBodySummary(result);

  if (issues.length > 0) {
    core.info(`Semantic type confusion detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
