import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  computeTrend,
  computeFatigueScore,
  buildFatigueDashboard,
  formatFatigueDashboard,
} from "../fatigue-dashboard.js";
import type { FeedbackEntry, FeedbackStore } from "../feedback.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// computeTrend
// ---------------------------------------------------------------------------

describe("computeTrend", () => {
  it("returns stable for few entries", () => {
    const entries = [
      { category: "security", outcome: "helpful", createdAt: "2026-01-01" },
      { category: "security", outcome: "helpful", createdAt: "2026-01-02" },
    ];
    expect(computeTrend(entries, "security")).toBe("stable");
  });

  it("returns stable when rates are similar", () => {
    // Build 10 entries where both halves have 2 helpful / 3 unhelpful
    const entries: FeedbackEntry[] = [
      // First half: 2 helpful, 3 unhelpful
      { repo: "r", pr: 1, commentId: 0, file: "a.ts", line: 0, category: "bug", severity: "medium", messageHash: "h", outcome: "helpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-02" },
      { repo: "r", pr: 1, commentId: 2, file: "a.ts", line: 2, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-03" },
      { repo: "r", pr: 1, commentId: 3, file: "a.ts", line: 3, category: "bug", severity: "medium", messageHash: "h", outcome: "helpful", createdAt: "2026-01-04" },
      { repo: "r", pr: 1, commentId: 4, file: "a.ts", line: 4, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-05" },
      // Second half: 2 helpful, 3 unhelpful
      { repo: "r", pr: 1, commentId: 5, file: "a.ts", line: 5, category: "bug", severity: "medium", messageHash: "h", outcome: "helpful", createdAt: "2026-01-06" },
      { repo: "r", pr: 1, commentId: 6, file: "a.ts", line: 6, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-07" },
      { repo: "r", pr: 1, commentId: 7, file: "a.ts", line: 7, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-08" },
      { repo: "r", pr: 1, commentId: 8, file: "a.ts", line: 8, category: "bug", severity: "medium", messageHash: "h", outcome: "helpful", createdAt: "2026-01-09" },
      { repo: "r", pr: 1, commentId: 9, file: "a.ts", line: 9, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-10" },
    ];
    expect(computeTrend(entries, "bug")).toBe("stable");
  });

  it("returns improving when newer entries have better rate", () => {
    const entries: FeedbackEntry[] = [
      // Older: mostly unhelpful
      ...Array.from({ length: 5 }, (_, i) => ({
        repo: "r", pr: 1, commentId: i, file: "a.ts", line: i,
        category: "style", severity: "low", messageHash: "h",
        outcome: "unhelpful" as const,
        createdAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
      })),
      // Newer: mostly helpful
      ...Array.from({ length: 5 }, (_, i) => ({
        repo: "r", pr: 1, commentId: i + 5, file: "a.ts", line: i + 5,
        category: "style", severity: "low", messageHash: "h",
        outcome: "helpful" as const,
        createdAt: `2026-01-${String(i + 6).padStart(2, "0")}`,
      })),
    ];
    expect(computeTrend(entries, "style")).toBe("improving");
  });

  it("returns declining when newer entries have worse rate", () => {
    const entries: FeedbackEntry[] = [
      // Older: mostly helpful
      ...Array.from({ length: 5 }, (_, i) => ({
        repo: "r", pr: 1, commentId: i, file: "a.ts", line: i,
        category: "security", severity: "high", messageHash: "h",
        outcome: "helpful" as const,
        createdAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
      })),
      // Newer: mostly unhelpful
      ...Array.from({ length: 5 }, (_, i) => ({
        repo: "r", pr: 1, commentId: i + 5, file: "a.ts", line: i + 5,
        category: "security", severity: "high", messageHash: "h",
        outcome: "unhelpful" as const,
        createdAt: `2026-01-${String(i + 6).padStart(2, "0")}`,
      })),
    ];
    expect(computeTrend(entries, "security")).toBe("declining");
  });

  it("skips pending entries in trend calculation", () => {
    const entries: FeedbackEntry[] = [
      { repo: "r", pr: 1, commentId: 0, file: "a.ts", line: 1, category: "bug", severity: "medium", messageHash: "h", outcome: "pending", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 2, category: "bug", severity: "medium", messageHash: "h", outcome: "helpful", createdAt: "2026-01-02" },
      { repo: "r", pr: 1, commentId: 2, file: "a.ts", line: 3, category: "bug", severity: "medium", messageHash: "h", outcome: "unhelpful", createdAt: "2026-01-03" },
    ];
    expect(computeTrend(entries, "bug")).toBe("stable");
  });

  it("returns stable for unknown category", () => {
    const entries: FeedbackEntry[] = [
      { repo: "r", pr: 1, commentId: 0, file: "a.ts", line: 1, category: "security", severity: "high", messageHash: "h", outcome: "helpful", createdAt: "2026-01-01" },
    ];
    expect(computeTrend(entries, "nonexistent")).toBe("stable");
  });
});

// ---------------------------------------------------------------------------
// computeFatigueScore
// ---------------------------------------------------------------------------

describe("computeFatigueScore", () => {
  it("returns 0 for zero findings", () => {
    expect(computeFatigueScore(0, 0)).toBe(0);
  });

  it("computes score for high dismissal rate", () => {
    const score = computeFatigueScore(50, 0.8);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("gives higher score for more findings at same dismissal rate", () => {
    const small = computeFatigueScore(10, 0.5);
    const large = computeFatigueScore(100, 0.5);
    expect(large).toBeGreaterThan(small);
  });

  it("gives low score for low dismissal rate", () => {
    const score = computeFatigueScore(50, 0.1);
    expect(score).toBeLessThan(20);
  });

  it("gives higher score for high dismissal rate", () => {
    const lowDismiss = computeFatigueScore(50, 0.2);
    const highDismiss = computeFatigueScore(50, 0.9);
    expect(highDismiss).toBeGreaterThan(lowDismiss);
  });

  it("returns 0 for zero total even with non-zero dismissal rate", () => {
    expect(computeFatigueScore(0, 0.8)).toBe(0);
  });

  it("returns 0 for zero dismissal rate", () => {
    expect(computeFatigueScore(100, 0)).toBe(0);
  });

  it("volume factor increases with total findings", () => {
    const s10 = computeFatigueScore(10, 0.5);
    const s100 = computeFatigueScore(100, 0.5);
    const s1000 = computeFatigueScore(1000, 0.5);
    expect(s100).toBeGreaterThan(s10);
    expect(s1000).toBeGreaterThan(s100);
  });
});

// ---------------------------------------------------------------------------
// buildFatigueDashboard
// ---------------------------------------------------------------------------

describe("buildFatigueDashboard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-fatigue-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFeedbackStore(entries: FeedbackEntry[]) {
    const dir = path.join(tmpDir, ".github");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mizumi-feedback.json"), JSON.stringify({ entries }));
  }

  it("returns empty categories for no feedback", () => {
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.categories).toHaveLength(0);
    expect(result.totalFindings).toBe(0);
    expect(result.noisiestCategory).toBeNull();
  });

  it("computes per-category stats", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "security", severity: "high", messageHash: "h1", outcome: "helpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 2, file: "b.ts", line: 2, category: "security", severity: "high", messageHash: "h2", outcome: "helpful", createdAt: "2026-01-02" },
      { repo: "r", pr: 1, commentId: 3, file: "c.ts", line: 3, category: "style", severity: "low", messageHash: "h3", outcome: "unhelpful", createdAt: "2026-01-03" },
      { repo: "r", pr: 1, commentId: 4, file: "d.ts", line: 4, category: "style", severity: "low", messageHash: "h4", outcome: "unhelpful", createdAt: "2026-01-04" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.categories).toHaveLength(2);

    const security = result.categories.find((c) => c.category === "security");
    expect(security?.helpful).toBe(2);
    expect(security?.acceptanceRate).toBe(100);

    const style = result.categories.find((c) => c.category === "style");
    expect(style?.unhelpful).toBe(2);
    expect(style?.acceptanceRate).toBe(0);
  });

  it("sorts categories by fatigue score (noisiest first)", () => {
    writeFeedbackStore([
      // security: 50% acceptance (moderate)
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "security", severity: "high", messageHash: "h1", outcome: "helpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 2, file: "b.ts", line: 2, category: "security", severity: "high", messageHash: "h2", outcome: "unhelpful", createdAt: "2026-01-02" },
      // style: 0% acceptance (high fatigue)
      { repo: "r", pr: 1, commentId: 3, file: "c.ts", line: 3, category: "style", severity: "low", messageHash: "h3", outcome: "unhelpful", createdAt: "2026-01-03" },
      { repo: "r", pr: 1, commentId: 4, file: "d.ts", line: 4, category: "style", severity: "low", messageHash: "h4", outcome: "unhelpful", createdAt: "2026-01-04" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.categories[0].category).toBe("style");
  });

  it("identifies noisiest category", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "h1", outcome: "unhelpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 2, file: "b.ts", line: 2, category: "style", severity: "low", messageHash: "h2", outcome: "unhelpful", createdAt: "2026-01-02" },
      { repo: "r", pr: 1, commentId: 3, file: "c.ts", line: 3, category: "style", severity: "low", messageHash: "h3", outcome: "unhelpful", createdAt: "2026-01-03" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.noisiestCategory).toBe("style");
  });

  it("reports suppressed categories from input patterns", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "h1", outcome: "unhelpful", createdAt: "2026-01-01" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set(["style:low", "style:medium"]));
    expect(result.suppressedCategories).toContain("style");
    expect(result.suppressedCategories).toHaveLength(1); // deduplicated
  });

  it("computes overall acceptance rate", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "high", messageHash: "h1", outcome: "helpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 2, file: "b.ts", line: 2, category: "bug", severity: "high", messageHash: "h2", outcome: "helpful", createdAt: "2026-01-02" },
      { repo: "r", pr: 1, commentId: 3, file: "c.ts", line: 3, category: "bug", severity: "high", messageHash: "h3", outcome: "unhelpful", createdAt: "2026-01-03" },
      { repo: "r", pr: 1, commentId: 4, file: "d.ts", line: 4, category: "bug", severity: "high", messageHash: "h4", outcome: "unhelpful", createdAt: "2026-01-04" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.overallAcceptance).toBe(50);
  });

  it("counts pending entries separately", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "high", messageHash: "h1", outcome: "helpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 2, file: "b.ts", line: 2, category: "bug", severity: "high", messageHash: "h2", outcome: "pending", createdAt: "2026-01-02" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    const bug = result.categories.find((c) => c.category === "bug");
    expect(bug?.pending).toBe(1);
    expect(bug?.total).toBe(2);
  });

  it("counts totalFeedback excluding pending", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "high", messageHash: "h1", outcome: "helpful", createdAt: "2026-01-01" },
      { repo: "r", pr: 1, commentId: 2, file: "b.ts", line: 2, category: "bug", severity: "high", messageHash: "h2", outcome: "pending", createdAt: "2026-01-02" },
      { repo: "r", pr: 1, commentId: 3, file: "c.ts", line: 3, category: "bug", severity: "high", messageHash: "h3", outcome: "unhelpful", createdAt: "2026-01-03" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.totalFindings).toBe(3);
    expect(result.totalFeedback).toBe(2); // only helpful + unhelpful
  });

  it("sets noisiestCategory to null when all fatigue scores <= 5", () => {
    writeFeedbackStore([
      { repo: "r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "high", messageHash: "h1", outcome: "helpful", createdAt: "2026-01-01" },
    ]);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.noisiestCategory).toBeNull();
  });

  it("handles multiple categories with different fatigue scores", () => {
    const entries: FeedbackEntry[] = [];
    // bug: 100% acceptance (low fatigue)
    for (let i = 0; i < 5; i++) entries.push({ repo: "r", pr: 1, commentId: i, file: "a.ts", line: i, category: "bug", severity: "medium", messageHash: `h${i}`, outcome: "helpful", createdAt: `2026-01-${String(i + 1).padStart(2, "0")}` });
    // style: 0% acceptance (high fatigue)
    for (let i = 0; i < 5; i++) entries.push({ repo: "r", pr: 1, commentId: i + 10, file: "a.ts", line: i + 10, category: "style", severity: "low", messageHash: `h${i + 10}`, outcome: "unhelpful", createdAt: `2026-01-${String(i + 11).padStart(2, "0")}` });
    writeFeedbackStore(entries);
    const result = buildFatigueDashboard(tmpDir, new Set());
    expect(result.categories[0].category).toBe("style");
    expect(result.noisiestCategory).toBe("style");
  });
});

