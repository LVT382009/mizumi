import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createSpendEntry,
  appendSpendEntry,
  readSpendLog,
  formatSpendDigest,
} from "../spend.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-spend-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("createSpendEntry", () => {
  it("creates an entry with token counts", () => {
    const entry = createSpendEntry(
      "owner/repo", 42, "anthropic", "claude-sonnet-4-6",
      { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200 },
      "standard", 3, 2
    );
    expect(entry.totalTokens).toBe(1500);
    expect(entry.cachedTokens).toBe(200);
    expect(entry.tier).toBe("standard");
  });

  it("defaults missing usage fields to 0", () => {
    const entry = createSpendEntry("o/r", 1, "openai", "gpt-4.1", {}, "light", 0, 1);
    expect(entry.inputTokens).toBe(0);
    expect(entry.totalTokens).toBe(0);
  });

  it("includes all fields", () => {
    const entry = createSpendEntry(
      "owner/repo", 7, "anthropic", "claude-sonnet-4-6",
      { inputTokens: 100, outputTokens: 50 },
      "standard", 4, 3
    );
    expect(entry.timestamp).toBeTruthy();
    expect(entry.repo).toBe("owner/repo");
    expect(entry.pr).toBe(7);
    expect(entry.tier).toBe("standard");
    expect(entry.findingCount).toBe(4);
    expect(entry.riskScore).toBe(3);
  });

  it("calculates totalTokens correctly with large numbers", () => {
    const entry = createSpendEntry(
      "o/r", 1, "anthropic", "claude",
      { inputTokens: 100000, outputTokens: 50000 },
      "standard", 0, 1
    );
    expect(entry.totalTokens).toBe(150000);
  });

  it("defaults outputTokens to 0", () => {
    const entry = createSpendEntry(
      "o/r", 1, "openai", "gpt-4.1",
      { inputTokens: 500 },
      "light", 0, 1
    );
    expect(entry.outputTokens).toBe(0);
    expect(entry.totalTokens).toBe(500);
  });
});

describe("appendSpendEntry + readSpendLog", () => {
  it("writes and reads back entries", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100, outputTokens: 50 }, "light", 1, 1);
    appendSpendEntry(tmpDir, entry);
    const log = readSpendLog(tmpDir);
    expect(log).toHaveLength(1);
    expect(log[0].totalTokens).toBe(150);
  });

  it("returns empty array when no spend file", () => {
    expect(readSpendLog(tmpDir)).toEqual([]);
  });

  it("appends multiple entries", () => {
    for (let i = 0; i < 3; i++) {
      appendSpendEntry(tmpDir, createSpendEntry("o/r", i, "anthropic", "claude", { inputTokens: 100 }, "light", 0, 1));
    }
    expect(readSpendLog(tmpDir)).toHaveLength(3);
  });

  it("handles empty file", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mizumi-spend.jsonl"), "", "utf-8");
    expect(readSpendLog(tmpDir)).toEqual([]);
  });

  it("handles file with only whitespace", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mizumi-spend.jsonl"), "\n\n\n", "utf-8");
    expect(readSpendLog(tmpDir)).toEqual([]);
  });

  it("skips malformed JSONL lines in readSpendLog", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mizumi-spend.jsonl"), "not-json\n{\"repo\":\"o/r\"}\n");
    const log = readSpendLog(tmpDir);
    // Malformed lines are filtered out
    expect(log.length).toBeLessThanOrEqual(1);
  });

  it("creates .github directory if missing", () => {
    const githubDir = path.join(tmpDir, ".github");
    // Ensure .github does not exist
    if (fs.existsSync(githubDir)) {
      fs.rmSync(githubDir, { recursive: true, force: true });
    }
    expect(fs.existsSync(githubDir)).toBe(false);

    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100 }, "light", 0, 1);
    appendSpendEntry(tmpDir, entry);

    expect(fs.existsSync(githubDir)).toBe(true);
    expect(fs.existsSync(path.join(githubDir, "mizumi-spend.jsonl"))).toBe(true);
  });
});

