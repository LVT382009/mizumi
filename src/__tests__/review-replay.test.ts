import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getReplaySummary,
  findRunsForPR,
  findLatestRunForPR,
  compareReplays,
  formatReplaySummary,
  formatReplayComparison,
  formatReplayTimeline,
} from "../review-replay.js";
import type { ReplaySummary } from "../review-replay.js";
import { AuditTrailBuilder, writeAuditTrail } from "../audit-trail.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTrail(owner: string, repo: string, pr: number, sha: string, findingCount: number) {
  const builder = new AuditTrailBuilder(owner, repo, pr, sha, "abc12345");
  for (let i = 0; i < findingCount; i++) {
    builder.logFinding({
      fingerprint: `fp-${sha.slice(0, 4)}-${i}`,
      file: `src/file${i}.ts`,
      line: 10 + i,
      severity: i === 0 ? "critical" : "medium",
      category: i === 0 ? "security" : "bug",
      message: `Finding ${i} for ${sha.slice(0, 7)}`,
      source: i % 2 === 0 ? "llm" : "rule",
      modifications: i === 0 ? ["calibrated"] : [],
      finalConfidence: 70 + i * 3,
    });
  }
  builder.logStage("review", 1200, true, findingCount);
  builder.logStage("critique", 200, true);
  builder.logStage("calibration", 100, true);
  builder.logLLMCall({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    purpose: "review",
    inputTokens: 10000,
    outputTokens: 2000,
    latencyMs: 3500,
    success: true,
  });
  builder.setConfigSnapshot({ provider: "anthropic", model: "claude-sonnet-4-6", maxComments: 15 });
  return builder.build();
}

// ---------------------------------------------------------------------------
// getReplaySummary
// ---------------------------------------------------------------------------

