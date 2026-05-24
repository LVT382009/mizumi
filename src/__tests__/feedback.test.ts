import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  hashMessage,
  classifyReaction,
  readFeedbackStore,
  writeFeedbackStore,
  recordFindings,
  categoryAcceptanceRates,
  computeSuppressedPatterns,
  applyNoiseReduction,
} from "../feedback.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-feedback-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashMessage", () => {
  it("returns consistent hash for same message", () => {
    expect(hashMessage("sql injection risk")).toBe(hashMessage("sql injection risk"));
  });

  it("returns different hash for different messages", () => {
    expect(hashMessage("sql injection")).not.toBe(hashMessage("xss risk"));
  });
});

describe("classifyReaction", () => {
  it("classifies +1 as helpful", () => {
    expect(classifyReaction("+1")).toBe("helpful");
  });

  it("classifies heart as helpful", () => {
    expect(classifyReaction("heart")).toBe("helpful");
  });

  it("classifies -1 as unhelpful", () => {
    expect(classifyReaction("-1")).toBe("unhelpful");
  });

  it("classifies no_entry as unhelpful", () => {
    expect(classifyReaction("no_entry")).toBe("unhelpful");
  });

  it("classifies other reactions as pending", () => {
    expect(classifyReaction("rocket")).toBe("pending");
  });
});

describe("feedback store", () => {
  it("reads empty store when file missing", () => {
    const store = readFeedbackStore(tmpDir);
    expect(store.entries).toEqual([]);
  });

  it("writes and reads back entries", () => {
    const store = { entries: [{ repo: "o/r", pr: 1, commentId: 99, file: "a.ts", line: 5, category: "security", severity: "high", messageHash: "abc", outcome: "pending" as const, createdAt: "2026-01-01" }] };
    writeFeedbackStore(tmpDir, store);
    const read = readFeedbackStore(tmpDir);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0].messageHash).toBe("abc");
  });

  it("caps entries at MAX_FEEDBACK_ENTRIES", () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i, category: "bug", severity: "low",
      messageHash: `h${i}`, outcome: "pending" as const, createdAt: "2026-01-01",
    }));
    writeFeedbackStore(tmpDir, { entries });
    const read = readFeedbackStore(tmpDir);
    expect(read.entries).toHaveLength(200);
  });
});

describe("recordFindings", () => {
  it("appends findings to store", () => {
    recordFindings(tmpDir, "owner/repo", 42, [
      { file: "src/auth.ts", line: 10, category: "security", severity: "critical", message: "sql injection" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].pr).toBe(42);
    expect(store.entries[0].messageHash).toBe(hashMessage("sql injection"));
  });
});

describe("categoryAcceptanceRates", () => {
  it("computes rates from resolved entries", () => {
    const store = {
      entries: [
        { repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "security", severity: "high", messageHash: "a", outcome: "helpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 2, commentId: 2, file: "b.ts", line: 2, category: "security", severity: "high", messageHash: "b", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 3, commentId: 3, file: "c.ts", line: 3, category: "security", severity: "high", messageHash: "c", outcome: "helpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 4, commentId: 4, file: "d.ts", line: 4, category: "style", severity: "low", messageHash: "d", outcome: "pending" as const, createdAt: "2026-01-01" },
      ],
    };
    const rates = categoryAcceptanceRates(store);
    expect(rates.security.rate).toBeCloseTo(2 / 3);
    expect(rates.style).toBeUndefined();
  });

  it("returns empty for store with no resolved entries", () => {
    const store = {
      entries: [
        { repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "medium", messageHash: "a", outcome: "pending" as const, createdAt: "2026-01-01" },
      ],
    };
    const rates = categoryAcceptanceRates(store);
    expect(Object.keys(rates)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeSuppressedPatterns — adaptive noise reduction
// ---------------------------------------------------------------------------

describe("computeSuppressedPatterns", () => {
  it("returns empty set for empty store", () => {
    const suppressed = computeSuppressedPatterns({ entries: [] });
    expect(suppressed.size).toBe(0);
  });

  it("returns empty set when all entries are pending", () => {
    const store = {
      entries: Array.from({ length: 10 }, (_, i) => ({
        repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
        category: "style", severity: "low", messageHash: `h${i}`,
        outcome: "pending" as const, createdAt: "2026-01-01",
      })),
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.size).toBe(0);
  });

  it("does not suppress with < 5 total responses", () => {
    const store = {
      entries: [
        { repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "style", severity: "low", messageHash: "a", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 2, commentId: 2, file: "b.ts", line: 2, category: "style", severity: "low", messageHash: "b", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 3, commentId: 3, file: "c.ts", line: 3, category: "style", severity: "low", messageHash: "c", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 4, commentId: 4, file: "d.ts", line: 4, category: "style", severity: "low", messageHash: "d", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.size).toBe(0); // 4 < 5 minimum
  });

  it("suppresses category:severity with < 30% acceptance and 5+ responses", () => {
    const store = {
      entries: [
        ...Array.from({ length: 4 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `h${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
        { repo: "o/r", pr: 5, commentId: 5, file: "e.ts", line: 5, category: "style", severity: "low", messageHash: "e", outcome: "helpful" as const, createdAt: "2026-01-01" },
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("style:low")).toBe(true); // 1/5 = 20% < 30%
  });

  it("does not suppress category:severity with >= 30% acceptance", () => {
    const store = {
      entries: [
        ...Array.from({ length: 3 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "security", severity: "high", messageHash: `h${i}`,
          outcome: "helpful" as const, createdAt: "2026-01-01",
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          repo: "o/r", pr: i + 3, commentId: i + 3, file: "b.ts", line: i + 3,
          category: "security", severity: "high", messageHash: `u${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("security:high")).toBe(false); // 3/5 = 60% >= 30%
  });

  it("suppresses multiple patterns independently", () => {
    const store = {
      entries: [
        // style:low — all unhelpful (suppressed)
        ...Array.from({ length: 5 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `s${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
        // bug:medium — mixed (not suppressed)
        ...Array.from({ length: 3 }, (_, i) => ({
          repo: "o/r", pr: i + 5, commentId: i + 5, file: "b.ts", line: i + 5,
          category: "bug", severity: "medium", messageHash: `b${i}`,
          outcome: "helpful" as const, createdAt: "2026-01-01",
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          repo: "o/r", pr: i + 8, commentId: i + 8, file: "c.ts", line: i + 8,
          category: "bug", severity: "medium", messageHash: `bu${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("style:low")).toBe(true);
    expect(suppressed.has("bug:medium")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyNoiseReduction — confidence reduction for suppressed patterns
// ---------------------------------------------------------------------------

describe("applyNoiseReduction", () => {
  it("returns findings unchanged when no suppressed patterns", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 85, file: "a.ts", line: 1, message: "x" },
    ];
    const result = applyNoiseReduction(findings, new Set());
    expect(result[0].confidence).toBe(85);
  });

  it("reduces confidence by 25 for suppressed patterns", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 90, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(65);
  });

  it("does not reduce confidence below 50", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 55, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(50);
  });

  it("does not reduce findings already at 50", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 50, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(50);
  });

  it("leaves non-suppressed findings unchanged", () => {
    const findings = [
      { category: "security", severity: "high", confidence: 95, file: "a.ts", line: 1, message: "x" },
      { category: "style", severity: "low", confidence: 90, file: "b.ts", line: 2, message: "y" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(95); // unchanged
    expect(result[1].confidence).toBe(65); // reduced
  });

  it("handles empty findings array", () => {
    const result = applyNoiseReduction([], new Set(["style:low"]));
    expect(result).toEqual([]);
  });
});
