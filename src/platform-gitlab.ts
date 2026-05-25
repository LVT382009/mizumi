/**
 * GitLab platform adapter — competitive gap #5.
 *
 * Implements the PlatformClient interface using GitLab REST API v4.
 * No extra dependencies — uses native fetch (Node 24 has global fetch).
 *
 * GitLab CI/CD integration:
 * - Triggered via CI job (not webhook, since Mizumi runs in CI)
 * - Uses GITLAB_TOKEN, CI_PROJECT_ID, CI_MERGE_REQUEST_IID env vars
 * - Posts positioned discussions on MR diff lines (like GitHub inline comments)
 *
 * This is the foundation for multi-platform support that CodeRabbit has
 * but Copilot, Anthropic, and Macroscope lack (GitHub-only).
 */
import * as core from "@actions/core";
import {
  PlatformClient,
  PlatformMR,
  PlatformComment,
  PlatformReviewResult,
  InlineComment,
} from "./platform.js";
import { ParsedDiff, DiffFile, DiffHunk } from "./diff.js";

// ---------------------------------------------------------------------------
// GitLab API types
// ---------------------------------------------------------------------------

interface GitLabMRData {
  iid: number;
  title: string;
  description: string;
  sha: string;
  source_branch: string;
  target_branch: string;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  author: { username: string };
}

interface GitLabMRVersion {
  id: number;
  base_commit_sha: string;
  head_commit_sha: string;
  start_commit_sha: string;
}

interface GitLabDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

interface GitLabPipeline {
  status: string;
}

// ---------------------------------------------------------------------------
// GitLab client
// ---------------------------------------------------------------------------

class GitLabPlatformClient implements PlatformClient {
  platform = "gitlab" as const;
  private baseUrl: string;
  private token: string;
  private projectId: string;
  private mrIid: number;

  constructor() {
    this.baseUrl = (process.env.CI_API_V4_URL || "https://gitlab.com/api/v4").replace(/\/$/, "");
    this.token = process.env.GITLAB_TOKEN || process.env.MIZUMI_GITLAB_TOKEN || "";
    this.projectId = process.env.CI_PROJECT_ID || "";
    this.mrIid = parseInt(process.env.CI_MERGE_REQUEST_IID || "0", 10);

    if (!this.token) throw new Error("GITLAB_TOKEN is required for GitLab platform");
    if (!this.projectId) throw new Error("CI_PROJECT_ID is required (set automatically in GitLab CI)");
    if (!this.mrIid) throw new Error("CI_MERGE_REQUEST_IID is required (set in GitLab MR pipelines)");
  }

  async getMR(): Promise<PlatformMR> {
    const mr = await this.api<GitLabMRData>("GET", `/projects/${this.projectId}/merge_requests/${this.mrIid}`);
    return {
      number: mr.iid,
      title: mr.title || "",
      body: mr.description || "",
      headSha: mr.sha,
      headRef: mr.source_branch,
      baseRef: mr.target_branch,
      baseSha: mr.diff_refs?.base_sha || "",
      author: mr.author?.username || "unknown",
    };
  }

  async fetchDiff(): Promise<ParsedDiff> {
    const diffs = await this.api<GitLabDiff[]>("GET", `/projects/${this.projectId}/merge_requests/${this.mrIid}/diffs`);

    const files: DiffFile[] = diffs.map((d) => parseGitLabDiff(d)).filter(Boolean) as DiffFile[];
    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    // Build raw diff text for line mapping
    const rawDiff = diffs.map((d) => d.diff).join("\n");

    return { files, totalAdditions, totalDeletions, rawDiff };
  }

