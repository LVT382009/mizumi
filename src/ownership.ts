/**
 * CODEOWNERS-aware review routing - competitive gap #7.
 *
 * No AI reviewer currently uses CODEOWNERS data to adjust review behavior.
 * This module:
 * 1. Parses CODEOWNERS files to map file paths to owning teams/users
 * 2. Tags findings with ownership context (`@team-frontend`)
 * 3. Boosts priority for findings in owned files (owning team cares most)
 * 4. Supports per-owner review profiles (e.g., security-strict for @sec-team)
 *
 * This is how human review works at Google (Bill): owners get pinged
 * for files they own. AI review should do the same.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";
import { ReviewCommentType } from "./review.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnershipRule {
  pattern: string;
  owners: string[];
  isNegative: boolean;
  regex: RegExp;
}

export interface OwnershipMatch {
  file: string;
  owners: string[];
}

export interface OwnershipConfig {
  /** Boost severity for findings in owned files (default: true) */
  boostOwned: boolean;
  /** Tag owners in review comments (default: true) */
  tagOwners: boolean;
  /** Minimum number of files an owner must own to get tagged (default: 1) */
  minFilesForTag: number;
  /** Ownership boost amount added to confidence (default: 10) */
  confidenceBoost: number;
}

export const DEFAULT_OWNERSHIP_CONFIG: OwnershipConfig = {
  boostOwned: true,
  tagOwners: true,
  minFilesForTag: 1,
  confidenceBoost: 10,
};

// ---------------------------------------------------------------------------
// CODEOWNERS parser
// ---------------------------------------------------------------------------

/**
 * Parse a CODEOWNERS file into ownership rules.
 * Handles: glob patterns, negation (!pattern), multiple owners per line,
 * comments (#), and default owners at the end.
 */
export function parseCodeowners(content: string): OwnershipRule[] {
  const rules: OwnershipRule[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const isNegative = trimmed.startsWith("!");
    const patternPart = isNegative ? trimmed.slice(1) : trimmed;

    // Split pattern from owners (owners come after the pattern)
    // Pattern is the first token; owners follow
    const tokens = patternPart.split(/\s+/);
    if (tokens.length === 0) continue;

    const rawPattern = tokens[0];
    const owners = tokens.slice(1).filter((t) => t.startsWith("@") || t.includes("/") || !t.includes(" "));

    // Convert glob to regex
    const regex = globToRegex(rawPattern);

    rules.push({
      pattern: rawPattern,
      owners,
      isNegative,
      regex,
    });
  }

  return rules;
}

/**
 * Convert a CODEOWNERS glob pattern to a RegExp.
 * Supports: *, **, ?, character classes [...], and negation [!...]
 */
export function globToRegex(pattern: string): RegExp {
  let regex = pattern
    // Escape regex special chars (except * ? [ ])
    .replace(/[.+^${}()|\\]/g, "\\$&")
    // Use placeholders for ** variants to prevent later * ? replacements clobbering them
    .replace(/\*\*\//g, "\x00DS\x00")
    .replace(/\*\*/g, "\x00D\x00")
    // * matches anything except /
    .replace(/\*/g, "[^/]*")
    // ? matches single char except /
    .replace(/\?/g, "[^/]")
    // [!...] is negation class
    .replace(/\[!/g, "[^")
    // Now replace placeholders with actual regex fragments
    .replace(/\x00DS\x00/g, "(?:.+/)?")
    .replace(/\x00D\x00/g, ".*");

  // Ensure pattern matches from start
  if (!regex.startsWith("^")) regex = "^" + regex;
  // Directory patterns ending in / match that dir + anything inside it
  if (regex.endsWith("/")) {
    regex += ".*";
  } else if (!regex.endsWith("$") && !regex.endsWith(".*")) {
    // File patterns: match the exact file OR the path as a directory prefix
    regex += "(?:$|/.*)";
  }

  return new RegExp(regex);
}

/**
 * Find the owners for a given file path based on CODEOWNERS rules.
 * CODEOWNERS uses last-match-wins semantics (last matching rule wins).
 */
export function findOwners(filePath: string, rules: OwnershipRule[]): string[] {
  let owners: string[] = [];

  for (const rule of rules) {
    if (rule.isNegative) {
      // Negation: if this file matches, clear the owners
      if (rule.regex.test(filePath)) {
        owners = [];
      }
    } else {
      if (rule.regex.test(filePath)) {
        owners = rule.owners;
      }
    }
  }

  return owners;
}

/**
 * Match all diff files against CODEOWNERS rules.
 */
export function matchOwnership(
  diffFiles: DiffFile[],
  rules: OwnershipRule[],
): OwnershipMatch[] {
  return diffFiles.map((f) => ({
    file: f.path,
    owners: findOwners(f.path, rules),
  }));
}

// ---------------------------------------------------------------------------
// Review enhancement
// ---------------------------------------------------------------------------

/**
 * Apply ownership context to review findings:
 * 1. Tag findings with owning teams
 * 2. Boost confidence for findings in owned files
 */
export function applyOwnershipToFindings(
  findings: ReviewCommentType[],
  ownership: OwnershipMatch[],
  config: OwnershipConfig = DEFAULT_OWNERSHIP_CONFIG,
): ReviewCommentType[] {
  const ownershipMap = new Map(ownership.map((o) => [o.file, o.owners]));

  return findings.map((finding) => {
    const owners = ownershipMap.get(finding.file) || [];
    let enhanced = { ...finding };

    // Tag owners in message
    if (config.tagOwners && owners.length > 0) {
      const ownerTags = owners.map((o) => o.startsWith("@") ? o : `@${o}`).join(" ");
      if (!enhanced.message.includes(ownerTags)) {
        enhanced.message = `${ownerTags} - ${enhanced.message}`;
      }
    }

    // Boost confidence for findings in owned files
    if (config.boostOwned && owners.length > 0) {
      enhanced.confidence = Math.min(100, enhanced.confidence + config.confidenceBoost);
    }

    return enhanced;
  });
}

/**
 * Build a summary of ownership coverage for the review body.
 * Shows which teams are affected by the diff.
 */
export function buildOwnershipSummary(ownership: OwnershipMatch[]): string {
  const teamFiles = new Map<string, string[]>();

  for (const match of ownership) {
    for (const owner of match.owners) {
      const key = owner.startsWith("@") ? owner : `@${owner}`;
      if (!teamFiles.has(key)) teamFiles.set(key, []);
      teamFiles.get(key)!.push(match.file);
    }
  }

  if (teamFiles.size === 0) return "";

  const sorted = [...teamFiles.entries()].sort((a, b) => b[1].length - a[1].length);

  let body = "| Team | Files | Coverage |\n|------|-------|----------|\n";
  for (const [team, files] of sorted) {
    body += `| ${team} | ${files.length} | \`${files.slice(0, 3).join("`, `\`")}\`${files.length > 3 ? ` +${files.length - 3} more` : ""} |\n`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// CODEOWNERS file loading
// ---------------------------------------------------------------------------

const CODEOWNERS_PATHS = [
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/CODEOWNERS",
];

/**
 * Load CODEOWNERS file from the workspace.
 * Tries standard locations in order (GitHub convention).
 */
export function loadCodeowners(workspace: string): OwnershipRule[] {
  for (const relPath of CODEOWNERS_PATHS) {
    const fullPath = path.join(workspace, relPath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        core.info(`Loaded CODEOWNERS from ${relPath} (${content.split("\n").length} lines)`);
        return parseCodeowners(content);
      } catch (e) {
        core.warning(`Failed to read CODEOWNERS at ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return [];
}
