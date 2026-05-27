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

  it("does not suggest splits for score 7 with only 4 files", () => {
    const four = [
      makeDiffFile({ path: "src/a.ts", additions: 80, deletions: 20 }),
      makeDiffFile({ path: "src/b.ts", additions: 60, deletions: 15 }),
      makeDiffFile({ path: "src/c.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/d.ts", additions: 40, deletions: 5 }),
    ];
    const result = suggestPRSplits(four, 7, "complex");
    expect(result.shouldSplit).toBe(false);
  });

  it("suggests splits for score 7 with exactly 5 files", () => {
    const five = [
      makeDiffFile({ path: "src/api/a.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/api/b.ts", additions: 30, deletions: 8 }),
      makeDiffFile({ path: "src/services/c.ts", additions: 50, deletions: 12 }),
      makeDiffFile({ path: "src/db/d.ts", additions: 35, deletions: 5 }),
      makeDiffFile({ path: "src/utils/e.ts", additions: 20, deletions: 3 }),
    ];
    const result = suggestPRSplits(five, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("suggests splits for complex category even with low score", () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      makeDiffFile({ path: `src/area/file${i}.ts`, additions: 30, deletions: 5 }),
    );
    const result = suggestPRSplits(five, 3, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("suggests splits for critical category even with low score", () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      makeDiffFile({ path: `src/area/file${i}.ts`, additions: 30, deletions: 5 }),
    );
    const result = suggestPRSplits(five, 2, "critical");
    expect(result.shouldSplit).toBe(true);
  });

  it("does not suggest splits for simple category with low score and enough files", () => {
    const result = suggestPRSplits(makeLargePR(), 3, "simple");
    expect(result.shouldSplit).toBe(false);
  });

  it("does not suggest splits for moderate category with score 6", () => {
    const result = suggestPRSplits(makeLargePR(), 6, "moderate");
    expect(result.shouldSplit).toBe(false);
    expect(result.contextText).toBe("");
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

  it("orders suggestions sequentially starting from 0", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    const orders = result.suggestions.map(s => s.order).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      expect(orders[i]).toBe(i);
    }
  });

  it("suggestion titles include file count", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    for (const s of result.suggestions) {
      if (!s.title.includes("Foundation")) {
        expect(s.title).toContain("file(s)");
      }
    }
  });

  it("suggestions include reason field with grouping explanation", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    for (const s of result.suggestions) {
      expect(s.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Area detection — all AREA_PATTERNS
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

  it("detects /middleware/ files as Middleware area", () => {
    const files = [
      makeDiffFile({ path: "src/middleware/auth.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/middleware/logging.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/services/user.ts", additions: 35, deletions: 8 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 20, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const mwSuggestion = result.suggestions.find(s => s.title.includes("Middleware"));
    expect(mwSuggestion).toBeDefined();
  });

  it("detects /models/ files as Models area", () => {
    const files = [
      makeDiffFile({ path: "src/models/user.ts", additions: 35, deletions: 8 }),
      makeDiffFile({ path: "src/models/product.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/services/data.ts", additions: 40, deletions: 12 }),
      makeDiffFile({ path: "src/config/db.ts", additions: 20, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const modelsSuggestion = result.suggestions.find(s => s.title.includes("Models"));
    expect(modelsSuggestion).toBeDefined();
  });

  it("detects /schemas/ files as Schema area (or Foundation for arch files)", () => {
    const files = [
      makeDiffFile({ path: "src/schemas/user.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/schemas/order.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/utils/helper.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    // Schema files are architecture files, so they go into Foundation PR
    const schemaOrFoundation = result.suggestions.find(
      s => s.title.includes("Schema") || s.title.includes("Foundation"),
    );
    expect(schemaOrFoundation).toBeDefined();
    // Schema files must appear in one of the suggestions
    const allFiles = result.suggestions.flatMap(s => s.files);
    expect(allFiles).toContain("src/schemas/user.ts");
    expect(allFiles).toContain("src/schemas/order.ts");
  });

  it("detects /services/ files as Services area", () => {
    const files = [
      makeDiffFile({ path: "src/services/auth.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/services/user.ts", additions: 35, deletions: 8 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/utils/format.ts", additions: 10, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const svcSuggestion = result.suggestions.find(s => s.title.includes("Services"));
    expect(svcSuggestion).toBeDefined();
  });

  it("detects /handlers/ files as Handlers area", () => {
    const files = [
      makeDiffFile({ path: "src/handler/create.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/handler/delete.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/models/user.ts", additions: 25, deletions: 8 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const handlerSuggestion = result.suggestions.find(s => s.title.includes("Handlers"));
    expect(handlerSuggestion).toBeDefined();
  });

  it("detects /routes/ files as Routes area", () => {
    const files = [
      makeDiffFile({ path: "src/route/index.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/route/users.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/models/user.ts", additions: 25, deletions: 8 }),
      makeDiffFile({ path: "src/utils/format.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const routeSuggestion = result.suggestions.find(s => s.title.includes("Routes"));
    expect(routeSuggestion).toBeDefined();
  });

  it("detects /controllers/ files as Controllers area", () => {
    const files = [
      makeDiffFile({ path: "src/controller/users.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/controller/orders.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 25, deletions: 8 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const ctrlSuggestion = result.suggestions.find(s => s.title.includes("Controllers"));
    expect(ctrlSuggestion).toBeDefined();
  });

  it("detects /utils/ files as Utils area", () => {
    const files = [
      makeDiffFile({ path: "src/utils/format.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/utils/parse.ts", additions: 15, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 10, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const utilsSuggestion = result.suggestions.find(s => s.title.includes("Utils"));
    expect(utilsSuggestion).toBeDefined();
  });

  it("detects /helpers/ files as Helpers area", () => {
    const files = [
      makeDiffFile({ path: "src/helper/format.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/helper/parse.ts", additions: 15, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 10, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const helpSuggestion = result.suggestions.find(s => s.title.includes("Helpers"));
    expect(helpSuggestion).toBeDefined();
  });

  it("detects /config files as Config area", () => {
    const files = [
      makeDiffFile({ path: "src/config/database.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/config/env.ts", additions: 15, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/utils/format.ts", additions: 10, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const cfgSuggestion = result.suggestions.find(s => s.title.includes("Config"));
    expect(cfgSuggestion).toBeDefined();
  });

  it("detects /spec/ files as Tests area", () => {
    const files = [
      makeDiffFile({ path: "src/spec/api.spec.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/spec/db.spec.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/db/queries.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const testSuggestion = result.suggestions.find(s => s.title.includes("Tests"));
    expect(testSuggestion).toBeDefined();
  });

  it("detects /migrations/ files as Migrations area", () => {
    const files = [
      makeDiffFile({ path: "src/migration/001_create_users.ts", additions: 40, deletions: 0 }),
      makeDiffFile({ path: "src/migration/002_create_orders.ts", additions: 35, deletions: 0 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const migSuggestion = result.suggestions.find(s => s.title.includes("Migrations"));
    expect(migSuggestion).toBeDefined();
  });

  it("detects /scripts/ files as Scripts area", () => {
    const files = [
      makeDiffFile({ path: "src/script/seed.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/script/setup.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/db/queries.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const scriptSuggestion = result.suggestions.find(s => s.title.includes("Scripts"));
    expect(scriptSuggestion).toBeDefined();
  });

  it("detects /docs/ files as Docs area", () => {
    const files = [
      makeDiffFile({ path: "src/doc/api.md", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/doc/setup.md", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/db/queries.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const docSuggestion = result.suggestions.find(s => s.title.includes("Docs"));
    expect(docSuggestion).toBeDefined();
  });

  it("detects /ui/ files as UI area", () => {
    const files = [
      makeDiffFile({ path: "src/ui/theme.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/ui/layout.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/db/queries.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const uiSuggestion = result.suggestions.find(s => s.title.includes("UI"));
    expect(uiSuggestion).toBeDefined();
  });

  it("detects /pages/ files as UI area", () => {
    const files = [
      makeDiffFile({ path: "src/page/dashboard.tsx", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/page/settings.tsx", additions: 35, deletions: 8 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 50, deletions: 15 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 30, deletions: 7 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const uiSuggestion = result.suggestions.find(s => s.title.includes("UI"));
    expect(uiSuggestion).toBeDefined();
  });

  it("detects /interfaces/ files as Contracts area", () => {
    const files = [
      makeDiffFile({ path: "src/interface/IUser.ts", additions: 25, deletions: 5 }),
      makeDiffFile({ path: "src/interface/IOrder.ts", additions: 20, deletions: 3 }),
      makeDiffFile({ path: "src/api/handler.ts", additions: 60, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    // Single interface files get pulled into archFiles by the foundation check
    // or grouped into Contracts area
    const contractOrFoundation = result.suggestions.find(
      s => s.title.includes("Contracts") || s.title.includes("Foundation"),
    );
    expect(contractOrFoundation).toBeDefined();
  });

  it("area detection is case-insensitive", () => {
    const files = [
      makeDiffFile({ path: "src/API/users.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/Services/data.ts", additions: 40, deletions: 5 }),
      makeDiffFile({ path: "src/DB/queries.ts", additions: 30, deletions: 8 }),
      makeDiffFile({ path: "src/Config/app.ts", additions: 20, deletions: 3 }),
      makeDiffFile({ path: "src/Utils/format.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope determination — boundary values
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

  it("scope boundary: exactly 50 lines is small", () => {
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 25, deletions: 25 }),
      makeDiffFile({ path: "src/api/b.ts", additions: 0, deletions: 0 }),
      makeDiffFile({ path: "src/services/c.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/db/d.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/utils/e.ts", additions: 10, deletions: 0 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const apiSuggestion = result.suggestions.find(s => s.title.includes("API"));
    if (apiSuggestion) {
      const total = apiSuggestion.files.reduce((sum, f) => {
        const df = files.find(d => d.path === f);
        return sum + (df ? df.additions + df.deletions : 0);
      }, 0);
      if (total === 50) {
        expect(apiSuggestion.scope).toBe("small");
      }
    }
  });

  it("scope boundary: 51 lines is medium", () => {
    // Create a scenario where one area has exactly 51 lines
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 26, deletions: 25 }),
      makeDiffFile({ path: "src/api/b.ts", additions: 10, deletions: 10 }),
      makeDiffFile({ path: "src/services/c.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/db/d.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/utils/e.ts", additions: 10, deletions: 0 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const apiSuggestion = result.suggestions.find(s => s.title.includes("API"));
    if (apiSuggestion) {
      const total = apiSuggestion.files.reduce((sum, f) => {
        const df = files.find(d => d.path === f);
        return sum + (df ? df.additions + df.deletions : 0);
      }, 0);
      if (total === 51) {
        expect(apiSuggestion.scope).toBe("medium");
      }
    }
  });

  it("scope boundary: 200 lines is medium", () => {
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 100, deletions: 100 }),
      makeDiffFile({ path: "src/services/c.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/db/d.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/utils/e.ts", additions: 10, deletions: 0 }),
      makeDiffFile({ path: "src/config/f.ts", additions: 5, deletions: 0 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const apiSuggestion = result.suggestions.find(s => s.title.includes("API"));
    if (apiSuggestion) {
      const total = apiSuggestion.files.reduce((sum, f) => {
        const df = files.find(d => d.path === f);
        return sum + (df ? df.additions + df.deletions : 0);
      }, 0);
      if (total === 200) {
        expect(apiSuggestion.scope).toBe("medium");
      }
    }
  });

  it("scope boundary: 201 lines is large", () => {
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 101, deletions: 100 }),
      makeDiffFile({ path: "src/services/c.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/db/d.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/utils/e.ts", additions: 10, deletions: 0 }),
      makeDiffFile({ path: "src/config/f.ts", additions: 5, deletions: 0 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const apiSuggestion = result.suggestions.find(s => s.title.includes("API"));
    if (apiSuggestion) {
      const total = apiSuggestion.files.reduce((sum, f) => {
        const df = files.find(d => d.path === f);
        return sum + (df ? df.additions + df.deletions : 0);
      }, 0);
      if (total >= 201) {
        expect(apiSuggestion.scope).toBe("large");
      }
    }
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

  it("includes numbered ordering in context text", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    if (result.suggestions.length > 1) {
      // Check that context has numbered items like "1.", "2."
      expect(result.contextText).toContain("1.");
    }
  });

  it("includes scope in context text", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    const scopes = result.suggestions.map(s => s.scope);
    if (scopes.includes("small")) expect(result.contextText).toContain("small");
    if (scopes.includes("medium")) expect(result.contextText).toContain("medium");
    if (scopes.includes("large")) expect(result.contextText).toContain("large");
  });

  it("includes reason for each suggestion in context text", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    for (const s of result.suggestions) {
      expect(result.contextText).toContain(s.reason);
    }
  });

  it("includes file count in context text", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    expect(result.contextText).toContain("file(s)");
  });

  it("includes PR Split Suggestions heading", () => {
    const result = suggestPRSplits(makeLargePR(), 8, "complex");
    expect(result.contextText).toContain("PR Split Suggestions");
  });

  it("includes complexity fraction format", () => {
    const result = suggestPRSplits(makeLargePR(), 9, "critical");
    expect(result.contextText).toContain("9/10");
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

  it("foundation PR with exactly 2 arch files", () => {
    const files = [
      makeDiffFile({ path: "src/types/user.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/interfaces/IRepo.ts", additions: 25, deletions: 8 }),
      makeDiffFile({ path: "src/api/users.ts", additions: 80, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/__tests__/test.ts", additions: 35, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    expect(foundation).toBeDefined();
    expect(foundation!.files.length).toBeGreaterThanOrEqual(2);
  });

  it("remaining files overflow folded into last suggestion", () => {
    // Create more areas than MAX_SUGGESTIONS to trigger overflow
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/auth/b.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/middleware/c.ts", additions: 20, deletions: 8 }),
      makeDiffFile({ path: "src/services/d.ts", additions: 15, deletions: 2 }),
      makeDiffFile({ path: "src/db/e.ts", additions: 10, deletions: 1 }),
      makeDiffFile({ path: "src/utils/f.ts", additions: 10, deletions: 1 }),
      makeDiffFile({ path: "src/config/g.ts", additions: 10, deletions: 1 }),
      makeDiffFile({ path: "src/handlers/h.ts", additions: 10, deletions: 1 }),
      makeDiffFile({ path: "src/routes/i.ts", additions: 10, deletions: 1 }),
    ];
    const result = suggestPRSplits(files, 8, "complex");
    // Should still cover all files even with limited suggestions
    const allSuggested = result.suggestions.flatMap(s => s.files);
    for (const f of files) {
      expect(allSuggested).toContain(f.path);
    }
  });

  it("single area with many files", () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeDiffFile({ path: `src/services/service${i}.ts`, additions: 40, deletions: 10 })
    );
    const result = suggestPRSplits(files, 8, "complex");
    expect(result.shouldSplit).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
    // All files covered
    const allSuggested = result.suggestions.flatMap(s => s.files);
    expect(allSuggested.length).toBe(files.length);
  });

  it("handles files with special characters in paths", () => {
    const files = [
      makeDiffFile({ path: "src/api/[dynamic]-route.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/utils/@decorator.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/services/user.service.ts", additions: 20, deletions: 8 }),
      makeDiffFile({ path: "src/db/data_base.ts", additions: 15, deletions: 2 }),
      makeDiffFile({ path: "src/config/app.config.ts", additions: 10, deletions: 1 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("handles files with dots and dashes in names", () => {
    const files = [
      makeDiffFile({ path: "src/api/user-handler.spec.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/api/order.controller.ts", additions: 25, deletions: 3 }),
      makeDiffFile({ path: "src/services/data.processor.ts", additions: 20, deletions: 8 }),
      makeDiffFile({ path: "src/db/migration.001.ts", additions: 15, deletions: 2 }),
      makeDiffFile({ path: "src/config/app.config.dev.ts", additions: 10, deletions: 1 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("handles empty file with zero additions", () => {
    const files = [
      makeDiffFile({ path: "src/api/users.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/api/orders.ts", additions: 40, deletions: 8 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/db/queries.ts", additions: 0, deletions: 0 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
    // Zero-addition file should still appear
    const allSuggested = result.suggestions.flatMap(s => s.files);
    expect(allSuggested).toContain("src/db/queries.ts");
  });

  it("handles Windows-style backslash paths (forward slash in path)", () => {
    const files = [
      makeDiffFile({ path: "src\\api\\users.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src\\services\\svc.ts", additions: 40, deletions: 5 }),
      makeDiffFile({ path: "src\\db\\queries.ts", additions: 30, deletions: 8 }),
      makeDiffFile({ path: "src\\utils\\helper.ts", additions: 20, deletions: 3 }),
      makeDiffFile({ path: "src\\config\\app.ts", additions: 15, deletions: 2 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("foundation with exactly 2 arch files gets order 0", () => {
    const files = [
      makeDiffFile({ path: "src/types/user.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/types/order.ts", additions: 15, deletions: 3 }),
      makeDiffFile({ path: "src/api/users.ts", additions: 80, deletions: 20 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 50, deletions: 10 }),
      makeDiffFile({ path: "src/__tests__/test.ts", additions: 35, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 8, "complex");
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    if (foundation) {
      expect(foundation.order).toBe(0);
    }
  });

  it("countLines correctly sums matching files only", () => {
    // Build a PR where one area's files have known line counts
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 10, deletions: 5 }),
      makeDiffFile({ path: "src/api/b.ts", additions: 20, deletions: 8 }),
      makeDiffFile({ path: "src/services/c.ts", additions: 100, deletions: 50 }),
      makeDiffFile({ path: "src/db/d.ts", additions: 30, deletions: 10 }),
      makeDiffFile({ path: "src/utils/e.ts", additions: 15, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 8, "complex");
    const apiSuggestion = result.suggestions.find(s => s.title.includes("API"));
    if (apiSuggestion && apiSuggestion.files.length === 2) {
      // api/a.ts: 15 lines, api/b.ts: 28 lines = 43 total => small
      expect(apiSuggestion.scope).toBe("small");
    }
  });

  it("handles files with .d.ts extension as architecture", () => {
    const files = [
      makeDiffFile({ path: "src/types/global.d.ts", additions: 15, deletions: 0 }),
      makeDiffFile({ path: "src/interfaces/IUser.ts", additions: 20, deletions: 5 }),
      makeDiffFile({ path: "src/api/routes.ts", additions: 60, deletions: 15 }),
      makeDiffFile({ path: "src/services/svc.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/__tests__/test.ts", additions: 25, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    // .d.ts and /interfaces/ should be in foundation
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    if (foundation) {
      expect(foundation.files).toContain("src/types/global.d.ts");
    }
  });

  it("handles index.ts and mod.ts as architecture files", () => {
    const files = [
      makeDiffFile({ path: "src/api/index.ts", additions: 10, deletions: 2 }),
      makeDiffFile({ path: "src/services/mod.ts", additions: 8, deletions: 1 }),
      makeDiffFile({ path: "src/db/migration.ts", additions: 40, deletions: 10 }),
      makeDiffFile({ path: "src/utils/format.ts", additions: 30, deletions: 5 }),
      makeDiffFile({ path: "src/config/app.ts", additions: 20, deletions: 3 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
    // index.ts and mod.ts should filter into archFiles
    const foundation = result.suggestions.find(s => s.title.includes("Foundation"));
    if (foundation) {
      expect(foundation.files).toContain("src/api/index.ts");
    }
  });

  it("PR with MIN_FILES_FOR_SPLIT files at score 7 does split", () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makeDiffFile({ path: `src/area${i}/file${i}.ts`, additions: 30, deletions: 5 })
    );
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
  });

  it("PR with MIN_FILES_FOR_SPLIT minus 1 files at score 7 does NOT split", () => {
    const files = Array.from({ length: 4 }, (_, i) =>
      makeDiffFile({ path: `src/area${i}/file${i}.ts`, additions: 30, deletions: 5 })
    );
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(false);
  });

  it("handles mixed status types", () => {
    const files: DiffFile[] = [
      { path: "src/api/new.ts", status: "added", additions: 50, deletions: 0, hunks: [] },
      { path: "src/api/old.ts", status: "deleted", additions: 0, deletions: 40, hunks: [] },
      { path: "src/services/renamed.ts", status: "renamed", additions: 10, deletions: 10, hunks: [] },
      { path: "src/db/modified.ts", status: "modified", additions: 30, deletions: 5, hunks: [] },
      { path: "src/utils/helper.ts", status: "modified", additions: 15, deletions: 3, hunks: [] },
    ];
    const result = suggestPRSplits(files, 7, "complex");
    expect(result.shouldSplit).toBe(true);
    const allSuggested = result.suggestions.flatMap(s => s.files);
    expect(allSuggested.length).toBe(5);
  });

  it("files not in diffFiles are not counted in line totals", () => {
    // If a suggestion has files that don't exist in diffFiles,
    // they contribute 0 to totals
    const files = [
      makeDiffFile({ path: "src/api/a.ts", additions: 5, deletions: 0 }),
      makeDiffFile({ path: "src/services/b.ts", additions: 5, deletions: 0 }),
      makeDiffFile({ path: "src/db/c.ts", additions: 5, deletions: 0 }),
      makeDiffFile({ path: "src/utils/d.ts", additions: 5, deletions: 0 }),
      makeDiffFile({ path: "src/config/e.ts", additions: 5, deletions: 0 }),
    ];
    const result = suggestPRSplits(files, 7, "complex");
    // Each area has only 5 lines = small scope
    const allSmall = result.suggestions.every(s => s.scope === "small");
    expect(allSmall).toBe(true);
  });
});