describe("getReplaySummary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-replay-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent run", () => {
    const summary = getReplaySummary(tmpDir, "nonexistent");
    expect(summary).toBeNull();
  });

  it("returns replay summary for existing run", () => {
    const trail = buildTrail("owner", "repo", 42, "abc123", 3);
    writeAuditTrail(tmpDir, trail);
    const summary = getReplaySummary(tmpDir, trail.meta.runId);
    expect(summary).not.toBeNull();
    expect(summary!.runId).toBe(trail.meta.runId);
    expect(summary!.prNumber).toBe(42);
  });

  it("includes all findings in replay", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 5);
    writeAuditTrail(tmpDir, trail);
    const summary = getReplaySummary(tmpDir, trail.meta.runId);
    expect(summary!.findings).toHaveLength(5);
  });

  it("includes all stages in replay", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 2);
    writeAuditTrail(tmpDir, trail);
    const summary = getReplaySummary(tmpDir, trail.meta.runId);
    expect(summary!.stages).toHaveLength(3);
  });

  it("includes LLM calls in replay", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 1);
    writeAuditTrail(tmpDir, trail);
    const summary = getReplaySummary(tmpDir, trail.meta.runId);
    expect(summary!.llmCalls).toHaveLength(1);
    expect(summary!.llmCalls[0].provider).toBe("anthropic");
  });

  it("includes config snapshot in replay", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 1);
    writeAuditTrail(tmpDir, trail);
    const summary = getReplaySummary(tmpDir, trail.meta.runId);
    expect(summary!.configSnapshot.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// findRunsForPR
// ---------------------------------------------------------------------------

describe("findRunsForPR", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-replay-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no runs exist", () => {
    const runs = findRunsForPR(tmpDir, "owner", "repo", 1);
    expect(runs).toHaveLength(0);
  });

  it("returns runs matching PR", () => {
    const trail1 = buildTrail("owner", "repo", 42, "sha1", 2);
    const trail2 = buildTrail("owner", "repo", 42, "sha2", 3);
    writeAuditTrail(tmpDir, trail1);
    writeAuditTrail(tmpDir, trail2);
    const runs = findRunsForPR(tmpDir, "owner", "repo", 42);
    expect(runs).toHaveLength(2);
  });

  it("filters out runs from different repos", () => {
    const trail1 = buildTrail("owner", "repo", 42, "sha1", 2);
    const trail2 = buildTrail("other", "repo2", 42, "sha2", 1);
    writeAuditTrail(tmpDir, trail1);
    writeAuditTrail(tmpDir, trail2);
    const runs = findRunsForPR(tmpDir, "owner", "repo", 42);
    expect(runs).toHaveLength(1);
  });

  it("filters out runs from different PRs", () => {
    const trail1 = buildTrail("owner", "repo", 42, "sha1", 2);
    const trail2 = buildTrail("owner", "repo", 99, "sha2", 1);
    writeAuditTrail(tmpDir, trail1);
    writeAuditTrail(tmpDir, trail2);
    const runs = findRunsForPR(tmpDir, "owner", "repo", 42);
    expect(runs).toHaveLength(1);
  });

  it("sorts runs by timestamp", () => {
    const trail1 = buildTrail("o", "r", 1, "sha1", 1);
    const trail2 = buildTrail("o", "r", 1, "sha2", 2);
    writeAuditTrail(tmpDir, trail1);
    writeAuditTrail(tmpDir, trail2);
    const runs = findRunsForPR(tmpDir, "o", "r", 1);
    expect(runs).toHaveLength(2);
    // Both have valid timestamps, sorted chronologically
    expect(runs[0].timestamp <= runs[1].timestamp).toBe(true);
  });

  it("returns empty for no matching runs even when other PRs exist", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 1);
    writeAuditTrail(tmpDir, trail);
    const runs = findRunsForPR(tmpDir, "o", "r", 999);
    expect(runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findLatestRunForPR
// ---------------------------------------------------------------------------

describe("findLatestRunForPR", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-replay-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no runs exist", () => {
    const run = findLatestRunForPR(tmpDir, "o", "r", 1);
    expect(run).toBeNull();
  });

  it("returns the latest run for a PR", () => {
    const trail1 = buildTrail("o", "r", 1, "sha1", 1);
    const trail2 = buildTrail("o", "r", 1, "sha2", 3);
    writeAuditTrail(tmpDir, trail1);
    writeAuditTrail(tmpDir, trail2);
    const latest = findLatestRunForPR(tmpDir, "o", "r", 1);
    expect(latest).not.toBeNull();
    expect(latest!.findings).toHaveLength(3);
  });

  it("returns single run when only one exists", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 2);
    writeAuditTrail(tmpDir, trail);
    const latest = findLatestRunForPR(tmpDir, "o", "r", 1);
    expect(latest).not.toBeNull();
    expect(latest!.findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// compareReplays
// ---------------------------------------------------------------------------

describe("compareReplays", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-replay-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent run A", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 1);
    writeAuditTrail(tmpDir, trail);
    const comparison = compareReplays(tmpDir, "nonexistent", trail.meta.runId);
    expect(comparison).toBeNull();
  });

  it("returns null for non-existent run B", () => {
    const trail = buildTrail("o", "r", 1, "sha1", 1);
    writeAuditTrail(tmpDir, trail);
    const comparison = compareReplays(tmpDir, trail.meta.runId, "nonexistent");
    expect(comparison).toBeNull();
  });

  it("compares two runs and finds metric diffs", () => {
    const trailA = buildTrail("o", "r", 1, "sha1", 3);
    const trailB = buildTrail("o", "r", 1, "sha2", 5);
    writeAuditTrail(tmpDir, trailA);
    writeAuditTrail(tmpDir, trailB);
    const comparison = compareReplays(tmpDir, trailA.meta.runId, trailB.meta.runId);
    expect(comparison).not.toBeNull();
    expect(comparison!.diffs.length).toBeGreaterThan(0);
  });

  it("finds added findings in run B", () => {
    const builderA = new AuditTrailBuilder("o", "r", 1, "sha1", "hash1");
    builderA.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug A", source: "llm", modifications: [], finalConfidence: 80 });
    builderA.logStage("review", 1000, true, 1);
    const trailA = builderA.build();

    const builderB = new AuditTrailBuilder("o", "r", 1, "sha2", "hash1");
    builderB.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug A", source: "llm", modifications: [], finalConfidence: 80 });
    builderB.logFinding({ fingerprint: "fp-2", file: "b.ts", line: 2, severity: "critical", category: "security", message: "Bug B", source: "rule", modifications: [], finalConfidence: 90 });
    builderB.logStage("review", 1200, true, 2);
    const trailB = builderB.build();

    writeAuditTrail(tmpDir, trailA);
    writeAuditTrail(tmpDir, trailB);

    const comparison = compareReplays(tmpDir, trailA.meta.runId, trailB.meta.runId);
    expect(comparison!.findingsAdded).toHaveLength(1);
    expect(comparison!.findingsAdded[0].fingerprint).toBe("fp-2");
  });

  it("finds removed findings in run B", () => {
    const builderA = new AuditTrailBuilder("o", "r", 1, "sha1", "hash1");
    builderA.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug A", source: "llm", modifications: [], finalConfidence: 80 });
    builderA.logFinding({ fingerprint: "fp-2", file: "b.ts", line: 2, severity: "medium", category: "style", message: "Style B", source: "linter", modifications: [], finalConfidence: 60 });
    builderA.logStage("review", 1000, true, 2);
    const trailA = builderA.build();

    const builderB = new AuditTrailBuilder("o", "r", 1, "sha2", "hash1");
    builderB.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug A", source: "llm", modifications: [], finalConfidence: 80 });
    builderB.logStage("review", 800, true, 1);
    const trailB = builderB.build();

    writeAuditTrail(tmpDir, trailA);
    writeAuditTrail(tmpDir, trailB);

    const comparison = compareReplays(tmpDir, trailA.meta.runId, trailB.meta.runId);
    expect(comparison!.findingsRemoved).toHaveLength(1);
    expect(comparison!.findingsRemoved[0].fingerprint).toBe("fp-2");
  });

  it("finds changed findings between runs", () => {
    const builderA = new AuditTrailBuilder("o", "r", 1, "sha1", "hash1");
    builderA.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "medium", category: "bug", message: "Bug A", source: "llm", modifications: [], finalConfidence: 60 });
    builderA.logStage("review", 1000, true, 1);
    const trailA = builderA.build();

    const builderB = new AuditTrailBuilder("o", "r", 1, "sha2", "hash1");
    builderB.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug A", source: "llm", modifications: ["calibrated"], finalConfidence: 90 });
    builderB.logStage("review", 1200, true, 1);
    const trailB = builderB.build();

    writeAuditTrail(tmpDir, trailA);
    writeAuditTrail(tmpDir, trailB);

    const comparison = compareReplays(tmpDir, trailA.meta.runId, trailB.meta.runId);
    expect(comparison!.findingsChanged).toHaveLength(1);
  });

  it("detects config changes between runs", () => {
    const builderA = new AuditTrailBuilder("o", "r", 1, "sha1", "hash1");
    builderA.setConfigSnapshot({ provider: "anthropic", maxComments: 15 });
    builderA.logStage("review", 1000, true, 0);
    const trailA = builderA.build();

    const builderB = new AuditTrailBuilder("o", "r", 1, "sha2", "hash2");
    builderB.setConfigSnapshot({ provider: "openai", maxComments: 20 });
    builderB.logStage("review", 800, true, 0);
    const trailB = builderB.build();

    writeAuditTrail(tmpDir, trailA);
    writeAuditTrail(tmpDir, trailB);

    const comparison = compareReplays(tmpDir, trailA.meta.runId, trailB.meta.runId);
    expect(comparison!.configChanges.length).toBeGreaterThan(0);
  });

  it("handles identical runs with no diffs", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha1", "hash1");
    builder.logFinding({ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", source: "llm", modifications: [], finalConfidence: 80 });
    builder.logStage("review", 1000, true, 1);
    builder.setConfigSnapshot({ provider: "anthropic" });
    const trail = builder.build();
    writeAuditTrail(tmpDir, trail);

    const comparison = compareReplays(tmpDir, trail.meta.runId, trail.meta.runId);
    expect(comparison!.findingsAdded).toHaveLength(0);
    expect(comparison!.findingsRemoved).toHaveLength(0);
    expect(comparison!.findingsChanged).toHaveLength(0);
    expect(comparison!.configChanges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatReplaySummary
// ---------------------------------------------------------------------------

describe("formatReplaySummary", () => {
  function makeSummary(findings: number = 3): ReplaySummary {
    const builder = new AuditTrailBuilder("myorg", "myrepo", 42, "abcdef123456", "cfg12345");
    for (let i = 0; i < findings; i++) {
      builder.logFinding({
        fingerprint: `fp-${i}`,
        file: `src/file${i}.ts`,
        line: 10 + i,
        severity: i === 0 ? "critical" : "medium",
        category: i === 0 ? "security" : "bug",
        message: `Finding ${i}`,
        source: i % 2 === 0 ? "llm" : "rule",
        modifications: i === 0 ? ["calibrated"] : [],
        finalConfidence: 70 + i * 5,
      });
    }
    builder.logStage("review", 1200, true, findings);
    builder.logStage("critique", 200, true);
    builder.logStage("calibration", 50, false, undefined, "timeout");
    builder.logLLMCall({ provider: "anthropic", model: "sonnet-4-6", purpose: "review", inputTokens: 10000, outputTokens: 2000, latencyMs: 3500, success: true });
    builder.setConfigSnapshot({ provider: "anthropic", maxComments: 15 });
    const trail = builder.build();
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

  it("wraps in details block", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("<details>");
    expect(text).toContain("</details>");
    expect(text).toContain("<summary>");
  });

  it("includes run ID", () => {
    const summary = makeSummary();
    const text = formatReplaySummary(summary);
    expect(text).toContain(summary.runId);
  });

  it("includes PR reference", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("myorg/myrepo#42");
  });

  it("includes commit SHA truncated", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("abcdef1");
  });

  it("includes pipeline stages table", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("### Pipeline Stages");
    expect(text).toContain("review");
    expect(text).toContain("critique");
  });

  it("marks failed stages", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("fail");
  });

  it("includes findings table", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("### Findings");
    expect(text).toContain("fp-0");
  });

  it("includes finding source breakdown", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("llm=");
    expect(text).toContain("rule=");
  });

  it("handles zero findings", () => {
    const text = formatReplaySummary(makeSummary(0));
    expect(text).toContain("<details>");
    expect(text).toContain("0");
  });

  it("includes config hash", () => {
    const text = formatReplaySummary(makeSummary());
    expect(text).toContain("cfg12345");
  });
});

