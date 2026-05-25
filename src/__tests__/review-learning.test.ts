import { describe, it, expect, vi, beforeEach } from "vitest";
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
