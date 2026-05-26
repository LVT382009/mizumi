/**
 * GitHub Checks API — create Check Runs with annotations.
 *
 * P0 v1 feature: post findings as Check Run annotations visible in
 * the GitHub Checks tab (like Codecov, SonarQube, CodeRabbit do).
 * This enables deeper branch protection integration beyond commit statuses.
 *
 * Architecture:
 * - createCheckRun: creates a Check Run with finding annotations
 * - updateCheckRun: updates an existing Check Run (for re-reviews)
 * - Finding → GitHub Check Annotation mapping with severity levels
 *
 * GitHub Annotations limits:
 * - Max 50 annotations per request (we batch)
 * - annotation_level: notice, warning, failure
 * - path + start_line + end_line required
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckRunResult {
  checkRunId: number;
  annotationCount: number;
  conclusion: "success" | "failure" | "neutral";
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
  raw_details?: string;
}

// ---------------------------------------------------------------------------
// Severity → annotation level mapping
// ---------------------------------------------------------------------------

const SEVERITY_TO_LEVEL: Record<string, "failure" | "warning" | "notice"> = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "notice",
  nitpick: "notice",
};

function toAnnotationLevel(severity: string): "failure" | "warning" | "notice" {
  return SEVERITY_TO_LEVEL[severity.toLowerCase()] || "notice";
}

// ---------------------------------------------------------------------------
// Finding → Annotation conversion
// ---------------------------------------------------------------------------

export function findingsToAnnotations(findings: ReviewCommentType[]): CheckAnnotation[] {
  return findings.map((f) => ({
    path: f.file,
    start_line: f.line || 1,
    end_line: f.endLine || f.line || 1,
    annotation_level: toAnnotationLevel(f.severity),
    message: f.message.slice(0, 65535),
    title: `[${f.severity.toUpperCase()}] ${f.category}`,
    raw_details: f.suggestion || undefined,
  }));
}

// ---------------------------------------------------------------------------
// Decision → conclusion mapping
// ---------------------------------------------------------------------------

function toConclusion(riskScore: number, findingCount: number): "success" | "failure" | "neutral" {
  if (findingCount === 0) return "success";
  if (riskScore >= 7) return "failure";
  if (riskScore >= 4) return "neutral";
  return "success";
}

// ---------------------------------------------------------------------------
// Create a Check Run
// ---------------------------------------------------------------------------

const MAX_ANNOTATIONS_PER_REQUEST = 50;

/**
 * Create a GitHub Check Run with annotations from review findings.
 * Batches annotations in groups of 50 (GitHub API limit per request).
 */
export async function createCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  findings: ReviewCommentType[],
  riskScore: number,
): Promise<CheckRunResult> {
  const annotations = findingsToAnnotations(findings);
  const conclusion = toConclusion(riskScore, findings.length);

  // Create the check run first
  const { data: checkRun } = await octokit.rest.checks.create({
    owner,
    repo,
    name: "Mizumi Review",
    head_sha: headSha,
    status: "completed",
    completed_at: new Date().toISOString(),
    conclusion,
    output: {
      title: `Mizumi: ${findings.length} finding(s) — risk ${riskScore}/10`,
      summary: buildSummary(findings, riskScore),
      annotations: annotations.slice(0, MAX_ANNOTATIONS_PER_REQUEST),
    },
  });

  core.info(`Check Run created: id=${checkRun.id}, conclusion=${conclusion}, annotations=${annotations.length}`);

  // Post remaining annotations in batches of 50
  const remaining = annotations.slice(MAX_ANNOTATIONS_PER_REQUEST);
  for (let i = 0; i < remaining.length; i += MAX_ANNOTATIONS_PER_REQUEST) {
    const batch = remaining.slice(i, i + MAX_ANNOTATIONS_PER_REQUEST);
    try {
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRun.id,
        output: {
          title: `Mizumi: ${findings.length} finding(s) — risk ${riskScore}/10`,
          summary: buildSummary(findings, riskScore),
          annotations: batch,
        },
      });
    } catch (e) {
      core.warning(`Failed to post annotation batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    checkRunId: checkRun.id,
    annotationCount: annotations.length,
    conclusion,
  };
}

// ---------------------------------------------------------------------------
// Update an existing Check Run (for re-reviews)
// ---------------------------------------------------------------------------

/**
 * Update an existing Check Run with new findings.
 */
export async function updateCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  findings: ReviewCommentType[],
  riskScore: number,
): Promise<CheckRunResult> {
  const annotations = findingsToAnnotations(findings);
  const conclusion = toConclusion(riskScore, findings.length);

  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    completed_at: new Date().toISOString(),
    conclusion,
    output: {
      title: `Mizumi: ${findings.length} finding(s) — risk ${riskScore}/10`,
      summary: buildSummary(findings, riskScore),
      annotations: annotations.slice(0, MAX_ANNOTATIONS_PER_REQUEST),
    },
  });

  // Post remaining annotations in batches
  const remaining = annotations.slice(MAX_ANNOTATIONS_PER_REQUEST);
  for (let i = 0; i < remaining.length; i += MAX_ANNOTATIONS_PER_REQUEST) {
    const batch = remaining.slice(i, i + MAX_ANNOTATIONS_PER_REQUEST);
    try {
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        output: {
          title: `Mizumi: ${findings.length} finding(s) — risk ${riskScore}/10`,
          summary: buildSummary(findings, riskScore),
          annotations: batch,
        },
      });
    } catch (e) {
      core.warning(`Failed to post annotation batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    checkRunId,
    annotationCount: annotations.length,
    conclusion,
  };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(findings: ReviewCommentType[], riskScore: number): string {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  const lines = [`**Risk Score:** ${riskScore}/10`, `**Findings:** ${findings.length}`, ""];

  for (const [sev, count] of Object.entries(counts).sort((a, b) => {
    const order = ["critical", "high", "medium", "low", "nitpick"];
    return order.indexOf(a[0]) - order.indexOf(b[0]);
  })) {
    lines.push(`- ${sev}: ${count}`);
  }

  return lines.join("\n");
}
