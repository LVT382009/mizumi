/**
 * Post review — severity-delivered output + summary + HTML marker dedup.
 *
 * Delivery tiers (Phase 2.4 — CodeRabbit pattern):
 * Critical/High → inline suggestions (with "Commit suggestion" button)
 * Medium → summary table in review body
 * Low/Nitpick → collapsible <details> in review body
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

export function vscodeLink(file: string, line: number): string {
  return `[Open in VS Code](vscode://file/${file}:${line})`;
}

export interface PostResult {
  reviewId: number;
  findingCount: number;
  riskScore: number;
}

/**
 * Post the full review to GitHub with severity-based delivery.
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

  // 1. Partition findings by severity
  const inlineFindings: ReviewCommentType[] = [];
  const tableFindings: ReviewCommentType[] = [];
  const detailsFindings: ReviewCommentType[] = [];
  const unmappableFindings: ReviewCommentType[] = [];

  for (const finding of review.comments.slice(0, config.maxComments)) {
    if (finding.severity === "critical" || finding.severity === "high") {
      inlineFindings.push(finding);
    } else if (finding.severity === "medium") {
      tableFindings.push(finding);
    } else {
      detailsFindings.push(finding);
    }
  }

  // 2. Build inline comments (critical + high only)
  const inlineComments: Array<{
    path: string;
    line: number;
    side: "RIGHT";
    body: string;
    start_line?: number;
    start_side?: "RIGHT";
  }> = [];

  for (const finding of inlineFindings) {
    const resolvedLine = resolveLine(lineMap, finding.file, finding.line);
    if (resolvedLine === null) {
      unmappableFindings.push(finding);
      continue;
    }

    const link = vscodeLink(finding.file, resolvedLine);
    const body = screenOutput(
      finding.suggestion
        ? `**[${finding.severity.toUpperCase()}] ${finding.category}**: ${finding.message}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`\n\n${link}`
        : `**[${finding.severity.toUpperCase()}] ${finding.category}**: ${finding.message}\n\n${link}`
    );

    const comment: (typeof inlineComments)[number] = {
      path: finding.file,
      line: resolvedLine,
      side: "RIGHT",
      body,
    };

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

  // 3. Slice to GitHub's 30-comment limit; overflow joins table
  const postedInline = inlineComments.slice(0, MAX_INLINE_COMMENTS);
  const extraOverflow = inlineComments.slice(MAX_INLINE_COMMENTS);
  for (const c of extraOverflow) {
    tableFindings.push({
      file: c.path,
      line: c.start_line || c.line,
      severity: "medium",
      category: "style",
      message: c.body.replace(/\*\*\[.*?\]\s*.*?\*\*:\s*/, "").split("\n")[0],
      confidence: 100,
    });
  }

  // 4. Create PR Review
  let reviewId = 0;
  try {
    const reviewBody = buildReviewBody(
      inlineFindings, tableFindings, detailsFindings, unmappableFindings,
      review.riskScore, review.comments.length,
      mapDecision(review.decision) as "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
      review.summary
    );
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

  // 5. Post/update summary comment with HTML marker dedup
  const summaryBody = buildSummaryComment(review);
  await createOrUpdateSummaryComment(octokit, owner, repo, prNumber, summaryBody);

  // 6. Set outputs
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

export function buildFatigueWarning(findingCount: number): string {
  if (findingCount <= 15) return "";
  return `> ⚠️ **Review Fatigue**: This review found ${findingCount} findings. Consider splitting this PR into smaller, focused changes for better review quality.`;
}

export function buildReviewBody(
  _inlineFindings: ReviewCommentType[],
  tableFindings: ReviewCommentType[],
  detailsFindings: ReviewCommentType[],
  unmappableFindings: ReviewCommentType[],
  riskScore: number,
  findingCount: number,
  _reviewDecision: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  descriptionFeedback?: string
): string {
  let body = MARKER;
  const fatigueWarning = buildFatigueWarning(findingCount);
  if (fatigueWarning) {
    body += `\n${fatigueWarning}\n\n`;
  }
  body += `## Mizumi Review — Risk: ${"🔴".repeat(riskScore)}${"⚪".repeat(5 - riskScore)} (${riskScore}/5)\n\n`;
  if (descriptionFeedback) {
    body += screenOutput(descriptionFeedback) + "\n\n";
  }

  // Medium findings — summary table
  const allTableFindings = [...tableFindings, ...unmappableFindings];
  if (allTableFindings.length > 0) {
    body += `### Medium Findings (${allTableFindings.length})\n\n`;
    body += "| File | Line | Category | Message |\n";
    body += "|------|------|----------|--------|\n";
    for (const f of allTableFindings) {
      body += `| \`${f.file}\` | ${f.line} | ${f.category} | ${screenOutput(f.message)} |\n`;
    }
    body += "\n";
  }

  // Low/nitpick findings — collapsible details
  if (detailsFindings.length > 0) {
    body += `<details><summary>Low/Nitpick findings (${detailsFindings.length})</summary>\n\n`;
    body += "| File | Line | Severity | Category | Message |\n";
    body += "|------|------|----------|----------|--------|\n";
    for (const f of detailsFindings) {
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

/**
 * Delete Mizumi's own inline review comments whose file+line no longer
 * appears in the current findings (reviewdog stale-cleanup pattern).
 * Returns the number of comments deleted. Never throws.
 */
export async function cleanupOutdatedComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  currentFindings: Array<{ file: string; line: number; message: string }>
): Promise<number> {
  const currentKeys = new Set(
    currentFindings.map((f) => `${f.file}:${f.line}`)
  );
  let deleted = 0;
  let page = 1;

  while (true) {
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner, repo, pull_number: prNumber, per_page: 100, page,
    });

    for (const comment of comments) {
      if (!comment.body?.includes(MARKER)) continue;
      const key = `${comment.path}:${comment.line}`;
      if (currentKeys.has(key)) continue;
      try {
        await octokit.rest.pulls.deleteReviewComment({
          owner, repo, comment_id: comment.id,
        });
        deleted++;
      } catch { /* never fail the review for a cleanup error */ }
    }

    if (comments.length < 100) break;
    page++;
  }

  return deleted;
}

async function createOrUpdateSummaryComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find((c) => c.body?.includes(MARKER));

  if (existing) {
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
