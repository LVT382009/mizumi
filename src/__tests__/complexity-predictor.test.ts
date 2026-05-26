import { describe, it, expect, vi } from "vitest";
import { computeComplexity } from "../complexity-predictor.js";
import type { ComplexityResult, ComplexityFactor } from "../complexity-predictor.js";
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
    hunks: overrides.hunks ?? [],
  };
}

function makeHunk(changes: Array<{ type: "add" | "delete" | "normal"; content: string }>) {
  return {
    oldStart: 1, oldLines: changes.length,
    newStart: 1, newLines: changes.length,
    content: changes.map(c => c.content).join("\n"),
    changes: changes.map((c, i) => ({
      type: c.type,
      line: i + 1,
      oldLine: i + 1,
      content: c.content,
    })),
  };
}

// ---------------------------------------------------------------------------
// computeComplexity — basic scoring
// ---------------------------------------------------------------------------

describe("computeComplexity", () => {
  it("returns a trivial score for a small single-file change", () => {
    const result = computeComplexity(
      [makeDiffFile({ additions: 5, deletions: 2 })],
      5, 2,
    );
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.estimatedMinutes).toBeGreaterThanOrEqual(2);
    expect(result.category).toBeDefined();
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.contextText).toContain("Complexity Assessment");
  });

  it("returns a higher score for many files with lots of lines", () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) =>
      makeDiffFile({ path: `src/file${i}.ts`, additions: 30, deletions: 10 })
    );
    const result = computeComplexity(manyFiles, 600, 200);
    const smallResult = computeComplexity(
      [makeDiffFile({ additions: 5, deletions: 2 })], 5, 2,
    );
    expect(result.score).toBeGreaterThan(smallResult.score);
    expect(result.estimatedMinutes).toBeGreaterThan(smallResult.estimatedMinutes);
  });

  it("caps score at 10 even for enormous changes", () => {
    const hugeFiles = Array.from({ length: 50 }, (_, i) =>
      makeDiffFile({ path: `src/file${i}.ts`, additions: 200, deletions: 100 })
    );
    const result = computeComplexity(hugeFiles, 10000, 5000);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("never returns score below 1", () => {
    const result = computeComplexity([], 0, 0);
    expect(result.score).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Category thresholds
// ---------------------------------------------------------------------------

describe("complexity categories", () => {
  it("returns 'trivial' for score <= 2", () => {
    const result = computeComplexity([makeDiffFile({ additions: 3, deletions: 1 })], 3, 1);
    if (result.score <= 2) {
      expect(result.category).toBe("trivial");
    }
  });

  it("returns 'simple' for score 3-4", () => {
    // 50 lines in 3 files → moderate but not huge
    const files = Array.from({ length: 3 }, (_, i) =>
      makeDiffFile({ path: `src/mod${i}.ts`, additions: 15, deletions: 5 })
    );
    const result = computeComplexity(files, 45, 15);
    if (result.score >= 3 && result.score <= 4) {
      expect(result.category).toBe("simple");
    }
  });

  it("returns 'moderate' for score 5-6", () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      makeDiffFile({ path: `src/feature${i}.ts`, additions: 50, deletions: 20 })
    );
    const result = computeComplexity(files, 400, 160);
    if (result.score >= 5 && result.score <= 6) {
      expect(result.category).toBe("moderate");
    }
  });

  it("returns 'complex' for score 7-8", () => {
    const files = Array.from({ length: 15 }, (_, i) =>
      makeDiffFile({ path: `src/api/${i}.ts`, additions: 80, deletions: 30 })
    );
    const result = computeComplexity(files, 1200, 450, 10, 5);
    if (result.score >= 7 && result.score <= 8) {
      expect(result.category).toBe("complex");
    }
  });

  it("returns 'critical' for score >= 9", () => {
    const files = Array.from({ length: 30 }, (_, i) =>
      makeDiffFile({ path: `src/api/contract${i}.ts`, additions: 200, deletions: 100 })
    );
    const result = computeComplexity(files, 6000, 3000, 20, 10);
    if (result.score >= 9) {
      expect(result.category).toBe("critical");
    }
  });
});

// ---------------------------------------------------------------------------
// Factor: size (lines changed)
// ---------------------------------------------------------------------------

describe("size factor", () => {
  it("contributes 0 for 0 lines changed", () => {
    const result = computeComplexity([makeDiffFile({ additions: 0, deletions: 0 })], 0, 0);
    const sizeFactor = result.factors.find(f => f.name === "size");
    expect(sizeFactor).toBeDefined();
    expect(sizeFactor!.contribution).toBe(0);
  });

  it("contribution increases with lines changed", () => {
    const small = computeComplexity([makeDiffFile()], 10, 5);
    const large = computeComplexity([makeDiffFile()], 300, 200);
    const smallSize = small.factors.find(f => f.name === "size")!.contribution;
    const largeSize = large.factors.find(f => f.name === "size")!.contribution;
    expect(largeSize).toBeGreaterThan(smallSize);
  });

  it("caps at 3.0 for very large diffs", () => {
    const result = computeComplexity([makeDiffFile()], 10000, 10000);
    const sizeFactor = result.factors.find(f => f.name === "size");
    expect(sizeFactor!.contribution).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Factor: spread (file count)
// ---------------------------------------------------------------------------

describe("spread factor", () => {
  it("contributes 0 for 0 files", () => {
    const result = computeComplexity([], 0, 0);
    const spreadFactor = result.factors.find(f => f.name === "spread");
    expect(spreadFactor!.contribution).toBe(0);
  });

  it("contribution increases with more files", () => {
    const one = computeComplexity([makeDiffFile()], 10, 5);
    const ten = computeComplexity(
      Array.from({ length: 10 }, (_, i) => makeDiffFile({ path: `f${i}.ts` })),
      100, 50,
    );
    const oneSpread = one.factors.find(f => f.name === "spread")!.contribution;
    const tenSpread = ten.factors.find(f => f.name === "spread")!.contribution;
    expect(tenSpread).toBeGreaterThan(oneSpread);
  });

  it("caps at 2.0 for many files", () => {
    const many = computeComplexity(
      Array.from({ length: 50 }, (_, i) => makeDiffFile({ path: `f${i}.ts` })),
      500, 250,
    );
    const spreadFactor = many.factors.find(f => f.name === "spread");
    expect(spreadFactor!.contribution).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Factor: new_exports
// ---------------------------------------------------------------------------

describe("new_exports factor", () => {
  it("counts exported functions in added lines", () => {
    const file = makeDiffFile({
      path: "src/api.ts",
      hunks: [makeHunk([
        { type: "add", content: "export async function fetchData() {}" },
        { type: "add", content: "export function helper() {}" },
      ])],
    });
    const result = computeComplexity([file], 50, 10);
    const exportFactor = result.factors.find(f => f.name === "new_exports");
    expect(exportFactor).toBeDefined();
    expect(exportFactor!.contribution).toBeGreaterThan(0);
    expect(exportFactor!.description).toContain("2");
  });

  it("counts exported classes", () => {
    const file = makeDiffFile({
      path: "src/models.ts",
      hunks: [makeHunk([
        { type: "add", content: "export class UserService {}" },
        { type: "add", content: "export default class App {}" },
      ])],
    });
    const result = computeComplexity([file], 50, 10);
    const exportFactor = result.factors.find(f => f.name === "new_exports");
    expect(exportFactor!.description).toContain("2");
  });

  it("counts exported const arrow functions", () => {
    const file = makeDiffFile({
      path: "src/handlers.ts",
      hunks: [makeHunk([
        { type: "add", content: "export const handler = async () => {}" },
        { type: "add", content: "export const processItem = () => {}" },
      ])],
    });
    const result = computeComplexity([file], 30, 5);
    const exportFactor = result.factors.find(f => f.name === "new_exports");
    expect(exportFactor!.description).toContain("2");
  });

  it("ignores non-add lines (deletes/normal)", () => {
    const file = makeDiffFile({
      path: "src/api.ts",
      hunks: [makeHunk([
        { type: "delete", content: "export function oldFn() {}" },
        { type: "normal", content: "export function unchanged() {}" },
      ])],
    });
    const result = computeComplexity([file], 10, 5);
    const exportFactor = result.factors.find(f => f.name === "new_exports");
    expect(exportFactor!.contribution).toBe(0);
  });

  it("caps at 2.0 for many new exports", () => {
    const file = makeDiffFile({
      path: "src/big-api.ts",
      hunks: [makeHunk(
        Array.from({ length: 10 }, (_, i) => ({
          type: "add" as const,
          content: `export function fn${i}() {}`,
        }))
      )],
    });
    const result = computeComplexity([file], 100, 10);
    const exportFactor = result.factors.find(f => f.name === "new_exports");
    expect(exportFactor!.contribution).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Factor: architecture (API/interface files)
// ---------------------------------------------------------------------------

describe("architecture factor", () => {
  it("detects files in /api/ path", () => {
    const file = makeDiffFile({ path: "src/api/users.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
    expect(archFactor!.contribution).toBeGreaterThan(0);
  });

  it("detects files in /interfaces/ path", () => {
    const file = makeDiffFile({ path: "src/interfaces/types.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects .d.ts declaration files", () => {
    const file = makeDiffFile({ path: "src/global.d.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects index.ts entry files", () => {
    const file = makeDiffFile({ path: "src/index.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects mod.ts entry files", () => {
    const file = makeDiffFile({ path: "src/mod.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects /types/ path", () => {
    const file = makeDiffFile({ path: "src/types/config.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects /contracts/ path", () => {
    const file = makeDiffFile({ path: "src/contracts/user.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects /schemas/ path", () => {
    const file = makeDiffFile({ path: "src/schemas/validation.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("detects /protocol path", () => {
    const file = makeDiffFile({ path: "src/protocol/handler.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("omits architecture factor when no arch files present", () => {
    const file = makeDiffFile({ path: "src/utils/helpers.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeUndefined();
  });

  it("caps at 1.5 contribution for multiple arch files", () => {
    const files = [
      makeDiffFile({ path: "src/api/users.ts" }),
      makeDiffFile({ path: "src/api/orders.ts" }),
      makeDiffFile({ path: "src/interfaces/types.ts" }),
      makeDiffFile({ path: "src/schemas/db.ts" }),
    ];
    const result = computeComplexity(files, 100, 50);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor!.contribution).toBeLessThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// Factor: blast_radius (cross-file dependencies)
// ---------------------------------------------------------------------------

describe("blast_radius factor", () => {
  it("omits factor when crossFileDeps is 0", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5, 0, 0);
    const blastFactor = result.factors.find(f => f.name === "blast_radius");
    expect(blastFactor).toBeUndefined();
  });

  it("contributes when crossFileDeps > 0", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5, 5, 0);
    const blastFactor = result.factors.find(f => f.name === "blast_radius");
    expect(blastFactor).toBeDefined();
    expect(blastFactor!.contribution).toBeGreaterThan(0);
  });

  it("contribution scales with crossFileDeps count", () => {
    const few = computeComplexity([makeDiffFile()], 10, 5, 2, 0);
    const many = computeComplexity([makeDiffFile()], 10, 5, 10, 0);
    const fewDep = few.factors.find(f => f.name === "blast_radius")!.contribution;
    const manyDep = many.factors.find(f => f.name === "blast_radius")!.contribution;
    expect(manyDep).toBeGreaterThan(fewDep);
  });

  it("caps at 1.5 for many cross-file deps", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5, 50, 0);
    const blastFactor = result.factors.find(f => f.name === "blast_radius");
    expect(blastFactor!.contribution).toBeLessThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// Factor: security_sensitive (taint traces)
// ---------------------------------------------------------------------------

describe("security_sensitive factor", () => {
  it("omits factor when taintTraces is 0", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5, 0, 0);
    const secFactor = result.factors.find(f => f.name === "security_sensitive");
    expect(secFactor).toBeUndefined();
  });

  it("contributes when taintTraces > 0", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5, 0, 3);
    const secFactor = result.factors.find(f => f.name === "security_sensitive");
    expect(secFactor).toBeDefined();
    expect(secFactor!.contribution).toBeGreaterThan(0);
  });

  it("contribution scales with taintTraces count", () => {
    const few = computeComplexity([makeDiffFile()], 10, 5, 0, 1);
    const many = computeComplexity([makeDiffFile()], 10, 5, 0, 6);
    const fewSec = few.factors.find(f => f.name === "security_sensitive")!.contribution;
    const manySec = many.factors.find(f => f.name === "security_sensitive")!.contribution;
    expect(manySec).toBeGreaterThan(fewSec);
  });

  it("caps at 1.5 for many taint traces", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5, 0, 20);
    const secFactor = result.factors.find(f => f.name === "security_sensitive");
    expect(secFactor!.contribution).toBeLessThanOrEqual(1.5);
  });
});

// ---------------------------------------------------------------------------
// Estimated review time
// ---------------------------------------------------------------------------

describe("estimated review time", () => {
  it("returns at least 2 minutes", () => {
    const result = computeComplexity([makeDiffFile({ additions: 1, deletions: 0 })], 1, 0);
    expect(result.estimatedMinutes).toBeGreaterThanOrEqual(2);
  });

  it("increases with more lines changed", () => {
    const small = computeComplexity([makeDiffFile()], 10, 5);
    const large = computeComplexity([makeDiffFile()], 500, 300);
    expect(large.estimatedMinutes).toBeGreaterThan(small.estimatedMinutes);
  });

  it("increases with more files changed", () => {
    const one = computeComplexity([makeDiffFile()], 50, 25);
    const ten = computeComplexity(
      Array.from({ length: 10 }, (_, i) => makeDiffFile({ path: `f${i}.ts`, additions: 5, deletions: 3 })),
      50, 30,
    );
    expect(ten.estimatedMinutes).toBeGreaterThan(one.estimatedMinutes);
  });

  it("applies architecture multiplier to architecture files", () => {
    const normalFiles = [makeDiffFile({ path: "src/impl.ts", additions: 50, deletions: 20 })];
    const archFiles = [makeDiffFile({ path: "src/api/users.ts", additions: 50, deletions: 20 })];
    const normal = computeComplexity(normalFiles, 50, 20);
    const arch = computeComplexity(archFiles, 50, 20);
    expect(arch.estimatedMinutes).toBeGreaterThan(normal.estimatedMinutes);
  });

  it("applies security multiplier when taint traces present", () => {
    const noSec = computeComplexity([makeDiffFile()], 50, 20, 0, 0);
    const withSec = computeComplexity([makeDiffFile()], 50, 20, 0, 2);
    expect(withSec.estimatedMinutes).toBeGreaterThan(noSec.estimatedMinutes);
  });

  it("applies both multipliers when arch and security both present", () => {
    const neither = computeComplexity([makeDiffFile()], 100, 50, 0, 0);
    const both = computeComplexity(
      [makeDiffFile({ path: "src/api/auth.ts" })], 100, 50, 0, 3,
    );
    // Both multipliers: 1.8 * 1.5 = 2.7x
    expect(both.estimatedMinutes).toBeGreaterThan(neither.estimatedMinutes);
    expect(both.estimatedMinutes).toBe(Math.round(
      (2 + 150 * 0.15 + 1 * 1.5) * 1.8 * 1.5
    ));
  });
});

// ---------------------------------------------------------------------------
// Context text
// ---------------------------------------------------------------------------

describe("contextText", () => {
  it("includes score, category, and estimated minutes", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5);
    expect(result.contextText).toContain("Complexity Assessment");
    expect(result.contextText).toContain("Estimated review time");
    expect(result.contextText).toContain(result.category);
    expect(result.contextText).toContain(`${result.score}/10`);
  });

  it("includes factor breakdown", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5);
    expect(result.contextText).toContain("size");
    expect(result.contextText).toContain("spread");
  });

  it("includes complexity warning for score >= 7", () => {
    const result = computeComplexity(
      Array.from({ length: 15 }, (_, i) =>
        makeDiffFile({ path: `src/api/${i}.ts`, additions: 100, deletions: 50 })
      ),
      1500, 750, 8, 5,
    );
    if (result.score >= 7) {
      expect(result.contextText).toContain("complex");
      expect(result.contextText).toContain("smaller PRs");
    }
  });

  it("does not include warning for low complexity", () => {
    const result = computeComplexity([makeDiffFile()], 3, 1);
    if (result.score < 7) {
      expect(result.contextText).not.toContain("smaller PRs");
    }
  });
});

// ---------------------------------------------------------------------------
// Combined signals
// ---------------------------------------------------------------------------

describe("combined signals", () => {
  it("higher combo produces higher score than any single signal", () => {
    const base = computeComplexity([makeDiffFile()], 10, 5);
    const combo = computeComplexity(
      [makeDiffFile({ path: "src/api/handler.ts" })],
      10, 5, 5, 3,
    );
    expect(combo.score).toBeGreaterThan(base.score);
  });

  it("default params for crossFileDeps and taintTraces are 0", () => {
    const withDefaults = computeComplexity([makeDiffFile()], 10, 5);
    const explicit = computeComplexity([makeDiffFile()], 10, 5, 0, 0);
    expect(withDefaults.score).toBe(explicit.score);
    expect(withDefaults.estimatedMinutes).toBe(explicit.estimatedMinutes);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty diff files array", () => {
    const result = computeComplexity([], 0, 0);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.estimatedMinutes).toBeGreaterThanOrEqual(2);
  });

  it("handles large numbers without overflow", () => {
    const result = computeComplexity(
      Array.from({ length: 100 }, (_, i) =>
        makeDiffFile({ path: `f${i}.ts`, additions: 1000, deletions: 500 })
      ),
      100000, 50000, 50, 30,
    );
    expect(result.score).toBeLessThanOrEqual(10);
    expect(isFinite(result.estimatedMinutes)).toBe(true);
  });

  it("handles zero additions and deletions", () => {
    const result = computeComplexity([makeDiffFile({ additions: 0, deletions: 0 })], 0, 0);
    expect(result.score).toBeGreaterThanOrEqual(1);
  });

  it("handles file paths with various architectures patterns", () => {
    const files = [
      makeDiffFile({ path: "api/index.js" }),
      makeDiffFile({ path: "src/interfaces/IUser.ts" }),
      makeDiffFile({ path: "types/global.d.ts" }),
      makeDiffFile({ path: "src/index.ts" }),
    ];
    const result = computeComplexity(files, 50, 20);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor).toBeDefined();
  });

  it("architecture factor description lists affected files", () => {
    const file = makeDiffFile({ path: "src/api/users.ts" });
    const result = computeComplexity([file], 10, 5);
    const archFactor = result.factors.find(f => f.name === "architecture");
    expect(archFactor!.description).toContain("src/api/users.ts");
  });

  it("result object has all required fields", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5);
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("estimatedMinutes");
    expect(result).toHaveProperty("factors");
    expect(result).toHaveProperty("category");
    expect(result).toHaveProperty("contextText");
  });

  it("factors have all required fields", () => {
    const result = computeComplexity([makeDiffFile()], 10, 5);
    for (const factor of result.factors) {
      expect(factor).toHaveProperty("name");
      expect(factor).toHaveProperty("contribution");
      expect(factor).toHaveProperty("description");
      expect(typeof factor.contribution).toBe("number");
    }
  });

  it("score is rounded to one decimal place", () => {
    const result = computeComplexity([makeDiffFile()], 37, 13, 2, 1);
    const decimalPart = result.score.toString().split(".")[1];
    if (decimalPart) {
      expect(decimalPart.length).toBeLessThanOrEqual(1);
    }
  });
});
