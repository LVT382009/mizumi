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

  it("exact confidence penalty calculation", () => {
    const findings = [{ category: "style", confidence: 80 }];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 20, helpful: 4, dismissed: 16,
        dismissalRate: 0.8, confidencePenalty: 60, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBe(20); // 80 - 60 = 20
  });

  it("findings not matching any penalized category are unchanged", () => {
    const findings = [
      { category: "performance", confidence: 90 },
      { category: "security", confidence: 85 },
    ];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 20, helpful: 2, dismissed: 18,
        dismissalRate: 0.9, confidencePenalty: 67, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBe(90);
    expect(result[1].confidence).toBe(85);
  });

  it("multiple findings in same penalized category all adjusted", () => {
    const findings = [
      { category: "style", confidence: 80 },
      { category: "style", confidence: 60 },
      { category: "style", confidence: 40 },
    ];
    const attribution: import("../attribution.js").AttributionResult = {
      categories: [{
        category: "style", total: 20, helpful: 2, dismissed: 18,
        dismissalRate: 0.9, confidencePenalty: 50, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = applyAttributionConfidence(findings, attribution);
    expect(result[0].confidence).toBe(30); // 80 - 50
    expect(result[1].confidence).toBe(10); // 60 - 50, clamped at 10
    expect(result[2].confidence).toBe(10); // max(10, 40-50)
  });
});

// ---------------------------------------------------------------------------
// computeAttribution additional edge cases
// ---------------------------------------------------------------------------

describe("computeAttribution additional", () => {
  it("handles single helpful entry", () => {
    const store = makeStore([{ category: "bug", outcome: "helpful" }]);
    const result = computeAttribution(store);
    const bug = result.categories.find((c) => c.category === "bug");
    expect(bug!.total).toBe(1);
    expect(bug!.helpful).toBe(1);
    expect(bug!.dismissed).toBe(0);
    expect(bug!.dismissalRate).toBe(0);
    expect(bug!.isReliable).toBe(false);
  });

  it("handles single unhelpful entry", () => {
    const store = makeStore([{ category: "bug", outcome: "unhelpful" }]);
    const result = computeAttribution(store);
    const bug = result.categories.find((c) => c.category === "bug");
    expect(bug!.dismissalRate).toBeGreaterThan(0.5);
    expect(bug!.confidencePenalty).toBeGreaterThan(0); // penalty computed but isReliable=false
    expect(bug!.isReliable).toBe(false);
  });

  it("exactly at MIN_RELIABLE_SAMPLES threshold", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 10; i++) entries.push({ category: "style", outcome: "unhelpful" });
    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style!.isReliable).toBe(true);
  });

  it("below MIN_RELIABLE_SAMPLES threshold", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 9; i++) entries.push({ category: "style", outcome: "unhelpful" });
    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style!.isReliable).toBe(false);
  });

  it("dismissal rate exactly at 0.4 threshold", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 6; i++) entries.push({ category: "bug", outcome: "unhelpful" });
    for (let i = 0; i < 9; i++) entries.push({ category: "bug", outcome: "helpful" });
    const result = computeAttribution(makeStore(entries));
    const bug = result.categories.find((c) => c.category === "bug");
    // 6/15 = 0.4 exactly — penalty should NOT apply (> 0.4 condition)
    expect(bug!.dismissalRate).toBeLessThanOrEqual(0.41);
  });

  it("recency weighting gives recent entries more influence", () => {
    const now = new Date();
    const veryRecent = new Date(now.getTime() - 1000).toISOString();
    const veryOld = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const store = makeStore([
      { category: "style", outcome: "unhelpful", createdAt: veryOld },
      { category: "style", outcome: "unhelpful", createdAt: veryOld },
      { category: "style", outcome: "helpful", createdAt: veryRecent },
    ]);
    const result = computeAttribution(store);
    const style = result.categories.find((c) => c.category === "style");
    // Recent helpful should outweigh old unhelpful
    expect(style!.dismissalRate).toBeLessThan(0.5);
  });

  it("entries from exactly 30 days ago (half-life)", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const store = makeStore([
      { category: "style", outcome: "unhelpful", createdAt: thirtyDaysAgo },
      { category: "style", outcome: "helpful", createdAt: new Date().toISOString() },
    ]);
    const result = computeAttribution(store);
    const style = result.categories.find((c) => c.category === "style");
    // At half-life, unhelpful is weighted 0.5, helpful is weighted 1.0
    // dismissalRate = 0.5 / (0.5 + 1.0) = 0.333
    expect(style!.dismissalRate).toBeLessThan(0.5);
  });

  it("confidence penalty exactly at MAX_PENALTY", () => {
    const entries: Partial<FeedbackEntry>[] = [];
    for (let i = 0; i < 50; i++) entries.push({ category: "style", outcome: "unhelpful" });
    const result = computeAttribution(makeStore(entries));
    const style = result.categories.find((c) => c.category === "style");
    expect(style!.confidencePenalty).toBe(75);
  });

  it("handles mixed pending and resolved entries correctly", () => {
    const entries: Partial<FeedbackEntry>[] = [
      { category: "bug", outcome: "pending" },
      { category: "bug", outcome: "helpful" },
      { category: "bug", outcome: "pending" },
      { category: "bug", outcome: "unhelpful" },
    ];
    const result = computeAttribution(makeStore(entries));
    const bug = result.categories.find((c) => c.category === "bug");
    expect(bug!.total).toBe(2); // only non-pending
    expect(bug!.helpful).toBe(1);
    expect(bug!.dismissed).toBe(1);
  });

  it("entriesAnalyzed counts all entries including pending", () => {
    const entries: Partial<FeedbackEntry>[] = [
      { category: "bug", outcome: "pending" },
      { category: "bug", outcome: "helpful" },
      { category: "bug", outcome: "unhelpful" },
    ];
    const result = computeAttribution(makeStore(entries));
    expect(result.entriesAnalyzed).toBe(3);
  });

  it("empty store has zero reliableCategories", () => {
    const result = computeAttribution({ entries: [] });
    expect(result.reliableCategories).toBe(0);
  });
});
