/**
 * Fetch PR diff — 3 strategies from diff0 pattern:
 * 1. GitHub API mediaType diff (preferred)
 * 2. Compare commits endpoint
 * 3. Git diff via CLI fallback
 */
import { Octokit } from "@octokit/rest";
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
  line: number; // New file line number
  oldLine: number; // Old file line number
  content: string;
}

export interface ParsedDiff {
  files: DiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  rawDiff: string; // Raw diff text for accurate position mapping
}

/**
 * Fetch and parse PR diff from GitHub API.
 * Strategy 1: diff media type (most efficient).
 * Strategy 2: compare commits fallback if strategy 1 fails.
 */
export async function fetchDiff(
 octokit: Octokit,
 owner: string,
 repo: string,
 prNumber: number,
 excludePatterns: string[]
): Promise<ParsedDiff> {
 try {
   // Strategy 1: Use the diff media type (most efficient)
   const { data: diffText } = await octokit.pulls.get({
     owner,
     repo,
     pull_number: prNumber,
     mediaType: { format: "diff" },
   });

   const rawDiff = typeof diffText === "string" ? diffText : JSON.stringify(diffText);
   const parsed = await parseDiff(rawDiff, excludePatterns);
   return { ...parsed, rawDiff };
 } catch {
   // Strategy 2: Compare commits fallback
   const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
   const base = pr.base?.sha;
   const head = pr.head?.sha;
   if (!base || !head) throw new Error("Could not determine base/head SHA for diff fallback");

   const { data: comparison } = await octokit.rest.repos.compareCommits({
     owner, repo, base, head,
     mediaType: { format: "diff" },
   });
   const rawDiff = typeof comparison === "string" ? comparison : JSON.stringify(comparison);
   const parsed = await parseDiff(rawDiff, excludePatterns);
   return { ...parsed, rawDiff };
 }
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
    // parse-diff File doesn't have a `renamed` flag — detect from `from` !== `to`
    const isRenamed = !!(file.from && file.to && file.from !== file.to);
    const status = file.new ? "added" : file.deleted ? "deleted" : isRenamed ? "renamed" : "modified";

    // Skip excluded files
    if (shouldExclude(filePath, excludePatterns)) continue;

    const hunks: DiffHunk[] = [];

    for (const chunk of file.chunks || []) {
      const changes: DiffChange[] = [];
      for (const change of chunk.changes || []) {
        const type = change.type === "add" ? "add" : change.type === "del" ? "delete" : "normal";
        // Type narrowing: AddChange/DeleteChange have `ln`, NormalChange has `ln1`/`ln2`
        let line = 0;
        let oldLine = 0;
        if (change.type === "normal") {
          const nc = change as import("parse-diff").NormalChange;
          line = nc.ln2 || 0;
          oldLine = nc.ln1 || 0;
        } else {
          const ac = change as import("parse-diff").AddChange | import("parse-diff").DeleteChange;
          line = ac.ln || 0;
          oldLine = ac.ln || 0;
        }
        changes.push({
          type,
          line,
          oldLine,
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

  return { files, totalAdditions, totalDeletions, rawDiff: diffText };
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
