/**
 * Build review context — diff + file contents + MEMORY.md + rules.
 * Assembles everything the LLM needs for a thorough review.
 */
import { Octokit } from "@octokit/rest";
import { DiffFile, ParsedDiff } from "./diff.js";
import { readMemory, readRules } from "./memory.js";
import { stripPatchPII } from "./diff.js";
import stripAnsi from "strip-ansi";

export interface ReviewContext {
  diffText: string;
  files: DiffFile[];
  memoryContent: string;
  rulesContent: string;
  prTitle: string;
  prDescription: string;
  changedFiles: string[];
}

/**
 * Build the full review context for the LLM.
 */
export async function buildContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  diff: ParsedDiff,
  workspace: string
): Promise<ReviewContext> {
  // Fetch PR metadata
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });

  // Build diff text (PII-stripped, ANSI-cleaned)
  let diffText = "";
  for (const file of diff.files) {
    diffText += `\n--- ${file.path} (${file.status}, +${file.additions}/-${file.deletions}) ---\n`;
    for (const hunk of file.hunks) {
      diffText += hunk.content + "\n";
      for (const change of hunk.changes) {
        const prefix = change.type === "add" ? "+" : change.type === "delete" ? "-" : " ";
        diffText += `${prefix}${change.content}\n`;
      }
    }
  }

  diffText = stripPatchPII(stripAnsi(diffText));

  // Read memory + rules
  const memoryContent = readMemory(workspace);
  const rulesContent = readRules(workspace);

  return {
    diffText,
    files: diff.files,
    memoryContent,
    rulesContent,
    prTitle: pr.title || "",
    prDescription: pr.body || "",
    changedFiles: diff.files.map((f) => f.path),
  };
}
