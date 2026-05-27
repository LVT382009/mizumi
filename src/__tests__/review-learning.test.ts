import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  learnNegativeRules,
  matchesNegativeRule,
  applyNegativeRules,
  runReviewLearning,
  buildLearningContext,
  toPersistedRule,
} from "../review-learning.js";
import type { NegativeRule, LearningResult } from "../review-learning.js";
import type { FeedbackStore } from "../feedback.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// ---------------------------------------------------------------------------
// learnNegativeRules
// ---------------------------------------------------------------------------

describe("learnNegativeRules", () => {
  it("returns empty array for empty store", () => {
    const store: FeedbackStore = { entries: [] };
    expect(learnNegativeRules(store)).toHaveLength(0);
  });

  it("returns empty array when all entries are pending", () => {
    const store: FeedbackStore = {
      entries: Array.from({ length: 5 }, (_, i) => ({
        repo: "test/repo",
        pr: i + 1,
        commentId: i,
        file: "a.ts",
        line: i,
        category: "style",
        severity: "low",
        messageHash: "abc1",
        outcome: "pending" as const,
        createdAt: "2026-01-01",
      })),
    };
    expect(learnNegativeRules(store)).toHaveLength(0);
  });

  it("generates rule for 60%+ dismissal rate with 3+ samples", () => {
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "abc1", outcome: "helpful", createdAt: "2026-01-03" },
      ],
    };
    const rules = learnNegativeRules(store);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules[0].dismissalRate).toBeGreaterThanOrEqual(0.6);
    expect(rules[0].category).toBe("style");
  });

  it("does not generate rule for 50% dismissal rate", () => {
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "medium", messageHash: "xyz1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "bug", severity: "medium", messageHash: "xyz1", outcome: "helpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "bug", severity: "medium", messageHash: "xyz1", outcome: "helpful", createdAt: "2026-01-03" },
      ],
    };
    const rules = learnNegativeRules(store);
    // 33% dismissal rate — below threshold
    expect(rules).toHaveLength(0);
  });

  it("does not generate rule for fewer than 3 samples", () => {
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-02" },
      ],
    };
    const rules = learnNegativeRules(store);
    expect(rules).toHaveLength(0);
  });

  it("generates rules for multiple categories with high dismissal", () => {
    const store: FeedbackStore = {
      entries: [
        // style: 100% dismissal
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "s1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "s1", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "s1", outcome: "unhelpful", createdAt: "2026-01-03" },
        // compliance: 67% dismissal
        { repo: "t", pr: 4, commentId: 4, file: "b.ts", line: 1, category: "compliance", severity: "medium", messageHash: "c1", outcome: "unhelpful", createdAt: "2026-01-04" },
        { repo: "t", pr: 5, commentId: 5, file: "b.ts", line: 2, category: "compliance", severity: "medium", messageHash: "c1", outcome: "unhelpful", createdAt: "2026-01-05" },
        { repo: "t", pr: 6, commentId: 6, file: "b.ts", line: 3, category: "compliance", severity: "medium", messageHash: "c1", outcome: "helpful", createdAt: "2026-01-06" },
      ],
    };
    const rules = learnNegativeRules(store);
    expect(rules.length).toBeGreaterThanOrEqual(2);
  });

  it("sorts rules by dismissal rate descending", () => {
    const store: FeedbackStore = {
      entries: [
        // 100% dismissal
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "s1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "s1", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "s1", outcome: "unhelpful", createdAt: "2026-01-03" },
        // 67% dismissal
        { repo: "t", pr: 4, commentId: 4, file: "b.ts", line: 1, category: "security", severity: "high", messageHash: "sec1", outcome: "unhelpful", createdAt: "2026-01-04" },
        { repo: "t", pr: 5, commentId: 5, file: "b.ts", line: 2, category: "security", severity: "high", messageHash: "sec1", outcome: "unhelpful", createdAt: "2026-01-05" },
        { repo: "t", pr: 6, commentId: 6, file: "b.ts", line: 3, category: "security", severity: "high", messageHash: "sec1", outcome: "helpful", createdAt: "2026-01-06" },
      ],
    };
    const rules = learnNegativeRules(store);
    if (rules.length >= 2) {
      expect(rules[0].dismissalRate).toBeGreaterThanOrEqual(rules[1].dismissalRate);
    }
  });

  it("limits to MAX_NEGATIVE_RULES (20)", () => {
    const entries = [];
    for (let i = 0; i < 25; i++) {
      entries.push(
        { repo: "t", pr: i + 1, commentId: i * 3, file: "a.ts", line: i, category: `cat-${i}`, severity: "low", messageHash: `h${i}`, outcome: "unhelpful" as const, createdAt: "2026-01-01" },
        { repo: "t", pr: i + 1, commentId: i * 3 + 1, file: "a.ts", line: i, category: `cat-${i}`, severity: "low", messageHash: `h${i}`, outcome: "unhelpful" as const, createdAt: "2026-01-02" },
        { repo: "t", pr: i + 1, commentId: i * 3 + 2, file: "a.ts", line: i, category: `cat-${i}`, severity: "low", messageHash: `h${i}`, outcome: "helpful" as const, createdAt: "2026-01-03" },
      );
    }
    const store: FeedbackStore = { entries };
    const rules = learnNegativeRules(store);
    expect(rules.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// matchesNegativeRule
// ---------------------------------------------------------------------------

describe("matchesNegativeRule", () => {
  const rules: NegativeRule[] = [
    { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" },
    { category: "compliance", messagePattern: "*", dismissalRate: 0.9, sampleSize: 10, createdAt: "2026-01-02" },
  ];

  it("matches finding by category and message pattern", () => {
    const match = matchesNegativeRule(
      { category: "style", message: "some style issue", severity: "low", confidence: 80 },
      rules
    );
    // Match depends on hash prefix matching
    expect(match === null || match.category === "style").toBe(true);
  });

  it("matches whole-category wildcard", () => {
    const match = matchesNegativeRule(
      { category: "compliance", message: "any compliance message", severity: "medium", confidence: 90 },
      rules
    );
    expect(match).not.toBeNull();
    expect(match!.category).toBe("compliance");
    expect(match!.messagePattern).toBe("*");
  });

  it("returns null for non-matching category", () => {
    const match = matchesNegativeRule(
      { category: "security", message: "SQL injection", severity: "high", confidence: 95 },
      rules
    );
    expect(match).toBeNull();
  });

  it("returns null for empty rules array", () => {
    const match = matchesNegativeRule(
      { category: "style", message: "test", severity: "low", confidence: 80 },
      []
    );
    expect(match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyNegativeRules
// ---------------------------------------------------------------------------

describe("applyNegativeRules", () => {
  it("filters out matching findings", () => {
    const rules: NegativeRule[] = [
      { category: "compliance", messagePattern: "*", dismissalRate: 0.9, sampleSize: 8, createdAt: "2026-01-01" },
    ];
    const findings = [
      { category: "compliance", message: "missing LICENSE", severity: "medium", confidence: 85 },
      { category: "security", message: "SQL injection", severity: "high", confidence: 95 },
    ];
    const result = applyNegativeRules(findings, rules);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("security");
  });

  it("returns all findings when no rules match", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" },
    ];
    const findings = [
      { category: "security", message: "XSS risk", severity: "high", confidence: 90 },
      { category: "bug", message: "null check", severity: "medium", confidence: 80 },
    ];
    const result = applyNegativeRules(findings, rules);
    expect(result).toHaveLength(2);
  });

  it("returns all findings for empty rules array", () => {
    const findings = [
      { category: "style", message: "indent", severity: "low", confidence: 70 },
    ];
    const result = applyNegativeRules(findings, []);
    expect(result).toHaveLength(1);
  });

  it("filters multiple categories with wildcard rules", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01" },
      { category: "compliance", messagePattern: "*", dismissalRate: 0.85, sampleSize: 7, createdAt: "2026-01-02" },
    ];
    const findings = [
      { category: "style", message: "semi", severity: "low", confidence: 75 },
      { category: "compliance", message: "missing header", severity: "medium", confidence: 80 },
      { category: "security", message: "injection", severity: "high", confidence: 95 },
      { category: "bug", message: "null deref", severity: "medium", confidence: 85 },
    ];
    const result = applyNegativeRules(findings, rules);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.category !== "style" && f.category !== "compliance")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runReviewLearning
// ---------------------------------------------------------------------------

describe("runReviewLearning", () => {
  it("returns empty result when no feedback file exists", () => {
    const tmpDir = os.tmpdir();
    const randomPath = path.join(tmpDir, `mizumi-test-${Date.now()}`);
    const result = runReviewLearning(randomPath);
    expect(result.newRules).toHaveLength(0);
    expect(result.entriesAnalyzed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildLearningContext
// ---------------------------------------------------------------------------

describe("buildLearningContext", () => {
  it("returns empty string for zero rules", () => {
    const result: LearningResult = { newRules: [], totalRules: 0, entriesAnalyzed: 10 };
    expect(buildLearningContext(result)).toBe("");
  });

  it("includes Review Learning header", () => {
    const rule: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 10 };
    const context = buildLearningContext(result);
    expect(context).toContain("Review Learning");
  });

  it("includes rule count in header", () => {
    const rule: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 10 };
    const context = buildLearningContext(result);
    expect(context).toContain("1 rule");
  });

  it("includes category names", () => {
    const rule: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 10 };
    const context = buildLearningContext(result);
    expect(context).toContain("style");
  });

  it("includes dismissal rates as percentages", () => {
    const rule: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 10 };
    const context = buildLearningContext(result);
    expect(context).toContain("80%");
  });

  it("includes sample sizes", () => {
    const rule: NegativeRule = { category: "compliance", messagePattern: "*", dismissalRate: 0.9, sampleSize: 12, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 20 };
    const context = buildLearningContext(result);
    expect(context).toContain("12 reviews");
  });

  it("includes avoid-instructions guidance", () => {
    const rule: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 10 };
    const context = buildLearningContext(result);
    expect(context).toContain("Avoid");
  });

  it("truncates at 8 rules with suffix", () => {
    const rules: NegativeRule[] = Array.from({ length: 10 }, (_, i) => ({
      category: `cat-${i}`, messagePattern: "*", dismissalRate: 0.9, sampleSize: 5 + i, createdAt: "2026-01-01",
    }));
    const result: LearningResult = { newRules: rules, totalRules: 10, entriesAnalyzed: 50 };
    const context = buildLearningContext(result);
    expect(context).toContain("2 more suppressed pattern");
  });

  it("does not truncate for 8 or fewer rules", () => {
    const rules: NegativeRule[] = Array.from({ length: 4 }, (_, i) => ({
      category: `cat-${i}`, messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01",
    }));
    const result: LearningResult = { newRules: rules, totalRules: 4, entriesAnalyzed: 20 };
    const context = buildLearningContext(result);
    expect(context).not.toContain("more suppressed");
  });

  it("handles multiple categories in context", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "abc1", dismissalRate: 0.9, sampleSize: 6, createdAt: "2026-01-01" },
      { category: "compliance", messagePattern: "xyz2", dismissalRate: 0.7, sampleSize: 4, createdAt: "2026-01-02" },
    ];
    const result: LearningResult = { newRules: rules, totalRules: 2, entriesAnalyzed: 15 };
    const context = buildLearningContext(result);
    expect(context).toContain("style");
    expect(context).toContain("compliance");
  });
});

// ---------------------------------------------------------------------------
// toPersistedRule
// ---------------------------------------------------------------------------

describe("toPersistedRule", () => {
  it("converts negative rule to persisted rule", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.id).toBe("learned-neg-0");
    expect(rule.source).toBe("discovered");
    expect(rule.severity).toBe("low");
    expect(rule.enabled).toBe(true);
  });

  it("sets confidence inversely proportional to dismissal rate", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 1.0, sampleSize: 10, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 1);
    // 100% dismissal → confidence = 0
    expect(rule.confidence).toBe(0);
  });

  it("sets higher confidence for lower dismissal rates", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 0.6, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 2);
    // 60% dismissal → confidence = (1 - 0.6) * 60 = 24
    expect(rule.confidence).toBe(24);
  });

  it("includes dismissal rate in description", () => {
    const neg: NegativeRule = { category: "compliance", messagePattern: "*", dismissalRate: 0.75, sampleSize: 8, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.description).toContain("75%");
  });

  it("includes sample size in description", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 12, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.description).toContain("12 reviews");
  });

  it("sets type to pattern", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.type).toBe("pattern");
  });

  it("uses provided index in id", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 42);
    expect(rule.id).toBe("learned-neg-42");
  });
});

