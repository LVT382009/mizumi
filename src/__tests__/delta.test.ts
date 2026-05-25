import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getLastReviewedSha,
  recordReviewedSha,
  computeDeltaReview,
  formatDeltaSummary,
} from "../delta.js";
import type { DeltaReviewResult } from "../delta.js";
import type { ParsedDiff } from "../diff.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
  dirname: vi.fn((p: string) => p.split("/").slice(0, -1).join("/")),
}));

vi.mock("../diff.js", () => ({
  parseDiff: vi.fn(() => ({
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    rawDiff: "",
  })),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(),
}));

import { parseDiff } from "../diff.js";
import { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockParsedDiff = (
  files: Array<{ path: string; additions: number; deletions: number }>,
): ParsedDiff => ({
  files: files.map((f) => ({
    path: f.path,
    status: "modified" as const,
    additions: f.additions,
    deletions: f.deletions,
    hunks: [],
  })),
  totalAdditions: files.reduce((s, f) => s + f.additions, 0),
  totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
  rawDiff: "mock raw diff",
});

function mockOctokit(diffResponse: string | null = null): InstanceType<typeof Octokit> {
  const fn = diffResponse === null
    ? vi.fn().mockRejectedValue(new Error("Not found"))
    : vi.fn().mockResolvedValue({ data: diffResponse });
  return {
    rest: {
      repos: {
        compareCommits: fn,
      },
    },
  } as unknown as InstanceType<typeof Octokit>;
}

// ---------------------------------------------------------------------------
// getLastReviewedSha / recordReviewedSha
// ---------------------------------------------------------------------------

describe("SHA tracking store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("returns undefined when no store file exists", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const sha = getLastReviewedSha("/workspace", "owner", "repo", 42);
    expect(sha).toBeUndefined();
  });

  it("returns stored SHA when store exists", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#42": "abc123" },
        timestamps: { "owner/repo#42": 1000000 },
      }),
    );
    const sha = getLastReviewedSha("/workspace", "owner", "repo", 42);
    expect(sha).toBe("abc123");
  });

  it("returns undefined for PR not in store", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#99": "def456" },
        timestamps: { "owner/repo#99": 1000000 },
      }),
    );
    const sha = getLastReviewedSha("/workspace", "owner", "repo", 42);
    expect(sha).toBeUndefined();
  });

  it("records SHA and writes store", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ prShas: {}, timestamps: {} }),
    );

    recordReviewedSha("/workspace", "owner", "repo", 42, "newsha");

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("newsha"),
      "utf-8",
    );
  });

  it("evicts oldest entries when store exceeds max", () => {
    const prShas: Record<string, string> = {};
    const timestamps: Record<string, number> = {};
    // Create 1001 entries (MAX_PR_ENTRIES = 1000)
    for (let i = 0; i < 1001; i++) {
      prShas[`owner/repo#${i}`] = `sha${i}`;
      timestamps[`owner/repo#${i}`] = i; // oldest = 0
    }
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ prShas, timestamps }),
    );

    recordReviewedSha("/workspace", "owner", "repo", 9999, "newsha");

    const written = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const store = JSON.parse(written);
    // Oldest entry (i=0) should be evicted
    expect(store.prShas["owner/repo#0"]).toBeUndefined();
    // Newest entry should be present
    expect(store.prShas["owner/repo#9999"]).toBe("newsha");
    // Total entries should be <= 1000
    expect(Object.keys(store.prShas).length).toBeLessThanOrEqual(1000);
  });

  it("handles corrupted store file gracefully", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("not json");

    const sha = getLastReviewedSha("/workspace", "owner", "repo", 42);
    expect(sha).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeDeltaReview
// ---------------------------------------------------------------------------

describe("computeDeltaReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("returns non-incremental when no previous SHA exists", async () => {
    const octokit = mockOctokit();
    const fullDiff = mockParsedDiff([{ path: "src/a.ts", additions: 10, deletions: 5 }]);

    const result = await computeDeltaReview(
      octokit, "owner", "repo", 42, "head123", fullDiff, "/workspace", [],
    );

    expect(result.isIncremental).toBe(false);
    expect(result.lastReviewedSha).toBeUndefined();
    expect(result.incrementalDiff).toBeUndefined();
    expect(result.savings.percentSaved).toBe(0);
  });

  it("returns non-incremental when last SHA equals head SHA", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#42": "same123" },
        timestamps: { "owner/repo#42": 1000000 },
      }),
    );
    const octokit = mockOctokit();
    const fullDiff = mockParsedDiff([{ path: "src/a.ts", additions: 10, deletions: 5 }]);

    const result = await computeDeltaReview(
      octokit, "owner", "repo", 42, "same123", fullDiff, "/workspace", [],
    );

    expect(result.isIncremental).toBe(false);
    expect(result.lastReviewedSha).toBe("same123");
  });

  it("returns incremental result when diff exists between SHAs", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#42": "base456" },
        timestamps: { "owner/repo#42": 1000000 },
      }),
    );
    const octokit = mockOctokit("diff --git a/src/b.ts b/src/b.ts\n+new line\n");
    const fullDiff = mockParsedDiff([
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 20, deletions: 10 },
    ]);

    const incrementalParsed = mockParsedDiff([{ path: "src/b.ts", additions: 20, deletions: 10 }]);
    (parseDiff as ReturnType<typeof vi.fn>).mockReturnValue(incrementalParsed);

    const result = await computeDeltaReview(
      octokit, "owner", "repo", 42, "head789", fullDiff, "/workspace", [],
    );

    expect(result.isIncremental).toBe(true);
    expect(result.lastReviewedSha).toBe("base456");
    expect(result.incrementalDiff).toBeDefined();
    // Full diff: 45 lines, incremental: 30 lines -> 33% saved
    expect(result.savings.percentSaved).toBe(33);
    expect(result.savings.fullFiles).toBe(2);
    expect(result.savings.incrementalFiles).toBe(1);
  });

  it("falls back to non-incremental when compareCommits fails", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#42": "base456" },
        timestamps: { "owner/repo#42": 1000000 },
      }),
    );
    const octokit = {
      rest: {
        repos: {
          compareCommits: vi.fn().mockRejectedValue(new Error("SHA not found")),
        },
      },
    } as unknown as InstanceType<typeof Octokit>;
    const fullDiff = mockParsedDiff([{ path: "src/a.ts", additions: 10, deletions: 5 }]);

    const result = await computeDeltaReview(
      octokit, "owner", "repo", 42, "head789", fullDiff, "/workspace", [],
    );

    expect(result.isIncremental).toBe(false);
    expect(result.lastReviewedSha).toBe("base456");
    expect(result.incrementalDiff).toBeUndefined();
  });

  it("falls back to non-incremental when incremental diff is empty", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#42": "base456" },
        timestamps: { "owner/repo#42": 1000000 },
      }),
    );
    // Return empty string from compareCommits - should cause fetchIncrementalDiff to return undefined
    const octokit = mockOctokit("   "); // whitespace-only diff = empty after trim
    const fullDiff = mockParsedDiff([{ path: "src/a.ts", additions: 10, deletions: 5 }]);

    const result = await computeDeltaReview(
      octokit, "owner", "repo", 42, "head789", fullDiff, "/workspace", [],
    );

    expect(result.isIncremental).toBe(false);
  });

  it("calculates 100% savings when incremental diff has zero lines", async () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        prShas: { "owner/repo#42": "base456" },
        timestamps: { "owner/repo#42": 1000000 },
      }),
    );
    // Need a non-empty string so fetchIncrementalDiff doesn't bail early
    const octokit = mockOctokit("diff --git a/placeholder b/placeholder\n");
    const fullDiff = mockParsedDiff([{ path: "src/a.ts", additions: 10, deletions: 5 }]);
    const emptyIncremental = mockParsedDiff([]);
    (parseDiff as ReturnType<typeof vi.fn>).mockReturnValue(emptyIncremental);

    const result = await computeDeltaReview(
      octokit, "owner", "repo", 42, "head789", fullDiff, "/workspace", [],
    );

    expect(result.isIncremental).toBe(true);
    expect(result.savings.percentSaved).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatDeltaSummary
// ---------------------------------------------------------------------------

describe("formatDeltaSummary", () => {
  it("returns empty string for non-incremental result", () => {
    const result: DeltaReviewResult = {
      isIncremental: false,
      lastReviewedSha: undefined,
      incrementalDiff: undefined,
      savings: { fullFiles: 5, incrementalFiles: 5, fullLines: 100, incrementalLines: 100, percentSaved: 0 },
    };
    expect(formatDeltaSummary(result)).toBe("");
  });

  it("produces markdown summary with savings table", () => {
    const result: DeltaReviewResult = {
      isIncremental: true,
      lastReviewedSha: "abc123def456",
      incrementalDiff: undefined,
      savings: { fullFiles: 5, incrementalFiles: 2, fullLines: 100, incrementalLines: 30, percentSaved: 70 },
    };
    const summary = formatDeltaSummary(result);
    expect(summary).toContain("Incremental Review");
    expect(summary).toContain("70% token savings");
    expect(summary).toContain("abc123d"); // short SHA
    expect(summary).toContain("| Files | 5 | 2 | 3 |");
    expect(summary).toContain("| Lines | 100 | 30 | 70 |");
  });

  it("handles zero savings gracefully", () => {
    const result: DeltaReviewResult = {
      isIncremental: true,
      lastReviewedSha: "abc123",
      incrementalDiff: undefined,
      savings: { fullFiles: 3, incrementalFiles: 3, fullLines: 50, incrementalLines: 50, percentSaved: 0 },
    };
    const summary = formatDeltaSummary(result);
    expect(summary).toContain("0% token savings");
  });
});
