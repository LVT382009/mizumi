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
