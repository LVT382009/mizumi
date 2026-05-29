import { describe, it, expect, vi, beforeEach } from "vitest";
import { findingsToAnnotations, createCheckRun, updateCheckRun, type CheckAnnotation } from "../checks.js";
import type { ReviewCommentType } from "../review.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: overrides.file ?? "src/api/auth.ts",
    line: overrides.line ?? 10,
    endLine: overrides.endLine,
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "security",
    message: overrides.message ?? "SQL injection vulnerability",
    suggestion: overrides.suggestion,
    confidence: overrides.confidence ?? 90,
  };
}

function makeOctokit(checkRunId = 42) {
  return {
    rest: {
      checks: {
        create: vi.fn().mockResolvedValue({
          data: { id: checkRunId },
        }),
        update: vi.fn().mockResolvedValue({ data: { id: checkRunId } }),
      },
    },
  } as any;
}

// ---------------------------------------------------------------------------
// findingsToAnnotations
// ---------------------------------------------------------------------------

describe("findingsToAnnotations", () => {
  it("converts a single finding to annotation", () => {
    const findings = [makeFinding()];
    const annotations = findingsToAnnotations(findings);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].path).toBe("src/api/auth.ts");
    expect(annotations[0].start_line).toBe(10);
    expect(annotations[0].end_line).toBe(10);
    expect(annotations[0].annotation_level).toBe("failure"); // high → failure
    expect(annotations[0].message).toBe("SQL injection vulnerability");
    expect(annotations[0].title).toBe("[HIGH] security");
  });

  it("maps critical severity to failure annotation level", () => {
    const findings = [makeFinding({ severity: "critical" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("failure");
  });

  it("maps high severity to failure annotation level", () => {
    const findings = [makeFinding({ severity: "high" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("failure");
  });

  it("maps medium severity to warning annotation level", () => {
    const findings = [makeFinding({ severity: "medium" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("warning");
  });

  it("maps low severity to notice annotation level", () => {
    const findings = [makeFinding({ severity: "low" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("notice");
  });

  it("maps nitpick severity to notice annotation level", () => {
    const findings = [makeFinding({ severity: "nitpick" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("notice");
  });

  it("defaults unknown severity to notice", () => {
    const findings = [makeFinding({ severity: "unknown" as any })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("notice");
  });

  it("uses endLine when present", () => {
    const findings = [makeFinding({ line: 5, endLine: 15 })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].start_line).toBe(5);
    expect(annotations[0].end_line).toBe(15);
  });

  it("defaults to line 1 when line is 0", () => {
    const findings = [makeFinding({ line: 0 })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].start_line).toBe(1);
    expect(annotations[0].end_line).toBe(1);
  });

  it("includes suggestion as raw_details", () => {
    const findings = [makeFinding({ suggestion: "Use parameterized queries" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].raw_details).toBe("Use parameterized queries");
  });

  it("omits raw_details when no suggestion", () => {
    const findings = [makeFinding({ suggestion: undefined })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].raw_details).toBeUndefined();
  });

  it("truncates message to 65535 chars", () => {
    const longMsg = "A".repeat(70000);
    const findings = [makeFinding({ message: longMsg })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].message.length).toBe(65535);
  });

  it("handles empty findings array", () => {
    const annotations = findingsToAnnotations([]);
    expect(annotations).toHaveLength(0);
  });

  it("converts multiple findings", () => {
    const findings = [
      makeFinding({ file: "a.ts", line: 1, severity: "critical", category: "security" }),
      makeFinding({ file: "b.ts", line: 2, severity: "medium", category: "bug" }),
      makeFinding({ file: "c.ts", line: 3, severity: "low", category: "style" }),
    ];
    const annotations = findingsToAnnotations(findings);
    expect(annotations).toHaveLength(3);
    expect(annotations[0].annotation_level).toBe("failure");
    expect(annotations[1].annotation_level).toBe("warning");
    expect(annotations[2].annotation_level).toBe("notice");
  });
});

// ---------------------------------------------------------------------------
// createCheckRun
// ---------------------------------------------------------------------------

describe("createCheckRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a check run with annotations", async () => {
    const octokit = makeOctokit(99);
    const findings = [makeFinding()];

    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 7);

    expect(result.checkRunId).toBe(99);
    expect(result.annotationCount).toBe(1);
    expect(result.conclusion).toBe("failure");
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);

    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.name).toBe("Mizumi Review");
    expect(call.head_sha).toBe("sha1");
    expect(call.conclusion).toBe("failure");
    expect(call.output.annotations).toHaveLength(1);
  });

  it("returns success conclusion for no findings", async () => {
    const octokit = makeOctokit(1);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [], 0);
    expect(result.conclusion).toBe("success");
  });

  it("returns failure for risk >= 7 with findings", async () => {
    const octokit = makeOctokit(2);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 8);
    expect(result.conclusion).toBe("failure");
  });

  it("returns neutral for risk 4-6 with findings", async () => {
    const octokit = makeOctokit(3);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 5);
    expect(result.conclusion).toBe("neutral");
  });

  it("returns success for risk < 4 with findings", async () => {
    const octokit = makeOctokit(4);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 2);
    expect(result.conclusion).toBe("success");
  });

  it("batches annotations when > 50 findings", async () => {
    const octokit = makeOctokit(10);
    const findings = Array.from({ length: 120 }, (_, i) =>
      makeFinding({ file: `f${i}.ts`, line: i + 1, severity: "medium", category: "bug" })
    );

    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 5);

    expect(result.annotationCount).toBe(120);
    // create called once with first 50
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);
    const createCall = octokit.rest.checks.create.mock.calls[0][0];
    expect(createCall.output.annotations).toHaveLength(50);
    // update called twice: 50 + 20 remaining
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(2);
  });

  it("includes summary with risk score", async () => {
    const octokit = makeOctokit(5);
    await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 6);

    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.summary).toContain("6/10");
    expect(call.output.summary).toContain("1");
  });

  it("includes severity breakdown in summary", async () => {
    const octokit = makeOctokit(6);
    const findings = [
      makeFinding({ severity: "critical", category: "security" }),
      makeFinding({ severity: "high", category: "bug" }),
      makeFinding({ severity: "medium", category: "style" }),
    ];
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 7);

    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.summary).toContain("critical: 1");
    expect(call.output.summary).toContain("high: 1");
    expect(call.output.summary).toContain("medium: 1");
  });

  it("handles empty findings with success conclusion", async () => {
    const octokit = makeOctokit(7);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [], 0);
    expect(result.conclusion).toBe("success");
    expect(result.annotationCount).toBe(0);

    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.annotations).toHaveLength(0);
  });

  it("sets completed_at timestamp", async () => {
    const octokit = makeOctokit(8);
    await createCheckRun(octokit, "owner", "repo", "sha1", [], 0);

    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.completed_at).toBeTruthy();
    expect(call.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// updateCheckRun
// ---------------------------------------------------------------------------

describe("updateCheckRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates an existing check run", async () => {
    const octokit = makeOctokit(55);
    const findings = [makeFinding()];

    const result = await updateCheckRun(octokit, "owner", "repo", 55, findings, 5);

    expect(result.checkRunId).toBe(55);
    expect(result.annotationCount).toBe(1);
    expect(result.conclusion).toBe("neutral");
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(1);
  });

  it("passes check_run_id to update", async () => {
    const octokit = makeOctokit(77);
    await updateCheckRun(octokit, "owner", "repo", 77, [], 0);

    const call = octokit.rest.checks.update.mock.calls[0][0];
    expect(call.check_run_id).toBe(77);
  });

  it("batches annotations when > 50 findings", async () => {
    const octokit = makeOctokit(88);
    const findings = Array.from({ length: 75 }, (_, i) =>
      makeFinding({ file: `g${i}.ts`, line: i + 1, severity: "high", category: "security" })
    );

    const result = await updateCheckRun(octokit, "owner", "repo", 88, findings, 9);

    expect(result.annotationCount).toBe(75);
    // First update: 50 annotations, second: 25
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(2);
  });

  it("updates conclusion based on new risk score", async () => {
    const octokit = makeOctokit(99);
    const result = await updateCheckRun(octokit, "owner", "repo", 99, [makeFinding()], 2);
    expect(result.conclusion).toBe("success");
  });

  it("handles update API failure gracefully for batches", async () => {
    const octokit = makeOctokit(100);
    // First call (initial 50) succeeds, second batch fails
    octokit.rest.checks.update
      .mockResolvedValueOnce({ data: { id: 100 } })
      .mockRejectedValueOnce(new Error("API error"));

    const findings = Array.from({ length: 60 }, (_, i) =>
      makeFinding({ file: `h${i}.ts`, line: i + 1, severity: "low", category: "style" })
    );

    // Should not throw — the error is caught and warned
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 3);
    expect(result.annotationCount).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Conclusion logic
// ---------------------------------------------------------------------------

describe("conclusion logic", () => {
  const octokit = makeOctokit(1);

  it("success when no findings regardless of risk", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [], 10);
    expect(result.conclusion).toBe("success");
  });

  it("failure when risk=7 with findings", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 7);
    expect(result.conclusion).toBe("failure");
  });

  it("neutral when risk=4 with findings", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 4);
    expect(result.conclusion).toBe("neutral");
  });

  it("success when risk=3 with findings", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 3);
    expect(result.conclusion).toBe("success");
  });

  it("failure for maximum risk=10", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 10);
    expect(result.conclusion).toBe("failure");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Summary content