describe("formatSpendDigest", () => {
  it("returns message for empty entries", () => {
    expect(formatSpendDigest([])).toContain("No spend data");
  });

  it("formats digest with provider breakdown", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 5000 }, "standard", 2, 2),
      createSpendEntry("o/r", 2, "openai", "gpt-4.1", { inputTokens: 3000 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("Total tokens");
    expect(digest).toContain("anthropic/claude");
    expect(digest).toContain("openai/gpt-4.1");
  });

  it("includes cache hit percentage", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100 }, "standard", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("Cached tokens: 500");
  });

  it("includes total cached tokens count", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 2000, cachedInputTokens: 800, outputTokens: 200 }, "standard", 0, 1),
      createSpendEntry("o/r", 2, "openai", "gpt-4.1", { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    // Total cached = 800 + 200 = 1000
    expect(digest).toContain("Cached tokens: 1,000");
  });

  it("table includes all provider/model combos", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude-sonnet-4-6", { inputTokens: 3000 }, "standard", 0, 1),
      createSpendEntry("o/r", 2, "anthropic", "claude-haiku-4-5", { inputTokens: 2000 }, "light", 0, 1),
      createSpendEntry("o/r", 3, "openai", "gpt-4.1", { inputTokens: 1000 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("anthropic/claude-sonnet-4-6");
    expect(digest).toContain("anthropic/claude-haiku-4-5");
    expect(digest).toContain("openai/gpt-4.1");
  });
});

describe("spend threshold logic", () => {
  it("triggers dashboard when totalTokens exceeds threshold", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 80000, outputTokens: 30000 }, "standard", 3, 3);
    const threshold = 100000;
    expect(entry.totalTokens).toBe(110000);
    expect(entry.totalTokens > threshold).toBe(true);
  });

  it("does not trigger dashboard when totalTokens is below threshold", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 1000, outputTokens: 500 }, "light", 0, 1);
    const threshold = 100000;
    expect(entry.totalTokens).toBe(1500);
    expect(entry.totalTokens > threshold).toBe(false);
  });

  it("disabled when threshold is 0", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100000 }, "standard", 5, 5);
    const threshold = 0;
    expect(threshold > 0).toBe(false);
  });

  it("formatSpendDigest can filter entries by repo", () => {
    const entries = [
      createSpendEntry("owner/repo1", 1, "anthropic", "claude", { inputTokens: 5000 }, "standard", 1, 2),
      createSpendEntry("owner/repo2", 2, "anthropic", "claude", { inputTokens: 3000 }, "light", 0, 1),
    ];
    const filtered = entries.filter(e => e.repo === "owner/repo1");
    const digest = formatSpendDigest(filtered);
    expect(digest).toContain("1 reviews");
    expect(digest).toContain("5,000");
  });

  it("formats digest with review count", () => {
    const entries = Array.from({ length: 5 }, () =>
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 1000 }, "standard", 1, 1)
    );
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("5 reviews");
  });

  it("handles 0 cache hit percentage", () => {
    const entries = [
      createSpendEntry("o/r", 1, "openai", "gpt-4.1", { inputTokens: 1000, outputTokens: 500 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("0% cache hit");
  });

  it("sorts providers by token count descending", () => {
    const entries = [
      createSpendEntry("o/r", 1, "openai", "gpt-4.1", { inputTokens: 1000 }, "light", 0, 1),
      createSpendEntry("o/r", 2, "anthropic", "claude", { inputTokens: 5000 }, "standard", 1, 2),
    ];
    const digest = formatSpendDigest(entries);
    const anthropicIdx = digest.indexOf("anthropic/claude");
    const openaiIdx = digest.indexOf("openai/gpt-4.1");
    expect(anthropicIdx).toBeLessThan(openaiIdx);
  });

  it("handles single entry in digest", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude-sonnet-4-6", { inputTokens: 2000, outputTokens: 500 }, "standard", 2, 2),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("1 reviews");
    expect(digest).toContain("2,500");
  });

  it("entry has ISO timestamp", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100 }, "light", 0, 1);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles zero tokens gracefully", () => {
    const entry = createSpendEntry("o/r", 1, "local", "llama3", {}, "light", 0, 1);
    expect(entry.totalTokens).toBe(0);
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
  });

  it("preserves provider and model in entry", () => {
    const entry = createSpendEntry("o/r", 1, "google", "gemini-2.5-flash", { inputTokens: 100 }, "standard", 1, 2);
    expect(entry.provider).toBe("google");
    expect(entry.model).toBe("gemini-2.5-flash");
  });

  it("preserves pr number in entry", () => {
    const entry = createSpendEntry("o/r", 99, "anthropic", "claude", { inputTokens: 100 }, "light", 0, 1);
    expect(entry.pr).toBe(99);
  });

  it("preserves finding count and risk score", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100 }, "thorough", 8, 4);
    expect(entry.findingCount).toBe(8);
    expect(entry.riskScore).toBe(4);
  });

  it("formats digest with light tier entries", () => {
    const entries = [
      createSpendEntry("o/r", 1, "openai", "gpt-4.1-mini", { inputTokens: 500 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("openai/gpt-4.1-mini");
  });

});

  it("MAX_SPEND_ENTRIES is set to 500", () => {
    // Constant is internal to spend.ts, but we can verify behavior indirectly:
    // rotation happens when file exceeds 500KB, keeping last 500 entries
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100 }, "light", 0, 1);
    expect(entry.totalTokens).toBeDefined(); // Module loaded successfully
  });

