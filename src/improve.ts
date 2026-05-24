/** /mizumi improve — apply ```suggestion blocks from review comments. v0.1: no LLM call. */
import * as core from "@actions/core";
import * as path from "node:path";
import { Octokit } from "@octokit/rest";
import { MizumiConfig } from "./config.js";
const MARKER = "<!-- mizumi-review-marker -->";
export interface Suggestion { path: string; line: number; code: string }
export interface FixResult { fixedCount: number; commitSha: string | null }
/** Reject paths with traversal (..), absolute paths, UNC paths, or hidden files */
export function isDangerousPath(p: string): boolean {
  if (!p || p.trim() === "") return true;
  const normalized = path.normalize(p);
  if (path.isAbsolute(normalized)) return true;
  // Check for .. segments after normalization (catches encoded, backslash, etc.)
  const segments = normalized.split(/[/\\]+/);
  if (segments.some((s) => s === "..")) return true;
  // Reject hidden files/dirs (starting with .)
  if (segments.some((s) => s.startsWith(".") && s !== ".")) return true;
  // Reject UNC paths (\\server\share)
  if (/^\\\\/.test(p)) return true;
  return false;
}

/** Extract ```suggestion blocks from a review comment body. */
export function parseSuggestions(body: string, filePath: string, line: number): Suggestion[] {
  const results: Suggestion[] = [];
  const regex = /```suggestion\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    results.push({ path: filePath, line, code: m[1].replace(/\n$/, "") });
  }
  return results;
}
/** Fetch Mizumi review comments containing suggestion blocks. */
async function fetchSuggestions(octokit: Octokit, owner: string, repo: string, pr: number): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  let page = 1;
  while (true) {
    const { data: comments } = await octokit.rest.pulls.listReviewComments({ owner, repo, pull_number: pr, per_page: 100, page });
    for (const c of comments) {
      if (!c.body?.includes(MARKER)) continue;
      out.push(...parseSuggestions(c.body, c.path, c.line ?? 0));
    }
    if (comments.length < 100) break;
    page++;
  }
  return out;
}
type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha: string };
/** Apply file suggestions via Git Data API, returning tree entries and fix count. */
async function applyFileFixes(
  octokit: Octokit, owner: string, repo: string, headRef: string, byFile: Map<string, Suggestion[]>
): Promise<{ entries: TreeEntry[]; fixedCount: number }> {
  const entries: TreeEntry[] = [];
  let fixedCount = 0;
  const { data: refData } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${headRef}` });
  const { data: c } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: refData.object.sha });
  const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: c.tree.sha, recursive: "true" });
  for (const [filePath, suggestions] of byFile) {
    if (isDangerousPath(filePath)) { core.warning(`Skipping suspicious path: ${filePath}`); continue; }
    const entry = tree.tree.find((e) => e.path === filePath && e.type === "blob");
    if (!entry?.sha) { core.warning(`Skipping ${filePath}: not found in tree`); continue; }
    const { data: blob } = await octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    const lines = Buffer.from(blob.content, "base64").toString("utf-8").split("\n");
    for (const s of [...suggestions].sort((a, b) => b.line - a.line)) {
      const idx = s.line - 1;
      if (idx >= 0 && idx < lines.length) { lines[idx] = s.code; fixedCount++; }
    }
    const { data: newBlob } = await octokit.rest.git.createBlob({ owner, repo, content: lines.join("\n"), encoding: "utf-8" });
    entries.push({ path: filePath, mode: "100644", type: "blob", sha: newBlob.sha });
  }
  return { entries, fixedCount };
}
/** Apply suggestion blocks from Mizumi review comments and commit to the PR branch. */
export async function generateFix(
  octokit: Octokit, owner: string, repo: string, prNumber: number, _config: MizumiConfig
): Promise<FixResult> {
  const suggestions = await fetchSuggestions(octokit, owner, repo, prNumber);
  if (suggestions.length === 0) {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: "No fixable suggestions found" });
    return { fixedCount: 0, commitSha: null };
  }
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const byFile = new Map<string, Suggestion[]>();
  for (const s of suggestions) { const l = byFile.get(s.path) || []; l.push(s); byFile.set(s.path, l); }
  const { entries, fixedCount } = await applyFileFixes(octokit, owner, repo, pr.head.ref, byFile);
  if (fixedCount === 0) {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: "No fixable suggestions found" });
    return { fixedCount: 0, commitSha: null };
  }
  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, base_tree: pr.head.sha, tree: entries });
  const { data: nc } = await octokit.rest.git.createCommit({ owner, repo, message: `mizumi: apply ${fixedCount} suggestion(s)`, tree: newTree.sha, parents: [pr.head.sha] });
  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${pr.head.ref}`, sha: nc.sha });
  core.info(`Applied ${fixedCount} suggestion(s): ${nc.sha}`);
  return { fixedCount, commitSha: nc.sha };
}
