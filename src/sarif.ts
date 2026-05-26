/**
 * SARIF 2.1.0 Export — GitHub Code Scanning Integration.
 *
 * Converts Mizumi review findings to SARIF format so they appear in the
 * GitHub "Security > Code scanning alerts" tab alongside CodeQL results.
 *
 * No AI code reviewer integrates with Code Scanning today.
 * CodeRabbit, CodeGuru, Sourcery, Copilot — none produce SARIF.
 * This gives Mizumi findings native visibility in GitHub's security UI
 * with filtering, tracking, and dismissal workflows.
 *
 * Implementation:
 * 1. Convert ReviewCommentType[] → SARIF result[] with rule metadata
 * 2. Fingerprint each finding for stable alert tracking across runs
 * 3. Map Mizumi severity → SARIF level (error/warning/note/none)
 * 4. Map Mizumi category → SARIF rule with help URIs
 * 5. Output valid SARIF 2.1.0 JSON for upload via code-scanning/alerts API
 *
 * Zero LLM cost — pure data transformation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types (SARIF 2.1.0 subset)
// ---------------------------------------------------------------------------

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

export interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  invocations: SarifInvocation[];
}

export interface SarifTool {
  driver: SarifDriver;
}

export interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  defaultConfiguration: { level: string };
  properties: { tags: string[] };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
  fingerprints: { primaryLocationLineHash: string };
  properties: { confidence: number; severity: string };
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: "%SRCROOT%" };
    region: { startLine: number; endLine?: number };
  };
}

export interface SarifInvocation {
  executionSuccessful: boolean;
  startTimeUtc: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIZUMI_VERSION = "0.1.0";
const MIZUMI_INFO_URI = "https://github.com/LVT382009/mizumi";

const SEVERITY_TO_LEVEL: Record<string, string> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  nitpick: "none",
};

const CATEGORY_HELP: Record<string, string> = {
  bug: "Potential bug or logic error detected by Mizumi AI review",
  security: "Security vulnerability detected by Mizumi AI review",
  performance: "Performance issue detected by Mizumi AI review",
  style: "Code style issue detected by Mizumi AI review",
  architecture: "Architecture concern detected by Mizumi AI review",
  compliance: "Compliance issue detected by Mizumi AI review",
};

const CATEGORY_RULE_PREFIX: Record<string, string> = {
  bug: "MIZ",
  security: "MIZ-SEC",
  performance: "MIZ-PERF",
  style: "MIZ-STYLE",
  architecture: "MIZ-ARCH",
  compliance: "MIZ-COMP",
};

// ---------------------------------------------------------------------------
// Fingerprinting (stable across runs for alert tracking)
// ---------------------------------------------------------------------------

function fingerprintFinding(finding: ReviewCommentType): string {
  // Stable fingerprint: category + file + line + message prefix
  const raw = `${finding.category}:${finding.file}:${finding.line}:${finding.message.substring(0, 80)}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Map Mizumi severity to SARIF level. */
export function severityToLevel(severity: string): string {
  return SEVERITY_TO_LEVEL[severity] || "warning";
}

/** Build a SARIF rule ID from category + index. */
export function buildRuleId(category: string, index: number): string {
  const prefix = CATEGORY_RULE_PREFIX[category] || "MIZ";
  return `${prefix}/${index + 1}`;
}

/** Build the SARIF rules list from unique categories in findings. */
export function buildRules(findings: ReviewCommentType[]): SarifRule[] {
  const seen = new Map<string, number>();
  const rules: SarifRule[] = [];

  for (const f of findings) {
    if (seen.has(f.category)) continue;
    seen.set(f.category, rules.length);

    const id = buildRuleId(f.category, seen.get(f.category)!);
    const helpText = CATEGORY_HELP[f.category] || `Issue detected by Mizumi AI review (${f.category})`;
    const level = severityToLevel(f.severity);

    rules.push({
      id,
      name: `mizumi-${f.category}`,
      shortDescription: { text: helpText },
      fullDescription: { text: helpText },
      helpUri: `${MIZUMI_INFO_URI}#${f.category}`,
      defaultConfiguration: { level },
      properties: { tags: [f.category, "ai-review", "mizumi"] },
    });
  }

  return rules;
}

/** Convert Mizumi findings to a complete SARIF log. */
export function generateSARIF(findings: ReviewCommentType[], repoUrl?: string): SarifLog {
  const rules = buildRules(findings);
  const categoryIndex = new Map<string, number>();
  for (let i = 0; i < rules.length; i++) {
    categoryIndex.set(rules[i].name.replace("mizumi-", ""), i);
  }

  const results: SarifResult[] = findings.map((f) => {
    const ruleIdx = categoryIndex.get(f.category) ?? 0;
    const rule = rules[ruleIdx];
    const level = severityToLevel(f.severity);
    const fingerprint = fingerprintFinding(f);

    const location: SarifLocation = {
      physicalLocation: {
        artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
        region: { startLine: f.line },
      },
    };
    if (f.endLine && f.endLine > f.line) {
      location.physicalLocation.region.endLine = f.endLine;
    }

    return {
      ruleId: rule.id,
      ruleIndex: ruleIdx,
      level,
      message: { text: f.message },
      locations: [location],
      fingerprints: { primaryLocationLineHash: fingerprint },
      properties: {
        confidence: f.confidence,
        severity: f.severity,
      },
    };
  });

  const run: SarifRun = {
    tool: {
      driver: {
        name: "Mizumi",
        version: MIZUMI_VERSION,
        informationUri: repoUrl || MIZUMI_INFO_URI,
        rules,
      },
    },
    results,
    invocations: [{
      executionSuccessful: true,
      startTimeUtc: new Date().toISOString(),
    }],
  };

  return {
    $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [run],
  };
}

/** Write SARIF output to a file. */
export function writeSARIF(workspace: string, sarif: SarifLog): string {
  const outDir = path.join(workspace, ".github");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "mizumi-results.sarif");
  fs.writeFileSync(outPath, JSON.stringify(sarif, null, 2), "utf-8");
  return outPath;
}

/** Upload SARIF to GitHub Code Scanning API. */
export async function uploadSARIF(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any,
  owner: string,
  repo: string,
  headSha: string,
  sarifPath: string,
): Promise<string | null> {
  if (!fs.existsSync(sarifPath)) return null;

  const sarifContent = fs.readFileSync(sarifPath, "utf-8");
  const encoded = Buffer.from(sarifContent, "utf-8").toString("base64");

  try {
    const result = await octokit.rest.codeScanning.uploadSarif({
      owner,
      repo,
      commit_sha: headSha,
      sarif: encoded,
      ref: `refs/heads/${headSha.substring(0, 7)}`,
    });
    return result.data?.id ?? "uploaded";
  } catch {
    // SARIF upload may fail if code scanning is not enabled on the repo
    // or the token lacks security_events scope. Non-fatal.
    return null;
  }
}
