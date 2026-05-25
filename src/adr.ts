/**
 * ADR (Architecture Decision Record) Enforcement — competitive gap, blue ocean.
 *
 * No AI code reviewer currently enforces ADRs. This module:
 * 1. Auto-discovers ADR files from docs/adr/ or .github/adr/
 * 2. Parses structured ADR format (Status/Context/Decision/Consequences)
 * 3. Generates review context from ADR decisions
 * 4. Creates deterministic rules for common ADR patterns
 *
 * When ADRs live in docs but nothing checks PRs against them, architecture erodes.
 * This bridges the gap — the LLM reviews code against documented architecture decisions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";
import { minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ADRRecord {
  /** ADR number (e.g. "0001" from ADR-0001.md) */
  number: string;
  /** Title of the decision */
  title: string;
  /** Status: proposed | accepted | deprecated | superseded */
  status: string;
  /** Context: why this decision was needed */
  context: string;
  /** Decision: what was decided */
  decision: string;
  /** Consequences: what happens as a result */
  consequences: string;
  /** File globs that this ADR applies to (inferred from context/decision) */
  appliesTo: string[];
  /** Full file path */
  filePath: string;
}

export interface ADRViolation {
  file: string;
  line: number;
  severity: "high" | "medium";
  category: "architecture";
  message: string;
  rule: string;
}

// ---------------------------------------------------------------------------
// ADR discovery
// ---------------------------------------------------------------------------

const ADR_DIRS = ["docs/adr", ".github/adr", "ADR", "adr"];
const ADR_PATTERN = /^ADR-?(\d+)|^(\d+)[-\s]/;

/**
 * Discover ADR files from standard directories.
 * Returns parsed ADR records sorted by number.
 */
export function discoverADRs(workspace: string): ADRRecord[] {
  const adrs: ADRRecord[] = [];

  for (const dir of ADR_DIRS) {
    const fullDir = path.join(workspace, dir);
    if (!fs.existsSync(fullDir)) continue;

    try {
      const files = fs.readdirSync(fullDir)
        .filter((f) => f.endsWith(".md") || f.endsWith(".MD"))
        .sort();

      for (const file of files) {
        const filePath = path.join(fullDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const adr = parseADR(content, file, filePath);
          if (adr) adrs.push(adr);
        } catch {
          core.warning(`Failed to read ADR: ${file}`);
        }
      }
    } catch {
      // Directory not readable
    }
  }

  return adrs;
}

/**
 * Parse an ADR markdown file into a structured record.
 * Supports multiple ADR formats:
 * - Nygard format (title, Context, Decision, Status)
 * - Michael Nygard YAML-frontmatter style
 * - Simple markdown headers
 */
export function parseADR(
  content: string,
  filename: string,
  filePath: string,
): ADRRecord | null {
  // Extract ADR number from filename
  const numMatch = filename.match(ADR_PATTERN);
  const number = numMatch ? (numMatch[1] || numMatch[2]) : "0";

  // Extract title from first heading or filename
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/i, "");

  // Extract sections by header
  const status = extractSection(content, "status") || "accepted";
  const context = extractSection(content, "context") || "";
  const decision = extractSection(content, "decision") || "";
  const consequences = extractSection(content, "consequences") || "";

  // Skip superseded/deprecated ADRs
  if (status.toLowerCase() === "superseded" || status.toLowerCase() === "deprecated") {
    return null;
  }

  // Infer file globs from decision/context content
  const appliesTo = inferAppliesTo(context + " " + decision);

  return { number, title, status, context, decision, consequences, appliesTo, filePath };
}

/**
 * Extract a section from ADR markdown content.
 * Looks for ## Section Name or # Section Name headers.
 */
export function extractSection(content: string, sectionName: string): string {
  const re = new RegExp(`^##?\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=^##?\\s+\\w|$(?!\\n))`, "mi");
  const match = content.match(re);
  if (!match) return "";
  return match[1].trim();
}

/**
 * Infer which file patterns an ADR applies to from its text.
 * Looks for mentions of directories, technologies, and patterns.
 */
