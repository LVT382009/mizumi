/**
 * Agency Escalation Detector — detect OWASP LLM06:2025 Excessive Agency
 * patterns where generated code grants AI agents unrestricted capabilities.
 *
 * OWASP LLM06:2025 defines three sub-types — excessive functionality,
 * excessive permissions, excessive autonomy — none of which any code
 * review tool detects in generated code.
 *
 * Microsoft Security (May 2026) documented CVE-2026-26030 and
 * CVE-2026-25592 where AI-controlled parameters reached dangerous code
 * sinks because frameworks trusted the AI model's output without
 * validation. Snyk ToxicSkills found 13.4% of agent skills contain
 * critical security issues, with 91% pairing prompt injection with
 * code execution.
 *
 * Patterns detected:
 * 1. unrestricted-tool-parameter: Parameters controlling file paths,
 *    commands, or network destinations without allowlisting
 * 2. excessive-autonomy: Auto-approve, auto-deploy, auto-merge without
 *    human-in-the-loop confirmation in source code
 * 3. dangerous-sink-from-llm-output: LLM-controlled strings reaching
 *    eval/exec/child_process/file-write sinks without validation
 *
 * Zero LLM cost — pattern analysis on added diff lines.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgencyEscalationCategory =
  | "unrestricted-tool-parameter"
  | "excessive-autonomy"
  | "dangerous-sink-from-llm-output";

export interface AgencyEscalationIssue {
  category: AgencyEscalationCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface AgencyEscalationResult {
  issues: AgencyEscalationIssue[];
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

const SKIP_LINE_RE = /^[-+]\s*(?:[\/][\/]|\/\*|\*|import\s+type\s|export\s+type\s)/;

const TEST_PATH_RE = /(?:__tests__|\.test\.|\.spec\.|_test\.|_spec\.|tests?\/)/;

// ---------------------------------------------------------------------------
// Category 1: Unrestricted tool parameters
// ---------------------------------------------------------------------------

// Parameters that control dangerous operations without validation
const UNRESTRICTED_PARAM_PATTERNS: Array<{ re: RegExp; sink: string }> = [
  // File path parameters without allowlisting
  { re: /(?:filePath|filepath|path|dest|destination|outputPath|output)\s*[=:]\s*(?:req|request|params|query|body|input|args|ctx)\b/i, sink: "file" },
  // Shell command parameters without allowlisting
  { re: /(?:command|cmd|shell|exec|script)\s*[=:]\s*(?:req|request|params|query|body|input|args|ctx)\b/i, sink: "exec" },
  // URL parameters from user/agent input
  { re: /(?:url|endpoint|host|server|baseUrl|apiUrl)\s*[=:]\s*(?:req|request|params|query|body|input|args|ctx)\b/i, sink: "network" },
  // Function signature with dangerous params with no validation guard
  { re: /(?:function|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?)\s*\w+\s*\([^)]*(?:filePath|filepath|cmd|command|exec_path|script).*(?:\)|\{)/i, sink: "param" },
];

// Validation patterns that would make dangerous params safe
const VALIDATION_GUARD_RE = [
  /(?:startsWith|includes|indexOf|match|test)\s*\(/i,
  /(?:ALLOWED|WHITELIST|SAFE|VALID)_(?:PATHS|COMMANDS|URLS|DOMAINS)/i,
  /allowlist|whitelist|safeList/i,
  /(?:path\.normalize|path\.resolve|path\.basename)\s*\(/i,
  /(?:sanitize|validate|check|restrict)\w*\s*\(/i,
];

// ---------------------------------------------------------------------------
// Category 2: Excessive autonomy
// ---------------------------------------------------------------------------

const EXCESSIVE_AUTONOMY_PATTERNS: Array<{ re: RegExp; description: string }> = [
  // Auto-deploy/auto-approve without confirmation
  { re: /auto[_-]?deploy\s*[:=]\s*true/i, description: "auto-deploy enabled — code deploys without human confirmation gate" },
  { re: /auto[_-]?approve\s*[:=]\s*true/i, description: "auto-approve enabled — agent approves its own output" },
  { re: /auto[_-]?merge\s*[:=]\s*true/i, description: "auto-merge enabled — PRs merge without human review" },
  { re: /skip[_-]?(?:review|approval|confirm|gate)\s*[:=]\s*true/i, description: "review/approval gate skipped in source code" },
  // Cron/scheduled execution without human initiation
  { re: /(?:cron|schedule)\s*[:=]\s*['"](?:\*|0|@)/i, description: "scheduled execution — agent runs without human initiation" },
  // Force/unattended operations
  { re: /(?:force|confirm!?)\s*[=:]\s*true/i, description: "force mode — operations proceed without confirmation dialogs" },
  // No-human-in-the-loop patterns
  { re: /no[_-]?human[_-]?in[_-]?loop/i, description: "no-human-in-the-loop — agent operates without any human oversight" },
  // Autonomous agent patterns
  { re: /(?:autonomous|unattended|headless)\s*[:=]\s*true/i, description: "autonomous mode — agent runs without human-in-the-loop" },
  // Continuous agent loops
  { re: /while\s*\(\s*true\s*\)/i, description: "infinite agent loop — runs perpetually without termination gate" },
  // Agent self-modification code
  { re: /(?:write|update|modify|patch|edit)File\s*\([^)]*(?:config|settings|rules|policy)/i, description: "agent writes to governance/config files — self-modification capability" },
];

// ---------------------------------------------------------------------------
// Category 3: Dangerous sinks from LLM output
// ---------------------------------------------------------------------------

const DANGEROUS_SINK_PATTERNS: Array<{ re: RegExp; sink: string }> = [
  // eval with dynamic content
  { re: /\beval\s*\(/i, sink: "eval" },
  // Function constructor
  { re: /\bnew\s+Function\s*\(/i, sink: "Function constructor" },
  // child_process.exec/execSync with variable input
  { re: /(?:child_process\.)?exec(?:Sync)?\s*\(\s*(?!['"`]\/)/i, sink: "child_process.exec" },
  // child_process.spawn without path restriction
  { re: /(?:child_process\.)?spawn(?:Sync)?\s*\(\s*(?:`|\$\{)/i, sink: "child_process.spawn" },
  // vm module
  { re: /vm\.(?:runIn(?:New)?Context|runInThisContext|compileFunction)\s*\(/i, sink: "vm module" },
  // fs.writeFile with variable path
  { re: /fs\.(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\(\s*(?!['"`](?:\.|\/tmp|\/var|os\.tmpdir))/i, sink: "fs.writeFile" },
  // Dynamic import with variable
  { re: /import\s*\(\s*(?!['"][a-z@])/i, sink: "dynamic import" },
  // Process execution from agent context
  { re: /\.exec\s*\(\s*(?:`|\$\{|llm|agent|prompt|model|response|output|result|completion)/i, sink: "exec from agent output" },
];

// LLM output source patterns — taint sources
const LLM_OUTPUT_SOURCE_RE = /\b(?:llm|agent|model|prompt|completion|response|output|result|chat|message|reply|answer|generated)\w*\b/i;

// ---------------------------------------------------------------------------
// Detection: unrestricted-tool-parameter
// ---------------------------------------------------------------------------

function detectUnrestrictedToolParam(file: DiffFile): AgencyEscalationIssue[] {
  const issues: AgencyEscalationIssue[] = [];
  if (TEST_PATH_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Check if has validation guard on same line
    if (VALIDATION_GUARD_RE.some((re) => re.test(trimmed))) continue;

    for (const { re, sink } of UNRESTRICTED_PARAM_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "unrestricted-tool-parameter",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Unrestricted tool parameter in \`${file.path}:${change.line}\`: ${sink} parameter from untrusted input without allowlisting; OWASP LLM06:2025 Excessive Agency; Microsoft CVE-2026-25592: AI-controlled localFilePath reached dangerous sink without path validation — map to allowlist pattern: validate against an array of permitted values before use`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: excessive-autonomy
// ---------------------------------------------------------------------------

function detectExcessiveAutonomy(file: DiffFile): AgencyEscalationIssue[] {
  const issues: AgencyEscalationIssue[] = [];
  if (TEST_PATH_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    for (const { re, description } of EXCESSIVE_AUTONOMY_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "excessive-autonomy",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Excessive autonomy in \`${file.path}:${change.line}\`: ${description}; OWASP LLM06:2025 Excessive Agency defines excessive autonomy as "systems that can take actions without oversight"; Snyk ToxicSkills: 91% of malicious skills pair prompt injection with code execution; add human-in-the-loop confirmation for this operation`,
          severity: "warning",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: dangerous-sink-from-llm-output
// ---------------------------------------------------------------------------

function detectDangerousSinkFromLLM(file: DiffFile): AgencyEscalationIssue[] {
  const issues: AgencyEscalationIssue[] = [];
  if (TEST_PATH_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Check if has validation guard on same line
    if (VALIDATION_GUARD_RE.some((re) => re.test(trimmed))) continue;

    for (const { re, sink } of DANGEROUS_SINK_PATTERNS) {
      if (re.test(trimmed)) {
        // Check if LLM output source is present on this line or nearby
        const hasLLMSource = LLM_OUTPUT_SOURCE_RE.test(trimmed);
        const severity = hasLLMSource ? "critical" : "warning";

        issues.push({
          category: "dangerous-sink-from-llm-output",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Dangerous sink in \`${file.path}:${change.line}\`: ${sink}${hasLLMSource ? " with LLM-controlled input" : " — reachable from LLM output taint path"}; OWASP LLM06:2025 Excessive Agency; Microsoft CVE-2026-26030: AI-controlled parameters crossed container boundaries; add input validation, allowlisting, and sandboxing before ${sink}`,
          severity,
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: AgencyEscalationIssue[]): AgencyEscalationIssue[] {
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

function buildAgencyEscalationContext(result: AgencyEscalationResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Agency Escalation Detection (${result.issues.length})\n`;
  ctx += "This PR introduces excessive agency — AI agents gain capabilities without proper guardrails:\n\n";

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

function buildAgencyEscalationBodySummary(result: AgencyEscalationResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Agency Escalation Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*OWASP LLM06:2025 Excessive Agency — unrestricted tool parameters, excessive autonomy, dangerous sinks from LLM output. Microsoft CVE-2026-25592: AI-controlled parameters reach dangerous sinks without validation. Snyk ToxicSkills: 13.4% of agent skills contain critical security issues. Zero competitors detect agent capability escalation in source code.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run agency escalation detection on diff files. Zero LLM cost. */
export function detectAgencyEscalation(diffFiles: DiffFile[]): AgencyEscalationResult {
  const allIssues: AgencyEscalationIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectUnrestrictedToolParam(file));
    allIssues.push(...detectExcessiveAutonomy(file));
    allIssues.push(...detectDangerousSinkFromLLM(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: AgencyEscalationResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildAgencyEscalationContext(result);
  result.bodySummary = buildAgencyEscalationBodySummary(result);

  if (issues.length > 0) {
    core.info(`Agency escalation detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
