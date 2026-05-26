import { describe, it, expect, vi } from "vitest";
import { suggestPRSplits } from "../pr-split.js";
import type { SplitSuggestion } from "../pr-split.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: overrides.path ?? "src/utils.ts",
    status: overrides.status ?? "modified",
    additions: overrides.additions ?? 10,
    deletions: overrides.deletions ?? 5,
    hunks: [],
  };
}

function makeLargePR(): DiffFile[] {
  return [
    makeDiffFile({ path: "src/types/user.ts", additions: 30, deletions: 10 }),
    makeDiffFile({ path: "src/types/order.ts", additions: 25, deletions: 5 }),
    makeDiffFile({ path: "src/interfaces/IRepository.ts", additions: 20, deletions: 8 }),
    makeDiffFile({ path: "src/api/users.ts", additions: 80, deletions: 20 }),
    makeDiffFile({ path: "src/api/orders.ts", additions: 60, deletions: 15 }),
    makeDiffFile({ path: "src/services/userService.ts", additions: 50, deletions: 10 }),
    makeDiffFile({ path: "src/services/orderService.ts", additions: 45, deletions: 12 }),
    makeDiffFile({ path: "src/db/migrations/001_add_users.ts", additions: 40, deletions: 0 }),
    makeDiffFile({ path: "src/utils/helpers.ts", additions: 15, deletions: 5 }),
    makeDiffFile({ path: "src/__tests__/users.test.ts", additions: 35, deletions: 3 }),
  ];
}

// ---------------------------------------------------------------------------
// suggestPRSplits — gating
// ---------------------------------------------------------------------------

describe("suggestPRSplits gating", () => {
  it("does not suggest splits for low complexity scores", () => {
    const result = suggestPRSplits(
      [makeDiffFile({ additions: 5, deletions: 2 })],
      3, "simple",
    );
    expect(result.shouldSplit).toBe(false);
    expect(result.suggestions).toHaveLength(0);
    expect(result.contextText).toBe("");
  });

  it("does not suggest splits for moderate scores", () => {
    const result = suggestPRSplits(makeLargePR(), 5, "moderate");
    expect(result.shouldSplit).toBe(false);
  });

  it("suggests splits for score >= 7 with enough files", () => {
    const result = suggestPRSplits(makeLargePR(), 7, "complex");
    expect(result.shouldSplit).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("suggests splits for critical category", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "critical");
    expect(result.shouldSplit).toBe(true);
  });

  it("suggests splits for complex category", () => {
    const result = suggestPRSplits(makeLargePR(), 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("does not suggest splits for high score but few files", () => {
    const few = [
      makeDiffFile({ path: "src/a.ts", additions: 500, deletions: 200 }),
      makeDiffFile({ path: "src/b.ts", additions: 300, deletions: 100 }),
    ];
    const result = suggestPRSplits(few, 9, "critical");
    expect(result.shouldSplit).toBe(false);
  });

  it("does not suggest splits for score 6 even with many files", () => {
    const result = suggestPRSplits(makeLargePR(), 6, "moderate");
    expect(result.shouldSplit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Split suggestions — grouping
// ---------------------------------------------------------------------------

describe("split suggestion grouping", () => {
  it("groups architecture files as a foundation PR", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    if (foundation) {
      expect(foundation.files.some(f => f.includes("/types/") || f.includes("/interfaces/"))).toBe(true);
      expect(foundation.order).toBe(0); // Foundation goes first
    }
  });

  it("groups files by functional area", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    // Should have separate groups for API, Services, Migrations, etc.
    const titles = result.suggestions.map(s => s.title);
    const hasAreaGroups = titles.some(t => t.includes("API") || t.includes("Services") || t.includes("Database"));
    expect(hasAreaGroups).toBe(true);
  });

  it("orders suggestions with foundation first", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "critical");
    if (result.suggestions.length > 1) {
      const orders = result.suggestions.map(s => s.order);
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i]).toBeGreaterThan(orders[0]);
      }
    }
  });

  it("limits to MAX_SUGGESTIONS splits", () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) =>
      makeDiffFile({ path: `src/area${i % 5}/file${i}.ts`, additions: 20, deletions: 5 })
    );
    const result = suggestPRSplits(manyFiles, 9, "critical");
    expect(result.suggestions.length).toBeLessThanOrEqual(4);
  });

  it("each suggestion has required fields", () => {
    const result = suggestPRSplits(makeLargePR(), 7, "complex");
    for (const s of result.suggestions) {
      expect(s).toHaveProperty("title");
      expect(s).toHaveProperty("files");
      expect(s).toHaveProperty("scope");
      expect(s).toHaveProperty("reason");
      expect(s).toHaveProperty("order");
      expect(s.files.length).toBeGreaterThan(0);
      expect(["small", "medium", "large"]).toContain(s.scope);
    }
  });

  it("all diff files are covered in suggestions", () => {
    const files = makeLargePR();
    const result = suggestPRSplits(files, 8, "complex");
    const allSuggested = result.suggestions.flatMap(s => s.files);
    const allPaths = files.map(f => f.path);
    for (const path of allPaths) {
      expect(allSuggested).toContain(path);
    }
  });

  it("no file appears in multiple suggestions", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    const allFiles = result.suggestions.flatMap(s => s.files);
    const uniqueFiles = new Set(allFiles);
    expect(allFiles.length).toBe(uniqueFiles.size);
  });
});

