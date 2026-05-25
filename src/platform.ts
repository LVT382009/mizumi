/**
 * Platform abstraction layer — competitive gap #5.
 *
 * Provides a unified interface for GitHub and GitLab so Mizumi
 * can review PRs on both platforms with the same core engine.
 *
 * Platform auto-detection: GITHUB_ACTION env → GitHub, GITLAB_CI → GitLab.
 * The GitHub adapter wraps the existing Octokit calls.
 * The GitLab adapter uses GitLab REST API v4 with fetch (no extra dependency).
 *
 * Architecture: same core review logic, different platform I/O.
 * This is how CodeRabbit supports 4 platforms from one codebase.
 */
import * as core from "@actions/core";
import { ParsedDiff } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlatformType = "github" | "gitlab";

export interface PlatformMR {
  number: number;
  title: string;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha: string;
  author: string;
}

export interface PlatformComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
}

export interface PlatformReviewResult {
  reviewId: number;
  findingCount: number;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
  severity: string;
  confidence: number;
  category: string;
  suggestion?: string;
}

export interface PlatformClient {
  /** Which platform this client targets. */
  platform: PlatformType;

  /** Get merge request / pull request metadata. */
  getMR(): Promise<PlatformMR>;

  /** Fetch the diff for the MR. */
  fetchDiff(): Promise<ParsedDiff>;

  /** Post a review with inline comments. */
  postReview(
    comments: InlineComment[],
    summary: string,
    riskScore: number,
  ): Promise<PlatformReviewResult>;

  /** Post a general comment on the MR. */
  postComment(body: string): Promise<void>;

  /** List existing bot comments (for cleanup/dedup). */
  listBotComments(): Promise<PlatformComment[]>;

  /** Delete a comment by ID. */
  deleteComment(id: number): Promise<void>;

  /** Create a commit status / pipeline status. */
  createStatus(
    sha: string,
    state: "pending" | "success" | "failure",
    description: string,
    context: string,
  ): Promise<void>;

  /** Get CI/check status for a SHA. */
  getCIStatus(sha: string): Promise<"passed" | "failed" | "pending" | "no_checks">;

  /** Apply a fix via platform's file API (Git Data API on GitHub, repository files on GitLab). */
  applyFix?(
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
  ): Promise<string | null>;

  /** Get the project/repo identifier. */
  getProjectId(): string;
}

// ---------------------------------------------------------------------------
// Factory — detect platform and create client
// ---------------------------------------------------------------------------

/**
 * Detect the current platform from environment variables.
 * GITHUB_ACTION → GitHub, GITLAB_CI → GitLab.
 */
export function detectPlatform(): PlatformType {
  if (process.env.GITHUB_ACTION) return "github";
  if (process.env.GITLAB_CI) return "gitlab";
  // Default to GitHub for backward compatibility
  return "github";
}

/**
 * Create the appropriate platform client.
 * Lazy-loads adapters to keep bundle size minimal.
 */
export async function createPlatformClient(): Promise<PlatformClient> {
  const platform = detectPlatform();
  core.info(`Platform detected: ${platform}`);

  if (platform === "gitlab") {
    const { createGitLabClient } = await import("./platform-gitlab.js");
    return createGitLabClient();
  }

  // GitHub — wrap existing Octokit-based logic
  const { createGitHubClient } = await import("./platform-github.js");
  return createGitHubClient();
}

// ---------------------------------------------------------------------------
// Platform-agnostic helpers
// ---------------------------------------------------------------------------

/** Check if running in a CI environment (either platform). */
export function isCI(): boolean {
  return !!(process.env.GITHUB_ACTION || process.env.GITLAB_CI);
}

/** Get the workspace directory for the current platform. */
export function getWorkspace(): string {
  return process.env.GITHUB_WORKSPACE || process.env.CI_PROJECT_DIR || ".";
}
