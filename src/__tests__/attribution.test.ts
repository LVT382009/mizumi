import { describe, it, expect, vi } from "vitest";
import {
  computeAttribution,
  applyAttributionConfidence,
  buildAttributionContext,
} from "../attribution.js";
import type { FeedbackStore, FeedbackEntry } from "../feedback.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(entries: Partial<FeedbackEntry>[]): FeedbackStore {
  return {
    entries: entries.map((e, i) => ({
      repo: e.repo || "o/r",
      pr: e.pr || 1,
      commentId: e.commentId || i,
      file: e.file || "a.ts",
      line: e.line || i,
      category: e.category || "bug",
      severity: e.severity || "medium",
      messageHash: e.messageHash || "h",
      outcome: e.outcome || "pending",
      createdAt: e.createdAt || new Date().toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// computeAttribution
// ---------------------------------------------------------------------------

describe("computeAttribution", () => {
  it("returns empty categories for no feedback", () => {
    const result = computeAttribution({ entries: [] });
    expect(result.categories).toHaveLength(0);
    expect(result.entriesAnalyzed).toBe(0);
    expect(result.reliableCategories).toBe(0);
  });

  it("ignores pending entries", () => {
    const store = makeStore([
      { category: "bug", outcome: "pending" },
      { category: "bug", outcome: "pending" },
    ]);
    const result = computeAttribution(store);
    expect(result.categories).toHaveLength(0);
  });

  it("computes dismissal rate per category", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    // 10 entries: 3 helpful, 7 unhelpful for "style"
    for (let i = 0; i < 3; i++) entries.push({ category: "style", outcome: "helpful" });
    for (let i = 0; i < 7; i++) entries.push({ category: "style", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style).toBeDefined();
    expect(style!.total).toBe(10);
    expect(style!.dismissalRate).toBeGreaterThan(0.5);
    expect(style!.isReliable).toBe(true);
  });

  it("marks categories with <10 samples as unreliable", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 5; i++) entries.push({ category: "style", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style?.isReliable).toBe(false);
  });

  it("applies confidence penalty for high dismissal categories", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 15; i++) entries.push({ category: "style", outcome: "unhelpful" });
    for (let i = 0; i < 2; i++) entries.push({ category: "style", outcome: "helpful" });

    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style!.confidencePenalty).toBeGreaterThan(0);
    expect(style!.confidencePenalty).toBeLessThanOrEqual(75);
  });

  it("applies zero penalty when dismissal rate is below 40%", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 12; i++) entries.push({ category: "bug", outcome: "helpful" });
    for (let i = 0; i < 3; i++) entries.push({ category: "bug", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    const bug = result.categories.find((c) => c.category === "bug");
    expect(bug!.confidencePenalty).toBe(0);
  });

  it("sorts categories by dismissal rate (highest first)", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 12; i++) entries.push({ category: "bug", outcome: "helpful" });
    for (let i = 0; i < 12; i++) entries.push({ category: "style", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    expect(result.categories[0].category).toBe("style");
    expect(result.categories[1].category).toBe("bug");
  });

  it("handles multiple categories independently", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 15; i++) entries.push({ category: "security", outcome: "helpful" });
    for (let i = 0; i < 15; i++) entries.push({ category: "style", outcome: "unhelpful" });
    for (let i = 0; i < 10; i++) entries.push({ category: "performance", outcome: "helpful" });
    for (let i = 0; i < 10; i++) entries.push({ category: "performance", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    expect(result.categories).toHaveLength(3);
    expect(result.reliableCategories).toBe(3);
  });

  it("weights recent entries more heavily with recency decay", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1000 * 60 * 60).toISOString(); // 1 hour ago
    const old = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 90).toISOString(); // 90 days ago

    const store = makeStore([
      { category: "style", outcome: "unhelpful", createdAt: old },
      { category: "style", outcome: "helpful", createdAt: recent },
    ]);
    const result = computeAttribution(store);
    const style = result.categories.find((c) => c.category === "style");
    // Recent helpful entry should outweigh old unhelpful
    expect(style!.dismissalRate).toBeLessThan(0.5);
  });

  it("counts raw totals correctly regardless of recency weighting", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 6; i++) entries.push({ category: "bug", outcome: "helpful" });
    for (let i = 0; i < 6; i++) entries.push({ category: "bug", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    const bug = result.categories.find((c) => c.category === "bug");
    expect(bug!.total).toBe(12);
    expect(bug!.helpful).toBe(6);
    expect(bug!.dismissed).toBe(6);
  });

  it("caps confidence penalty at 75", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 100; i++) entries.push({ category: "style", outcome: "unhelpful" });

    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style!.confidencePenalty).toBeLessThanOrEqual(75);
  });
});

// ---------------------------------------------------------------------------
// applyAttributionConfidence
// ---------------------------------------------------------------------------