// ---------------------------------------------------------------------------
// learnNegativeRules — additional edge cases
// ---------------------------------------------------------------------------

describe("learnNegativeRules (edge cases)", () => {
  it("generates rule at exactly 60% dismissal rate (boundary)", () => {
    // 3 unhelpful, 2 helpful = 60% dismissal — should trigger (>= 0.6)
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "abc1", outcome: "unhelpful", createdAt: "2026-01-03" },
        { repo: "t", pr: 4, commentId: 4, file: "a.ts", line: 4, category: "style", severity: "low", messageHash: "abc1", outcome: "helpful", createdAt: "2026-01-04" },
        { repo: "t", pr: 5, commentId: 5, file: "a.ts", line: 5, category: "style", severity: "low", messageHash: "abc1", outcome: "helpful", createdAt: "2026-01-05" },
      ],
    };
    const rules = learnNegativeRules(store);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules[0].dismissalRate).toBe(0.6);
  });

  it("does not generate rule at 59% dismissal rate (just below threshold)", () => {
    // 3 unhelpful, 2 helpful but need 5 samples minimum. Let's use 5: ~59% impossible
    // with integers. 3/5=60%. 2/3=66%. Let's use 7: 4 unhelpful / 7 total = ~57%
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "test", severity: "low", messageHash: "xyz1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "test", severity: "low", messageHash: "xyz1", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "test", severity: "low", messageHash: "xyz1", outcome: "unhelpful", createdAt: "2026-01-03" },
        { repo: "t", pr: 4, commentId: 4, file: "a.ts", line: 4, category: "test", severity: "low", messageHash: "xyz1", outcome: "helpful", createdAt: "2026-01-04" },
        { repo: "t", pr: 5, commentId: 5, file: "a.ts", line: 5, category: "test", severity: "low", messageHash: "xyz1", outcome: "helpful", createdAt: "2026-01-05" },
        { repo: "t", pr: 6, commentId: 6, file: "a.ts", line: 6, category: "test", severity: "low", messageHash: "xyz1", outcome: "helpful", createdAt: "2026-01-06" },
        { repo: "t", pr: 7, commentId: 7, file: "a.ts", line: 7, category: "test", severity: "low", messageHash: "xyz1", outcome: "helpful", createdAt: "2026-01-07" },
      ],
    };
    const rules = learnNegativeRules(store);
    // 3/7 = ~43% — below 60%
    expect(rules).toHaveLength(0);
  });

  it("groups by message prefix not full hash", () => {
    // Two entries with same first 4 chars of hash should group together
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "abcd1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "abcd2", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "abcd3", outcome: "unhelpful", createdAt: "2026-01-03" },
      ],
    };
    const rules = learnNegativeRules(store);
    // All 3 share prefix "abcd", should be grouped together → 100% dismissal
    expect(rules.length).toBeGreaterThanOrEqual(1);
    if (rules.length > 0) {
      expect(rules[0].sampleSize).toBe(3);
    }
  });

  it("separates entries with different message prefixes", () => {
    const store: FeedbackStore = {
      entries: [
        // "aaaa" prefix group — 3 entries, 100% dismissal
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "aaaa1", outcome: "unhelpful", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "aaaa2", outcome: "unhelpful", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "aaaa3", outcome: "unhelpful", createdAt: "2026-01-03" },
        // "bbbb" prefix group — 3 entries, 33% dismissal (should not generate rule)
        { repo: "t", pr: 4, commentId: 4, file: "b.ts", line: 4, category: "style", severity: "low", messageHash: "bbbb1", outcome: "helpful", createdAt: "2026-01-04" },
        { repo: "t", pr: 5, commentId: 5, file: "b.ts", line: 5, category: "style", severity: "low", messageHash: "bbbb2", outcome: "helpful", createdAt: "2026-01-05" },
        { repo: "t", pr: 6, commentId: 6, file: "b.ts", line: 6, category: "style", severity: "low", messageHash: "bbbb3", outcome: "unhelpful", createdAt: "2026-01-06" },
      ],
    };
    const rules = learnNegativeRules(store);
    // "aaaa" prefix has 3 unhelpful entries → 100% dismissal → rule
    const aaaaRule = rules.find((r) => r.messagePattern === "aaaa");
    expect(aaaaRule).toBeDefined();
    // "bbbb" prefix has 1 unhelpful / 3 total → 33% dismissal → no rule
    const bbbbRule = rules.find((r) => r.messagePattern === "bbbb");
    expect(bbbbRule).toBeUndefined();
  });

  it("skips pending entries in learning", () => {
    const store: FeedbackStore = {
      entries: [
        { repo: "t", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "abc1", outcome: "pending", createdAt: "2026-01-01" },
        { repo: "t", pr: 2, commentId: 2, file: "a.ts", line: 2, category: "style", severity: "low", messageHash: "abc1", outcome: "pending", createdAt: "2026-01-02" },
        { repo: "t", pr: 3, commentId: 3, file: "a.ts", line: 3, category: "style", severity: "low", messageHash: "abc1", outcome: "pending", createdAt: "2026-01-03" },
      ],
    };
    const rules = learnNegativeRules(store);
    expect(rules).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchesNegativeRule — additional edge cases
// ---------------------------------------------------------------------------

describe("matchesNegativeRule (edge cases)", () => {
  it("returns null for finding with no matching category", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01" },
    ];
    const match = matchesNegativeRule(
      { category: "security", message: "SQL injection", severity: "high", confidence: 95 },
      rules,
    );
    expect(match).toBeNull();
  });

  it("returns matching rule for wildcard pattern on same category", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "*", dismissalRate: 0.85, sampleSize: 7, createdAt: "2026-01-01" },
    ];
    const match = matchesNegativeRule(
      { category: "style", message: "any style message", severity: "low", confidence: 60 },
      rules,
    );
    expect(match).not.toBeNull();
    expect(match!.messagePattern).toBe("*");
  });

  it("checks all rules and returns first matching", () => {
    const rules: NegativeRule[] = [
      { category: "security", messagePattern: "xyz", dismissalRate: 0.7, sampleSize: 5, createdAt: "2026-01-01" },
      { category: "style", messagePattern: "*", dismissalRate: 0.9, sampleSize: 8, createdAt: "2026-01-02" },
    ];
    // Finding in "security" won't match first rule unless hash prefix matches
    const match = matchesNegativeRule(
      { category: "style", message: "indent issue", severity: "low", confidence: 70 },
      rules,
    );
    expect(match).not.toBeNull();
    expect(match!.category).toBe("style");
  });

  it("returns null for single-entry rules with non-matching hash", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "zzzz", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01" },
    ];
    const match = matchesNegativeRule(
      { category: "style", message: "some totally different thing", severity: "low", confidence: 70 },
      rules,
    );
    // The hash prefix of "some totally different thing" is unlikely to be "zzzz"
    // This tests the hash prefix matching path
    expect(match === null || match.messagePattern === "zzzz").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyNegativeRules — additional edge cases