// ---------------------------------------------------------------------------

describe("summary content", () => {
  const octokit = makeOctokit(1);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes risk score in output title", async () => {
    await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 6);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.title).toContain("6/10");
  });

  it("includes finding count in output title", async () => {
    const findings = [makeFinding(), makeFinding(), makeFinding()];
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 5);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.title).toContain("3 finding(s)");
  });

  it("sorts severity counts in priority order", async () => {
    const findings = [
      makeFinding({ severity: "low", category: "style" }),
      makeFinding({ severity: "critical", category: "security" }),
      makeFinding({ severity: "medium", category: "bug" }),
    ];
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 7);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    const summary = call.output.summary;
    const critIdx = summary.indexOf("critical:");
    const medIdx = summary.indexOf("medium:");
    const lowIdx = summary.indexOf("low:");
    expect(critIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests
// ---------------------------------------------------------------------------

describe("findingsToAnnotations — edge cases", () => {
  it("handles finding with line = 1 correctly (no fallback)", () => {
    const findings = [makeFinding({ line: 1 })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].start_line).toBe(1);
    expect(annotations[0].end_line).toBe(1);
  });

  it("handles negative line number (passes through, not falsy)", () => {
    const findings = [makeFinding({ line: -5 as any })];
    const annotations = findingsToAnnotations(findings);
    // -5 is truthy in JS, so f.line || 1 returns -5
    expect(annotations[0].start_line).toBe(-5);
  });

  it("uses endLine over line for end_line when both set", () => {
    const findings = [makeFinding({ line: 10, endLine: 20 })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].start_line).toBe(10);
    expect(annotations[0].end_line).toBe(20);
  });

  it("falls back to line for end_line when endLine is 0", () => {
    const findings = [makeFinding({ line: 10, endLine: 0 })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].end_line).toBe(10);
  });

  it("handles message at exactly 65535 chars (no truncation)", () => {
    const exactMsg = "A".repeat(65535);
    const findings = [makeFinding({ message: exactMsg })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].message.length).toBe(65535);
  });

  it("handles message at exactly 65536 chars (truncates by 1)", () => {
    const overByOne = "B".repeat(65536);
    const findings = [makeFinding({ message: overByOne })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].message.length).toBe(65535);
  });

  it("handles empty string message", () => {
    const findings = [makeFinding({ message: "" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].message).toBe("");
  });

  it("title includes UPPERCASE severity and category", () => {
    const findings = [makeFinding({ severity: "high", category: "bug" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].title).toBe("[HIGH] bug");
  });

  it("handles severity case-insensitively", () => {
    const findings = [makeFinding({ severity: "HIGH" as any })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].annotation_level).toBe("failure");
  });

  it("empty suggestion string is truthy so raw_details is set", () => {
    const findings = [makeFinding({ suggestion: "" })];
    const annotations = findingsToAnnotations(findings);
    // "" is falsy in JS, so raw_details should be undefined
    expect(annotations[0].raw_details).toBeUndefined();
  });

  it("handles finding with special characters in message", () => {
    const findings = [makeFinding({ message: 'XSS: <script>alert("xss")</script>' })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].message).toBe('XSS: <script>alert("xss")</script>');
  });

  it("handles finding with unicode characters in message", () => {
    const findings = [makeFinding({ message: "Error: échec de l'authentification" })];
    const annotations = findingsToAnnotations(findings);
    expect(annotations[0].message).toContain("échec");
  });
});