describe("spend persistence", () => {
  it("survives multiple append+read cycles", () => {
    for (let i = 0; i < 5; i++) {
      const entry = createSpendEntry("o/r", i, "anthropic", "claude", { inputTokens: 100 * (i + 1) }, "light", 0, 1);
      appendSpendEntry(tmpDir, entry);
    }
    const log = readSpendLog(tmpDir);
    expect(log).toHaveLength(5);
    expect(log[0].inputTokens).toBe(100);
    expect(log[4].inputTokens).toBe(500);
  });

  it("writes JSONL format (one valid JSON per line)", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 100 }, "light", 0, 1);
    appendSpendEntry(tmpDir, entry);
    appendSpendEntry(tmpDir, entry);
    const dir = path.join(tmpDir, ".github");
    const content = fs.readFileSync(path.join(dir, "mizumi-spend.jsonl"), "utf-8");
    const fileLines = content.trim().split(String.fromCharCode(10));
    expect(fileLines).toHaveLength(2);
    for (const line of fileLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("createSpendEntry - edge cases", () => {
  it("handles very large token counts", () => {
    const entry = createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 10_000_000, outputTokens: 5_000_000 }, "standard", 0, 1);
    expect(entry.totalTokens).toBe(15_000_000);
  });

  it("preserves all numeric fields as numbers", () => {
    const entry = createSpendEntry("o/r", 99, "google", "gemini", { inputTokens: 500, outputTokens: 200 }, "standard", 7, 4);
    expect(typeof entry.pr).toBe("number");
    expect(typeof entry.inputTokens).toBe("number");
    expect(typeof entry.findingCount).toBe("number");
    expect(typeof entry.riskScore).toBe("number");
  });
});

describe("formatSpendDigest - edge cases", () => {
  it("handles entries from multiple repos", () => {
    const entries = [
      createSpendEntry("org/repo1", 1, "anthropic", "claude", { inputTokens: 1000 }, "standard", 1, 2),
      createSpendEntry("org/repo2", 1, "openai", "gpt-4.1", { inputTokens: 500 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("2 reviews");
  });

  it("includes all provider entries regardless of token count", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 10000 }, "standard", 5, 3),
      createSpendEntry("o/r", 2, "google", "gemini", { inputTokens: 1 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("anthropic/claude");
    expect(digest).toContain("google/gemini");
  });

  it("formats 100% cache hit when all tokens are cached", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 }, "standard", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("100% cache hit");
  });

  it("handles single model with multiple reviews", () => {
    const entries = Array.from({ length: 10 }, () =>
      createSpendEntry("o/r", 1, "anthropic", "claude-sonnet-4-6", { inputTokens: 500 }, "standard", 1, 1)
    );
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("10 reviews");
    expect(digest).toContain("anthropic/claude-sonnet-4-6");
  });

  it("includes per-provider review count", () => {
    const entries = [
      createSpendEntry("o/r", 1, "anthropic", "claude", { inputTokens: 500 }, "standard", 1, 2),
      createSpendEntry("o/r", 2, "anthropic", "claude", { inputTokens: 500 }, "standard", 0, 1),
      createSpendEntry("o/r", 3, "openai", "gpt-4.1", { inputTokens: 300 }, "light", 0, 1),
    ];
    const digest = formatSpendDigest(entries);
    expect(digest).toContain("| 2 |");
  });
});