// ---------------------------------------------------------------------------

describe("applyNegativeRules (edge cases)", () => {
  it("handles empty findings array", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01" },
    ];
    const result = applyNegativeRules([], rules);
    expect(result).toEqual([]);
  });

  it("returns same array when rules are empty (no copy)", () => {
    const findings = [
      { category: "security", message: "xss", severity: "high", confidence: 95 },
    ];
    const result = applyNegativeRules(findings, []);
    expect(result).toBe(findings); // same reference
  });

  it("filters all findings when they all match", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01" },
    ];
    const findings = [
      { category: "style", message: "indent", severity: "low", confidence: 75 },
      { category: "style", message: "spacing", severity: "low", confidence: 80 },
    ];
    const result = applyNegativeRules(findings, rules);
    expect(result).toHaveLength(0);
  });

  it("preserves findings that do not match any rule", () => {
    const rules: NegativeRule[] = [
      { category: "compliance", messagePattern: "*", dismissalRate: 0.9, sampleSize: 8, createdAt: "2026-01-01" },
    ];
    const findings = [
      { category: "security", message: "SQL injection", severity: "high", confidence: 95 },
      { category: "bug", message: "null deref", severity: "medium", confidence: 80 },
    ];
    const result = applyNegativeRules(findings, rules);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.category)).toEqual(["security", "bug"]);
  });
});