// ---------------------------------------------------------------------------
// formatReplayComparison
// ---------------------------------------------------------------------------

describe("formatReplayComparison", () => {
  it("wraps in details block", () => {
    const builderA = new AuditTrailBuilder("o", "r", 1, "sha1", "h1");
    builderA.logStage("review", 1000, true, 0);
    const trailA = builderA.build();

    const builderB = new AuditTrailBuilder("o", "r", 1, "sha2", "h2");
    builderB.logStage("review", 1200, true, 1);
    const trailB = builderB.build();

    const comparison = {
      runA: { runId: trailA.meta.runId, timestamp: trailA.meta.timestamp, owner: "o", repo: "r", prNumber: 1, headSha: "sha1", configHash: "h1", totalDurationMs: 1000, stages: trailA.stages, findings: trailA.findings, llmCalls: trailA.llmCalls, configSnapshot: trailA.configSnapshot },
      runB: { runId: trailB.meta.runId, timestamp: trailB.meta.timestamp, owner: "o", repo: "r", prNumber: 1, headSha: "sha2", configHash: "h2", totalDurationMs: 1200, stages: trailB.stages, findings: trailB.findings, llmCalls: trailB.llmCalls, configSnapshot: trailB.configSnapshot },
      diffs: [{ field: "Findings", runA: "0", runB: "1" }],
      findingsAdded: [],
      findingsRemoved: [],
      findingsChanged: [],
      configChanges: [],
    };

    const text = formatReplayComparison(comparison);
    expect(text).toContain("<details>");
    expect(text).toContain("</details>");
  });

  it("shows no differences message when runs are identical", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha1", "h1");
    builder.logStage("review", 1000, true, 0);
    const trail = builder.build();

    const comparison = {
      runA: { runId: trail.meta.runId, timestamp: trail.meta.timestamp, owner: "o", repo: "r", prNumber: 1, headSha: "sha1", configHash: "h1", totalDurationMs: 1000, stages: trail.stages, findings: trail.findings, llmCalls: trail.llmCalls, configSnapshot: trail.configSnapshot },
      runB: { runId: trail.meta.runId, timestamp: trail.meta.timestamp, owner: "o", repo: "r", prNumber: 1, headSha: "sha1", configHash: "h1", totalDurationMs: 1000, stages: trail.stages, findings: trail.findings, llmCalls: trail.llmCalls, configSnapshot: trail.configSnapshot },
      diffs: [{ field: "Duration", runA: "1,000ms", runB: "1,000ms" }],
      findingsAdded: [],
      findingsRemoved: [],
      findingsChanged: [],
      configChanges: [],
    };

    const text = formatReplayComparison(comparison);
    expect(text).toContain("No differences");
  });

  it("lists added findings", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha1", "h1");
    builder.logStage("review", 1000, true, 0);
    const trail = builder.build();

    const comparison = {
      runA: { runId: "a", timestamp: "", owner: "o", repo: "r", prNumber: 1, headSha: "s1", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      runB: { runId: "b", timestamp: "", owner: "o", repo: "r", prNumber: 1, headSha: "s2", configHash: "h2", totalDurationMs: 1200, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      diffs: [],
      findingsAdded: [{ fingerprint: "fp-1", file: "a.ts", line: 1, severity: "critical", category: "security", message: "SQL injection", source: "llm", modifications: [], finalConfidence: 95 }],
      findingsRemoved: [],
      findingsChanged: [],
      configChanges: [],
    };

    const text = formatReplayComparison(comparison);
    expect(text).toContain("New Findings");
    expect(text).toContain("SQL injection");
  });

  it("lists removed findings with strikethrough", () => {
    const comparison = {
      runA: { runId: "a", timestamp: "", owner: "o", repo: "r", prNumber: 1, headSha: "s1", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      runB: { runId: "b", timestamp: "", owner: "o", repo: "r", prNumber: 1, headSha: "s2", configHash: "h2", totalDurationMs: 1200, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      diffs: [],
      findingsAdded: [],
      findingsRemoved: [{ fingerprint: "fp-old", file: "old.ts", line: 5, severity: "medium", category: "style", message: "Use const", source: "linter", modifications: [], finalConfidence: 100 }],
      findingsChanged: [],
      configChanges: [],
    };

    const text = formatReplayComparison(comparison);
    expect(text).toContain("Removed Findings");
    expect(text).toContain("~~");
  });

  it("shows config changes when present", () => {
    const comparison = {
      runA: { runId: "a", timestamp: "", owner: "o", repo: "r", prNumber: 1, headSha: "s1", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      runB: { runId: "b", timestamp: "", owner: "o", repo: "r", prNumber: 1, headSha: "s2", configHash: "h2", totalDurationMs: 1200, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      diffs: [],
      findingsAdded: [],
      findingsRemoved: [],
      findingsChanged: [],
      configChanges: [{ field: "provider", runA: "anthropic", runB: "openai" }],
    };

    const text = formatReplayComparison(comparison);
    expect(text).toContain("Config Changes");
    expect(text).toContain("anthropic");
    expect(text).toContain("openai");
  });
});

// ---------------------------------------------------------------------------
// formatReplayTimeline
// ---------------------------------------------------------------------------

describe("formatReplayTimeline", () => {
  it("returns no-history message for empty runs", () => {
    const text = formatReplayTimeline([]);
    expect(text).toContain("No review history");
  });

  it("wraps in details block", () => {
    const runs: ReplaySummary[] = [{
      runId: "test-123", timestamp: "2026-05-27T10:00:00Z", owner: "o", repo: "r",
      prNumber: 1, headSha: "abc123", configHash: "h1", totalDurationMs: 1000,
      stages: [], findings: [], llmCalls: [], configSnapshot: {},
    }];
    const text = formatReplayTimeline(runs);
    expect(text).toContain("<details>");
    expect(text).toContain("</details>");
  });

  it("shows run count in summary", () => {
    const runs: ReplaySummary[] = [
      { runId: "r1", timestamp: "2026-05-27T10:00:00Z", owner: "o", repo: "r", prNumber: 1, headSha: "abc", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
      { runId: "r2", timestamp: "2026-05-27T11:00:00Z", owner: "o", repo: "r", prNumber: 1, headSha: "def", configHash: "h1", totalDurationMs: 1500, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
    ];
    const text = formatReplayTimeline(runs);
    expect(text).toContain("2 runs");
  });

  it("includes each run in the table", () => {
    const runs: ReplaySummary[] = [
      { runId: "r1", timestamp: "2026-05-27T10:00:00Z", owner: "o", repo: "r", prNumber: 1, headSha: "abc", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [{ fingerprint: "fp1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", source: "llm", modifications: [], finalConfidence: 80 }], llmCalls: [], configSnapshot: {} },
    ];
    const text = formatReplayTimeline(runs);
    expect(text).toContain("r1");
    expect(text).toContain("abc");
    expect(text).toContain("1"); // finding count
  });

  it("shows cumulative stats", () => {
    const runs: ReplaySummary[] = [
      { runId: "r1", timestamp: "2026-05-27T10:00:00Z", owner: "o", repo: "r", prNumber: 1, headSha: "abc", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [{ fingerprint: "fp1", file: "a.ts", line: 1, severity: "high", category: "bug", message: "Bug", source: "llm", modifications: [], finalConfidence: 80 }], llmCalls: [{ provider: "anthropic", model: "sonnet", purpose: "review", inputTokens: 5000, outputTokens: 1000, latencyMs: 3000, success: true }], configSnapshot: {} },
      { runId: "r2", timestamp: "2026-05-27T11:00:00Z", owner: "o", repo: "r", prNumber: 1, headSha: "def", configHash: "h1", totalDurationMs: 1500, stages: [], findings: [{ fingerprint: "fp2", file: "b.ts", line: 2, severity: "medium", category: "style", message: "Style", source: "linter", modifications: [], finalConfidence: 70 }], llmCalls: [{ provider: "anthropic", model: "sonnet", purpose: "review", inputTokens: 6000, outputTokens: 1200, latencyMs: 3500, success: true }], configSnapshot: {} },
    ];
    const text = formatReplayTimeline(runs);
    expect(text).toContain("Cumulative");
    expect(text).toContain("2 findings");
    expect(text).toContain("13,200"); // 5000+1000+6000+1200 = 13200
  });

  it("uses singular for single run", () => {
    const runs: ReplaySummary[] = [
      { runId: "r1", timestamp: "2026-05-27T10:00:00Z", owner: "o", repo: "r", prNumber: 1, headSha: "abc", configHash: "h1", totalDurationMs: 1000, stages: [], findings: [], llmCalls: [], configSnapshot: {} },
    ];
    const text = formatReplayTimeline(runs);
    expect(text).toContain("1 run");
    expect(text).not.toContain("1 runs");
  });
});
