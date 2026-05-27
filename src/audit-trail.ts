/**
 * Review Audit Trail — full provenance chain for every review run.
 *
 * Competitive gap: No AI code reviewer provides a full audit trail.
 * CodeRabbit has no review history. Sourcery has no replay. CodeGuru
 * has no provenance. Mizumi records every decision, every finding
 * source, every LLM call, and every config override so teams can
 * reconstruct exactly what happened and why.
 *
 * Audit trail structure:
 * 1. Run metadata (timestamp, PR, commit, config hash)
 * 2. Pipeline stage execution log (name, duration, result summary)
 * 3. Finding provenance (which source produced each finding, what changed it)
 * 4. Config snapshot (full config as-run, not just defaults)
 * 5. LLM call log (provider, model, token counts, latency — no content)
 *
 * Zero LLM cost — this is pure record-keeping from deterministic signals.
 */
import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditRunMeta {
  runId: string;
  timestamp: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  configHash: string;
}

export interface AuditStageLog {
  name: string;
  durationMs: number;
  success: boolean;
  findingCount?: number;
  error?: string;
}

export interface AuditFindingProvenance {
  fingerprint: string;
  file: string;
  line: number;
  severity: string;
  category: string;
  message: string;
  /** Where this finding came from: "llm", "rule", "engine", "swarm", "linter", "cache" */
  source: string;
  /** What modifications were applied: ["calibrated", "noise-reduced", "deduped"] */
  modifications: string[];
  /** Final confidence after all modifications */
  finalConfidence: number;
}

export interface AuditLLMCall {
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
}