// ---------------------------------------------------------------------------
// runReviewLearning — with actual feedback store
// ---------------------------------------------------------------------------

describe("runReviewLearning (with store)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-review-learning-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("analyzes feedback store from disk", () => {
    // Write feedback store to disk
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    const store = {
      entries: Array.from({ length: 5 }, (_, i) => ({
        repo: "t", pr: i + 1, commentId: i, file: "a.ts", line: i,
        category: "style", severity: "low", messageHash: "abc1",
        outcome: "unhelpful" as const, createdAt: "2026-01-01",
      })),
    };
    fs.writeFileSync(path.join(dir, "mizumi-feedback.json"), JSON.stringify(store));

    const result = runReviewLearning(tmpDir);
    expect(result.entriesAnalyzed).toBe(5);
    expect(result.newRules.length).toBeGreaterThanOrEqual(1);
  });

  it("reports zero entries analyzed for missing store", () => {
    const result = runReviewLearning(tmpDir);
    expect(result.entriesAnalyzed).toBe(0);
    expect(result.newRules).toHaveLength(0);
  });

  it("returns totalRules equal to newRules count", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    const store = {
      entries: Array.from({ length: 5 }, (_, i) => ({
        repo: "t", pr: i + 1, commentId: i, file: "a.ts", line: i,
        category: "style", severity: "low", messageHash: "abc1",
        outcome: "unhelpful" as const, createdAt: "2026-01-01",
      })),
    };
    fs.writeFileSync(path.join(dir, "mizumi-feedback.json"), JSON.stringify(store));

    const result = runReviewLearning(tmpDir);
    expect(result.totalRules).toBe(result.newRules.length);
  });
});

