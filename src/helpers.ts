/**
 * Helper functions extracted from main.ts for testability.
 * Pagination, regex parsing, and comment CRUD — pure logic with Octokit dependency.
 */
import { Octokit } from "@octokit/rest";

const MARKER = "<!-- mizumi-review-marker -->";
export const SPEND_MARKER = "<!-- mizumi-spend-marker -->";

/** Count past Mizumi reviews on a PR by scanning issue comments + PR reviews. */
export async function countMizumiReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number> {
  let count = 0;
  let page = 1;

  while (page <= 10) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    });

    count += comments.filter((c) => c.body?.includes(MARKER)).length;

    if (comments.length < 100) break;
    page++;
  }

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  count += reviews.filter((r) => r.body?.includes(MARKER)).length;
  return count;
}

/** Parse latest findings from Mizumi inline review comments. */
export async function getLatestFindings(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<Array<{ file: string; line: number; severity: string; category: string; message: string; suggestion?: string }>> {
  const findings: Array<{ file: string; line: number; severity: string; category: string; message: string; suggestion?: string }> = [];
  const { data: comments } = await octokit.rest.pulls.listReviewComments({
    owner, repo, pull_number: prNumber, per_page: 100, sort: "created", direction: "desc",
  });

  for (const c of comments.slice(0, 20)) {
    if (!c.body?.includes(MARKER)) continue;
    const seveMatch = c.body.match(/\*\*Severity:\*\*\s*(\w+)/);
    const catMatch = c.body.match(/\*\*Category:\*\*\s*(\w+)/);
    const sugMatch = c.body.match(/```suggestion\n([\s\S]*?)```/);
    findings.push({
      file: c.path,
      line: c.line ?? 0,
      severity: seveMatch?.[1]?.toLowerCase() || "medium",
      category: catMatch?.[1]?.toLowerCase() || "bug",
      message: c.body.replace(/<[^>]*>/g, "").slice(0, 200).trim(),
      suggestion: sugMatch?.[1]?.replace(/\n$/, ""),
    });
  }
  return findings;
}

/** Create or update a spend dashboard comment on a PR. */
export async function createOrUpdateSpendComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  let page = 1;
  let existing: { id: number } | undefined;

  while (!existing) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: prNumber, per_page: 100, page,
    });
    existing = comments.find((c) => c.body?.includes(SPEND_MARKER)) as { id: number } | undefined;
    if (comments.length < 100) break;
    page++;
  }

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  }
}