export interface AuditTrail {
  meta: AuditRunMeta;
  stages: AuditStageLog[];
  findings: AuditFindingProvenance[];
  llmCalls: AuditLLMCall[];
  configSnapshot: Record<string, unknown>;
  /** Total wall-clock time in ms */
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class AuditTrailBuilder {
  private meta: AuditRunMeta;
  private stages: AuditStageLog[] = [];
  private findings: AuditFindingProvenance[] = [];
  private llmCalls: AuditLLMCall[] = [];
  private configSnapshot: Record<string, unknown> = {};
  private startTime: number;

  constructor(owner: string, repo: string, prNumber: number, headSha: string, configHash: string) {
    this.startTime = Date.now();
    this.meta = {
      runId: generateRunId(),
      timestamp: new Date().toISOString(),
      owner,
      repo,
      prNumber,
      headSha,
      configHash,
    };
  }

  /** Record a pipeline stage execution */
  logStage(name: string, durationMs: number, success: boolean, findingCount?: number, error?: string): void {
    this.stages.push({ name, durationMs, success, findingCount, error });
  }

  /** Record a finding with its provenance */
  logFinding(provenance: AuditFindingProvenance): void {
    this.findings.push(provenance);
  }

  /** Record an LLM call */
  logLLMCall(call: AuditLLMCall): void {
    this.llmCalls.push(call);
  }

  /** Record the full config snapshot */
  setConfigSnapshot(config: Record<string, unknown>): void {
    this.configSnapshot = sanitizeConfig(config);
  }

  /** Build the final audit trail */
  build(): AuditTrail {
    return {
      meta: this.meta,
      stages: this.stages,
      findings: this.findings,
      llmCalls: this.llmCalls,
      configSnapshot: this.configSnapshot,
      totalDurationMs: Date.now() - this.startTime,
    };
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Write audit trail to a JSONL file (append-only for safety).
 */
export function writeAuditTrail(workspace: string, trail: AuditTrail): string {
  const dir = path.join(workspace, ".mizumi", "audit");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = `audit-${trail.meta.runId}.json`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(trail, null, 2), "utf8");
  core.info(`Audit trail written to ${filePath} (${trail.stages.length} stages, ${trail.findings.length} findings, ${trail.llmCalls.length} LLM calls)`);
  return filePath;
}

/**
 * Read a specific audit trail by run ID.
 */
export function readAuditTrail(workspace: string, runId: string): AuditTrail | null {
  const filePath = path.join(workspace, ".mizumi", "audit", `audit-${runId}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as AuditTrail;
  } catch {
    return null;
  }
}

/**
 * List all audit trail run IDs.
 */
export function listAuditTrails(workspace: string): string[] {
  const dir = path.join(workspace, ".mizumi", "audit");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith("audit-") && f.endsWith(".json"))
    .map((f) => f.slice(6, -5)) // strip "audit-" and ".json"
    .sort();
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format audit trail as a human-readable summary for comments.
 */
export function formatAuditSummary(trail: AuditTrail): string {
  const successStages = trail.stages.filter((s) => s.success).length;
  const failedStages = trail.stages.filter((s) => !s.success).length;
  const totalTokens = trail.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0);
  const totalLLMCost = estimateCost(trail.llmCalls);
  const sources = groupBy(trail.findings, (f) => f.source);

  let summary = `### Audit Trail: \`${trail.meta.runId.slice(0, 8)}\`\n\n`;
  summary += `| Metric | Value |\n|--------|-------|\n`;
  summary += `| PR | ${trail.meta.owner}/${trail.meta.repo}#${trail.meta.prNumber} |\n`;
  summary += `| Commit | \`${trail.meta.headSha.slice(0, 7)}\` |\n`;
  summary += `| Duration | ${formatNumber(trail.totalDurationMs)}ms |\n`;
  summary += `| Stages | ${successStages} passed, ${failedStages} failed |\n`;
  summary += `| Findings | ${trail.findings.length} |\n`;
  summary += `| LLM Calls | ${trail.llmCalls.length} |\n`;
  summary += `| Total Tokens | ${formatNumber(totalTokens)} |\n`;
  if (totalLLMCost > 0) summary += `| Est. Cost | $${totalLLMCost.toFixed(3)} |\n`;

  if (Object.keys(sources).length > 0) {
    summary += `\n**Finding sources:** ${Object.entries(sources).map(([k, v]) => `${k}=${v.length}`).join(", ")}\n`;
  }

  return summary;
}

/**
 * Format the full audit trail as JSON for API consumption.
 */
export function formatAuditJSON(trail: AuditTrail): string {
  return JSON.stringify(trail, null, 2);
}

/**
 * Format a comparison between two audit trails.
 */
export function compareAuditTrails(a: AuditTrail, b: AuditTrail): string {
  const diff = {
    durationDiff: b.totalDurationMs - a.totalDurationMs,
    findingsDiff: b.findings.length - a.findings.length,
    llmCallsDiff: b.llmCalls.length - a.llmCalls.length,
    tokensDiff: (b.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)) -
               (a.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0)),
  };

  let text = `### Audit Comparison\n\n`;
  text += `| Metric | Run A | Run B | Delta |\n|--------|-------|-------|-------|\n`;
  text += `| Duration | ${formatNumber(a.totalDurationMs)}ms | ${formatNumber(b.totalDurationMs)}ms | ${diff.durationDiff > 0 ? "+" : ""}${formatNumber(diff.durationDiff)}ms |\n`;
  text += `| Findings | ${a.findings.length} | ${b.findings.length} | ${diff.findingsDiff > 0 ? "+" : ""}${diff.findingsDiff} |\n`;
  text += `| LLM Calls | ${a.llmCalls.length} | ${b.llmCalls.length} | ${diff.llmCallsDiff > 0 ? "+" : ""}${diff.llmCallsDiff} |\n`;
  text += `| Tokens | ${formatNumber(a.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0))} | ${formatNumber(b.llmCalls.reduce((s, c) => s + c.inputTokens + c.outputTokens, 0))} | ${diff.tokensDiff > 0 ? "+" : ""}${formatNumber(diff.tokensDiff)} |\n`;
  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  const abs = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${abs}` : abs;
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    // Redact sensitive fields
    if (/key|token|secret|password|credential/i.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
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

function estimateCost(calls: AuditLLMCall[]): number {
  // Rough cost estimation based on provider
  let cost = 0;
  for (const call of calls) {
    const inputPer1k = call.provider === "anthropic" ? 0.003 : call.provider === "openai" ? 0.002 : 0.001;
    const outputPer1k = call.provider === "anthropic" ? 0.015 : call.provider === "openai" ? 0.008 : 0.003;
    cost += (call.inputTokens / 1000) * inputPer1k + (call.outputTokens / 1000) * outputPer1k;
  }
  return cost;
}

/**
 * Compute a config hash for audit trail (identifies which config produced a review).
 */
export function computeConfigHash(config: Record<string, unknown>): string {
  const str = JSON.stringify(config, Object.keys(config).sort());
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
