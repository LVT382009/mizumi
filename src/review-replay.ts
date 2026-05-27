/**
 * Review Replay — reconstruct any past review run from audit trail data.
 *
 * Competitive gap: No AI code reviewer offers replay. CodeRabbit has no
 * review history. Sourcery has no replay. CodeGuru has no provenance.
 * Mizumi lets teams answer "what happened on that review 3 weeks ago?"
 * without scrolling through PR comments. Full finding provenance, stage
 * execution timeline, LLM cost breakdown, and config diff — zero LLM cost.
 */
import { readAuditTrail, listAuditTrails, formatNumber } from "./audit-trail.js";
import type { AuditTrail } from "./audit-trail.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayFinding {
  fingerprint: string;
  file: string;
  line: number;
  severity: string;
  category: string;
  message: string;
  source: string;
  modifications: string[];
  finalConfidence: number;
}

export interface ReplayStage {
  name: string;
  durationMs: number;
  success: boolean;
  findingCount?: number;
  error?: string;
}

export interface ReplaySummary {
  runId: string;
  timestamp: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  configHash: string;
  totalDurationMs: number;
  stages: ReplayStage[];
  findings: ReplayFinding[];
  llmCalls: { provider: string; model: string; purpose: string; inputTokens: number; outputTokens: number; latencyMs: number; success: boolean }[];
  configSnapshot: Record<string, unknown>;
}

export interface ReplayDiff {
  field: string;
  runA: string;
  runB: string;
}

export interface ReplayComparison {
  runA: ReplaySummary;
  runB: ReplaySummary;
  diffs: ReplayDiff[];
  findingsAdded: ReplayFinding[];
  findingsRemoved: ReplayFinding[];
  findingsChanged: ReplayFinding[];
  configChanges: ReplayDiff[];
}

// ---------------------------------------------------------------------------
// Core replay functions
// ---------------------------------------------------------------------------

/**
 * Get the replay summary for a specific run ID.
 */
export function getReplaySummary(workspace: string, runId: string): ReplaySummary | null {
  const trail = readAuditTrail(workspace, runId);
  if (!trail) return null;
  return trailToReplay(trail);
}

/**
 * Find all audit trail runs for a specific PR.
 */
export function findRunsForPR(workspace: string, owner: string, repo: string, prNumber: number): ReplaySummary[] {
  const runIds = listAuditTrails(workspace);
  const results: ReplaySummary[] = [];
  for (const runId of runIds) {
    const trail = readAuditTrail(workspace, runId);
    if (trail && trail.meta.owner === owner && trail.meta.repo === repo && trail.meta.prNumber === prNumber) {
      results.push(trailToReplay(trail));
    }
  }
  return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.runId.localeCompare(b.runId));
}

/**
 * Find the most recent run for a PR.
 */
