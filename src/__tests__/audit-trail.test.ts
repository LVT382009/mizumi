import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AuditTrailBuilder,
  writeAuditTrail,
  readAuditTrail,
  listAuditTrails,
  formatAuditSummary,
  formatAuditJSON,
  compareAuditTrails,
  computeConfigHash,
} from "../audit-trail.js";
import type { AuditTrail, AuditFindingProvenance } from "../audit-trail.js";

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
// AuditTrailBuilder
// ---------------------------------------------------------------------------

describe("AuditTrailBuilder", () => {
  it("builds audit trail with run metadata", () => {
    const builder = new AuditTrailBuilder("owner", "repo", 42, "abc123", "confighash");
    const trail = builder.build();
    expect(trail.meta.owner).toBe("owner");
    expect(trail.meta.repo).toBe("repo");
    expect(trail.meta.prNumber).toBe(42);
    expect(trail.meta.headSha).toBe("abc123");
    expect(trail.meta.configHash).toBe("confighash");
    expect(trail.meta.runId).toBeTruthy();
    expect(trail.meta.timestamp).toBeTruthy();
  });

  it("records pipeline stages", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    builder.logStage("review", 1200, true, 5);
    builder.logStage("calibration", 300, true, 3);
    builder.logStage("compliance", 200, false, undefined, "API error");
    const trail = builder.build();
    expect(trail.stages).toHaveLength(3);
    expect(trail.stages[0].name).toBe("review");
    expect(trail.stages[0].success).toBe(true);
    expect(trail.stages[2].error).toBe("API error");
  });

  it("records finding provenance", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    builder.logFinding({
      fingerprint: "abc12345",
      file: "src/app.ts",
      line: 10,
      severity: "critical",
      category: "security",
      message: "SQL injection",
      source: "llm",
      modifications: ["calibrated", "noise-reduced"],
      finalConfidence: 95,
    });
    const trail = builder.build();
    expect(trail.findings).toHaveLength(1);
    expect(trail.findings[0].source).toBe("llm");
    expect(trail.findings[0].modifications).toContain("calibrated");
  });

  it("records LLM calls", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    builder.logLLMCall({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      purpose: "review",
      inputTokens: 10000,
      outputTokens: 2000,
      latencyMs: 3500,
      success: true,
    });
    const trail = builder.build();
    expect(trail.llmCalls).toHaveLength(1);
    expect(trail.llmCalls[0].provider).toBe("anthropic");
    expect(trail.llmCalls[0].latencyMs).toBe(3500);
  });

  it("records config snapshot with redacted secrets", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    builder.setConfigSnapshot({
      provider: "anthropic",
      apiKey: "sk-super-secret-key",
      maxComments: 15,
      password: "hunter2",
    });
    const trail = builder.build();
    expect(trail.configSnapshot.provider).toBe("anthropic");
    expect(trail.configSnapshot.apiKey).toBe("[REDACTED]");
    expect(trail.configSnapshot.password).toBe("[REDACTED]");
    expect(trail.configSnapshot.maxComments).toBe(15);
  });

  it("calculates total duration", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    const trail = builder.build();
    expect(trail.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("generates unique run IDs", () => {
    const b1 = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    const b2 = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    expect(b1.build().meta.runId).not.toBe(b2.build().meta.runId);
  });

  it("handles empty trail", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    const trail = builder.build();
    expect(trail.stages).toHaveLength(0);
    expect(trail.findings).toHaveLength(0);
    expect(trail.llmCalls).toHaveLength(0);
  });

  it("handles multiple findings from different sources", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    const sources = ["llm", "rule", "engine", "swarm", "linter", "cache"];
    for (const source of sources) {
      builder.logFinding({
        fingerprint: `fp-${source}`,
        file: `${source}.ts`,
        line: 1,
        severity: "medium",
        category: "bug",
        message: `Finding from ${source}`,
        source,
        modifications: [],
        finalConfidence: 80,
      });
    }
    const trail = builder.build();
    expect(trail.findings).toHaveLength(6);
    const trailSources = trail.findings.map((f) => f.source);
    expect(trailSources).toContain("llm");
    expect(trailSources).toContain("cache");
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("persistence", () => {
  let tmpDir: string;
  let trail: AuditTrail;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-audit-"));
    const builder = new AuditTrailBuilder("owner", "repo", 42, "abc123def", "abc12345");
    builder.logStage("review", 1200, true, 5);
    builder.logStage("critique", 200, true, 3);
    builder.logFinding({
      fingerprint: "12345678",
      file: "src/a.ts",
      line: 10,
      severity: "high",
      category: "bug",
      message: "Null deref",
      source: "llm",
      modifications: [],
      finalConfidence: 85,
    });
    builder.logLLMCall({
      provider: "openai",
      model: "gpt-4.1-mini",
      purpose: "review",
      inputTokens: 5000,
      outputTokens: 1000,
      latencyMs: 2000,
      success: true,
    });
    trail = builder.build();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes audit trail to .mizumi/audit/", () => {
    const filePath = writeAuditTrail(tmpDir, trail);
    expect(filePath).toContain("audit-");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("writes valid JSON", () => {
    writeAuditTrail(tmpDir, trail);
    const content = fs.readFileSync(
      path.join(tmpDir, ".mizumi", "audit", `audit-${trail.meta.runId}.json`),
      "utf8",
    );
    const parsed = JSON.parse(content);
    expect(parsed.meta.runId).toBe(trail.meta.runId);
  });

  it("reads audit trail by run ID", () => {
    writeAuditTrail(tmpDir, trail);
    const read = readAuditTrail(tmpDir, trail.meta.runId);
    expect(read).not.toBeNull();
    expect(read!.meta.runId).toBe(trail.meta.runId);
    expect(read!.stages).toHaveLength(2);
    expect(read!.findings).toHaveLength(1);
  });

  it("returns null for non-existent run ID", () => {
    const read = readAuditTrail(tmpDir, "nonexistent");
    expect(read).toBeNull();
  });

  it("lists audit trail run IDs", () => {
    writeAuditTrail(tmpDir, trail);
    const ids = listAuditTrails(tmpDir);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(trail.meta.runId);
  });

  it("returns empty list when no audits exist", () => {
    const ids = listAuditTrails(tmpDir);
    expect(ids).toHaveLength(0);
  });

  it("sorts audit trails by run ID", () => {
    writeAuditTrail(tmpDir, trail);
    const builder2 = new AuditTrailBuilder("o", "r", 2, "sha2", "hash2");
    const trail2 = builder2.build();
    writeAuditTrail(tmpDir, trail2);
    const ids = listAuditTrails(tmpDir);
    expect(ids).toHaveLength(2);
    // Should be sorted
    expect(ids[0] <= ids[1]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatAuditSummary
// ---------------------------------------------------------------------------

describe("formatAuditSummary", () => {
  function makeTrail(overrides?: Partial<AuditTrail>): AuditTrail {
    const builder = new AuditTrailBuilder("myorg", "myrepo", 42, "abcdef123456", "cfg12345");
    builder.logStage("review", 1200, true, 5);
    builder.logStage("critique", 200, true, 3);
    builder.logStage("calibration", 100, false, undefined, "timeout");
    builder.logFinding({
      fingerprint: "aaaa1111",
      file: "src/a.ts",
      line: 10,
      severity: "high",
      category: "bug",
      message: "Bug",
      source: "llm",
      modifications: ["calibrated"],
      finalConfidence: 85,
    });
    builder.logFinding({
      fingerprint: "bbbb2222",
      file: "src/b.ts",
      line: 20,
      severity: "critical",
      category: "security",
      message: "Vuln",
      source: "rule",
      modifications: [],
      finalConfidence: 100,
    });
    builder.logLLMCall({
      provider: "anthropic",
      model: "sonnet-4-6",
      purpose: "review",
      inputTokens: 10000,
      outputTokens: 2000,
      latencyMs: 3500,
      success: true,
    });
    return { ...builder.build(), ...overrides };
  }

  it("includes run ID", () => {
    const trail = makeTrail();
    const summary = formatAuditSummary(trail);
    expect(summary).toContain(trail.meta.runId.slice(0, 8));
  });

  it("includes PR reference", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("myorg/myrepo#42");
  });

  it("includes commit SHA (truncated)", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("abcdef1");
  });

  it("includes stage success/failure counts", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("passed");
    expect(summary).toContain("failed");
  });

  it("includes finding count", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("2");
  });

  it("includes token count", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("12,000");
  });

  it("includes estimated cost when > 0", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("$");
  });

  it("includes finding sources breakdown", () => {
    const summary = formatAuditSummary(makeTrail());
    expect(summary).toContain("llm=");
    expect(summary).toContain("rule=");
  });

  it("handles trail with no LLM calls", () => {
    const trail = makeTrail();
    trail.llmCalls = [];
    const summary = formatAuditSummary(trail);
    expect(summary).toContain("0");
  });
});

// ---------------------------------------------------------------------------
// formatAuditJSON
// ---------------------------------------------------------------------------

describe("formatAuditJSON", () => {
  it("produces valid JSON", () => {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    const trail = builder.build();
    const json = formatAuditJSON(trail);
    const parsed = JSON.parse(json);
    expect(parsed.meta).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// compareAuditTrails
// ---------------------------------------------------------------------------

describe("compareAuditTrails", () => {
  function makeSimpleTrail(findings: number, duration: number): AuditTrail {
    const builder = new AuditTrailBuilder("o", "r", 1, "sha", "hash");
    for (let i = 0; i < findings; i++) {
      builder.logFinding({
        fingerprint: `fp-${i}`,
        file: `${i}.ts`,
        line: i,
        severity: "medium",
        category: "bug",
        message: `Finding ${i}`,
        source: "llm",
        modifications: [],
        finalConfidence: 80,
      });
    }
    const trail = builder.build();
    trail.totalDurationMs = duration;
    return trail;
  }

  it("shows duration delta", () => {
    const a = makeSimpleTrail(3, 1000);
    const b = makeSimpleTrail(3, 1500);
    const comparison = compareAuditTrails(a, b);
    expect(comparison).toContain("+500ms");
  });

  it("shows findings delta", () => {
    const a = makeSimpleTrail(5, 1000);
    const b = makeSimpleTrail(8, 1000);
    const comparison = compareAuditTrails(a, b);
    expect(comparison).toContain("+3");
  });

  it("shows negative delta with minus sign", () => {
    const a = makeSimpleTrail(5, 2000);
    const b = makeSimpleTrail(3, 1000);
    const comparison = compareAuditTrails(a, b);
    expect(comparison).toContain("-2");
    expect(comparison).toContain("-1,000ms");
  });

  it("includes both run values", () => {
    const a = makeSimpleTrail(5, 1000);
    const b = makeSimpleTrail(3, 2000);
    const comparison = compareAuditTrails(a, b);
    expect(comparison).toContain("1,000ms");
    expect(comparison).toContain("2,000ms");
  });
});

// ---------------------------------------------------------------------------
// computeConfigHash
// ---------------------------------------------------------------------------

describe("computeConfigHash", () => {
  it("returns 8-char hex string", () => {
    const hash = computeConfigHash({ provider: "anthropic" });
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("same config gives same hash", () => {
    const config = { provider: "openai", maxComments: 15 };
    expect(computeConfigHash(config)).toBe(computeConfigHash(config));
  });

  it("different config gives different hash", () => {
    const a = computeConfigHash({ provider: "anthropic" });
    const b = computeConfigHash({ provider: "openai" });
    expect(a).not.toBe(b);
  });

  it("is order-independent (sorted keys)", () => {
    const a = computeConfigHash({ provider: "anthropic", maxComments: 15 });
    const b = computeConfigHash({ maxComments: 15, provider: "anthropic" });
    expect(a).toBe(b);
  });

  it("handles empty config", () => {
    const hash = computeConfigHash({});
    expect(hash).toHaveLength(8);
  });
});