// ---------------------------------------------------------------------------
// formatFatigueDashboard
// ---------------------------------------------------------------------------

describe("formatFatigueDashboard", () => {
  it("returns empty string for no categories", () => {
    const result = { categories: [], totalFindings: 0, totalFeedback: 0, overallAcceptance: 0, noisiestCategory: null, suppressedCategories: [] };
    expect(formatFatigueDashboard(result)).toBe("");
  });

  it("formats dashboard with markdown table", () => {
    const result = {
      categories: [{
        category: "style", total: 20, helpful: 5, unhelpful: 15,
        acceptanceRate: 25, fatigueScore: 19.5, trend: "declining" as const,
      }],
      totalFindings: 20, totalFeedback: 20, overallAcceptance: 25,
      noisiestCategory: "style", suppressedCategories: [],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("Review Fatigue Dashboard");
    expect(body).toContain("style");
    expect(body).toContain("25%");
    expect(body).toContain("19.5");
    expect(body).toContain("<details>");
    expect(body).toContain("</details>");
    expect(body).toContain("mizumi-fatigue-dashboard");
  });

  it("includes overall metrics", () => {
    const result = {
      categories: [{ category: "bug", total: 10, helpful: 8, unhelpful: 2, acceptanceRate: 80, fatigueScore: 3.2, trend: "stable" as const }],
      totalFindings: 10, totalFeedback: 10, overallAcceptance: 80,
      noisiestCategory: null, suppressedCategories: [],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("Total findings");
    expect(body).toContain("10");
    expect(body).toContain("80%");
  });

  it("includes recommendations for low-acceptance categories", () => {
    const result = {
      categories: [{ category: "style", total: 10, helpful: 1, unhelpful: 9, acceptanceRate: 10, fatigueScore: 9.5, trend: "stable" as const }],
      totalFindings: 10, totalFeedback: 10, overallAcceptance: 10,
      noisiestCategory: "style", suppressedCategories: [],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("Recommendations");
    expect(body).toContain("style");
    expect(body).toContain("10% acceptance");
  });

  it("includes declining trend recommendations", () => {
    const result = {
      categories: [{ category: "security", total: 8, helpful: 4, unhelpful: 4, acceptanceRate: 50, fatigueScore: 5, trend: "declining" as const }],
      totalFindings: 8, totalFeedback: 8, overallAcceptance: 50,
      noisiestCategory: "security", suppressedCategories: [],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("declining");
  });

  it("includes suppressed categories in summary", () => {
    const result = {
      categories: [{ category: "style", total: 5, helpful: 0, unhelpful: 5, acceptanceRate: 0, fatigueScore: 5, trend: "stable" as const }],
      totalFindings: 5, totalFeedback: 5, overallAcceptance: 0,
      noisiestCategory: "style", suppressedCategories: ["style"],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("Suppressed categories");
    expect(body).toContain("style");
  });

  it("truncates table at 15 categories", () => {
    const categories = Array.from({ length: 20 }, (_, i) => ({
      category: `cat${i}`, total: i + 1, helpful: 0, unhelpful: i + 1,
      acceptanceRate: 0, fatigueScore: i, trend: "stable" as const,
    }));
    const result = {
      categories, totalFindings: 100, totalFeedback: 100, overallAcceptance: 0,
      noisiestCategory: "cat19", suppressedCategories: [],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("cat0");
    expect(body).toContain("cat14");
    expect(body).toContain("20 total");
  });

  it("includes trend badges in table", () => {
    const result = {
      categories: [{ category: "bug", total: 10, helpful: 7, unhelpful: 3, acceptanceRate: 70, fatigueScore: 3, trend: "improving" as const }],
      totalFindings: 10, totalFeedback: 10, overallAcceptance: 70,
      noisiestCategory: null, suppressedCategories: [],
    };
    const body = formatFatigueDashboard(result);
    expect(body).toContain("improving");
    expect(body).toContain("img.shields.io");
  });
});