export function findLatestRunForPR(workspace: string, owner: string, repo: string, prNumber: number): ReplaySummary | null {
  const runs = findRunsForPR(workspace, owner, repo, prNumber);
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

/**
 * Compare two review runs — finding-level diff with config changes.
 */
export function compareReplays(workspace: string, runIdA: string, runIdB: string): ReplayComparison | null {
  const trailA = readAuditTrail(workspace, runIdA);
  const trailB = readAuditTrail(workspace, runIdB);
  if (!trailA || !trailB) return null;

  const summaryA = trailToReplay(trailA);
  const summaryB = trailToReplay(trailB);

  const fpA = new Map(trailA.findings.map((f) => [f.fingerprint, f]));
  const fpB = new Map(trailB.findings.map((f) => [f.fingerprint, f]));

  const findingsAdded: ReplayFinding[] = [];
  const findingsRemoved: ReplayFinding[] = [];
  const findingsChanged: ReplayFinding[] = [];

  for (const [fp, finding] of fpB) {
    if (!fpA.has(fp)) {
      findingsAdded.push(finding);
    } else {
      const prev = fpA.get(fp)!;
      if (prev.finalConfidence !== finding.finalConfidence || prev.severity !== finding.severity) {
        findingsChanged.push(finding);
      }
    }
  }
  for (const [fp, finding] of fpA) {
    if (!fpB.has(fp)) {
      findingsRemoved.push(finding);
    }
  }

  const metricDiffs: ReplayDiff[] = [
    { field: "Duration", runA: `${formatNumber(summaryA.totalDurationMs)}ms`, runB: `${formatNumber(summaryB.totalDurationMs)}ms` },
    { field: "Findings", runA: String(summaryA.findings.length), runB: String(summaryB.findings.length) },
    { field: "Stages Passed", runA: String(summaryA.stages.filter((s) => s.success).length), runB: String(summaryB.stages.filter((s) => s.success).length) },
    { field: "Total Tokens", runA: formatNumber(summaryA.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)), runB: formatNumber(summaryB.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)) },
  ];

  const configChanges = diffConfigs(trailA.configSnapshot, trailB.configSnapshot);

  return {
    runA: summaryA,
    runB: summaryB,
    diffs: metricDiffs,
    findingsAdded,
    findingsRemoved,
    findingsChanged,
    configChanges,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format a replay summary as a Markdown details block.
 */
export function formatReplaySummary(summary: ReplaySummary): string {
  const successStages = summary.stages.filter((s) => s.success).length;
  const failedStages = summary.stages.filter((s) => !s.success).length;
  const totalTokens = summary.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0);
  const sources = groupBy(summary.findings, (f) => f.source);

  let text = `<details>\n<summary>Review Replay: \`${summary.runId.slice(0, 8)}\`</summary>\n\n`;
  text += `| Metric | Value |\n|--------|-------|\n`;
  text += `| Run ID | \`${summary.runId}\` |\n`;
  text += `| Timestamp | ${summary.timestamp} |\n`;
  text += `| PR | ${summary.owner}/${summary.repo}#${summary.prNumber} |\n`;
  text += `| Commit | \`${summary.headSha.slice(0, 7)}\` |\n`;
  text += `| Config Hash | \`${summary.configHash}\` |\n`;
  text += `| Duration | ${formatNumber(summary.totalDurationMs)}ms |\n`;
  text += `| Stages | ${successStages} passed, ${failedStages} failed |\n`;
  text += `| Findings | ${summary.findings.length} |\n`;
  text += `| LLM Calls | ${summary.llmCalls.length} |\n`;
  text += `| Total Tokens | ${formatNumber(totalTokens)} |\n`;

  if (summary.stages.length > 0) {
    text += `\n### Pipeline Stages\n\n`;
    text += `| Stage | Duration | Result | Findings |\n|-------|----------|--------|----------|\n`;
    for (const stage of summary.stages) {
      const result = stage.success ? "pass" : `fail${stage.error ? ": " + stage.error : ""}`;
      text += `| ${stage.name} | ${formatNumber(stage.durationMs)}ms | ${result} | ${stage.findingCount ?? "-"} |\n`;
    }
  }

  if (summary.findings.length > 0) {
    text += `\n### Findings\n\n`;
    text += `| # | Fingerprint | File | Sev | Category | Source | Conf | Modifications |\n`;
    text += `|---|-------------|------|-----|----------|--------|------|---------------|\n`;
    summary.findings.forEach((f, i) => {
      text += `| ${i + 1} | \`${f.fingerprint.slice(0, 8)}\` | ${f.file}:${f.line} | ${f.severity} | ${f.category} | ${f.source} | ${f.finalConfidence}% | ${f.modifications.join(", ") || "-"} |\n`;
    });
  }

  if (Object.keys(sources).length > 0) {
    text += `\n**Finding sources:** ${Object.entries(sources).map(([k, v]) => `${k}=${v.length}`).join(", ")}\n`;
  }

  text += `\n</details>`;
  return text;
}

/**
 * Format a replay comparison as a Markdown details block.
 */
