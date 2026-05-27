/**
 * TODO/FIXME Tech Debt Detector — detect tech debt markers added in PR diffs.
 *
 * No AI code reviewer flags when developers add TODO, FIXME, HACK, XXX, or
 * WORKAROUND comments in PRs. These markers accumulate as technical debt that
 * is almost never addressed. SonarQube tracks them at the repo level but
 * doesn't flag new ones at PR review time. CodeRabbit, Copilot, and Sourcery
 * all ignore them entirely.
 *
 * Mizumi scans added lines for 5 tech debt categories:
 * 1. TODO: Work planned but not yet done
 * 2. FIXME: Known bugs or broken code that needs fixing
 * 3. HACK: Workarounds that bypass proper solutions
 * 4. XXX: Dangerous or questionable code
 * 5. WORKAROUND: Temporary fixes that should be replaced
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TechDebtCategory =
  | "todo"
  | "fixme"
  | "hack"
  | "xxx"
  | "workaround";

export interface TechDebtIssue {
  /** Category of the issue */
  category: TechDebtCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The marker text (TODO, FIXME, etc.) */
  marker: string;
  /** The comment content after the marker */
  description: string;
  /** Human-readable summary */
  summary: string;
  /** Severity: critical = FIXME/HACK/XXX, warning = TODO/WORKAROUND */
  severity: "critical" | "warning";
}

export interface TechDebtResult {
  /** All detected tech debt issues */
  issues: TechDebtIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const DEBT_PATTERNS: Array<{
  category: TechDebtCategory;
  pattern: RegExp;
  severity: "critical" | "warning";
}> = [
  { category: "fixme", pattern: /\bFIXME\b/, severity: "critical" },
  { category: "hack", pattern: /\bHACK\b/, severity: "critical" },
  { category: "xxx", pattern: /\bXXX\b/, severity: "critical" },
  { category: "todo", pattern: /\bTODO\b/, severity: "warning" },
  { category: "workaround", pattern: /\bWORKAROUND\b/, severity: "warning" },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detectTechDebtInFile(file: DiffFile): TechDebtIssue[] {
  const issues: TechDebtIssue[] = [];

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Skip non-code lines (empty, pure closing braces)
      if (!trimmed || trimmed === "}") continue;

      for (const { category, pattern, severity } of DEBT_PATTERNS) {
        if (!pattern.test(content)) continue;

        const match = trimmed.match(pattern);
        if (!match) continue;

        // Extract the text after the marker (the explanation)
        const afterMarker = trimmed.slice(trimmed.indexOf(match[0]) + match[0].length).trim();
        // Remove leading colon or dash
        const cleanDesc = afterMarker.replace(/^[:\-]\s*/, "").trim();
        const displayDesc = cleanDesc.length > 80 ? cleanDesc.slice(0, 77) + "..." : cleanDesc;

        issues.push({
          category,
          file: file.path,
          line: change.line,
          marker: match[0],
          description: displayDesc || "(no description)",
          summary: `\`${match[0]}\` added in \`${file.path}:${change.line}\`${displayDesc ? " — " + displayDesc : ""}`,
          severity,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: TechDebtIssue[]): TechDebtIssue[] {
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

function buildTechDebtContext(result: TechDebtResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Tech Debt Detection (${result.issues.length})\n`;
  ctx += "This PR adds tech debt markers:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical.slice(0, 10)) {
      ctx += `- ${i.summary}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const i of warnings.slice(0, 10)) {
      ctx += `- ${i.summary}\n`;
    }
  }

  return ctx.trim();
}

function buildTechDebtBodySummary(result: TechDebtResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Tech Debt Detection</strong> — ${result.issues.length} marker(s) added</summary>\n\n`;
  body += "| Marker | File | Line | Description | Severity |\n";
  body += "|--------|------|------|-------------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const desc = i.description.length > 40 ? i.description.slice(0, 37) + "..." : i.description;
    body += `| \`${i.marker}\` | \`${i.file}\` | ${i.line} | ${desc} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Tech debt markers accumulate silently. FIXME/HACK/XXX signal known bugs or workarounds that should be tracked.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run tech debt detection on diff files.
 * Zero LLM cost.
 */
export function detectTechDebt(diffFiles: DiffFile[]): TechDebtResult {
  const allIssues: TechDebtIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectTechDebtInFile(file));
  }

  const issues = dedupIssues(allIssues);

  // Sort: critical first, then by file
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: TechDebtResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildTechDebtContext(result);
  result.bodySummary = buildTechDebtBodySummary(result);

  if (issues.length > 0) {
    core.info(`Tech debt detection: ${issues.length} marker(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
