/**
 * Post review — inline suggestions + summary + Check Run + HTML marker dedup.
 * reviewdog pattern: Checks API as primary, PR Review API for final state,
 * summary comment update-in-place.
 *
 * Uses `line`/`start_line`/`side` (GitHub GA since April 2020).
 * The deprecated `position` parameter is NOT used.
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { ReviewCommentType, ReviewResponseType } from "./review.js";
import { LineMap, resolveLine } from "./linemap.js";
import { screenOutput } from "./sanitize.js";
import { MizumiConfig } from "./config.js";

const MARKER = "<!-- mizumi-review-marker -->";
const MAX_INLINE_COMMENTS = 30; // GitHub limit per createReview call

export interface PostResult {
  reviewId: number;
  findingCount: number;
  riskScore: number;
}

/**
 * Post the full review to GitHub.
 */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  review: ReviewResponseType,
  lineMap: LineMap,
  config: MizumiConfig
): Promise<PostResult> {

  // 1. Build inline comments with valid line numbers
  const inlineComments: Array<{
    path: string;
    line: number;
    side: "RIGHT";
    body: string;
    start_line?: number;
    start_side?: "RIGHT";
  }> = [];

  const overflowComments: ReviewCommentType[] = [];

  for (const finding of review.comments.slice(0, config.maxComments)) {
    const resolvedLine = resolveLine(lineMap, finding.file, finding.line);
    if (resolvedLine === null) {
      // Can't map to a valid diff line — goes to overflow
      overflowComments.push(finding);
      continue;
    }

    const body = screenOutput(
      finding.suggestion
        ? `**[${finding.severity.toUpperCase()}] ${finding.category}**: ${finding.message}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``
        : `**[${finding.severity.toUpperCase()}] ${finding.category}**: ${finding.message}`
    );

    const comment: (typeof inlineComments)[number] = {
      path: finding.file,
      line: resolvedLine,
      side: "RIGHT",
      body,
    };

    // Multi-line suggestion support
    if (finding.endLine && finding.endLine > finding.line) {
      const resolvedEndLine = resolveLine(lineMap, finding.file, finding.endLine);
      if (resolvedEndLine !== null && resolvedEndLine > resolvedLine) {
        comment.start_line = resolvedLine;
        comment.line = resolvedEndLine;
        comment.start_side = "RIGHT";
      }
    }

    inlineComments.push(comment);
  }

  // 2. Slice to GitHub's 30-comment limit
  const postedInline = inlineComments.slice(0, MAX_INLINE_COMMENTS);
  const extraOverflow = inlineComments.slice(MAX_INLINE_COMMENTS);
  // Comments that exceeded the 30-comment limit join overflow
  for (const c of extraOverflow) {
    overflowComments.push({
      file: c.path,
      line: c.start_line || c.line,
      severity: "medium",
      category: "style",
      message: c.body.replace(/\*\*\[.*?\]\s*.*?\*\*:\s*/, "").split("\n")[0],
      confidence: 100,
    });
  }

  // 3. Create PR Review
  let reviewId = 0;
  try {
    const reviewBody = buildReviewBody(review, [...overflowComments]);
    const { data: createdReview } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      body: screenOutput(reviewBody),
      event: mapDecision(review.decision),
      comments: postedInline,
    });
    reviewId = createdReview.id;
  } catch (error: any) {
    // 422 = invalid line numbers — fall back to summary-only
    if (error?.status === 422) {
      core.warning("422 on createReview — falling back to summary-only comment");
      const summaryBody = buildSummaryComment(review);
      await createOrUpdateSummaryComment(octokit, owner, repo, prNumber, summaryBody);
      return { reviewId: 0, findingCount: review.comments.length, riskScore: review.riskScore };
    }
    throw error;
  }

  // 4. Post/update summary comment with HTML marker dedup
  const summaryBody = buildSummaryComment(review);
  await createOrUpdateSummaryComment(octokit, owner, repo, prNumber, summaryBody);

  // 5. Set outputs
  core.setOutput("review_id", reviewId);
  core.setOutput("finding_count", review.comments.length);
  core.setOutput("risk_score", review.riskScore);

  return { reviewId, findingCount: review.comments.length, riskScore: review.riskScore };
}

function mapDecision(decision: string): "APPROVE" | "COMMENT" | "REQUEST_CHANGES" {
  switch (decision) {
    case "approve":
      return "APPROVE";
    case "request_changes":
      return "REQUEST_CHANGES";
    default:
      return "COMMENT";
  }
}

function buildReviewBody(review: ReviewResponseType, overflow: ReviewCommentType[]): string {
  let body = MARKER;
  body += `\n## Mizumi Review — Risk: ${"🔴".repeat(review.riskScore)}${"⚪".repeat(5 - review.riskScore)} (${review.riskScore}/5)\n\n`;
  body += screenOutput(review.summary) + "\n\n";

  if (overflow.length > 0) {
    body += `<details><summary>Additional findings (${overflow.length})</summary>\n\n`;
    body += "| File | Line | Severity | Category | Message |\n";
    body += "|------|------|----------|----------|--------|\n";
    for (const f of overflow) {
      body += `| \`${f.file}\` | ${f.line} | ${f.severity} | ${f.category} | ${screenOutput(f.message)} |\n`;
    }
    body += "\n</details>\n";
  }

  body += "\n---\n*This review was AI-generated by Mizumi. Always verify findings before acting. Not a substitute for human security review.*";

  return body;
}

function buildSummaryComment(review: ReviewResponseType): string {
  let body = MARKER;
  body += `\n## Mizumi Review — Risk: ${"🔴".repeat(review.riskScore)}${"⚪".repeat(5 - review.riskScore)} (${review.riskScore}/5)`;
  body += `\n\n${screenOutput(review.summary)}`;
  body += `\n\n**Decision:** ${review.decision.toUpperCase()} | **Findings:** ${review.comments.length}`;

  if (review.comments.length > 0) {
    body += "\n\n| Severity | Count |\n|----------|-------|\n";
    const counts: Record<string, number> = {};
    for (const c of review.comments) {
      counts[c.severity] = (counts[c.severity] || 0) + 1;
    }
    for (const [sev, count] of Object.entries(counts).sort()) {
      body += `| ${sev} | ${count} |\n`;
    }
  }

  body += "\n\n---\n*This review was AI-generated by Mizumi. Always verify findings before acting. Not a substitute for human security review.*";

  return body;
}

async function createOrUpdateSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  // Find existing comment with our marker
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find((c) => c.body?.includes(MARKER));

  if (existing) {
    // Update-in-place (dependency-review-action pattern)
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}
