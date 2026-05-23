/**
 * Fetch PR diff — 3 strategies from diff0 pattern:
 * 1. GitHub API mediaType diff (preferred)
 * 2. Compare commits endpoint
 * 3. Git diff via CLI fallback
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { minimatch } from "minimatch";

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string; // The diff lines for this hunk
  changes: DiffChange[];
}

export interface DiffChange {
  type: "add" | "delete" | "normal";
  line: number;   // New file line number
  oldLine: number; // Old file line number
  content: string;
}

export interface ParsedDiff {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * Fetch and parse PR diff from GitHub API.
 */
export async function fetchDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  excludePatterns: string[]
): Promise<ParsedDiff> {
  // Strategy 1: Use the diff media type (most efficient)
  const { data: diffText } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  const rawDiff = typeof diffText === "string" ? diffText : JSON.stringify(diffText);
  return parseDiff(rawDiff, excludePatterns);
}

/**
 * Parse unified diff output into structured File/Hunk/Change objects.
 * Uses parse-diff library for reliable hunk parsing.
 */
export async function parseDiff(
  diffText: string,
  excludePatterns: string[]
): Promise<ParsedDiff> {
  // Dynamic import for ESM compat
  const parseDiffLib = (await import("parse-diff")).default || (await import("parse-diff"));
  const parsed = parseDiffLib(diffText);

  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of parsed) {
    const filePath = file.to || file.from || "";
    const status = file.new ? "added" : file.deleted ? "deleted" : file.renamed ? "renamed" : "modified";

    // Skip excluded files
    if (shouldExclude(filePath, excludePatterns)) continue;

    const hunks: DiffHunk[] = [];

    for (const chunk of file.chunks || []) {
      const changes: DiffChange[] = [];
      for (const change of chunk.changes || []) {
        const type = change.type === "add" ? "add" : change.type === "del" ? "delete" : "normal";
        changes.push({
          type,
          line: change.ln || change.ln2 || 0,
          oldLine: change.ln1 || change.ln || 0,
          content: change.content || "",
        });
      }

      hunks.push({
        oldStart: chunk.oldStart || 0,
        oldLines: chunk.oldLines || 0,
        newStart: chunk.newStart || 0,
        newLines: chunk.newLines || 0,
        content: chunk.content || "",
        changes,
      });
    }

    const additions = file.additions || 0;
    const deletions = file.deletions || 0;
    totalAdditions += additions;
    totalDeletions += deletions;

    files.push({ path: filePath, status, additions, deletions, hunks });
  }

  return { files, totalAdditions, totalDeletions };
}

/**
 * Build a valid-position map from parsed diff.
 * This is THE hard problem — mapping LLM output lines to GitHub diff positions.
 */
export function buildPositionMap(files: DiffFile[]): Map<string, Map<number, number>> {
  // filePath → (newFileLineNumber → gitDiffPosition)
  const positionMap = new Map<string, Map<number, number>>();

  for (const file of files) {
    const lineMap = new Map<number, number>();
    let position = 0; // GitHub diff position is 1-based index in the diff

    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        position++;
        if (change.type === "add" || change.type === "normal") {
          lineMap.set(change.line, position);
        }
      }
    }

    positionMap.set(file.path, lineMap);
  }

  return positionMap;
}

function shouldExclude(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(filePath, p));
}

/**
 * Strip PII (commit author name/email) from git patch headers.
 * Only file/line info is needed — GDPR compliance.
 */
export function stripPatchPII(diffText: string): string {
  return diffText.replace(/^diff --git.*$/m, (header) => {
    // Keep only the file path info, strip author/email
    return header;
  }).replace(/^From: .*$\n/m, "")
    .replace(/^Author: .*$\n/m, "")
    .replace(/^Date: .*$\n/m, "");
}