describe("applyAttributionConfidence", () => {
  it("returns findings unchanged when no reliable categories", () => {
    const findings = [
      { category: "style", confidence: 80 },
      { category: "bug", confidence: 90 },
    ];
    const attribution = { categories: [], reliableCategories: 0, entriesAnalyzed: 0 };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBe(80);
    expect(result[1].confidence).toBe(90);
  });

  it("reduces confidence for matching categories", () => {
    const findings = [
      { category: "style", confidence: 80 },
      { category: "bug", confidence: 90 },
    ];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBeLessThan(80);
    expect(result[0].confidence).toBeGreaterThanOrEqual(10);
    expect(result[1].confidence).toBe(90); // bug not penalized
  });

  it("does not reduce confidence below 10", () => {
    const findings = [{ category: "style", confidence: 30 }];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 20, helpful: 0, dismissed: 20,
        dismissalRate: 1.0, confidencePenalty: 75, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBeGreaterThanOrEqual(10);
  });

  it("does not penalize categories with <40% dismissal", () => {
    const findings = [{ category: "bug", confidence: 85 }];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "bug", total: 20, helpful: 14, dismissed: 6,
        dismissalRate: 0.3, confidencePenalty: 0, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBe(85);
  });

  it("ignores unreliable categories", () => {
    const findings = [{ category: "style", confidence: 80 }];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 3, helpful: 0, dismissed: 3,
        dismissalRate: 1.0, confidencePenalty: 75, isReliable: false,
      }],
      reliableCategories: 0,
      entriesAnalyzed: 3,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBe(80);
  });

  it("handles empty findings array", () => {
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 20, helpful: 0, dismissed: 20,
        dismissalRate: 1.0, confidencePenalty: 75, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = applyAttributionConfidence([], attribution);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildAttributionContext
// ---------------------------------------------------------------------------

describe("buildAttributionContext", () => {
  it("returns empty string when no reliable categories with >40% dismissal", () => {
    const result = buildAttributionContext({
      categories: [{
        category: "bug", total: 20, helpful: 18, dismissed: 2,
        dismissalRate: 0.1, confidencePenalty: 0, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    });
    expect(result).toBe("");
  });

  it("formats attribution context for LLM injection", () => {
    const result = buildAttributionContext({
      categories: [{
        category: "style", total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    });
    expect(result).toContain("Team Attribution");
    expect(result).toContain("style");
    expect(result).toContain("87%");
    expect(result).toContain("65");
  });

  it("limits to 6 categories", () => {
    const categories = Array.from({ length: 10 }, (_, i) => ({
      category: `cat${i}`, total: 15, helpful: 2, dismissed: 13,
      dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
    }));
    const result = buildAttributionContext({
      categories,
      reliableCategories: 10,
      entriesAnalyzed: 150,
    });
    expect(result).toContain("cat0");
    expect(result).toContain("cat5");
    expect(result).not.toContain("cat6");
  });

  it("returns empty for no categories", () => {
    const result = buildAttributionContext({
      categories: [],
      reliableCategories: 0,
      entriesAnalyzed: 0,
    });
    expect(result).toBe("");
  });

  it("includes confidence penalty value", () => {
    const result = buildAttributionContext({
      categories: [{
        category: "style", total: 20, helpful: 3, dismissed: 17,
        dismissalRate: 0.85, confidencePenalty: 63, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    });
    expect(result).toContain("63");
  });

  it("skips unreliable categories even with high dismissal", () => {
    const result = buildAttributionContext({
      categories: [{
        category: "style", total: 5, helpful: 0, dismissed: 5,
        dismissalRate: 1.0, confidencePenalty: 75, isReliable: false,
      }],
      reliableCategories: 0,
      entriesAnalyzed: 5,
    });
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Additional applyAttributionConfidence edge cases
// ---------------------------------------------------------------------------

describe("applyAttributionConfidence additional edge cases", () => {
  it("reduces confidence proportionally for moderate dismissal rate", () => {
    const findings = [{ category: "style", confidence: 80 }];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 15, helpful: 5, dismissed: 10,
        dismissalRate: 0.67, confidencePenalty: 50, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBeLessThan(80);
    expect(result[0].confidence).toBeGreaterThan(10);
  });

  it("handles multiple categories with different penalties", () => {
    const findings = [
      { category: "style", confidence: 90 },
      { category: "security", confidence: 85 },
    ];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [
        { category: "style", total: 15, helpful: 2, dismissed: 13, dismissalRate: 0.87, confidencePenalty: 65, isReliable: true },
        { category: "security", total: 20, helpful: 18, dismissed: 2, dismissalRate: 0.1, confidencePenalty: 0, isReliable: true },
      ],
      reliableCategories: 2,
      entriesAnalyzed: 35,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBeLessThan(90); // style reduced
    expect(result[1].confidence).toBe(85); // security not reduced
  });

  it("clamps confidence at minimum 10 even with very high penalty", () => {
    const findings = [{ category: "style", confidence: 15 }];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 50, helpful: 0, dismissed: 50,
        dismissalRate: 1.0, confidencePenalty: 75, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 50,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBeGreaterThanOrEqual(10);
  });
});