export function formatReplayComparison(comparison: ReplayComparison): string {
  let text = `<details>\n<summary>Review Replay Comparison: \`${comparison.runA.runId.slice(0, 8)}\` vs \`${comparison.runB.runId.slice(0, 8)}\`</summary>\n\n`;

  text += `### Metrics\n\n`;
  text += `| Metric | Run A | Run B |\n|--------|-------|-------|\n`;
  for (const diff of comparison.diffs) {
    text += `| ${diff.field} | ${diff.runA} | ${diff.runB} |\n`;
  }

  if (comparison.findingsAdded.length > 0) {
    text += `\n### New Findings (${comparison.findingsAdded.length})\n\n`;
    for (const f of comparison.findingsAdded) {
      text += `- [${f.severity}] ${f.file}:${f.line} — ${f.message} (${f.source}, ${f.finalConfidence}%)\n`;
    }
  }

  if (comparison.findingsRemoved.length > 0) {
    text += `\n### Removed Findings (${comparison.findingsRemoved.length})\n\n`;
    for (const f of comparison.findingsRemoved) {
      text += `- ~~[${f.severity}] ${f.file}:${f.line} — ${f.message}~~ (${f.source})\n`;
    }
  }

  if (comparison.findingsChanged.length > 0) {
    text += `\n### Changed Findings (${comparison.findingsChanged.length})\n\n`;
    for (const f of comparison.findingsChanged) {
      text += `- [${f.severity}] ${f.file}:${f.line} — ${f.message} (${f.finalConfidence}%)\n`;
    }
  }

  if (comparison.configChanges.length > 0) {
    text += `\n### Config Changes\n\n`;
    text += `| Setting | Run A | Run B |\n|---------|-------|-------|\n`;
    for (const change of comparison.configChanges) {
      text += `| ${change.field} | ${change.runA} | ${change.runB} |\n`;
    }
  }

  if (comparison.findingsAdded.length === 0 && comparison.findingsRemoved.length === 0 && comparison.findingsChanged.length === 0 && comparison.configChanges.length === 0) {
    text += `\n*No differences between runs.*\n`;
  }

  text += `\n</details>`;
  return text;
}

/**
 * Format a PR's review history as a timeline.
 */
export function formatReplayTimeline(runs: ReplaySummary[]): string {
  if (runs.length === 0) return "*No review history for this PR.*";

  let text = `<details>\n<summary>Review History (${runs.length} run${runs.length > 1 ? "s" : ""})</summary>\n\n`;
  text += `| # | Run ID | Timestamp | Commit | Findings | Duration | Config Hash |\n`;
  text += `|---|--------|-----------|--------|----------|----------|-------------|\n`;
  runs.forEach((run, i) => {
    text += `| ${i + 1} | \`${run.runId.slice(0, 8)}\` | ${run.timestamp.slice(0, 19)} | \`${run.headSha.slice(0, 7)}\` | ${run.findings.length} | ${formatNumber(run.totalDurationMs)}ms | \`${run.configHash}\` |\n`;
  });

  const totalTokens = runs.reduce((s, r) => s + r.llmCalls.reduce((s2, c) => s2 + c.inputTokens + c.outputTokens, 0), 0);
  const totalFindings = runs.reduce((s, r) => s + r.findings.length, 0);
  text += `\n**Cumulative:** ${formatNumber(totalFindings)} findings across ${runs.length} run${runs.length > 1 ? "s" : ""}, ${formatNumber(totalTokens)} total tokens\n`;

  text += `\n</details>`;
  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trailToReplay(trail: AuditTrail): ReplaySummary {
  return {
    runId: trail.meta.runId,
    timestamp: trail.meta.timestamp,
    owner: trail.meta.owner,
    repo: trail.meta.repo,
    prNumber: trail.meta.prNumber,
    headSha: trail.meta.headSha,
    configHash: trail.meta.configHash,
    totalDurationMs: trail.totalDurationMs,
    stages: trail.stages,
    findings: trail.findings,
    llmCalls: trail.llmCalls,
    configSnapshot: trail.configSnapshot,
  };
}

function diffConfigs(configA: Record<string, unknown>, configB: Record<string, unknown>): ReplayDiff[] {
  const changes: ReplayDiff[] = [];
  const allKeys = new Set([...Object.keys(configA), ...Object.keys(configB)]);
  for (const key of allKeys) {
    const valA = configA[key];
    const valB = configB[key];
    if (JSON.stringify(valA) !== JSON.stringify(valB)) {
      changes.push({ field: key, runA: String(valA ?? "(unset)"), runB: String(valB ?? "(unset)") });
    }
  }
  return changes;
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}