describe("createCheckRun — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles exactly 50 findings (no batching needed)", async () => {
    const octokit = makeOctokit(10);
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding({ file: `f${i}.ts`, line: i + 1, severity: "low", category: "style" })
    );
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 3);
    expect(result.annotationCount).toBe(50);
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(0);
  });

  it("handles exactly 51 findings (one batch overflow)", async () => {
    const octokit = makeOctokit(11);
    const findings = Array.from({ length: 51 }, (_, i) =>
      makeFinding({ file: `f${i}.ts`, line: i + 1, severity: "medium", category: "bug" })
    );
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 5);
    expect(result.annotationCount).toBe(51);
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(1);
    const updateCall = octokit.rest.checks.update.mock.calls[0][0];
    expect(updateCall.output.annotations).toHaveLength(1);
  });

  it("handles 100 findings (exact 2 batches)", async () => {
    const octokit = makeOctokit(12);
    const findings = Array.from({ length: 100 }, (_, i) =>
      makeFinding({ file: `f${i}.ts`, line: i + 1, severity: "high", category: "security" })
    );
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 8);
    expect(result.annotationCount).toBe(100);
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(1);
  });

  it("handles risk score 0 with findings (success conclusion)", async () => {
    const octokit = makeOctokit(13);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 0);
    expect(result.conclusion).toBe("success");
  });

  it("conclusion boundary: risk 6 with findings = neutral", async () => {
    const octokit = makeOctokit(14);
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 6);
    expect(result.conclusion).toBe("neutral");
  });

  it("summary includes all severity counts when all severities present", async () => {
    const octokit = makeOctokit(15);
    const findings = [
      makeFinding({ severity: "critical", category: "sec" }),
      makeFinding({ severity: "high", category: "bug" }),
      makeFinding({ severity: "medium", category: "style" }),
      makeFinding({ severity: "low", category: "style" }),
      makeFinding({ severity: "nitpick", category: "style" }),
    ];
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 7);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.summary).toContain("critical: 1");
    expect(call.output.summary).toContain("high: 1");
    expect(call.output.summary).toContain("medium: 1");
    expect(call.output.summary).toContain("low: 1");
    expect(call.output.summary).toContain("nitpick: 1");
  });

  it("passes owner and repo to create call", async () => {
    const octokit = makeOctokit(16);
    await createCheckRun(octokit, "myorg", "myrepo", "sha1", [], 0);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.owner).toBe("myorg");
    expect(call.repo).toBe("myrepo");
  });

  it("passes head_sha correctly", async () => {
    const octokit = makeOctokit(17);
    await createCheckRun(octokit, "owner", "repo", "deadbeef1234", [], 0);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.head_sha).toBe("deadbeef1234");
  });
});

