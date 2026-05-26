import { describe, it, expect } from "vitest";
import {
  computePriority,
  prioritizeFindings,
} from "../review-priority.js";
import type { ReviewCommentType } from "../review.js";

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: "src/auth/login.ts",
    line: 42,
    severity: "high",
    category: "security",
    message: "SQL injection vulnerability",
    confidence: 90,
    ...overrides,
  };
}

describe("computePriority", () => {
  it("gives high priority to critical security findings with high confidence", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "critical", category: "security", confidence: 100 }),
    });
    expect(result.priority).toBeGreaterThanOrEqual(7);
    expect(result.priorityLevel).toBe("high"); // 7 maps to "high" (critical requires >= 8)
  });

  it("gives low priority to nitpick style findings with low confidence", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "nitpick", category: "style", confidence: 50 }),
    });
    expect(result.priority).toBeLessThanOrEqual(3);
    expect(result.priorityLevel).toBe("low");
  });

  it("applies ownership boost for CODEOWNERS-owned files", () => {
    const without = computePriority({
      finding: makeFinding({ severity: "medium", category: "bug", confidence: 80 }),
    });
    const withOwnership = computePriority({
      finding: makeFinding({ severity: "medium", category: "bug", confidence: 80 }),
      isOwned: true,
    });
    expect(withOwnership.priority).toBeGreaterThanOrEqual(without.priority);
    expect(withOwnership.breakdown.ownershipBoost).toBe(2);
  });

  it("applies no ownership boost by default", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "medium", category: "bug", confidence: 80 }),
    });
    expect(result.breakdown.ownershipBoost).toBe(0);
  });

  it("applies intent alignment boost for security finding in security PR", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "security", confidence: 90 }),
      fileIntent: "security",
    });
    expect(result.breakdown.intentBoost).toBe(2);
  });

  it("applies intent alignment for bug finding in bugfix PR", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "bug", confidence: 85 }),
      fileIntent: "bugfix",
    });
    expect(result.breakdown.intentBoost).toBe(2);
  });

  it("applies intent alignment for performance finding in perf PR", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "medium", category: "performance", confidence: 80 }),
      fileIntent: "perf",
    });
    expect(result.breakdown.intentBoost).toBe(2);
  });

  it("no intent boost when finding category doesn't match intent", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "style", confidence: 80 }),
      fileIntent: "security",
    });
    expect(result.breakdown.intentBoost).toBe(0);
  });

  it("no intent boost when no fileIntent provided", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "security", confidence: 90 }),
    });
    expect(result.breakdown.intentBoost).toBe(0);
  });

  it("applies recurrence boost for cross-PR recurring findings", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "bug", confidence: 80 }),
      recurrenceCount: 3,
    });
    expect(result.breakdown.recurrenceBoost).toBe(3);
  });

  it("caps recurrence boost at 3", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "bug", confidence: 80 }),
      recurrenceCount: 10,
    });
    expect(result.breakdown.recurrenceBoost).toBe(3);
  });

  it("no recurrence boost by default", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "bug", confidence: 80 }),
    });
    expect(result.breakdown.recurrenceBoost).toBe(0);
  });

  it("applies category multiplier for security (1.5x)", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "security", confidence: 100 }),
    });
    expect(result.breakdown.categoryMultiplier).toBe(1.5);
  });

  it("applies category multiplier for bug (1.3x)", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "bug", confidence: 100 }),
    });
    expect(result.breakdown.categoryMultiplier).toBe(1.3);
  });

  it("applies reduced category multiplier for style (0.8x)", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "medium", category: "style", confidence: 80 }),
    });
    expect(result.breakdown.categoryMultiplier).toBe(0.8);
  });

  it("uses default multiplier for unknown category", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "medium", category: "architecture" as any, confidence: 80 }),
    });
    expect(result.breakdown.categoryMultiplier).toBe(1.0);
  });

  it("severity scores: critical=10, high=8, medium=5, low=2, nitpick=1", () => {
    const severities: Array<[string, number]> = [
      ["critical", 10],
      ["high", 8],
      ["medium", 5],
      ["low", 2],
      ["nitpick", 1],
    ];
    for (const [sev, expected] of severities) {
      const result = computePriority({
        finding: makeFinding({ severity: sev as any, category: "bug", confidence: 100 }),
      });
      expect(result.breakdown.severityScore).toBe(expected);
    }
  });

  it("normalizes priority to 1-10 range", () => {
    // Minimum possible: nitpick style at 50% confidence, no boosts
    const min = computePriority({
      finding: makeFinding({ severity: "nitpick", category: "style", confidence: 50 }),
    });
    expect(min.priority).toBeGreaterThanOrEqual(1);
    expect(min.priority).toBeLessThanOrEqual(10);

    // Maximum possible: critical security at 100% confidence, all boosts
    const max = computePriority({
      finding: makeFinding({ severity: "critical", category: "security", confidence: 100 }),
      isOwned: true,
      fileIntent: "security",
      recurrenceCount: 5,
    });
    expect(max.priority).toBeGreaterThanOrEqual(1);
    expect(max.priority).toBeLessThanOrEqual(10);
  });

  it("maps priority levels correctly", () => {
    // Critical level needs priority >= 8 (critical security + ownership + intent)
    const critical = computePriority({
      finding: makeFinding({ severity: "critical", category: "security", confidence: 100 }),
      isOwned: true,
      fileIntent: "security",
    });
    expect(critical.priorityLevel).toBe("critical");

    // High severity with ownership boost pushes to "high" level
    const high = computePriority({
      finding: makeFinding({ severity: "high", category: "bug", confidence: 90 }),
      isOwned: true,
    });
    expect(["critical", "high"]).toContain(high.priorityLevel);

    const low = computePriority({
      finding: makeFinding({ severity: "nitpick", category: "style", confidence: 40 }),
    });
    expect(["medium", "low"]).toContain(low.priorityLevel);
  });

  it("confidence factor is 0-1 scale", () => {
    const result = computePriority({
      finding: makeFinding({ confidence: 75 }),
    });
    expect(result.breakdown.confidenceFactor).toBe(0.75);
  });

  it("defaults confidence to 50 when undefined", () => {
    const result = computePriority({
      finding: makeFinding({ confidence: undefined as any }),
    });
    expect(result.breakdown.confidenceFactor).toBe(0.5);
  });

  it("includes raw score in breakdown", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "high", category: "security", confidence: 90, line: 1, message: "XSS", file: "a.ts" }),
      isOwned: true,
      fileIntent: "security",
      recurrenceCount: 2,
    });
    expect(result.breakdown.rawScore).toBeGreaterThan(0);
    // raw = (8 * 0.9 * 1.5) + 2 + 2 + 2 = 10.8 + 6 = 16.8
    expect(result.breakdown.rawScore).toBeCloseTo(16.8, 1);
  });
});

