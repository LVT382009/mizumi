/**
 * Rules File Integrity Detector — detect suspicious changes to code
 * review rules, configuration, and safety files.
 *
 * LLMs may modify review rules to silence their own findings: lowering
 * confidence thresholds, excluding security paths, disabling detectors,
 * and expanding exclusion patterns. This is the AI equivalent of a
 * criminal altering the alarm system before a break-in.
 *
 * Categories:
 * 1. rule-softening: disabling detectors, lowering thresholds, changing
 *    profile from assertive to chill
 * 2. security-exclusion: removing security paths or adding non-standard
 *    exclusions to security-sensitive directories
 * 3. threshold-manipulation: changing confidence thresholds, max_comments,
 *    spend_threshold, or gate settings to reduce review effectiveness
 * 4. exclude-expansion: adding broad exclusion patterns that hide files
 *    from review
 *
 * Zero LLM cost — pure pattern analysis on diff content in rules files.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RulesIntegrityCategory =
  | "rule-softening"
  | "security-exclusion"
  | "threshold-manipulation"
  | "exclude-expansion";

export interface RulesIntegrityIssue {
  category: RulesIntegrityCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface RulesIntegrityResult {
  issues: RulesIntegrityIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^[-+]/, "").trim();
}

function getChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes);
}

// ---------------------------------------------------------------------------
// Rules files
// ---------------------------------------------------------------------------

const RULES_FILES = [
  "CLAUDE.md",
  "REVIEW.md",
  ".github/mizumi.yml",
  ".github/mizumi.yaml",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.js",
  ".prettierrc.json",
  "tsconfig.json",
  "biome.json",
  ".rubocop.yml",
  "pyproject.toml",
];

function isRulesFile(path: string): boolean {
  return RULES_FILES.some((rf) => path.endsWith(rf) || path === rf);
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Rule softening: disabling detectors or checks
const DISABLE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(?:self_critique|compliance_check|linter_scan|auto_labels|rule_engine):\s+false/i, label: "disabling a core review feature" },
  { re: /\b(?:taint_analysis|blast_radius|spec_compliance|auth_boundary):\s+false/i, label: "disabling a security detector" },
  { re: /\b(?:secret_entropy|safety_score|fatigue_dashboard|org_memory):\s+false/i, label: "disabling a safety feature" },
  { re: /\b(?:swarm_review|review_learning|delta_review|chunk_review):\s+false/i, label: "disabling a review optimization" },
  { re: /\b(?:ast_contract_analysis|behavioral_summary|ownership_routing):\s+false/i, label: "disabling an analysis feature" },
  { re: /\bprofile:\s*chill/i, label: "changing review profile to chill (least assertive)" },
  { re: /\bno.review\b|\bdisable.review\b|\bskip.review\b/i, label: "disabling review" },
];

// Security exclusion: removing security paths
const SECURITY_EXCLUSION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|-)\s*(?:\*\*\/auth|\*\*\/crypto|\*\*\/sql|\*\*\/secret|\*\*\/password)/, label: "removing a security path from monitoring" },
  { re: /security_paths:\s*\[\s*\]/, label: "emptying security paths array" },
  { re: /(?:^|-)\s*(?:src\/\*\*|\*\*\/\*\*|\/)/, label: "adding overly broad path to security exclusions" },
];

// Threshold manipulation: lowering review effectiveness
const THRESHOLD_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bconfidence_threshold:\s*(?:[0-7]\d?|[1-7])\b/, label: "lowering confidence threshold below 80" },
  { re: /\bmax_comments:\s*(?:[0-9]|1[0-4])\b/, label: "reducing max comments below 15" },
  { re: /\bgate_threshold:\s*none/i, label: "disabling merge gate" },
  { re: /\bspend_threshold:\s*0\b/, label: "disabling spend limit" },
  { re: /\bauto_pause_after:\s*(?:[6-9]\d|[1-9]\d{2,})/, label: "increasing auto-pause threshold significantly" },
];

// Exclude expansion: adding broad exclusion patterns
const EXCLUDE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-\s+'?\*\*\/\*'?|-\s+'?\*$|-\s+'?src\/\*\*'?|-\s+\.\.\//, label: "adding wildcard exclusion that hides entire directories" },
  { re: /-\s+'?\*\*\/(?:test|spec|__tests__)/, label: "excluding test directories from review" },
  { re: /-\s+'?\*\*\/(?:secret|key|credential|auth)/, label: "excluding security-sensitive directories from review" },
];

// Also check removed lines for security paths being removed
const SECURITY_PATH_REMOVE: Array<{ re: RegExp; label: string }> = [
  { re: /\*\*\/auth\/\*\*/, label: "removing auth directory from security monitoring" },
  { re: /\*\*\/crypto\/\*\*/, label: "removing crypto directory from security monitoring" },
  { re: /\*\*\/sql\/\*\*/, label: "removing SQL directory from security monitoring" },
  { re: /\*\*\/secret\*/, label: "removing secret paths from security monitoring" },
  { re: /\*\*\/password\*/, label: "removing password paths from security monitoring" },
];

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