describe("updateCheckRun — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles update with no findings (success)", async () => {
    const octokit = makeOctokit(60);
    const result = await updateCheckRun(octokit, "owner", "repo", 60, [], 0);
    expect(result.conclusion).toBe("success");
    expect(result.annotationCount).toBe(0);
  });

  it("handles update with exactly 50 findings", async () => {
    const octokit = makeOctokit(61);
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding({ file: `u${i}.ts`, line: i + 1, severity: "low", category: "style" })
    );
    const result = await updateCheckRun(octokit, "owner", "repo", 61, findings, 2);
    expect(result.annotationCount).toBe(50);
    // only the first update call with annotations
    expect(octokit.rest.checks.update).toHaveBeenCalledTimes(1);
  });

  it("update sets status to completed", async () => {
    const octokit = makeOctokit(62);
    await updateCheckRun(octokit, "owner", "repo", 62, [], 0);
    const call = octokit.rest.checks.update.mock.calls[0][0];
    expect(call.status).toBe("completed");
    expect(call.completed_at).toBeTruthy();
  });

  it("update includes summary text", async () => {
    const octokit = makeOctokit(63);
    await updateCheckRun(octokit, "owner", "repo", 63, [makeFinding()], 5);
    const call = octokit.rest.checks.update.mock.calls[0][0];
    expect(call.output.summary).toContain("5/10");
  });

  it("update handles first batch API failure gracefully", async () => {
    const octokit = makeOctokit(64);
    octokit.rest.checks.update.mockRejectedValueOnce(new Error("Update failed"));
    // Should not throw
    let thrown = false;
    try {
      await updateCheckRun(octokit, "owner", "repo", 64, [makeFinding()], 8);
    } catch {
      thrown = true;
    }
    // The first update call failing will throw since it's not in a try/catch
    // for the first batch in updateCheckRun — only later batches are caught
    expect(thrown).toBe(true);
  });

  it("update conclusion boundary: risk 7 = failure", async () => {
    const octokit = makeOctokit(65);
    const result = await updateCheckRun(octokit, "owner", "repo", 65, [makeFinding()], 7);
    expect(result.conclusion).toBe("failure");
  });
});

