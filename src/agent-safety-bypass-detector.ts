/**
 * Agent Self-Referential Safety Bypass Detector — detect when a PR modifies
 * AI agent governance files in ways that weaken safety controls.
 *
 * Vectimus research documents CVE-2025-54135 (CurXecute) where README
 * injection caused Cursor to rewrite its MCP config to an attacker server.
 * Similar attacks: Claude Code settings hijack via code comments, rules-file
 * backdoors using invisible Unicode, IDEsaster via launch.json modifications.
 *
 * Core insight: AI agents treat governance files as ordinary code without
 * recognizing those files control their own safety. Once safety settings
 * are disabled, all subsequent actions proceed without restriction — the
 * changes are "silent and persistent."
 *
 * CSA 2026: privilege escalation +322% in enterprise repos. Microsoft RCE
 * research (May 2026): SessionsPythonPlugin attack crossed container
 * boundaries because host-side functions lacked validation that the
 * initiator was the AI agent itself.
 *
 * Patterns detected:
 * 1. governance-config-modification: PR modifies agent governance files
 *    (settings.json, hooks/, .claude/, MCP configs) AND source code
 * 2. safety-hook-disabling: Removes/comments/nullifies safety hooks,
 *    pre-commit hooks, branch protection, tool deny lists
 * 3. agent-permission-expansion: Adds MCP servers, broadens tool
 *    permissions, adds allowedTools scopes, auto-approve settings
 *
 * Zero LLM cost — pattern analysis on added/removed diff lines.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentSafetyBypassCategory =
  | "governance-config-modification"
  | "safety-hook-disabling"
  | "agent-permission-expansion";

export interface AgentSafetyBypassIssue {
  category: AgentSafetyBypassCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface AgentSafetyBypassResult {
  issues: AgentSafetyBypassIssue[];
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

function getRemovedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "delete");
}

function getAllChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes);
}

// ---------------------------------------------------------------------------
// Governance file definitions
// ---------------------------------------------------------------------------

// Paths that control AI agent behavior — modifying these is the self-referential pattern
const AGENT_GOVERNANCE_PATHS = [
  /(?:^|[\\/])\.claude[\\/](?:settings|instructions|config)/i,
  /(?:^|[\\/])\.cursor[\\/](?:rules|mcp)/i,
  /(?:^|[\\/])\.cursorrules/i,
  /(?:^|[\\/])\.continue[\\/]/i,
  /(?:^|[\\/])\.serena[\\/]/i,
  /(?:^|[\\/])\.specweave[\\/]/i,
  /(?:^|[\\/])\.openclaude[\\/]/i,
  /(?:^|[\\/])\.mcp\.json$/i,
  /(?:^|[\\/])mcp\.json$/i,
  /(?:^|[\\/])claude_desktop_config\.json$/i,
  /(?:^|[\\/])\.vscode[\\/]settings\.json$/i,
  /(?:^|[\\/])\.vscode[\\/]extensions\.json$/i,
  /(?:^|[\\/])\.vscode[\\/]launch\.json$/i,
  /(?:^|[\\/])\.github[\\/]workflows[\\/]/i,
  /(?:^|[\\/])\.pre-commit/i,
  /(?:^|[\\/])hooks[\\/]/i,
  /(?:^|[\\/])\.husky[\\/]/i,
  /(?:^|[\\/])CLAUDE\.md$/i,
  /(?:^|[\\/])AGENTS?\.md$/i,
  /(?:^|[\\/])copilot-instructions/i,
  /(?:^|[\\/])\.github[\\/]copilot/i,
];

// Source code paths — if a PR touches BOTH governance and source, it's self-referential
const SOURCE_CODE_RE = /\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|kt|cs|php|c|cpp|h|hpp|swift|dart|lua|pl|sh|rs|zig)$/i;

function isGovernanceFile(filePath: string): boolean {
  return AGENT_GOVERNANCE_PATHS.some((re) => re.test(filePath));
}

function isSourceCodeFile(filePath: string): boolean {
  return SOURCE_CODE_RE.test(filePath);
}

const SKIP_LINE_RE = /^[-+]\s*(?:[\/][\/]|\/\*|\*|import\s+type\s|export\s+type\s)/;

const TEST_PATH_RE = /(?:__tests__|\.test\.|\.spec\.|_test\.|_spec\.|tests?\/)/;

// ---------------------------------------------------------------------------
// Pattern: safety-hook-disabling
// ---------------------------------------------------------------------------

// Patterns where safety controls are removed or disabled
const SAFETY_HOOK_DISABLE_PATTERNS: Array<{ re: RegExp; description: string }> = [
  {
    re: /["']?autoApprove["']?\s*[:=]\s*true/i,
    description: "autoApprove enabled — agent can approve its own changes without human review",
  },
  {
    re: /["']?auto_approve["']?\s*[:=]\s*true/i,
    description: "auto_approve enabled — agent can approve its own changes without human review",
  },
  {
    re: /["']?auto[_-]?merge["']?\s*[:=]\s*true/i,
    description: "auto-merge enabled — changes merge without human review gate",
  },
  {
    re: /["']?skip[_-]?review["']?\s*[:=]\s*true/i,
    description: "skip_review enabled — bypasses PR review requirement",
  },
  {
    re: /"(?:tools|permissions)"\s*:\s*\{[^}]*"deny"\s*:\s*\[\s*\]/s,
    description: "empty tool deny list — no tools are restricted, agent has unrestricted capability",
  },
  {
    re: /["']?protected[_-]?branches?["']?\s*[:=]\s*\[\s*\]/i,
    description: "empty protected branches — no branch protection rules active",
  },
  {
    re: /["']?required[_-]?reviewers["']?\s*[:=]\s*0/i,
    description: "zero required reviewers — PRs can merge without review",
  },
  {
    re: /["']?required[_-]?status[_-]?checks["']?\s*[:=]\s*\[\s*\]/i,
    description: "empty required status checks — CI no longer gates merges",
  },
  {
    re: /["']?(?:enforce|strict|require)["']?\s*[:=]\s*false/i,
    description: "safety enforcement disabled — protection rule turned off",
  },
  {
    re: /["']?allow(?:ed|-)?[_-]?(?:all|any|every|unrestricted)["']?\s*[:=]\s*true/i,
    description: "unrestricted allow rule — grants unlimited access",
  },
  {
    re: /"deny"\s*:\s*\[\s*\]/i,
    description: "empty deny list — no restrictions on agent tool access",
  },
  {
    re: /["']?always_allow["']?\s*[:=]\s*true/i,
    description: "always_allow enabled — agent bypasses permission prompts",
  },
];

// Removed lines that look like safety hook removals
const SAFETY_HOOK_REMOVAL_PATTERNS: Array<{ re: RegExp; description: string }> = [
  {
    re: /pre-commit/i,
    description: "pre-commit hook removed — safety checks no longer run before commits",
  },
  {
    re: /(?:husky|lint-staged)/i,
    description: "git hook framework removed — automated safety checks no longer enforced",
  },
  {
    re: /protected[_-]?branches?/i,
    description: "branch protection removed — branches can be force-pushed or deleted",
  },
  {
    re: /required[_-]?review/i,
    description: "required review removed — PRs can merge without approval",
  },
  {
    re: /required[_-]?status/i,
    description: "required status check removed — CI no longer gates merges",
  },
  {
    re: /"(?:deny|block|forbidden|restricted)"/i,
    description: "tool restriction removed from agent configuration",
  },
];

// ---------------------------------------------------------------------------
// Pattern: agent-permission-expansion
// ---------------------------------------------------------------------------

// Patterns where agent permissions are expanded or new capabilities added
const PERMISSION_EXPANSION_PATTERNS: Array<{ re: RegExp; description: string }> = [
  {
    re: /["']?mcpServers?["']?\s*[:=]\s*\{/i,
    description: "new MCP server added — agent gains new external tool capability",
  },
  {
    re: /["']?allowedTools["']?\s*[:=]\s*\[/i,
    description: "allowedTools expanded — agent gains additional tool permissions",
  },
  {
    re: /["']?allow(?:ed|-)?Tools?["']?\s*[:=]\s*\[/i,
    description: "tool allow list — agent granted specific tool access",
  },
  {
    re: /["']?permissions["']?\s*[:=]\s*\{[^}]*(?:read|write|execute|admin|full_access|all)/i,
    description: "broad permission scope — agent granted wide-reaching access",
  },
  {
    re: /["']?command["']?\s*[:=]\s*['"](?!echo|print|cat|ls|pwd)[^'"]+/i,
    description: "agent command execution — agent can run arbitrary commands",
  },
  {
    re: /["']?allowedCommands["']?\s*[:=]\s*\[/i,
    description: "allowedCommands — agent granted command execution capability",
  },
  {
    re: /["']?files["']?\s*[:=]\s*['"]\//i,
    description: "root filesystem access — agent can access files at system root",
  },
  {
    re: /(?:read|write|access)\s*[:=]\s*['"]\/(?:etc|root|var|tmp|home)/i,
    description: "sensitive directory access — agent can access system directories",
  },
  {
    re: /--yes|--force|-y\b/i,
    description: "force/yes flag — auto-approve destructive operations without confirmation",
  },
  {
    re: /["']?unattended["']?\s*[:=]\s*true/i,
    description: "unattended mode — agent runs without human-in-the-loop",
  },
];

// ---------------------------------------------------------------------------
// Detection: governance-config-modification (self-referential PR)
// ---------------------------------------------------------------------------

function detectGovernanceConfigModification(diffFiles: DiffFile[]): AgentSafetyBypassIssue[] {
  const issues: AgentSafetyBypassIssue[] = [];
  const governanceFiles: string[] = [];
  const sourceFiles: string[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (TEST_PATH_RE.test(file.path)) continue;

    if (isGovernanceFile(file.path)) {
      governanceFiles.push(file.path);
    } else if (isSourceCodeFile(file.path)) {
      sourceFiles.push(file.path);
    }
  }

  // Self-referential: PR touches BOTH governance AND source code
  if (governanceFiles.length > 0 && sourceFiles.length > 0) {
    for (const gPath of governanceFiles) {
      // Find a representative line from the governance file
      const govFile = diffFiles.find((f) => f.path === gPath);
      if (!govFile) continue;
      const added = getAddedChanges(govFile);
      const representativeLine = added.length > 0 ? added[0] : getAllChanges(govFile)[0];
      if (!representativeLine) continue;

      issues.push({
        category: "governance-config-modification",
        file: gPath,
        line: representativeLine.line,
        code: stripPrefix(representativeLine.content),
        description: `Self-referential governance change in \`${gPath}\` — this PR modifies agent governance files AND source code (${sourceFiles.slice(0, 3).join(", ")}); Vectimus CVE-2025-54135: AI agents modify their own safety configuration within the same PR; changes are "silent and persistent" — once safety settings are disabled, all subsequent actions proceed without restriction; separate governance changes into a dedicated human-reviewed PR`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: safety-hook-disabling
// ---------------------------------------------------------------------------

function detectSafetyHookDisabling(file: DiffFile): AgentSafetyBypassIssue[] {
  const issues: AgentSafetyBypassIssue[] = [];
  if (!isGovernanceFile(file.path)) return issues;
  if (TEST_PATH_RE.test(file.path)) return issues;

  // Check added lines for safety hook disabling patterns
  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    for (const { re, description } of SAFETY_HOOK_DISABLE_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "safety-hook-disabling",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Safety hook disabled in \`${file.path}:${change.line}\`: ${description}; CSA 2026: privilege escalation +322% in AI-generated code; Microsoft CVE-2026-25592: AI-controlled parameters crossed container boundaries without validation; restore the safety control or document why it is intentionally disabled`,
          severity: "critical",
        });
        break;
      }
    }
  }

  // Check removed lines for safety hook removal patterns
  const removed = getRemovedChanges(file);
  for (const change of removed) {
    const trimmed = stripPrefix(change.content);

    for (const { re, description } of SAFETY_HOOK_REMOVAL_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "safety-hook-disabling",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Safety hook removed in \`${file.path}:${change.line}\`: ${description}; CSA 2026: "architectural design flaws rose 153%" in AI-iterated code; removing safety controls without replacement is a critical governance gap; add replacement controls or document the removal justification`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: agent-permission-expansion
// ---------------------------------------------------------------------------

function detectAgentPermissionExpansion(file: DiffFile): AgentSafetyBypassIssue[] {
  const issues: AgentSafetyBypassIssue[] = [];
  if (!isGovernanceFile(file.path)) return issues;
  if (TEST_PATH_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    for (const { re, description } of PERMISSION_EXPANSION_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "agent-permission-expansion",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Agent permission expanded in \`${file.path}:${change.line}\`: ${description}; OWASP LLM06:2025 Excessive Agency — AI agents with unchecked permissions can autonomously execute destructive operations; Snyk ToxicSkills: 13.4% of agent skills contain critical security issues; verify this permission expansion is intentional and scoped to minimum necessary capability`,
          severity: "warning",
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

function dedupIssues(issues: AgentSafetyBypassIssue[]): AgentSafetyBypassIssue[] {
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

function buildAgentSafetyBypassContext(result: AgentSafetyBypassResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Agent Self-Referential Safety Bypass Detection (${result.issues.length})\n`;
  ctx += "This PR modifies AI agent governance files — self-referential safety changes:\n\n";

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

function buildAgentSafetyBypassBodySummary(result: AgentSafetyBypassResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Agent Self-Referential Safety Bypass Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Agent self-referential safety bypass — Vectimus CVE-2025-54135: AI agents modify their own safety configuration. OWASP LLM06:2025 Excessive Agency. CSA 2026: privilege escalation +322%. Microsoft RCE: AI-controlled parameters cross trust boundaries without validation. Zero competitors detect agent governance self-modification.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run agent self-referential safety bypass detection. Zero LLM cost. */
export function detectAgentSafetyBypass(diffFiles: DiffFile[]): AgentSafetyBypassResult {
  const allIssues: AgentSafetyBypassIssue[] = [];

  // Category 1: governance-config-modification (cross-file analysis)
  allIssues.push(...detectGovernanceConfigModification(diffFiles));

  // Categories 2 & 3: per-file analysis
  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectSafetyHookDisabling(file));
    allIssues.push(...detectAgentPermissionExpansion(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: AgentSafetyBypassResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildAgentSafetyBypassContext(result);
  result.bodySummary = buildAgentSafetyBypassBodySummary(result);

  if (issues.length > 0) {
    core.info(`Agent safety bypass detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