export function inferAppliesTo(text: string): string[] {
  const patterns: string[] = [];
  const lower = text.toLowerCase();

  // Common directory patterns
  const dirPatterns: Record<string, string> = {
    "api": "src/api/**",
    "route": "src/routes/**",
    "handler": "src/handlers/**",
    "controller": "src/controllers/**",
    "service": "src/services/**",
    "db": "src/db/**",
    "database": "src/db/**",
    "sql": "src/db/**",
    "auth": "src/auth/**",
    "security": "src/auth/**",
    "crypto": "src/crypto/**",
    "frontend": "src/frontend/**",
    "ui": "src/ui/**",
    "component": "src/components/**",
    "test": "test/**",
    "model": "src/models/**",
    "schema": "src/models/**",
    "config": "src/config/**",
    "middleware": "src/middleware/**",
  };

  for (const [keyword, pattern] of Object.entries(dirPatterns)) {
    if (lower.includes(keyword)) {
      patterns.push(pattern);
    }
  }

  // Detect technology-specific files
  if (lower.includes("docker") || lower.includes("container")) patterns.push("Dockerfile*");
  if (lower.includes("kubernetes") || lower.includes("k8s")) patterns.push("k8s/**");
  if (lower.includes("terraform") || lower.includes("infra")) patterns.push("*.tf");
  if (lower.includes("graphql")) patterns.push("**/*.graphql");
  if (lower.includes("rest") || lower.includes("endpoint")) patterns.push("src/api/**");

  return [...new Set(patterns)];
}

// ---------------------------------------------------------------------------
// ADR-based rule checking
// ---------------------------------------------------------------------------

/**
 * Check diff files against ADR decisions.
 * Generates violations when code contradicts documented decisions.
 */
export function checkADRViolations(
  files: DiffFile[],
  adrs: ADRRecord[],
): ADRViolation[] {
  if (adrs.length === 0) return [];

  const violations: ADRViolation[] = [];
  const acceptedADRs = adrs.filter((a) => a.status.toLowerCase() === "accepted");

  for (const adr of acceptedADRs) {
    const applicableFiles = files.filter((f) =>
      adr.appliesTo.some((pattern) => minimatch(f.path, pattern))
    );

    if (applicableFiles.length === 0) continue;

    // Check for common ADR violation patterns in the diff
    for (const file of applicableFiles) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type !== "add") continue;
          const line = change.content;

          const violation = checkLineAgainstADR(line, change.line, file.path, adr);
          if (violation) violations.push(violation);
        }
      }
    }
  }

  return violations;
}

/**
 * Check a single line against an ADR's decision.
 */
function checkLineAgainstADR(
  line: string,
  lineNum: number,
  filePath: string,
  adr: ADRRecord,
): ADRViolation | null {
  const lower = line.toLowerCase();
  const decisionLower = adr.decision.toLowerCase();

  // Pattern: ADR says "use X" but code uses alternative Y
  // Check for explicitly forbidden patterns
  const forbiddenPatterns = extractForbiddenPatterns(decisionLower);
  for (const pattern of forbiddenPatterns) {
    if (lower.includes(pattern)) {
      return {
        file: filePath,
        line: lineNum,
        severity: "high",
        category: "architecture",
        message: `ADR-${adr.number}: ${adr.title} — This code appears to use "${pattern}" which violates the architecture decision.`,
        rule: `ADR-${adr.number}`,
      };
    }
  }

  return null;
}

/**
 * Extract forbidden patterns from ADR decision text.
 * Looks for patterns like "do not use X", "avoid X", "never use X"
 */
export function extractForbiddenPatterns(decision: string): string[] {
  const patterns: string[] = [];
  const re = /(?:do not use|avoid|never use|must not use|should not use|don't use)\s+([^\s,.:;]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(decision)) !== null) {
    patterns.push(match[1].toLowerCase());
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// ADR review context generation
// ---------------------------------------------------------------------------

/**
 * Build review context from ADR records.
 * Produces a prompt section that tells the LLM which ADRs apply
 * so it can flag violations during review.
 */
export function buildADRContext(adrs: ADRRecord[]): string {
  if (adrs.length === 0) return "";

  const accepted = adrs.filter((a) => a.status.toLowerCase() === "accepted");
  if (accepted.length === 0) return "";

  let context = `## Architecture Decision Records (${accepted.length} active)\n`;
  context += "The following architecture decisions are in effect. Flag any code that violates these decisions.\n\n";

  for (const adr of accepted.slice(0, 10)) {
    context += `### ADR-${adr.number}: ${adr.title}\n`;
    if (adr.decision) {
      context += `**Decision:** ${adr.decision.slice(0, 300)}\n`;
    }
    if (adr.appliesTo.length > 0) {
      context += `**Applies to:** ${adr.appliesTo.join(", ")}\n`;
    }
    context += "\n";
  }

  if (accepted.length > 10) {
    context += `... and ${accepted.length - 10} more ADRs.\n`;
  }

  return context;
}