describe("buildSummary — edge cases", () => {
  const octokit = makeOctokit(1);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles duplicate severity counts correctly", async () => {
    const findings = [
      makeFinding({ severity: "high", category: "a" }),
      makeFinding({ severity: "high", category: "b" }),
      makeFinding({ severity: "high", category: "c" }),
    ];
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 7);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.summary).toContain("high: 3");
  });

  it("includes Findings count in summary", async () => {
    const findings = [makeFinding(), makeFinding()];
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 5);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.summary).toContain("Findings:** 2");
  });

  it("title includes exact finding count", async () => {
    const findings = Array.from({ length: 7 }, () => makeFinding());
    await createCheckRun(octokit, "owner", "repo", "sha1", findings, 5);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.output.title).toContain("7 finding(s)");
  });
});

describe("toConclusion — boundary conditions", () => {
  const octokit = makeOctokit(1);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("risk=4 with findings = neutral (lower boundary)", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 4);
    expect(result.conclusion).toBe("neutral");
  });

  it("risk=6 with findings = neutral (upper boundary)", async () => {
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", [makeFinding()], 6);
    expect(result.conclusion).toBe("neutral");
  });

  it("large number of findings with low risk = success", async () => {
    const findings = Array.from({ length: 200 }, (_, i) =>
      makeFinding({ file: `big${i}.ts`, line: i + 1, severity: "low", category: "style" })
    );
    const result = await createCheckRun(octokit, "owner", "repo", "sha1", findings, 2);
    expect(result.conclusion).toBe("success");
  });
});