  async postReview(
    comments: InlineComment[],
    summary: string,
    _riskScore: number,
  ): Promise<PlatformReviewResult> {
    // Get MR version for positioned comments
    const versions = await this.api<GitLabMRVersion[]>(
      "GET", `/projects/${this.projectId}/merge_requests/${this.mrIid}/versions`
    );
    const latestVersion = versions[0]; // Most recent first

    let postedCount = 0;

    // Post inline positioned discussions for each comment
    for (const comment of comments) {
      try {
        const body = this.formatCommentBody(comment);

        if (latestVersion && comment.line > 0) {
          // Positioned discussion (inline comment on specific line)
          await this.api("POST", `/projects/${this.projectId}/merge_requests/${this.mrIid}/discussions`, {
            body,
            position: {
              position_type: "text",
              base_sha: latestVersion.base_commit_sha,
              head_sha: latestVersion.head_commit_sha,
              start_sha: latestVersion.start_commit_sha,
              new_path: comment.path,
              old_path: comment.path,
              new_line: comment.line,
            },
          });
        } else {
          // Unpositioned discussion (general comment)
          await this.api("POST", `/projects/${this.projectId}/merge_requests/${this.mrIid}/discussions`, {
            body,
          });
        }
        postedCount++;
      } catch (e) {
        core.warning(`Failed to post GitLab discussion: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Post summary as a general comment
    if (summary) {
      await this.postComment(summary);
    }

    return { reviewId: this.mrIid, findingCount: postedCount };
  }

  async postComment(body: string): Promise<void> {
    await this.api("POST", `/projects/${this.projectId}/merge_requests/${this.mrIid}/notes`, {
      body,
    });
  }

  async listBotComments(): Promise<PlatformComment[]> {
    const notes = await this.api<Array<{ id: number; body: string; created_at: string }>>(
      "GET", `/projects/${this.projectId}/merge_requests/${this.mrIid}/notes`
    );
    const marker = "<!-- mizumi-review-marker -->";
    return notes
      .filter((n) => n.body?.includes(marker))
      .map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: n.created_at,
      }));
  }

  async deleteComment(id: number): Promise<void> {
    await this.api("DELETE", `/projects/${this.projectId}/merge_requests/${this.mrIid}/notes/${id}`);
  }

  async createStatus(
    sha: string,
    state: "pending" | "success" | "failure",
    description: string,
    context: string,
  ): Promise<void> {
    const gitlabState = state === "pending" ? "running" : state === "success" ? "success" : "failed";
    await this.api("POST", `/projects/${this.projectId}/statuses/${sha}`, {
      state: gitlabState,
      description,
      context,
      target_url: `${process.env.CI_PROJECT_URL || ""}/-/merge_requests/${this.mrIid}`,
    });
  }

  async getCIStatus(sha: string): Promise<"passed" | "failed" | "pending" | "no_checks"> {
    try {
      const pipelines = await this.api<Array<GitLabPipeline>>(
        "GET", `/projects/${this.projectId}/pipelines?sha=${sha}`
      );
      if (pipelines.length === 0) return "no_checks";
      const latest = pipelines[0];
      if (latest.status === "success") return "passed";
      if (["failed", "canceled", "skipped"].includes(latest.status)) return "failed";
      return "pending";
    } catch {
      return "no_checks";
    }
  }

  getProjectId(): string {
    return this.projectId;
  }

  // ---------------------------------------------------------------------------
  // GitLab API helper
  // ---------------------------------------------------------------------------

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitLab API ${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    }

    if (response.status === 204) return null as T;

    return response.json() as Promise<T>;
  }

  private formatCommentBody(comment: InlineComment): string {
    const marker = "<!-- mizumi-review-marker -->";
    const badge = comment.confidence > 80 ? "🟢" : comment.confidence > 50 ? "🟡" : "⚪";
    let body = `${marker}\n**[${comment.severity.toUpperCase()}]** ${badge} ${comment.category}\n\n${comment.body}`;
    if (comment.suggestion) {
      body += `\n\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
    }
    return body;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitLabClient(): PlatformClient {
  return new GitLabPlatformClient();
}

// ---------------------------------------------------------------------------
// Diff parsing — convert GitLab diff format to our ParsedDiff
// ---------------------------------------------------------------------------

function parseGitLabDiff(d: GitLabDiff): DiffFile | null {
  if (!d.diff) return null;

  const status: DiffFile["status"] = d.new_file ? "added" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified";

  const hunks = parseGitLabDiffHunks(d.diff);
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === "add") additions++;
      if (change.type === "delete") deletions++;
    }
  }

  return {
    path: d.new_path,
    status,
    additions,
    deletions,
    hunks,
  };
}

function parseGitLabDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffText.split("\n");
  let currentHunk: DiffHunk | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      currentHunk = {
        oldStart: oldLine,
        oldLines: 0,
        newStart: newLine,
        newLines: 0,
        content: line,
        changes: [],
      };
      hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.changes.push({
        type: "add",
        line: newLine,
        oldLine: 0,
        content: line.slice(1),
      });
      newLine++;
    } else if (line.startsWith("-")) {
      currentHunk.changes.push({
        type: "delete",
        line: 0,
        oldLine: oldLine,
        content: line.slice(1),
      });
      oldLine++;
    } else if (line.startsWith(" ")) {
      currentHunk.changes.push({
        type: "normal",
        line: newLine,
        oldLine: oldLine,
        content: line.slice(1),
      });
      newLine++;
      oldLine++;
    }
  }

  // Update hunk line counts
  for (const hunk of hunks) {
    hunk.oldLines = hunk.changes.filter((c) => c.type === "delete" || c.type === "normal").length;
    hunk.newLines = hunk.changes.filter((c) => c.type === "add" || c.type === "normal").length;
  }

  return hunks;
}
