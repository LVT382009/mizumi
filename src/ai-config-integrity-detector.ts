/**
 * AI Configuration Integrity Detector — scan AI rule/config files for
 * hidden Unicode control characters and malicious server redirects.
 *
 * CSA ShadowPrompt documents real attacks using zero-width characters
 * (U+200B-200F), bidi overrides (U+202A-202E) embedded in AI configuration
 * files that invisibly alter agent behavior. CSA slopsquatting documents
 * malicious MCP server redirects that exfiltrate data.
 *
 * Zero competitors scan AI rule/config files — entire attack surface
 * is invisible to every existing code review tool.
 *
 * Patterns detected:
 * 1. hidden-unicode-control: Zero-width, bidi, format chars in config files
 * 2. malicious-mcp-redirect: Suspicious MCP server URLs in config files
 *
 * Zero LLM cost — byte-level analysis on config file diffs.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AIConfigCategory =
  | "hidden-unicode-control"
  | "malicious-mcp-redirect";

export interface AIConfigIssue {
  category: AIConfigCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface AIConfigResult {
  issues: AIConfigIssue[];
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

// AI configuration file paths
const AI_CONFIG_PATH_RE = /(?:\.cursorrules|copilot-instructions|CLAUDE\.md|\.claude\/|\.github\/copilot|mcp\.json|\.mcp\.json|claude_desktop_config|\.cursor\/|\.continue\/|\.specweave\/|\.serena\/|\.openclaude\/|AGENT\.md|\.agent\/)/i;

// ---------------------------------------------------------------------------
// Unicode control character definitions
// ---------------------------------------------------------------------------

const UNICODE_CONTROL_CHARS: Array<{ code: number; name: string; severity: "critical" | "warning" }> = [
  // Zero-width characters — invisible text that can hide instructions
  { code: 0x200B, name: "ZERO-WIDTH SPACE", severity: "critical" },
  { code: 0x200C, name: "ZERO-WIDTH NON-JOINER", severity: "warning" },
  { code: 0x200D, name: "ZERO-WIDTH JOINER", severity: "warning" },
  { code: 0x200E, name: "LEFT-TO-RIGHT MARK", severity: "warning" },
  { code: 0x200F, name: "RIGHT-TO-LEFT MARK", severity: "critical" },
  // Bidi overrides — can reverse text direction to hide commands
  { code: 0x202A, name: "LEFT-TO-RIGHT EMBEDDING", severity: "critical" },
  { code: 0x202B, name: "RIGHT-TO-LEFT EMBEDDING", severity: "critical" },
  { code: 0x202C, name: "POP DIRECTIONAL FORMATTING", severity: "warning" },
  { code: 0x202D, name: "LEFT-TO-RIGHT OVERRIDE", severity: "critical" },
  { code: 0x202E, name: "RIGHT-TO-LEFT OVERRIDE", severity: "critical" },
  // Format characters
  { code: 0x2060, name: "WORD JOINER", severity: "warning" },
  { code: 0x2066, name: "LEFT-TO-RIGHT ISOLATE", severity: "warning" },
  { code: 0x2067, name: "RIGHT-TO-LEFT ISOLATE", severity: "warning" },
  { code: 0x2068, name: "FIRST STRONG ISOLATE", severity: "warning" },
  { code: 0x2069, name: "POP DIRECTIONAL ISOLATE", severity: "warning" },
  { code: 0xFEFF, name: "BYTE ORDER MARK", severity: "warning" },
  // Soft hyphen — can split words to evade filters
  { code: 0x00AD, name: "SOFT HYPHEN", severity: "warning" },
];

const CONTROL_CHAR_MAP = new Map(UNICODE_CONTROL_CHARS.map((c) => [c.code, c]));

// ---------------------------------------------------------------------------
// Malicious MCP server patterns
// ---------------------------------------------------------------------------

const SUSPICIOUS_MCP_URL_PATTERNS = [
  // Non-standard TLDs commonly used in phishing
  /\bhttps?:\/\/[a-z0-9-]+\.(?:xyz|top|click|buzz|loan|work|party|review|trade|date|loan|racing|win|accountant)\b/i,
  // IP addresses instead of domain names
  /\bhttps?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i,
  // Data exfiltration patterns
  /\b(?:exfil|steal|capture|harvest|collect|dump|send(?:All|Data|Keys|Secrets|Tokens))\b/i,
  // URL shortener domains (can redirect anywhere)
  /\bhttps?:\/\/(?:bit\.ly|t\.co|tinyurl|rb\.gy|shorturl|is\.gd|v\.gd|ow\.ly|buff\.ly)\b/i,
  // ngrok/logmein tunnels (temporary, unverified endpoints)
  /\bhttps?:\/\/[a-z0-9-]+\.(?:ngrok|ngrok-free|logmein|hamachi)\.(?:io|com|app)\b/i,
  // localhost/loopback in production configs (dev artifacts)
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i,
];

// Known safe MCP server domains — NOT flagged
const KNOWN_SAFE_MCP_DOMAINS = [
  /modelcontextprotocol\.org/i,
  /github\.com/i,
  /npmjs\.com/i,
  /pypi\.org/i,
  /files\.pythonhosted\.org/i,
  /registry\.npmjs\.org/i,
];

// ---------------------------------------------------------------------------
// Detection: hidden-unicode-control
// ---------------------------------------------------------------------------

function detectHiddenUnicodeControl(file: DiffFile): AIConfigIssue[] {
  const issues: AIConfigIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    // Scan raw content after diff prefix — trim() removes U+FEFF (BOM)
    // Only strip the leading +/- diff prefix — NOT trailing whitespace
    // (trim would remove U+FEFF BOM which we need to detect)
    const raw = change.content.replace(/^[-+]/, "");

    for (let i = 0; i < raw.length; i++) {
      const code = raw.codePointAt(i);
      if (code === undefined) continue;

      const charInfo = CONTROL_CHAR_MAP.get(code);
      if (charInfo) {
        const hexCode = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
        issues.push({
          category: "hidden-unicode-control",
          file: file.path,
          line: change.line,
          code: `${hexCode} (${charInfo.name})`,
          description: `Hidden Unicode control character in \`${file.path}:${change.line}\`: ${hexCode} ${charInfo.name} — CSA ShadowPrompt: zero-width and bidi override characters embedded in AI config files can invisibly alter agent behavior; attacker hides instructions that override visible rules; remove this character and audit the full file for other hidden content`,
          severity: charInfo.severity,
        });
        break; // one finding per line is enough
      }

      // Skip surrogate pair second code unit
      if (code > 0xFFFF) i++;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: malicious-mcp-redirect
// ---------------------------------------------------------------------------

function detectMaliciousMCPRedirect(file: DiffFile): AIConfigIssue[] {
  const issues: AIConfigIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Check if line contains MCP server URL
    const urlMatch = /\b(https?:\/\/[^\s"'`,;)\]]+)/i.exec(trimmed);
    if (!urlMatch) continue;

    const url = urlMatch[1];

    // Skip known safe domains
    if (KNOWN_SAFE_MCP_DOMAINS.some((re) => re.test(url))) continue;

    for (const re of SUSPICIOUS_MCP_URL_PATTERNS) {
      if (re.test(url)) {
        issues.push({
          category: "malicious-mcp-redirect",
          file: file.path,
          line: change.line,
          code: url.length > 60 ? url.slice(0, 50) + "..." : url,
          description: `Suspicious MCP server URL in \`${file.path}:${change.line}\`: ${url.length > 60 ? url.slice(0, 50) + "..." : url} — CSA slopsquatting: malicious MCP server redirects can exfiltrate data; verify this URL is intentional and points to a trusted endpoint; compare against known-safe MCP server registry`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

const SKIP_LINE_RE = /^[-+]\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: AIConfigIssue[]): AIConfigIssue[] {
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

function buildAIConfigContext(result: AIConfigResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## AI Configuration Integrity Detection (${result.issues.length})\n`;
  ctx += "This PR modifies AI configuration files with potentially dangerous content:\n\n";

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

function buildAIConfigBodySummary(result: AIConfigResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>AI Configuration Integrity Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*AI configuration integrity — CSA ShadowPrompt: hidden Unicode control characters (zero-width, bidi overrides) invisibly alter agent behavior. CSA slopsquatting: malicious MCP server redirects exfiltrate data. Zero competitors scan AI config files — this attack surface is invisible to all existing code review tools.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run AI configuration integrity detection on diff files. Zero LLM cost. */
export function detectAIConfigIntegrity(diffFiles: DiffFile[]): AIConfigResult {
  const allIssues: AIConfigIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    // Only scan AI config files
    if (!AI_CONFIG_PATH_RE.test(file.path)) continue;

    allIssues.push(...detectHiddenUnicodeControl(file));
    allIssues.push(...detectMaliciousMCPRedirect(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: AIConfigResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildAIConfigContext(result);
  result.bodySummary = buildAIConfigBodySummary(result);

  if (issues.length > 0) {
    core.info(`AI config integrity detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
