import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  pollReactions,
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

// ---------------------------------------------------------------------------
// pollReactions — requires mocking Octokit
// ---------------------------------------------------------------------------

describe("pollReactions", () => {
  it("returns helpful count for +1 reactions", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({
            data: [
              { content: "+1" },
              { content: "+1" },
            ],
          }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(2);
    expect(result.unhelpful).toBe(0);
  });

  it("returns unhelpful count for -1 reactions", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({
            data: [
              { content: "-1" },
            ],
          }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(0);
    expect(result.unhelpful).toBe(1);
  });

  it("counts heart as helpful", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({
            data: [{ content: "heart" }],
          }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(1);
  });

  it("counts no_entry as unhelpful", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({
            data: [{ content: "no_entry" }],
          }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.unhelpful).toBe(1);
  });

  it("ignores non-voting reactions (rocket, eyes, etc.)", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({
            data: [
              { content: "rocket" },
              { content: "eyes" },
            ],
          }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(0);
    expect(result.unhelpful).toBe(0);
  });

  it("handles mixed reactions", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({
            data: [
              { content: "+1" },
              { content: "heart" },
              { content: "-1" },
              { content: "rocket" },
            ],
          }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(2);
    expect(result.unhelpful).toBe(1);
  });

  it("returns zeros when API call fails", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockRejectedValue(new Error("API error")),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(0);
    expect(result.unhelpful).toBe(0);
  });

  it("returns zeros when no reactions exist", async () => {
    const octokit = {
      rest: {
        reactions: {
          listForIssueComment: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as any;

    const result = await pollReactions(octokit, "owner", "repo", 42);
    expect(result.helpful).toBe(0);
    expect(result.unhelpful).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hashMessage — additional edge cases
// ---------------------------------------------------------------------------

describe("hashMessage (edge cases)", () => {
  it("returns consistent hash for empty string", () => {
    expect(hashMessage("")).toBe(hashMessage(""));
  });

  it("returns different hash for empty vs non-empty", () => {
    expect(hashMessage("")).not.toBe(hashMessage("a"));
  });

  it("handles Unicode characters", () => {
    const h = hashMessage("SQLインジェクション");
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("returns consistent hash for Unicode message", () => {
    expect(hashMessage("SQLインジェクション")).toBe(hashMessage("SQLインジェクション"));
  });

  it("handles very long message", () => {
    const longMsg = "a".repeat(10_000);
    const h = hashMessage(longMsg);
    expect(typeof h).toBe("string");
    expect(h.length).toBeGreaterThan(0);
  });

  it("returns numeric base-36 string", () => {
    const h = hashMessage("test message");
    expect(h).toMatch(/^[0-9a-z]+$/);
  });
});

// ---------------------------------------------------------------------------
// classifyReaction — additional edge cases
// ---------------------------------------------------------------------------

describe("classifyReaction (edge cases)", () => {
  it("classifies laugh as pending", () => {
    expect(classifyReaction("laugh")).toBe("pending");
  });

  it("classifies confused as pending", () => {
    expect(classifyReaction("confused")).toBe("pending");
  });

  it("classifies hooray as pending", () => {
    expect(classifyReaction("hooray")).toBe("pending");
  });

  it("classifies empty string as pending", () => {
    expect(classifyReaction("")).toBe("pending");
  });

  it("classifies rocket as pending (not helpful)", () => {
    expect(classifyReaction("rocket")).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// readFeedbackStore — additional edge cases
// ---------------------------------------------------------------------------

describe("readFeedbackStore (edge cases)", () => {
  it("returns empty store for corrupt JSON", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mizumi-feedback.json"), "not valid json{{{{");
    const store = readFeedbackStore(tmpDir);
    expect(store.entries).toEqual([]);
  });

  it("returns empty store for empty file", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mizumi-feedback.json"), "");
    const store = readFeedbackStore(tmpDir);
    expect(store.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeFeedbackStore — additional edge cases
// ---------------------------------------------------------------------------

describe("writeFeedbackStore (edge cases)", () => {
  it("creates .github directory if missing", () => {
    const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-feedback-fresh-"));
    try {
      writeFeedbackStore(freshTmp, { entries: [{ repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "low", messageHash: "abc", outcome: "pending", createdAt: "2026-01-01" }] });
      const dirExists = fs.existsSync(path.join(freshTmp, ".github"));
      expect(dirExists).toBe(true);
      const fileExists = fs.existsSync(path.join(freshTmp, ".github", "mizumi-feedback.json"));
      expect(fileExists).toBe(true);
    } finally {
      fs.rmSync(freshTmp, { recursive: true, force: true });
    }
  });

  it("keeps most recent entries when capping", () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i, category: "bug", severity: "low",
      messageHash: `h${i}`, outcome: "pending" as const, createdAt: `2026-01-${String(i % 28 + 1).padStart(2, "0")}`,
    }));
    writeFeedbackStore(tmpDir, { entries });
    const read = readFeedbackStore(tmpDir);
    // Should keep last 200 entries (220-249 index range)
    expect(read.entries[0].pr).toBe(50);
    expect(read.entries[read.entries.length - 1].pr).toBe(249);
  });

  it("preserves entry data through write-read cycle", () => {
    const store = {
      entries: [
        { repo: "my/repo", pr: 99, commentId: 777, file: "deep/path/file.ts", line: 42, category: "security", severity: "critical", messageHash: "xyz789", outcome: "helpful" as const, createdAt: "2026-05-27T00:00:00Z" },
      ],
    };
    writeFeedbackStore(tmpDir, store);
    const read = readFeedbackStore(tmpDir);
    expect(read.entries[0]).toEqual(store.entries[0]);
  });

  it("does not cap entries below MAX", () => {
    const store = {
      entries: Array.from({ length: 100 }, (_, i) => ({
        repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i, category: "bug", severity: "low",
        messageHash: `h${i}`, outcome: "pending" as const, createdAt: "2026-01-01",
      })),
    };
    writeFeedbackStore(tmpDir, store);
    const read = readFeedbackStore(tmpDir);
    expect(read.entries).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// recordFindings — additional edge cases
// ---------------------------------------------------------------------------

describe("recordFindings (edge cases)", () => {
  it("records multiple findings at once", () => {
    recordFindings(tmpDir, "owner/repo", 10, [
      { file: "a.ts", line: 1, category: "security", severity: "high", message: "xss risk" },
      { file: "b.ts", line: 2, category: "style", severity: "low", message: "bad indent" },
      { file: "c.ts", line: 3, category: "bug", severity: "medium", message: "null deref" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries).toHaveLength(3);
    expect(store.entries[0].category).toBe("security");
    expect(store.entries[1].category).toBe("style");
    expect(store.entries[2].category).toBe("bug");
  });

  it("defaults commentId to 0 when not provided", () => {
    recordFindings(tmpDir, "owner/repo", 5, [
      { file: "a.ts", line: 1, category: "bug", severity: "low", message: "issue" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries[0].commentId).toBe(0);
  });

  it("uses provided commentId", () => {
    recordFindings(tmpDir, "owner/repo", 5, [
      { commentId: 999, file: "a.ts", line: 1, category: "bug", severity: "low", message: "issue" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries[0].commentId).toBe(999);
  });

  it("appends to existing store entries", () => {
    recordFindings(tmpDir, "owner/repo", 1, [
      { file: "a.ts", line: 1, category: "security", severity: "high", message: "first" },
    ]);
    recordFindings(tmpDir, "owner/repo", 2, [
      { file: "b.ts", line: 2, category: "bug", severity: "medium", message: "second" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries).toHaveLength(2);
    expect(store.entries[0].pr).toBe(1);
    expect(store.entries[1].pr).toBe(2);
  });

  it("computes messageHash from message content", () => {
    recordFindings(tmpDir, "owner/repo", 1, [
      { file: "a.ts", line: 1, category: "bug", severity: "low", message: "exact message" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries[0].messageHash).toBe(hashMessage("exact message"));
  });

  it("sets outcome to pending for new entries", () => {
    recordFindings(tmpDir, "owner/repo", 1, [
      { file: "a.ts", line: 1, category: "bug", severity: "low", message: "test" },
    ]);
    const store = readFeedbackStore(tmpDir);
    expect(store.entries[0].outcome).toBe("pending");
  });

  it("sets createdAt to a valid ISO date", () => {
    recordFindings(tmpDir, "owner/repo", 1, [
      { file: "a.ts", line: 1, category: "bug", severity: "low", message: "test" },
    ]);
    const store = readFeedbackStore(tmpDir);
    const date = new Date(store.entries[0].createdAt);
    expect(date.getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// categoryAcceptanceRates — additional edge cases
// ---------------------------------------------------------------------------

describe("categoryAcceptanceRates (edge cases)", () => {
  it("computes 100% rate for all-helpful entries", () => {
    const store = {
      entries: Array.from({ length: 5 }, (_, i) => ({
        repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i, category: "security", severity: "high",
        messageHash: `h${i}`, outcome: "helpful" as const, createdAt: "2026-01-01",
      })),
    };
    const rates = categoryAcceptanceRates(store);
    expect(rates.security.rate).toBe(1);
    expect(rates.security.helpful).toBe(5);
    expect(rates.security.unhelpful).toBe(0);
  });

  it("computes 0% rate for all-unhelpful entries", () => {
    const store = {
      entries: Array.from({ length: 5 }, (_, i) => ({
        repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i, category: "style", severity: "low",
        messageHash: `h${i}`, outcome: "unhelpful" as const, createdAt: "2026-01-01",
      })),
    };
    const rates = categoryAcceptanceRates(store);
    expect(rates.style.rate).toBe(0);
    expect(rates.style.helpful).toBe(0);
    expect(rates.style.unhelpful).toBe(5);
  });

  it("returns 0.5 rate for single helpful and single unhelpful", () => {
    const store = {
      entries: [
        { repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "medium", messageHash: "a", outcome: "helpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 2, commentId: 2, file: "b.ts", line: 2, category: "bug", severity: "medium", messageHash: "b", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
      ],
    };
    const rates = categoryAcceptanceRates(store);
    expect(rates.bug.rate).toBe(0.5);
  });

  it("computes rates independently per category", () => {
    const store = {
      entries: [
        { repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "security", severity: "high", messageHash: "a", outcome: "helpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 2, commentId: 2, file: "b.ts", line: 2, category: "security", severity: "high", messageHash: "b", outcome: "helpful" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 3, commentId: 3, file: "c.ts", line: 3, category: "style", severity: "low", messageHash: "c", outcome: "unhelpful" as const, createdAt: "2026-01-01" },
      ],
    };
    const rates = categoryAcceptanceRates(store);
    expect(rates.security.rate).toBe(1);
    expect(rates.style.rate).toBe(0);
  });

  it("skips pending entries from all categories", () => {
    const store = {
      entries: [
        { repo: "o/r", pr: 1, commentId: 1, file: "a.ts", line: 1, category: "bug", severity: "medium", messageHash: "a", outcome: "pending" as const, createdAt: "2026-01-01" },
        { repo: "o/r", pr: 2, commentId: 2, file: "b.ts", line: 2, category: "style", severity: "low", messageHash: "b", outcome: "pending" as const, createdAt: "2026-01-01" },
      ],
    };
    const rates = categoryAcceptanceRates(store);
    expect(Object.keys(rates)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeSuppressedPatterns — additional edge cases
// ---------------------------------------------------------------------------

describe("computeSuppressedPatterns (edge cases)", () => {
  it("does not suppress at exactly 30% acceptance (boundary)", () => {
    // 3 helpful, 7 unhelpful = 30% acceptance, not < 30%
    const store = {
      entries: [
        ...Array.from({ length: 3 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `h${i}`,
          outcome: "helpful" as const, createdAt: "2026-01-01",
        })),
        ...Array.from({ length: 7 }, (_, i) => ({
          repo: "o/r", pr: i + 10, commentId: i + 10, file: "b.ts", line: i,
          category: "style", severity: "low", messageHash: `u${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("style:low")).toBe(false); // 30% NOT < 30%
  });

  it("suppresses at 29% acceptance (below boundary)", () => {
    // 2 helpful, 5 unhelpful = ~28.6% acceptance
    const store = {
      entries: [
        ...Array.from({ length: 2 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `h${i}`,
          outcome: "helpful" as const, createdAt: "2026-01-01",
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          repo: "o/r", pr: i + 10, commentId: i + 10, file: "b.ts", line: i,
          category: "style", severity: "low", messageHash: `u${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("style:low")).toBe(true);
  });

  it("does not suppress exactly 4 total responses", () => {
    const store = {
      entries: Array.from({ length: 4 }, (_, i) => ({
        repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
        category: "style", severity: "low", messageHash: `h${i}`,
        outcome: "unhelpful" as const, createdAt: "2026-01-01",
      })),
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.size).toBe(0); // 4 < 5
  });

  it("suppresses at exactly 5 total responses with all unhelpful", () => {
    const store = {
      entries: Array.from({ length: 5 }, (_, i) => ({
        repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
        category: "bug", severity: "medium", messageHash: `h${i}`,
        outcome: "unhelpful" as const, createdAt: "2026-01-01",
      })),
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("bug:medium")).toBe(true); // 0% acceptance with 5+ responses
  });

  it("handles mixed pending and resolved entries", () => {
    const store = {
      entries: [
        // 5 pending — should be ignored
        ...Array.from({ length: 5 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `p${i}`,
          outcome: "pending" as const, createdAt: "2026-01-01",
        })),
        // 5 unhelpful — 0% acceptance, should suppress
        ...Array.from({ length: 5 }, (_, i) => ({
          repo: "o/r", pr: i + 10, commentId: i + 10, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `u${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("style:low")).toBe(true);
  });

  it("groups by category:severity combination not category alone", () => {
    const store = {
      entries: [
        // style:low — 0% acceptance, 5 samples → suppressed
        ...Array.from({ length: 5 }, (_, i) => ({
          repo: "o/r", pr: i, commentId: i, file: "a.ts", line: i,
          category: "style", severity: "low", messageHash: `sl${i}`,
          outcome: "unhelpful" as const, createdAt: "2026-01-01",
        })),
        // style:high — 100% acceptance, 5 samples → not suppressed
        ...Array.from({ length: 5 }, (_, i) => ({
          repo: "o/r", pr: i + 10, commentId: i + 10, file: "b.ts", line: i,
          category: "style", severity: "high", messageHash: `sh${i}`,
          outcome: "helpful" as const, createdAt: "2026-01-01",
        })),
      ],
    };
    const suppressed = computeSuppressedPatterns(store);
    expect(suppressed.has("style:low")).toBe(true);
    expect(suppressed.has("style:high")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyNoiseReduction — additional edge cases
// ---------------------------------------------------------------------------

describe("applyNoiseReduction (edge cases)", () => {
  it("does not reduce findings with confidence exactly at 50", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 50, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(50);
  });

  it("does not reduce findings with confidence below 50", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 40, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(40);
  });

  it("reduces confidence at boundary 51 to exactly 50 (floor)", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 51, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(50);
  });

  it("reduces confidence by exactly 25 from 75", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 75, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(50);
  });

  it("handles multiple findings with mixed suppressed patterns", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 90, file: "a.ts", line: 1, message: "x" },
      { category: "bug", severity: "medium", confidence: 80, file: "b.ts", line: 2, message: "y" },
      { category: "security", severity: "high", confidence: 85, file: "c.ts", line: 3, message: "z" },
    ];
    const suppressed = new Set(["style:low", "bug:medium"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(65); // 90 - 25
    expect(result[1].confidence).toBe(55); // 80 - 25
    expect(result[2].confidence).toBe(85); // unchanged
  });

  it("does not mutate original findings array", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 90, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(findings[0].confidence).toBe(90); // original unchanged
    expect(result[0].confidence).toBe(65); // result reduced
  });

  it("preserves extra properties on findings", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 80, file: "a.ts", line: 1, message: "x", customProp: "hello" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect((result[0] as any).customProp).toBe("hello");
  });

  it("handles high confidence near 100 with suppression", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 100, file: "a.ts", line: 1, message: "x" },
    ];
    const suppressed = new Set(["style:low"]);
    const result = applyNoiseReduction(findings, suppressed);
    expect(result[0].confidence).toBe(75); // 100 - 25
  });

  it("returns same reference to findings when suppressed set is empty", () => {
    const findings = [
      { category: "style", severity: "low", confidence: 80, file: "a.ts", line: 1, message: "x" },
    ];
    const result = applyNoiseReduction(findings, new Set());
    expect(result).toBe(findings); // same reference, not copied
  });
})