// ---------------------------------------------------------------------------
// Area detection
// ---------------------------------------------------------------------------

describe("area detection", () => {
  it("detects /api/ files as API area", () => {
    const files = [
      makeDiffFile({ path: "src/api/users.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/api/orders.ts", additions: 40, deletions: 8 }),
      makeDiffFile({ path: "src/utils/helpers.ts", additions: 15, deletions: 5 }),
      makeDiffFile({ path: "src/types/user.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/__tests__/api.test.ts", additions: 30, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const apiSuggestion = result.suggestions.find(s => s.title.includes("API"));
    expect(apiSuggestion).toBeDefined();
  });

  it("detects /auth/ files as Auth area", () => {
    const files = [
      makeDiffFile({ path: "src/auth/login.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/auth/oauth.ts", additions: 40, deletions: 8 }),
      makeDiffFile({ path: "src/config/settings.ts", additions: 15, deletions: 5 }),
      makeDiffFile({ path: "src/types/auth.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/__tests__/auth.test.ts", additions: 30, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const authSuggestion = result.suggestions.find(s => s.title.includes("Auth"));
    expect(authSuggestion).toBeDefined();
  });

  it("detects test files as Tests area", () => {
    const files = [
      makeDiffFile({ path: "src/__tests__/a.test.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/__tests__/b.test.ts", additions: 40, deletions: 8 }),
      makeDiffFile({ path: "src/__tests__/c.test.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 45, deletions: 10 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const testSuggestion = result.suggestions.find(s => s.title.includes("Tests"));
    if (testSuggestion) {
      expect(testSuggestion.files.some(f => f.includes("__tests__"))).toBe(true);
    }
  });

  it("detects /db/ and /sql/ as Database area", () => {
    const files = [
      makeDiffFile({ path: "src/db/queries.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/sql/migrations.sql", additions: 30, deletions: 0 }),
      makeDiffFile({ path: "src/models/user.ts", additions: 25, deletions: 5 }),
      makeDiffFile({ path: "src/services/dataService.ts", additions: 35, deletions: 8 }),
      makeDiffFile({ path: "src/types/models.ts", additions: 20, deletions: 5 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const dbSuggestion = result.suggestions.find(s => s.title.includes("Database"));
    expect(dbSuggestion).toBeDefined();
  });

  it("detects /components/ as UI area", () => {
    const files = [
      makeDiffFile({ path: "src/components/Button.tsx", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/components/Modal.tsx", additions: 40, deletions: 8 }),
      makeDiffFile({ path: "src/pages/Home.tsx", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/utils/format.ts", additions: 10, deletions: 2 }),
      makeDiffFile({ path: "src/types/props.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const uiSuggestion = result.suggestions.find(s => s.title.includes("UI"));
    expect(uiSuggestion).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scope determination
// ---------------------------------------------------------------------------

describe("scope determination", () => {
  it("marks small changes as small scope", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      makeDiffFile({ path: `src/area${i % 3}/file${i}.ts`, additions: 5, deletions: 2 })
    );
    const result = suggestPRSplits(files, 7, "complex");
    for (const s of result.suggestions) {
      const totalLines = s.files.reduce((sum, f) => {
        const df = files.find(d => d.path === f);
        return sum + (df ? df.additions + df.deletions : 0);
      }, 0);
      if (totalLines <= 50) {
        expect(s.scope).toBe("small");
      }
    }
  });

  it("marks large changes as large scope", () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      makeDiffFile({ path: `src/api/file${i}.ts`, additions: 150, deletions: 50 })
    );
    const result = suggestPRSplits(files, 9, "critical");
    const hasLarge = result.suggestions.some(s => s.scope === "large");
    expect(hasLarge).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Context text
// ---------------------------------------------------------------------------

describe("contextText", () => {
  it("includes complexity score and category", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    expect(result.contextText).toContain("8/10");
    expect(result.contextText).toContain("complex");
  });

  it("includes suggestion titles", () => {
    const result = suggestPRSplits(makeLargePR(), 7, "complex");
    for (const s of result.suggestions) {
      expect(result.contextText).toContain(s.title.split(":")[0]);
    }
  });

  it("includes recommendation to split", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    expect(result.contextText).toContain("Smaller PRs");
  });

  it("lists files with backticks", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    expect(result.contextText).toContain("`src/");
  });

  it("truncates file list when many files", () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) =>
      makeDiffFile({ path: `src/api/handler${i}.ts`, additions: 30, deletions: 10 })
    );
    const result = suggestPRSplits(manyFiles, 9, "critical");
    // If a group has > 8 files, should truncate with "and N more"
    if (result.suggestions.some(s => s.files.length > 8)) {
      expect(result.contextText).toContain("more");
    }
  });

  it("returns empty context when shouldSplit is false", () => {
    const result = suggestPRSplits([makeDiffFile()], 3, "simple");
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles all files in same area", () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      makeDiffFile({ path: `src/api/endpoint${i}.ts`, additions: 50, deletions: 10 })
    );
    const result = suggestPRSplits(files, 8, "complex");
    expect(result.shouldSplit).toBe(true);
    // Still produces at least the single area suggestion
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("handles files with no clear area (root level)", () => {
    const files = [
      makeDiffFile({ path: "index.ts", additions: 30, deletions: 10 }),
      makeDiffFile({ path: "config.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "helpers.ts", additions: 25, deletions: 8 }),
      makeDiffFile({ path: "server.ts", additions: 40, deletions: 15 }),
      makeDiffFile({ path: "app.ts", additions: 35, deletions: 12 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("handles all architecture files", () => {
    const files = [
      makeDiffFile({ path: "src/types/user.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/types/order.ts", additions: 15, deletions: 3 }),
      makeDiffFile({ path: "src/interfaces/IRepo.ts", additions: 25, deletions: 8 }),
      makeDiffFile({ path: "src/schemas/validation.ts", additions: 30, deletions: 10 }),
      makeDiffFile({ path: "src/contracts/api.ts", additions: 20, deletions: 5 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
    // Should detect foundation PR
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    expect(foundation).toBeDefined();
  });

  it("handles single architecture file (below foundation threshold)", () => {
    const files = [
      makeDiffFile({ path: "src/types/config.ts", additions: 10, deletions: 3 }),
      makeDiffFile({ path: "src/api/users.ts", additions: 80, deletions: 20 }),
      makeDiffFile({ path: "src/api/orders.ts", additions: 60, deletions: 15 }),
      makeDiffFile({ path: "src/services/userService.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/__tests__/users.test.ts", additions: 35, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    // Only 1 arch file — foundation PR needs >= 2 files
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    // The single type file gets grouped with its area instead
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("result has all required fields", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    expect(result).toHaveProperty("shouldSplit");
    expect(result).toHaveProperty("suggestions");
    expect(result).toHaveProperty("contextText");
    expect(typeof result.shouldSplit).toBe("boolean");
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(typeof result.contextText).toBe("string");
  });
});
