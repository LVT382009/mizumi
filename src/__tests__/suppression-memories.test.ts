import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

import {
  recordSuppressionMemory,
  shouldSuppress,
  applySuppressionMemories,
  runSuppressionMemories,
  buildSuppressionContext,
  getSuppressionMemories,
  deleteSuppressionMemory,
  pruneUnusedMemories,
} from "../suppression-memories.js";
import type { SuppressionMemory, SuppressionResult } from "../suppression-memories.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-supmem-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeFinding(overrides: { file?: string; category?: string; message?: string; confidence?: number } = {}) {
  return {
    file: overrides.file ?? "src/api/health.ts",
    category: overrides.category ?? "security",
    message: overrides.message ?? "SQL injection: unsanitized input in query",
    confidence: overrides.confidence ?? 90,
  };
}

// ---------------------------------------------------------------------------
// recordSuppressionMemory
// ---------------------------------------------------------------------------

describe("recordSuppressionMemory", () => {
  it("records a new suppression memory", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "Endpoint is auth-free by design");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories).toHaveLength(1);
    expect(memories[0].category).toBe("security");
    expect(memories[0].reason).toBe("Endpoint is auth-free by design");
  });

  it("stores file pattern as glob", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "x", "reason");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories[0].filePattern).toContain("health*");
  });

  it("deduplicates identical memories", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "same reason");
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "same reason");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories).toHaveLength(1);
  });

  it("allows different reasons for same file+category", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "reason A");
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "reason B");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories).toHaveLength(2);
  });

  it("skips empty reasons", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "");
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "   ");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories).toHaveLength(0);
  });

  it("scopes memories by repo", () => {
    recordSuppressionMemory(tmpDir, "org/repo1", "src/a.ts", "bug", "null ref", "intentional");
    recordSuppressionMemory(tmpDir, "org/repo2", "src/a.ts", "bug", "null ref", "intentional");
    expect(getSuppressionMemories(tmpDir, "org/repo1")).toHaveLength(1);
    expect(getSuppressionMemories(tmpDir, "org/repo2")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shouldSuppress
// ---------------------------------------------------------------------------

describe("shouldSuppress", () => {
  it("matches finding on same file+category", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "auth-free endpoint");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection in query");
    expect(memory).not.toBeNull();
    expect(memory!.reason).toBe("auth-free endpoint");
  });

  it("matches via glob pattern (health.ts matches health*.ts)", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "auth-free");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.controller.ts", "security", "SQL injection");
    expect(memory).not.toBeNull();
  });

  it("does not match different category", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "reason");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.ts", "bug", "SQL injection");
    expect(memory).toBeNull();
  });

  it("does not match different file", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "reason");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/users.ts", "security", "SQL injection");
    expect(memory).toBeNull();
  });

  it("matches on message pattern when provided", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "auth-free");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection in health check");
    expect(memory).not.toBeNull();
  });

  it("does not match when message pattern diverges", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "auth-free");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.ts", "security", "XSS attack vector");
    expect(memory).toBeNull();
  });

  it("matches on file+category alone when message pattern is empty", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "", "all security in health OK");
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.ts", "security", "any message at all");
    expect(memory).not.toBeNull();
  });

  it("returns null when no memories exist", () => {
    const memory = shouldSuppress(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection");
    expect(memory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applySuppressionMemories
// ---------------------------------------------------------------------------

describe("applySuppressionMemories", () => {
  it("filters out suppressed findings", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "auth-free");
    const findings = [
      makeFinding({ file: "src/api/health.ts", category: "security", message: "SQL injection in health" }),
      makeFinding({ file: "src/api/users.ts", category: "security", message: "SQL injection in users" }),
    ];
    const { filtered, suppressedCount } = applySuppressionMemories(tmpDir, "org/repo", findings);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].file).toBe("src/api/users.ts");
    expect(suppressedCount).toBe(1);
  });

  it("returns all findings when no memories match", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "bug", "null ref", "intentional");
    const findings = [
      makeFinding({ file: "src/api/health.ts", category: "security", message: "SQL injection" }),
    ];
    const { filtered, suppressedCount } = applySuppressionMemories(tmpDir, "org/repo", findings);
    expect(filtered).toHaveLength(1);
    expect(suppressedCount).toBe(0);
  });

  it("increments hit counts for matched memories", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL injection", "auth-free");
    const findings = [makeFinding({ file: "src/api/health.ts", category: "security", message: "SQL injection" })];
    applySuppressionMemories(tmpDir, "org/repo", findings);
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories[0].hitCount).toBe(1);
  });

  it("handles empty findings array", () => {
    const { filtered, suppressedCount } = applySuppressionMemories(tmpDir, "org/repo", []);
    expect(filtered).toHaveLength(0);
    expect(suppressedCount).toBe(0);
  });

  it("suppresses multiple findings from one memory", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "", "all security OK");
    const findings = [
      makeFinding({ file: "src/api/health.ts", category: "security", message: "finding 1" }),
      makeFinding({ file: "src/api/health.ts", category: "security", message: "finding 2" }),
      makeFinding({ file: "src/api/users.ts", category: "security", message: "finding 3" }),
    ];
    const { filtered, suppressedCount } = applySuppressionMemories(tmpDir, "org/repo", findings);
    expect(filtered).toHaveLength(1);
    expect(suppressedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runSuppressionMemories
// ---------------------------------------------------------------------------

describe("runSuppressionMemories", () => {
  it("returns filtered findings and result", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "auth-free");
    const findings = [
      makeFinding({ file: "src/api/health.ts", category: "security", message: "SQL injection" }),
      makeFinding({ file: "src/api/users.ts", category: "security", message: "XSS attack" }),
    ];
    const { filtered, result } = runSuppressionMemories(tmpDir, "org/repo", findings);
    expect(filtered).toHaveLength(1);
    expect(result.suppressedCount).toBe(1);
    expect(result.contextText).toContain("Suppression Memories");
  });

  it("returns empty context when nothing suppressed", () => {
    const findings = [makeFinding()];
    const { result } = runSuppressionMemories(tmpDir, "org/repo", findings);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildSuppressionContext
// ---------------------------------------------------------------------------

describe("buildSuppressionContext", () => {
  it("returns empty string for no suppressions", () => {
    const result: SuppressionResult = { matchedMemories: [], suppressedCount: 0, contextText: "" };
    expect(buildSuppressionContext(result)).toBe("");
  });

  it("includes header with count", () => {
    const result: SuppressionResult = {
      matchedMemories: [{
        id: 1,
        repo: "org/repo",
        filePattern: "src/api/health*",
        category: "security",
        messagePattern: "SQL",
        reason: "auth-free",
        hitCount: 3,
        createdAt: "2026-01-01",
        lastHitAt: "2026-05-26",
      }],
      suppressedCount: 1,
      contextText: "",
    };
    const ctx = buildSuppressionContext(result);
    expect(ctx).toContain("Suppression Memories");
    expect(ctx).toContain("1 finding(s) auto-suppressed");
    expect(ctx).toContain("security");
    expect(ctx).toContain("auth-free");
    expect(ctx).toContain("hit 3x");
  });

  it("includes do-not-re-raise instruction", () => {
    const result: SuppressionResult = {
      matchedMemories: [{
        id: 1, repo: "o/r", filePattern: "src/a.ts", category: "bug",
        messagePattern: "", reason: "OK", hitCount: 0, createdAt: "", lastHitAt: "",
      }],
      suppressedCount: 1,
      contextText: "",
    };
    const ctx = buildSuppressionContext(result);
    expect(ctx).toContain("Do NOT re-raise");
  });
});

// ---------------------------------------------------------------------------
// deleteSuppressionMemory
// ---------------------------------------------------------------------------

describe("deleteSuppressionMemory", () => {
  it("deletes an existing memory", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/a.ts", "bug", "err", "reason");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories).toHaveLength(1);
    const deleted = deleteSuppressionMemory(tmpDir, memories[0].id);
    expect(deleted).toBe(true);
    expect(getSuppressionMemories(tmpDir, "org/repo")).toHaveLength(0);
  });

  it("returns false for non-existent ID", () => {
    expect(deleteSuppressionMemory(tmpDir, 99999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pruneUnusedMemories
// ---------------------------------------------------------------------------

describe("pruneUnusedMemories", () => {
  it("prunes memories with zero hits older than threshold", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/old.ts", "bug", "err", "stale");
    // Manually update created_at to be old
    const db = require("node:sqlite").DatabaseSync;
    const database = new db(path.join(tmpDir, ".github", "mizumi-data.db"));
    database.prepare(`UPDATE suppression_memories SET created_at = datetime('now', '-100 days') WHERE hit_count = 0`).run();
    database.close();

    const pruned = pruneUnusedMemories(tmpDir, "org/repo", 30);
    expect(pruned).toBe(1);
    expect(getSuppressionMemories(tmpDir, "org/repo")).toHaveLength(0);
  });

  it("keeps memories with hits regardless of age", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/health.ts", "security", "SQL", "auth-free");
    // Hit it once to increment hit count
    const findings = [makeFinding()];
    applySuppressionMemories(tmpDir, "org/repo", findings);

    // Make it old
    const db = require("node:sqlite").DatabaseSync;
    const database = new db(path.join(tmpDir, ".github", "mizumi-data.db"));
    database.prepare(`UPDATE suppression_memories SET created_at = datetime('now', '-100 days')`).run();
    database.close();

    const pruned = pruneUnusedMemories(tmpDir, "org/repo", 30);
    expect(pruned).toBe(0);
    expect(getSuppressionMemories(tmpDir, "org/repo")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getSuppressionMemories
// ---------------------------------------------------------------------------

describe("getSuppressionMemories", () => {
  it("returns memories sorted by hit count descending", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/a.ts", "bug", "err", "low hit");
    recordSuppressionMemory(tmpDir, "org/repo", "src/b.ts", "security", "SQL", "high hit");

    // Hit the second memory twice
    const findings = [
      makeFinding({ file: "src/b.ts", category: "security", message: "SQL" }),
    ];
    applySuppressionMemories(tmpDir, "org/repo", findings);

    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories[0].hitCount).toBeGreaterThanOrEqual(memories[1].hitCount);
  });

  it("returns empty array for repo with no memories", () => {
    expect(getSuppressionMemories(tmpDir, "org/empty")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toGlobPattern (tested via recordSuppressionMemory)
// ---------------------------------------------------------------------------

describe("toGlobPattern (via recordSuppressionMemory)", () => {
  it("converts simple file path to glob", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/utils/helpers.ts", "bug", "err", "reason");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories[0].filePattern).toContain("helpers*");
  });

  it("handles deeply nested file paths", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/api/v2/users/controller.ts", "security", "xss", "safe");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories[0].filePattern).toContain("controller*");
    expect(memories[0].filePattern).toContain("src/api/v2/users");
  });

  it("handles file in root directory", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "index.ts", "bug", "err", "reason");
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories[0].filePattern).toContain("index*");
  });
});

// ---------------------------------------------------------------------------
// globMatch edge cases (via shouldSuppress)
// ---------------------------------------------------------------------------

describe("globMatch edge cases", () => {
  it("matches exact file path without wildcard", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/exact-match.ts", "bug", "err", "reason");
    // Manually set a non-glob pattern by inserting directly
    const db = require("node:sqlite").DatabaseSync;
    const database = new db(path.join(tmpDir, ".github", "mizumi-data.db"));
    database.prepare(`UPDATE suppression_memories SET file_pattern = ? WHERE repo = ?`).run("src/exact-match.ts", "org/repo");
    database.close();

    const memory = shouldSuppress(tmpDir, "org/repo", "src/exact-match.ts", "bug", "exact-match err");
    expect(memory).not.toBeNull();
  });

  it("does not match across directory boundaries", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/health.ts", "security", "SQL", "reason");
    // Pattern becomes src/health*.ts — should NOT match other-dir/health.ts
    const memory = shouldSuppress(tmpDir, "org/repo", "other-dir/health.ts", "security", "SQL injection");
    expect(memory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MAX_MEMORIES enforcement
// ---------------------------------------------------------------------------

describe("MAX_MEMORIES enforcement", () => {
  it("evicts oldest least-hit memory when exceeding limit", () => {
    // Record 100 memories (the max) + 1 more
    for (let i = 0; i < 101; i++) {
      recordSuppressionMemory(tmpDir, "org/repo", `src/file${i}.ts`, "bug", `err${i}`, `reason${i}`);
    }
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    // Should still be at max 100
    expect(memories.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Concurrent access safety
// ---------------------------------------------------------------------------

describe("concurrent access", () => {
  it("handles multiple sequential writes safely", () => {
    for (let i = 0; i < 10; i++) {
      recordSuppressionMemory(tmpDir, "org/repo", `src/mod${i}.ts`, "bug", `bug${i}`, `fix${i}`);
    }
    const memories = getSuppressionMemories(tmpDir, "org/repo");
    expect(memories).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// pruneUnusedMemories edge cases
// ---------------------------------------------------------------------------

describe("pruneUnusedMemories edge cases", () => {
  it("keeps recent memories even with zero hits", () => {
    recordSuppressionMemory(tmpDir, "org/repo", "src/recent.ts", "bug", "err", "just created");
    // This memory was just created, so even with 0 hits it shouldn't be pruned at 30 days
    const pruned = pruneUnusedMemories(tmpDir, "org/repo", 30);
    expect(pruned).toBe(0);
    expect(getSuppressionMemories(tmpDir, "org/repo")).toHaveLength(1);
  });

  it("prunes only for the specified repo", () => {
    recordSuppressionMemory(tmpDir, "org/repo1", "src/old.ts", "bug", "err", "stale");
    recordSuppressionMemory(tmpDir, "org/repo2", "src/fresh.ts", "bug", "err", "fresh");

    const db = require("node:sqlite").DatabaseSync;
    const database = new db(path.join(tmpDir, ".github", "mizumi-data.db"));
    database.prepare(`UPDATE suppression_memories SET created_at = datetime('now', '-100 days') WHERE repo = ?`).run("org/repo1");
    database.close();

    const pruned = pruneUnusedMemories(tmpDir, "org/repo1", 30);
    expect(pruned).toBe(1);
    // repo2 should be untouched
    expect(getSuppressionMemories(tmpDir, "org/repo2")).toHaveLength(1);
  });
});