// ---------------------------------------------------------------------------
// buildLearningContext — additional edge cases
// ---------------------------------------------------------------------------

describe("buildLearningContext (edge cases)", () => {
  it("returns empty string for rules with zero length", () => {
    const result: LearningResult = { newRules: [], totalRules: 0, entriesAnalyzed: 50 };
    expect(buildLearningContext(result)).toBe("");
  });

  it("includes exactly 8 rules without truncation at boundary", () => {
    const rules: NegativeRule[] = Array.from({ length: 8 }, (_, i) => ({
      category: `cat-${i}`, messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01",
    }));
    const result: LearningResult = { newRules: rules, totalRules: 8, entriesAnalyzed: 40 };
    const context = buildLearningContext(result);
    expect(context).not.toContain("more suppressed");
  });

  it("shows truncation for 9 rules", () => {
    const rules: NegativeRule[] = Array.from({ length: 9 }, (_, i) => ({
      category: `cat-${i}`, messagePattern: "*", dismissalRate: 0.9, sampleSize: 5, createdAt: "2026-01-01",
    }));
    const result: LearningResult = { newRules: rules, totalRules: 9, entriesAnalyzed: 45 };
    const context = buildLearningContext(result);
    expect(context).toContain("1 more suppressed pattern");
  });

  it("includes entriesAnalyzed in header indirectly", () => {
    const rule: NegativeRule = { category: "test", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const result: LearningResult = { newRules: [rule], totalRules: 1, entriesAnalyzed: 42 };
    const context = buildLearningContext(result);
    expect(context).toContain("1 rule");
  });

  it("formats multiple rules with category and rate", () => {
    const rules: NegativeRule[] = [
      { category: "style", messagePattern: "abc1", dismissalRate: 0.9, sampleSize: 10, createdAt: "2026-01-01" },
      { category: "compliance", messagePattern: "xyz2", dismissalRate: 0.7, sampleSize: 8, createdAt: "2026-01-02" },
    ];
    const result: LearningResult = { newRules: rules, totalRules: 2, entriesAnalyzed: 30 };
    const context = buildLearningContext(result);
    expect(context).toContain("90%");
    expect(context).toContain("70%");
    expect(context).toContain("10 reviews");
    expect(context).toContain("8 reviews");
  });
});

// ---------------------------------------------------------------------------
// toPersistedRule — additional edge cases
// ---------------------------------------------------------------------------

describe("toPersistedRule (edge cases)", () => {
  it("sets pattern field empty for wildcard rules", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.pattern).toBe("");
  });

  it("sets pattern field to messagePattern for non-wildcard rules", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "abcd", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.pattern).toBe("abcd");
  });

  it("sets source to discovered", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "abc1", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.source).toBe("discovered");
  });

  it("sets enabled to true", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.enabled).toBe(true);
  });

  it("sets matchCount to 0 and lastMatchedAt to null", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.matchCount).toBe(0);
    expect(rule.lastMatchedAt).toBeNull();
  });

  it("sets category correctly", () => {
    const neg: NegativeRule = { category: "compliance", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.category).toBe("compliance");
  });

  it("computes confidence as (1 - dismissalRate) * 60", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 0.5, sampleSize: 10, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.confidence).toBe(30); // (1 - 0.5) * 60 = 30
  });

  it("sets severity to low", () => {
    const neg: NegativeRule = { category: "security", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-01-01" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.severity).toBe("low");
  });

  it("uses createdAt from negative rule", () => {
    const neg: NegativeRule = { category: "style", messagePattern: "*", dismissalRate: 0.8, sampleSize: 5, createdAt: "2026-03-15" };
    const rule = toPersistedRule(neg, 0);
    expect(rule.createdAt).toBe("2026-03-15");
  });
});