function analyzeRulesFile(file: DiffFile): RulesIntegrityIssue[] {
  const issues: RulesIntegrityIssue[] = [];
  const changes = getChanges(file);

  for (const change of changes) {
    const trimmed = stripPrefix(change.content);
    if (!trimmed || trimmed.startsWith("#")) continue;

    const isAdded = change.type === "add";
    const isRemoved = change.type === "delete";

    // Rule softening (only in added lines)
    if (isAdded) {
      for (const { re, label } of DISABLE_PATTERNS) {
        if (re.test(trimmed)) {
          issues.push({
            category: "rule-softening",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Rule softening in \`${file.path}:${change.line}\`: ${label} — LLMs may modify review rules to silence their own findings; lowering review rigor weakens the entire review pipeline; this change should be reviewed by a human with security context`,
            severity: "critical",
          });
          break;
        }
      }

      // Threshold manipulation
      for (const { re, label } of THRESHOLD_PATTERNS) {
        if (re.test(trimmed)) {
          issues.push({
            category: "threshold-manipulation",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Threshold manipulation in \`${file.path}:${change.line}\`: ${label} — LLMs may lower review thresholds to make their own code pass review more easily; reduced thresholds mean fewer findings reach reviewers; keep thresholds at project defaults unless explicitly approved`,
            severity: "warning",
          });
          break;
        }
      }

      // Exclude expansion
      for (const { re, label } of EXCLUDE_PATTERNS) {
        if (re.test(trimmed)) {
          issues.push({
            category: "exclude-expansion",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Exclude expansion in \`${file.path}:${change.line}\`: ${label} — Broad exclusions hide files from review, including security-sensitive code; LLMs add exclusions to prevent their mistakes from being caught; only project owners should modify exclusion patterns`,
            severity: "warning",
          });
          break;
        }
      }

      // Security exclusion in added lines
      for (const { re, label } of SECURITY_EXCLUSION_PATTERNS) {
        if (re.test(trimmed)) {
          issues.push({
            category: "security-exclusion",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Security exclusion in \`${file.path}:${change.line}\`: ${label} — Removing security paths from monitoring creates blind spots; LLMs may exclude security directories to prevent their own security mistakes from being flagged; never remove security path monitoring without security team approval`,
            severity: "critical",
          });
          break;
        }
      }
    }

    // Security path removal (in removed lines)
    if (isRemoved) {
      for (const { re, label } of SECURITY_PATH_REMOVE) {
        if (re.test(trimmed)) {
          issues.push({
            category: "security-exclusion",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Security path removal in \`${file.path}:${change.line}\`: ${label} — Removing security monitoring paths is the AI equivalent of disabling the alarm before a break-in; this change should require security team review`,
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
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: RulesIntegrityIssue[]): RulesIntegrityIssue[] {
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

function buildRulesIntegrityContext(result: RulesIntegrityResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Rules File Integrity Detection (${result.issues.length})\n`;
  ctx += "This PR modifies code review rules or configuration — LLMs may alter review settings to silence their own findings:\n\n";

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

function buildRulesIntegrityBodySummary(result: RulesIntegrityResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Rules File Integrity Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLMs may modify review rules to silence their own findings — disabling detectors, lowering thresholds, excluding security paths, and expanding exclusion patterns. These changes weaken the review pipeline. Any modification to review configuration should require human approval.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run rules file integrity detection on diff files. Zero LLM cost. */
export function detectRulesFileIntegrity(diffFiles: DiffFile[]): RulesIntegrityResult {
  const allIssues: RulesIntegrityIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (!isRulesFile(file.path)) continue;

    allIssues.push(...analyzeRulesFile(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: RulesIntegrityResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildRulesIntegrityContext(result);
  result.bodySummary = buildRulesIntegrityBodySummary(result);

  if (issues.length > 0) {
    core.info(`Rules file integrity detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
