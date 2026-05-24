/**
 * Persist learning data across GitHub Action runs.
 *
 * The Actions runner filesystem is ephemeral — files written during a run
 * are destroyed when the job ends. This module commits learning data
 * (memory, skills, feedback) back to the repo's default branch using the
 * Git Data REST API, so they survive between runs.
 */
import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { Octokit } from "@octokit/rest";

const LEARNING_FILES = [
  ".github/mizumi-memory.md",
  ".github/mizumi-feedback.json",
];

const SKILLS_DIR = ".github/mizumi-skills";

interface PersistResult {
  committed: boolean;
  filesPushed: number;
  commitSha: string | null;
}

/**
 * Persist learning data files to the repo's default branch.
 * Creates blobs, a tree, a commit, and updates the branch ref.
 * Never throws — logs warnings on failure so reviews still complete.
 */
export async function persistLearningData(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  workspace: string
): Promise<PersistResult> {
  const filesToCommit = collectLearningFiles(workspace);
  if (filesToCommit.length === 0) {
    core.info("No learning data files to persist");
    return { committed: false, filesPushed: 0, commitSha: null };
  }

  try {
    // Get current ref for the default branch
    const { data: refData } = await octokit.rest.git.getRef({
      owner, repo, ref: `heads/${defaultBranch}`,
    });
    const currentSha = refData.object.sha;

    const { data: currentCommit } = await octokit.rest.git.getCommit({
      owner, repo, commit_sha: currentSha,
    });

    // Create blobs for each file
    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    for (const { repoPath, content } of filesToCommit) {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner, repo, content, encoding: "utf-8",
      });
      treeEntries.push({ path: repoPath, mode: "100644", type: "blob", sha: blob.sha });
    }

    // Create tree + commit
    const { data: newTree } = await octokit.rest.git.createTree({
      owner, repo, base_tree: currentCommit.tree.sha, tree: treeEntries,
    });

    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner, repo,
      message: `mizumi: persist learning data (${filesToCommit.length} file(s)) [skip ci]`,
      tree: newTree.sha,
      parents: [currentSha],
    });

    // Update the branch ref
    await octokit.rest.git.updateRef({
      owner, repo, ref: `heads/${defaultBranch}`, sha: newCommit.sha,
    });

    core.info(`Persisted ${filesToCommit.length} learning data file(s): ${newCommit.sha}`);
    return { committed: true, filesPushed: filesToCommit.length, commitSha: newCommit.sha };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to persist learning data: ${msg}`);
    return { committed: false, filesPushed: 0, commitSha: null };
  }
}

/**
 * Collect learning data files from the workspace that exist and have content.
 */
function collectLearningFiles(workspace: string): Array<{ repoPath: string; content: string }> {
  const results: Array<{ repoPath: string; content: string }> = [];

  for (const filePath of LEARNING_FILES) {
    const fullPath = path.join(workspace, filePath);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.trim()) {
        results.push({ repoPath: filePath, content });
      }
    } catch { /* skip unreadable */ }
  }

  // Collect skill files
  const skillsPath = path.join(workspace, SKILLS_DIR);
  if (fs.existsSync(skillsPath)) {
    try {
      const files = fs.readdirSync(skillsPath).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        const fullPath = path.join(skillsPath, f);
        const content = fs.readFileSync(fullPath, "utf-8");
        if (content.trim()) {
          results.push({ repoPath: `${SKILLS_DIR}/${f}`, content });
        }
      }
    } catch { /* skip unreadable */ }
  }

  return results;
}
