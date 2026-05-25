/**
 * GitHub platform adapter — wraps existing Octokit-based logic.
 *
 * This adapter preserves complete backward compatibility with
 * the existing Mizumi codebase. All the existing Octokit calls
 * used in main.ts are routed through this adapter.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import {
  PlatformClient,
  PlatformMR,
  PlatformComment,
  PlatformReviewResult,
  InlineComment,
} from "./platform.js";
import { fetchDiff } from "./diff.js";
import { ParsedDiff } from "./diff.js";
import { MizumiConfig, loadConfig } from "./config.js";
import { postReview } from "./post.js";
import { buildLineMapFromRawDiff } from "./linemap.js";
import { ReviewResponseType } from "./review.js";

const RetryingOctokit = Octokit.plugin(retry);

interface GitHubClientOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  config: MizumiConfig;
  headSha: string;
}

/**
 * Create a GitHub platform client from the current Actions context.
 */
export function createGitHubClient(): PlatformClient {
  const config = loadConfig();
  const ctx = github.context;
  const token = process.env.GITHUB_TOKEN || core.getInput("github_token");
  const octokit = new RetryingOctokit({ auth: token });

  const prNumber = getPrNumber(ctx);
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const headSha = ctx.payload.pull_request?.head?.sha || ctx.sha;

  const opts: GitHubClientOptions = {
    octokit,
    owner,
    repo,
    prNumber: prNumber || 0,
    config,
    headSha,
  };

  return new GitHubPlatformClient(opts);
}

function getPrNumber(ctx: typeof github.context): number | null {
  if (ctx.payload.pull_request?.number) return ctx.payload.pull_request.number;
  if (ctx.payload.issue?.pull_request) {
    const comment = ctx.payload.comment?.body || "";
    if (comment.startsWith("/mizumi")) return ctx.payload.issue.number;
  }
  return null;
}

export class GitHubPlatformClient implements PlatformClient {
  platform = "github" as const;
  private opts: GitHubClientOptions;

  constructor(opts: GitHubClientOptions) {
    this.opts = opts;
  }

  async getMR(): Promise<PlatformMR> {
    const { octokit, owner, repo, prNumber } = this.opts;
    const { data: pr } = await octokit.rest.pulls.get({
      owner, repo, pull_number: prNumber,
    });
    return {
      number: prNumber,
      title: pr.title || "",
      body: pr.body || "",
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      author: pr.user?.login || "unknown",
    };
  }

  async fetchDiff(): Promise<ParsedDiff> {
    const { octokit, owner, repo, prNumber, config } = this.opts;
    return fetchDiff(octokit, owner, repo, prNumber, config.excludePatterns);
  }

  async postReview(
    comments: InlineComment[],
    summary: string,
    riskScore: number,
  ): Promise<PlatformReviewResult> {
    const { octokit, owner, repo, prNumber, headSha } = this.opts;
    // Convert inline comments to the format postReview expects
    const reviewComments: import("./review.js").ReviewCommentType[] = comments.map((c) => ({
      file: c.path,
      line: c.line,
      severity: c.severity as "critical" | "high" | "medium" | "low",
      category: c.category as "security" | "compliance" | "performance" | "bug" | "style" | "architecture",
      message: c.body,
      suggestion: c.suggestion,
      confidence: c.confidence,
    }));

    const review: ReviewResponseType = {
      comments: reviewComments,
      decision: "comment",
      riskScore,
      summary,
    };

    const diff = await this.fetchDiff();
    const lineMap = buildLineMapFromRawDiff(diff.rawDiff);

    const result = await postReview(
      octokit, owner, repo, prNumber, headSha, review, lineMap, this.opts.config,
      diff.files,
    );

    return {
      reviewId: result.reviewId,
      findingCount: result.findingCount,
    };
  }

  async postComment(body: string): Promise<void> {
    const { octokit, owner, repo, prNumber } = this.opts;
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body,
    });
  }

  async listBotComments(): Promise<PlatformComment[]> {
    const { octokit, owner, repo, prNumber } = this.opts;
    const marker = "<!-- mizumi-review-marker -->";
    const comments: PlatformComment[] = [];
    let page = 1;

    while (page <= 5) {
      const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
        owner, repo, pull_number: prNumber, per_page: 100, page,
      });
      for (const c of reviewComments) {
        if (c.body?.includes(marker)) {
          comments.push({
            id: c.id,
            body: c.body,
            path: c.path || undefined,
            line: c.line ?? undefined,
            createdAt: c.created_at,
          });
        }
      }
      if (reviewComments.length < 100) break;
      page++;
    }

    return comments;
  }

  async deleteComment(id: number): Promise<void> {
    const { octokit, owner, repo } = this.opts;
    await octokit.rest.pulls.deleteReviewComment({
      owner, repo, comment_id: id,
    });
  }

  async createStatus(
    sha: string,
    state: "pending" | "success" | "failure",
    description: string,
    context: string,
  ): Promise<void> {
    const { octokit, owner, repo, prNumber } = this.opts;
    await octokit.rest.repos.createCommitStatus({
      owner, repo, sha,
      state,
      target_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      description,
      context,
    });
  }

  async getCIStatus(sha: string): Promise<"passed" | "failed" | "pending" | "no_checks"> {
    const { octokit, owner, repo } = this.opts;
    let hasAnyChecks = false;
    let allPassed = true;
    let anyFailed = false;
    let anyPending = false;

    try {
      const { data: combined } = await octokit.rest.repos.getCombinedStatusForRef({
        owner, repo, ref: sha,
      });
      if (combined.total_count > 0) hasAnyChecks = true;
      for (const s of combined.statuses) {
        if (s.state === "success") continue;
        if (s.state === "pending" || s.state === "neutral") { anyPending = true; allPassed = false; }
        else { anyFailed = true; allPassed = false; }
      }
    } catch { /* ignore */ }

    try {
      const { data: checks } = await octokit.rest.checks.listForRef({
        owner, repo, ref: sha,
      });
      if (checks.total_count > 0) hasAnyChecks = true;
      for (const c of checks.check_runs) {
        if (c.status === "completed") {
          if (["success", "neutral", "skipped"].includes(c.conclusion || "")) continue;
          if (["failure", "cancelled", "timed_out"].includes(c.conclusion || "")) { anyFailed = true; allPassed = false; }
          allPassed = false;
        } else { anyPending = true; allPassed = false; }
      }
    } catch { /* ignore */ }

    if (!hasAnyChecks) return "no_checks";
    if (anyFailed) return "failed";
    if (anyPending) return "pending";
    if (allPassed) return "passed";
    return "pending";
  }

  getProjectId(): string {
    return `${this.opts.owner}/${this.opts.repo}`;
  }
}
