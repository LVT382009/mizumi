/**
 * Auto-commit on 👍 reaction — polls reactions on Mizumi's review comments
 * and applies suggestion blocks when a 👍 is found.
 *
 * Phase 2.10: Since GitHub has no reaction webhook event, we poll at review time.
 * When a 👍 reaction is found on a Mizumi comment with a ```suggestion block,
 * the fix is applied via Git Data API (same as /mizumi improve).
 *
 * Based on CodeRabbit/OpenReview emoji feedback pattern.
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { generateFix } from "./improve.js";
import { MizumiConfig } from "./config.js";

const MARKER = "<!-- mizumi-review-marker -->";

/**
 * Check for 👍 reactions on Mizumi's review comments and auto-apply fixes.
 * Called at the start of each review run to process pending 👍 reactions.
 * Returns the number of fixes auto-applied.
 */
export async function processReactionApprovals(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  config: MizumiConfig
): Promise<number> {
  // Only run if contents: write permission is available
  const token = process.env.GITHUB_TOKEN || core.getInput("github_token");
  if (!token) return 0;

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  void pr; // Used to verify PR exists

  // Get all Mizumi review comments with suggestion blocks
  const mizumiComments: Array<{ id: number; body: string; path: string; line: number }> = [];
  let page = 1;

  while (page <= 5) {
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner, repo, pull_number: prNumber, per_page: 100, page,
    });

    for (const c of comments) {
      if (c.body?.includes(MARKER) && c.body?.includes("```suggestion")) {
        mizumiComments.push({ id: c.id, body: c.body, path: c.path, line: c.line ?? 0 });
      }
    }

    if (comments.length < 100) break;
    page++;
  }

  if (mizumiComments.length === 0) return 0;

  let applied = 0;

  for (const comment of mizumiComments) {
    try {
      // Check for 👍 reactions on this comment
      const { data: reactions } = await octokit.rest.reactions.listForPullRequestReviewComment({
        owner, repo, comment_id: comment.id,
      });

      const hasThumbsUp = reactions.some((r) => r.content === "+1");
      if (!hasThumbsUp) continue;

      // Found a 👍 — auto-apply the suggestion
      core.info(`Found 👍 on comment ${comment.id} in ${comment.path} — auto-applying suggestion`);

      // The improve.ts generateFix handles Git Data API commits
      const result = await generateFix(octokit, owner, repo, prNumber, config);

      if (result.fixedCount > 0) {
        applied += result.fixedCount;
        // Post a comment confirming auto-apply
        await octokit.rest.issues.createComment({
          owner, repo, issue_number: prNumber,
          body: `Applied suggestion from ${comment.path}:${comment.line} (👍 reaction). Commit: ${result.commitSha?.slice(0, 7)}`,
        });
      }

      // Only process one 👍 per review to avoid rate limits
      break;
    } catch (e) {
      core.warning(`Failed to process reaction on comment ${comment.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return applied;
}
