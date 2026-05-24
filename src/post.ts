/**
 * Post review — severity-delivered output + summary + fingerprint dedup.
 *
 * Delivery tiers (Phase 2.4 — CodeRabbit pattern):
 * Critical/High → inline suggestions (with "Commit suggestion" button)
 * Medium → summary table in review body
 * Low/Nitpick → collapsible <details> in review body
 *
 * Dedup: FNV-1a fingerprint in HTML meta comment (reviewdog pattern).
 * Reply-aware deletion: comments with human replies are never deleted.
 * 65,535 char cap: review body truncated if exceeding GitHub limit.
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { ReviewCommentType, ReviewResponseType } from "./review.js";
import { LineMap, resolveLine } from "./linemap.js";
import { screenOutput } from "./sanitize.js";
import { MizumiConfig } from "./config.js";
import { confidenceBadge } from "./calibrate.js";
import { buildChangeStack } from "./changestack.js";
import { generateArchDiagram, generateSeverityDiagram } from "./diagram.js";
import { buildWalkthrough, estimateEffort } from "./walkthrough.js";

const MARKER = "<!-- mizumi-review-marker -->";

/** Derive confidence level from numeric score (matches calibrate.ts thresholds) */
function confidenceLevel(score: number): "high" | "medium" | "low" {
  if (score > 80) return "high";
  if (score > 50) return "medium";
  return "low";
}

/** FNV-1a 32-bit hash — fast, deterministic fingerprint for dedup */
function fnv1a32(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Compute fingerprint for a finding — stable across re-reviews */
export function computeFingerprint(file: string, line: number, message: string): string {
  return fnv1a32(file + ":" + line + ":" + message);
}

const FINGERPRINT_PREFIX = "<!-- mizumi-fp:";
const MAX_COMMENT_BODY = 65535;
const MAX_INLINE_COMMENTS = 30;

export function vscodeLink(file: string, line: number): string {
  return `[Open in VS Code](vscode://file/${file}:${line})`;
}

export interface PostResult {
  reviewId: number;
  findingCount: number;
  riskScore: number;
}

export interface DiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
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
  config: MizumiConfig,
  diffFiles?: DiffFileSummary[]
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

  // 2. Build inline comments (critical + high only) with fingerprints
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
    const fp = computeFingerprint(finding.file, finding.line, finding.message);
    const fpMeta = FINGERPRINT_PREFIX + fp + "-->";
    const rawBody = finding.suggestion
      ? `**[${finding.severity.toUpperCase()}] ${finding.category}**: ${finding.message}\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\`\n\n${link}`
      : `**[${finding.severity.toUpperCase()}] ${finding.category}**: ${finding.message}\n\n${link}`;
    const body = fpMeta + "\n" + screenOutput(rawBody);

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
    let reviewBody = buildReviewBody(
      inlineFindings, tableFindings, detailsFindings, unmappableFindings,
      review.riskScore, review.comments.length,
      mapDecision(review.decision) as "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
      review.summary,
      review.comments,
      diffFiles
    );

    // Truncate if exceeding GitHub's 65,535 char limit
    if (reviewBody.length > MAX_COMMENT_BODY) {
      const originalLen = reviewBody.length;
      const truncated = reviewBody.slice(0, MAX_COMMENT_BODY - 100);
      reviewBody = truncated + `\n\n... Too many findings to display. (${review.comments.length} findings, body truncated to ${MAX_COMMENT_BODY} chars)`;
      core.warning(`Review body truncated from ${originalLen} to ${MAX_COMMENT_BODY} chars`);
    }

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

  // 6. Return result (orchestrator sets action outputs)
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
  descriptionFeedback?: string,
  allFindings?: ReviewCommentType[],
  diffFiles?: DiffFileSummary[]
): string {
  let body = MARKER;
  const fatigueWarning = buildFatigueWarning(findingCount);
  if (fatigueWarning) {
    body += `\n${fatigueWarning}\n\n`;
  }
  body += `## Mizumi Review — Risk: ${"🔴".repeat(Math.min(Math.max(riskScore, 1), 5))}${"⚪".repeat(5 - Math.min(Math.max(riskScore, 1), 5))} (${Math.min(Math.max(riskScore, 1), 5)}/5)\n\n`;
  if (descriptionFeedback) {
    body += screenOutput(descriptionFeedback) + "\n\n";
  }

  // Walkthrough summary
  if (diffFiles && diffFiles.length >= 2) {
    const walkthrough = buildWalkthrough(diffFiles, allFindings || [], riskScore);
    if (walkthrough) body += walkthrough + "\n";
    const effort = estimateEffort(diffFiles, findingCount);
    body += `**Review effort: ${effort}/5**\n\n`;
  }

  // Change Stack for larger reviews
  if (allFindings && allFindings.length >= 5) {
    const changeStack = buildChangeStack(allFindings);
    if (changeStack) body += changeStack + "\n\n";
  }

  // Architecture diagram when multiple directories changed
  if (diffFiles && diffFiles.length >= 2) {
    const archDiagram = generateArchDiagram(diffFiles, allFindings);
    if (archDiagram) body += "### Change Architecture\n\n" + archDiagram + "\n\n";
  }

  // Severity distribution diagram
  if (allFindings && allFindings.length > 0) {
    const sevDiagram = generateSeverityDiagram(allFindings);
    if (sevDiagram) body += "### Finding Distribution\n\n" + sevDiagram + "\n\n";
  }

  // Medium findings — summary table with confidence badges
  const allTableFindings = [...tableFindings, ...unmappableFindings];
  if (allTableFindings.length > 0) {
    body += `### Medium Findings (${allTableFindings.length})\n\n`;
    body += "| Badge | File | Line | Category | Message |\n";
    body += "|-------|------|------|----------|--------|\n";
    for (const f of allTableFindings) {
      const badge = confidenceBadge(confidenceLevel(f.confidence));
      body += `| ${badge} | \`${f.file}\` | ${f.line} | ${f.category} | ${screenOutput(f.message)} |\n`;
    }
    body += "\n";
  }

  // Low/nitpick findings — collapsible details with confidence badges
  if (detailsFindings.length > 0) {
    body += `<details><summary>Low/Nitpick findings (${detailsFindings.length})</summary>\n\n`;
    body += "| Badge | File | Line | Severity | Category | Message |\n";
    body += "|-------|------|------|----------|----------|--------|\n";
    for (const f of detailsFindings) {
      const badge = confidenceBadge(confidenceLevel(f.confidence));
      body += `| ${badge} | \`${f.file}\` | ${f.line} | ${f.severity} | ${f.category} | ${screenOutput(f.message)} |\n`;
    }
    body += "\n</details>\n";
  }

  body += "\n---\n*This review was AI-generated by Mizumi. Always verify findings before acting. Not a substitute for human security review.*";

  return body;
}

