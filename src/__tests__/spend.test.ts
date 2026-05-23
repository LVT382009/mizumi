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
});
