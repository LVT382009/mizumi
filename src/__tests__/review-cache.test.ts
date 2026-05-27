import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import {
  hashContent,
  readCacheStore,
  writeCacheStore,
  pruneStaleEntries,
  lookupCache,
  storeCacheEntry,
  planFileReviews,
  cacheReviewResults,
  formatCacheStats,
} from "../review-cache.js";
import type { CacheStore, CachedFinding } from "../review-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rc-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const makeFindings = (n: number): CachedFinding[] =>
  Array.from({ length: n }, (_, i) => ({
    file: `file${i}.ts`,
    line: i + 1,
    severity: "medium" as const,
    category: "bug",
    message: `Issue ${i}`,
    confidence: 80,
  }));

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

describe("hashContent", () => {
  it("returns 16-char hex string", () => {
    const hash = hashContent("test.ts", "content");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("produces same hash for same input", () => {
    const h1 = hashContent("app.ts", "hello world");
    const h2 = hashContent("app.ts", "hello world");
    expect(h1).toBe(h2);
  });

  it("produces different hash for different content", () => {
    const h1 = hashContent("app.ts", "hello");
    const h2 = hashContent("app.ts", "world");
    expect(h1).not.toBe(h2);
  });

  it("produces different hash for different paths with same content", () => {
    const h1 = hashContent("a.ts", "same content");
    const h2 = hashContent("b.ts", "same content");
    expect(h1).not.toBe(h2);
  });

  it("handles empty content", () => {
    const hash = hashContent("empty.ts", "");
    expect(hash).toHaveLength(16);
  });

  it("handles unicode content", () => {
    const hash = hashContent("i18n.ts", "日本語テスト");
    expect(hash).toHaveLength(16);
  });

  it("handles very long content", () => {
    const hash = hashContent("big.ts", "x".repeat(100000));
    expect(hash).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// readCacheStore / writeCacheStore
// ---------------------------------------------------------------------------

describe("readCacheStore / writeCacheStore", () => {
  it("returns empty store when no cache file exists", () => {
    const store = readCacheStore(tmpDir);
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("round-trips a store with entries", () => {
    const store: CacheStore = {
      version: 1,
      entries: {
        "app.ts": {
          contentHash: "abc123",
          findings: makeFindings(2),
          reviewedAt: new Date().toISOString(),
          riskScore: 3,
          summary: "OK",
        },
      },
    };
    writeCacheStore(tmpDir, store);
    const loaded = readCacheStore(tmpDir);
    expect(loaded.entries["app.ts"]).toBeDefined();
    expect(loaded.entries["app.ts"].contentHash).toBe("abc123");
  });

  it("handles corrupted cache file", () => {
    const cacheDir = path.join(tmpDir, ".mizumi", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "review-cache.json"), "{ invalid json");
    const store = readCacheStore(tmpDir);
    expect(store.entries).toEqual({});
  });

  it("resets store on version mismatch", () => {
    const cacheDir = path.join(tmpDir, ".mizumi", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "review-cache.json"),
      JSON.stringify({ version: 999, entries: { old: {} } }),
    );
    const store = readCacheStore(tmpDir);
    expect(store.version).toBe(1);
    expect(store.entries).toEqual({});
  });

  it("creates .mizumi/cache directory if missing", () => {
    const store: CacheStore = { version: 1, entries: {} };
    writeCacheStore(tmpDir, store);
    expect(fs.existsSync(path.join(tmpDir, ".mizumi", "cache", "review-cache.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pruneStaleEntries
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than 7 days", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const store: CacheStore = {
      version: 1,
      entries: {
        "old.ts": {
          contentHash: "old",
          findings: [],
          reviewedAt: eightDaysAgo,
          riskScore: 1,
          summary: "",
        },
      },
    };
    const pruned = pruneStaleEntries(store);
    expect(pruned).toBe(1);
    expect(store.entries["old.ts"]).toBeUndefined();
  });

  it("keeps entries within TTL", () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const store: CacheStore = {
      version: 1,
      entries: {
        "fresh.ts": {
          contentHash: "fresh",
          findings: [],
          reviewedAt: recent,
          riskScore: 1,
          summary: "",
        },
      },
    };
    const pruned = pruneStaleEntries(store);
    expect(pruned).toBe(0);
    expect(store.entries["fresh.ts"]).toBeDefined();
  });

  it("prunes oldest entries when over MAX_ENTRIES", () => {
    const store: CacheStore = { version: 1, entries: {} };
    for (let i = 0; i < 550; i++) {
      store.entries[`file${i}.ts`] = {
        contentHash: `hash${i}`,
        findings: [],
        reviewedAt: new Date(Date.now() - i * 1000).toISOString(),
        riskScore: 1,
        summary: "",
      };
    }
    const pruned = pruneStaleEntries(store);
    expect(pruned).toBe(50);
    expect(Object.keys(store.entries).length).toBe(500);
  });

  it("handles empty store", () => {
    const store: CacheStore = { version: 1, entries: {} };
    const pruned = pruneStaleEntries(store);
    expect(pruned).toBe(0);
  });

  it("prunes both stale and overflow entries", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const store: CacheStore = { version: 1, entries: {} };
    // 10 stale entries
    for (let i = 0; i < 10; i++) {
      store.entries[`stale${i}.ts`] = {
        contentHash: `stale${i}`,
        findings: [],
        reviewedAt: eightDaysAgo,
        riskScore: 1,
        summary: "",
      };
    }
    // 500 recent entries (already at MAX)
    for (let i = 0; i < 500; i++) {
      store.entries[`recent${i}.ts`] = {
        contentHash: `recent${i}`,
        findings: [],
        reviewedAt: new Date().toISOString(),
        riskScore: 1,
        summary: "",
      };
    }
    const pruned = pruneStaleEntries(store);
    expect(pruned).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// lookupCache
// ---------------------------------------------------------------------------

describe("lookupCache", () => {
  it("returns entry on cache hit", () => {
    const hash = hashContent("app.ts", "hello");
    const store: CacheStore = {
      version: 1,
      entries: {
        "app.ts": {
          contentHash: hash,
          findings: makeFindings(2),
          reviewedAt: new Date().toISOString(),
          riskScore: 3,
          summary: "Test",
        },
      },
    };
    const entry = lookupCache(store, "app.ts", hash);
    expect(entry).not.toBeNull();
    expect(entry!.findings).toHaveLength(2);
  });

  it("returns null on cache miss (no entry)", () => {
    const store: CacheStore = { version: 1, entries: {} };
    const entry = lookupCache(store, "app.ts", "hash");
    expect(entry).toBeNull();
  });

  it("returns null on content hash mismatch", () => {
    const store: CacheStore = {
      version: 1,
      entries: {
        "app.ts": {
          contentHash: "old_hash",
          findings: [],
          reviewedAt: new Date().toISOString(),
          riskScore: 1,
          summary: "",
        },
      },
    };
    const entry = lookupCache(store, "app.ts", "new_hash");
    expect(entry).toBeNull();
  });

  it("returns null on stale entry and removes it", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const store: CacheStore = {
      version: 1,
      entries: {
        "app.ts": {
          contentHash: "abc",
          findings: [],
          reviewedAt: eightDaysAgo,
          riskScore: 1,
          summary: "",
        },
      },
    };
    const entry = lookupCache(store, "app.ts", "abc");
    expect(entry).toBeNull();
    expect(store.entries["app.ts"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// storeCacheEntry
// ---------------------------------------------------------------------------

describe("storeCacheEntry", () => {
  it("stores a new entry", () => {
    const store: CacheStore = { version: 1, entries: {} };
    storeCacheEntry(store, "app.ts", "hash123", makeFindings(3), 4, "Summary");
    expect(store.entries["app.ts"]).toBeDefined();
    expect(store.entries["app.ts"].contentHash).toBe("hash123");
    expect(store.entries["app.ts"].findings).toHaveLength(3);
    expect(store.entries["app.ts"].riskScore).toBe(4);
  });

  it("overwrites existing entry on same path", () => {
    const store: CacheStore = { version: 1, entries: {} };
    storeCacheEntry(store, "app.ts", "hash1", makeFindings(1), 1, "Old");
    storeCacheEntry(store, "app.ts", "hash2", makeFindings(5), 5, "New");
    expect(store.entries["app.ts"].contentHash).toBe("hash2");
    expect(store.entries["app.ts"].findings).toHaveLength(5);
  });

  it("sets reviewedAt to current time", () => {
    const store: CacheStore = { version: 1, entries: {} };
    const before = new Date().toISOString();
    storeCacheEntry(store, "app.ts", "hash", [], 1, "");
    const after = new Date().toISOString();
    expect(store.entries["app.ts"].reviewedAt >= before).toBe(true);
    expect(store.entries["app.ts"].reviewedAt <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planFileReviews
// ---------------------------------------------------------------------------

describe("planFileReviews", () => {
  it("returns all files as toReview for empty cache", () => {
    const plan = planFileReviews(tmpDir, [
      { path: "a.ts", content: "hello" },
      { path: "b.ts", content: "world" },
    ]);
    expect(plan.toReview).toHaveLength(2);
    expect(plan.cached).toHaveLength(0);
    expect(plan.stats.hits).toBe(0);
    expect(plan.stats.misses).toBe(2);
  });

  it("returns cached results for previously reviewed files", () => {
    // First review — populate cache
    cacheReviewResults(tmpDir, [
      { path: "a.ts", content: "hello", findings: makeFindings(2), riskScore: 2, summary: "A" },
    ]);

    // Second review — should hit cache
    const plan = planFileReviews(tmpDir, [
      { path: "a.ts", content: "hello" },
      { path: "b.ts", content: "world" },
    ]);
    expect(plan.toReview).toHaveLength(1);
    expect(plan.toReview).toContain("b.ts");
    expect(plan.cached).toHaveLength(1);
    expect(plan.cached[0].path).toBe("a.ts");
    expect(plan.stats.hits).toBe(1);
    expect(plan.stats.misses).toBe(1);
  });

  it("detects content changes and invalidates cache", () => {
    // First review
    cacheReviewResults(tmpDir, [
      { path: "a.ts", content: "hello", findings: [], riskScore: 1, summary: "" },
    ]);

    // Second review with changed content
    const plan = planFileReviews(tmpDir, [
      { path: "a.ts", content: "hello modified" },
    ]);
    expect(plan.toReview).toHaveLength(1);
    expect(plan.cached).toHaveLength(0);
  });

  it("estimates tokens saved from cache hits", () => {
    // Populate cache for 3 files
    cacheReviewResults(tmpDir, [
      { path: "a.ts", content: "aaa", findings: [], riskScore: 1, summary: "" },
      { path: "b.ts", content: "bbb", findings: [], riskScore: 1, summary: "" },
      { path: "c.ts", content: "ccc", findings: [], riskScore: 1, summary: "" },
    ]);

    const plan = planFileReviews(tmpDir, [
      { path: "a.ts", content: "aaa" },
      { path: "b.ts", content: "bbb" },
      { path: "c.ts", content: "ccc" },
      { path: "d.ts", content: "ddd" },
    ]);
    expect(plan.stats.hits).toBe(3);
    expect(plan.stats.tokensSaved).toBe(6000); // 3 * 2000
  });

  it("handles empty file list", () => {
    const plan = planFileReviews(tmpDir, []);
    expect(plan.toReview).toHaveLength(0);
    expect(plan.cached).toHaveLength(0);
    expect(plan.stats.hits).toBe(0);
    expect(plan.stats.misses).toBe(0);
  });

  it("prunes stale entries during plan", () => {
    // Write a cache with a stale entry
    const store = readCacheStore(tmpDir);
    store.entries["old.ts"] = {
      contentHash: hashContent("old.ts", "old"),
      findings: [],
      reviewedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      riskScore: 1,
      summary: "",
    };
    writeCacheStore(tmpDir, store);

    const plan = planFileReviews(tmpDir, [
      { path: "old.ts", content: "old" },
    ]);
    // Stale entry was removed, so this is a miss
    expect(plan.toReview).toHaveLength(1);
    expect(plan.cached).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cacheReviewResults
// ---------------------------------------------------------------------------

describe("cacheReviewResults", () => {
  it("stores results and reads them back", () => {
    cacheReviewResults(tmpDir, [
      { path: "app.ts", content: "code", findings: makeFindings(1), riskScore: 2, summary: "Found 1 issue" },
    ]);

    const store = readCacheStore(tmpDir);
    expect(store.entries["app.ts"]).toBeDefined();
    expect(store.entries["app.ts"].findings).toHaveLength(1);
  });

  it("stores multiple files at once", () => {
    cacheReviewResults(tmpDir, [
      { path: "a.ts", content: "aa", findings: makeFindings(2), riskScore: 1, summary: "A" },
      { path: "b.ts", content: "bb", findings: makeFindings(3), riskScore: 3, summary: "B" },
    ]);

    const store = readCacheStore(tmpDir);
    expect(Object.keys(store.entries)).toHaveLength(2);
  });

  it("prunes stale entries after storing", () => {
    // Pre-populate with stale entry
    const store = readCacheStore(tmpDir);
    store.entries["stale.ts"] = {
      contentHash: "x",
      findings: [],
      reviewedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      riskScore: 0,
      summary: "",
    };
    writeCacheStore(tmpDir, store);

    // Store new results — should prune stale
    cacheReviewResults(tmpDir, [
      { path: "fresh.ts", content: "fresh", findings: [], riskScore: 0, summary: "" },
    ]);

    const after = readCacheStore(tmpDir);
    expect(after.entries["stale.ts"]).toBeUndefined();
    expect(after.entries["fresh.ts"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// formatCacheStats
// ---------------------------------------------------------------------------

describe("formatCacheStats", () => {
  it("formats stats with hit rate", () => {
    const result = formatCacheStats({ hits: 5, misses: 5, entriesStored: 50, tokensSaved: 10000 });
    expect(result).toContain("5/10");
    expect(result).toContain("50%");
    expect(result).toContain("10,000");
  });

  it("handles zero hits", () => {
    const result = formatCacheStats({ hits: 0, misses: 3, entriesStored: 0, tokensSaved: 0 });
    expect(result).toContain("0/3");
    expect(result).toContain("0%");
  });

  it("handles all hits", () => {
    const result = formatCacheStats({ hits: 5, misses: 0, entriesStored: 20, tokensSaved: 10000 });
    expect(result).toContain("5/5");
    expect(result).toContain("100%");
  });

  it("handles empty stats", () => {
    const result = formatCacheStats({ hits: 0, misses: 0, entriesStored: 0, tokensSaved: 0 });
    expect(result).toContain("0/0");
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests
// ---------------------------------------------------------------------------

describe("review cache integration", () => {
  it("full round-trip: review -> cache -> re-review", () => {
    const files = [
      { path: "app.ts", content: "console.log('hello')" },
      { path: "util.ts", content: "export function add(a, b) { return a + b; }" },
    ];

    // First review — all misses
    const plan1 = planFileReviews(tmpDir, files);
    expect(plan1.toReview).toHaveLength(2);
    expect(plan1.cached).toHaveLength(0);

    // Simulate LLM review results
    cacheReviewResults(tmpDir, [
      { path: "app.ts", content: files[0].content, findings: makeFindings(1), riskScore: 2, summary: "Found console.log" },
      { path: "util.ts", content: files[1].content, findings: [], riskScore: 0, summary: "Clean" },
    ]);

    // Second review — all hits (same files, same content)
    const plan2 = planFileReviews(tmpDir, files);
    expect(plan2.toReview).toHaveLength(0);
    expect(plan2.cached).toHaveLength(2);
  });

  it("partial cache hit: some files changed", () => {
    cacheReviewResults(tmpDir, [
      { path: "a.ts", content: "original", findings: makeFindings(1), riskScore: 1, summary: "" },
      { path: "b.ts", content: "original", findings: makeFindings(2), riskScore: 2, summary: "" },
    ]);

    const plan = planFileReviews(tmpDir, [
      { path: "a.ts", content: "original" }, // unchanged
      { path: "b.ts", content: "modified" }, // changed
      { path: "c.ts", content: "new" },      // new file
    ]);
    expect(plan.toReview).toHaveLength(2);
    expect(plan.toReview).toContain("b.ts");
    expect(plan.toReview).toContain("c.ts");
    expect(plan.cached).toHaveLength(1);
    expect(plan.cached[0].path).toBe("a.ts");
  });

  it("cache survives multiple rounds", () => {
    const content = "stable content";
    cacheReviewResults(tmpDir, [
      { path: "stable.ts", content, findings: makeFindings(3), riskScore: 2, summary: "3 issues" },
    ]);

    // Multiple lookups should all hit
    for (let i = 0; i < 5; i++) {
      const plan = planFileReviews(tmpDir, [{ path: "stable.ts", content }]);
      expect(plan.cached).toHaveLength(1);
      expect(plan.cached[0].findings).toHaveLength(3);
    }
  });
});