function buildSummaryComment(review: ReviewResponseType): string {
  let body = MARKER;
  body += `\n## Mizumi Review — Risk: ${"🔴".repeat(Math.min(Math.max(review.riskScore, 1), 5))}${"⚪".repeat(5 - Math.min(Math.max(review.riskScore, 1), 5))} (${Math.min(Math.max(review.riskScore, 1), 5)}/5)`;
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
 * Delete outdated Mizumi inline review comments using fingerprint matching.
 * Comments with human replies are never deleted (reviewdog pattern).
 * Returns the number of comments deleted. Never throws.
 */
export async function cleanupOutdatedComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  currentFindings: Array<{ file: string; line: number; message: string }>
): Promise<number> {
  const currentFingerprints = new Set(
    currentFindings.map((f) => computeFingerprint(f.file, f.line, f.message))
  );
  let deleted = 0;
  let page = 1;

  while (true) {
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner, repo, pull_number: prNumber, per_page: 100, page,
    });

    for (const comment of comments) {
      // Only touch comments with our fingerprint marker
      if (!comment.body?.includes(FINGERPRINT_PREFIX)) continue;

      // Skip deletion if comment has human replies (reviewdog pattern)
      const replies = (comment as any).replies;
      if (Array.isArray(replies) && replies.length > 0) continue;

      // Extract fingerprint from HTML meta comment
      const fpMatch = comment.body.match(/<!-- mizumi-fp:([0-9a-f]+)-->/);
      if (!fpMatch) continue;
      const fp = fpMatch[1];

      // Skip if this finding still exists in current review
      if (currentFingerprints.has(fp)) continue;

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

/** Truncate a string to the GitHub comment body char limit */
export function truncateToLimit(body: string, limit: number = MAX_COMMENT_BODY): string {
  if (body.length <= limit) return body;
  return body.slice(0, limit - 100) + "\n\n... Too many findings to display.";
}

async function createOrUpdateSummaryComment(
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
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    });

    existing = comments.find((c) => c.body?.includes(MARKER)) as { id: number } | undefined;

    if (comments.length < 100) break;
    page++;
  }

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