describe("prioritizeFindings", () => {
  it("sorts findings by priority descending", () => {
    const inputs = [
      { finding: makeFinding({ severity: "low", category: "style", confidence: 50 }) },
      { finding: makeFinding({ severity: "critical", category: "security", confidence: 100 }) },
      { finding: makeFinding({ severity: "medium", category: "bug", confidence: 70 }) },
    ];
    const result = prioritizeFindings(inputs);
    expect(result.findings[0].priority).toBeGreaterThanOrEqual(result.findings[1].priority);
    expect(result.findings[1].priority).toBeGreaterThanOrEqual(result.findings[2].priority);
  });

  it("computes correct average priority", () => {
    const inputs = [
      { finding: makeFinding({ severity: "high", category: "bug", confidence: 80 }) },
      { finding: makeFinding({ severity: "low", category: "style", confidence: 60 }) },
    ];
    const result = prioritizeFindings(inputs);
    expect(result.averagePriority).toBeGreaterThan(0);
    expect(result.averagePriority).toBeLessThanOrEqual(10);
  });

  it("returns average priority 0 for empty findings", () => {
    const result = prioritizeFindings([]);
    expect(result.averagePriority).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("generates context text with priority labels", () => {
    const inputs = [
      { finding: makeFinding({ severity: "critical", category: "security", confidence: 95, file: "src/auth.ts", line: 10, message: "SQL injection" }) },
    ];
    const result = prioritizeFindings(inputs);
    expect(result.contextText).toContain("Priority-Triaged");
    expect(result.contextText).toContain("P");
  });

  it("generates empty context text for no findings", () => {
    const result = prioritizeFindings([]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with priority distribution", () => {
    const inputs = [
      { finding: makeFinding({ severity: "critical", category: "security", confidence: 95 }) },
      { finding: makeFinding({ severity: "low", category: "style", confidence: 50 }) },
    ];
    const result = prioritizeFindings(inputs);
    expect(result.bodySummary).toContain("Priority Triage");
    expect(result.bodySummary).toContain("Critical");
    expect(result.bodySummary).toContain("Low");
  });

  it("generates empty body summary for no findings", () => {
    const result = prioritizeFindings([]);
    expect(result.bodySummary).toBe("");
  });

  it("body summary includes collapsible details block", () => {
    const inputs = [
      { finding: makeFinding({ severity: "high", category: "bug", confidence: 80 }) },
    ];
    const result = prioritizeFindings(inputs);
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("</details>");
  });

  it("context text limits to 10 findings", () => {
    const inputs = Array.from({ length: 15 }, (_, i) => ({
      finding: makeFinding({ file: `src/file${i}.ts`, line: i, category: "bug", message: `Bug ${i}`, confidence: 70 }),
    }));
    const result = prioritizeFindings(inputs);
    expect(result.contextText).toContain("5 more findings");
  });

  it("body summary counts per level", () => {
    const inputs = [
      { finding: makeFinding({ severity: "critical", category: "security", confidence: 100 }), isOwned: true, fileIntent: "security" },
      { finding: makeFinding({ severity: "high", category: "bug", confidence: 90 }) },
      { finding: makeFinding({ severity: "high", category: "bug", confidence: 85 }) },
      { finding: makeFinding({ severity: "nitpick", category: "style", confidence: 50 }) },
    ];
    const result = prioritizeFindings(inputs);
    // Verify the table structure exists
    expect(result.bodySummary).toContain("Critical");
    expect(result.bodySummary).toContain("High");
    expect(result.bodySummary).toContain("Low");
  });

  it("handles combined ownership + intent + recurrence boosts", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "critical", category: "security", confidence: 100 }),
      isOwned: true,
      fileIntent: "security",
      recurrenceCount: 3,
    });
    expect(result.breakdown.ownershipBoost).toBe(2);
    expect(result.breakdown.intentBoost).toBe(2);
    expect(result.breakdown.recurrenceBoost).toBe(3);
    expect(result.priority).toBeGreaterThanOrEqual(8);
  });

  it("compliance category gets 1.2x multiplier", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "medium", category: "compliance", confidence: 80 }),
    });
    expect(result.breakdown.categoryMultiplier).toBe(1.2);
  });

  it("performance category gets 1.1x multiplier", () => {
    const result = computePriority({
      finding: makeFinding({ severity: "medium", category: "performance", confidence: 80 }),
    });
    expect(result.breakdown.categoryMultiplier).toBe(1.1);
  });
});
