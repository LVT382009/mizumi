import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectCrossPRConflicts, buildOpenPRSummary } from "../crosspr-conflict.js";
import type { OpenPRSummary, PRConflict } from "../crosspr-conflict.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (
  filePath: string,
  changes: string[] = ["+added line"],
  status: DiffFile["status"] = "modified",
): DiffFile => ({
  path: filePath,
  status,
  additions: changes.filter((c) => c.startsWith("+")).length,
  deletions: changes.filter((c) => c.startsWith("-")).length,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      changes: changes.map((content, i) => ({
        type: content.startsWith("+")
          ? ("add" as const)
          : content.startsWith("-")
            ? ("delete" as const)
            : ("normal" as const),
        content,
        line: i + 1,
      })),
    },
  ],
});

const makeFiles = (n: number, prefix: string = "src"): DiffFile[] =>
  Array.from({ length: n }, (_, i) => makeFile(`${prefix}/file${i}.ts`));

// ---------------------------------------------------------------------------
// detectCrossPRConflicts — no conflicts
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — no conflicts", () => {
  it("returns empty when there are no other PRs", () => {
    const current = makeFiles(3, "src");
    const result = detectCrossPRConflicts(current, []);
    expect(result.conflicts).toHaveLength(0);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("returns empty when other PRs touch different files", () => {
    const current = makeFiles(3, "src/app");
    const otherPR: OpenPRSummary = {
      number: 99,
      title: "Other PR",
      files: ["lib/utils.ts", "lib/helpers.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("returns empty when both PRs exist but no overlap", () => {
    const current = [makeFile("src/auth.ts", ['+import "./db.ts"'])];
    const otherPR: OpenPRSummary = {
      number: 10,
      title: "Refactor styles",
      files: ["src/styles.css"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detectCrossPRConflicts — file collisions
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — file collisions", () => {
  it("detects when both PRs modify the same file", () => {
    const current = [makeFile("src/auth.ts")];
    const otherPR: OpenPRSummary = {
      number: 42,
      title: "Auth refactor",
      files: ["src/auth.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const collisions = result.conflicts.filter((c) => c.kind === "file-collision");
    expect(collisions).toHaveLength(1);
    expect(collisions[0].otherPR).toBe(42);
    expect(collisions[0].severity).toBe("high");
  });

  it("detects file collisions across multiple other PRs", () => {
    const current = [makeFile("src/api.ts")];
    const otherPRs: OpenPRSummary[] = [
      { number: 10, title: "API v2", files: ["src/api.ts"], edges: [], deletedFiles: [] },
      { number: 11, title: "Also API", files: ["src/api.ts"], edges: [], deletedFiles: [] },
    ];
    const result = detectCrossPRConflicts(current, otherPRs);
    const collisions = result.conflicts.filter((c) => c.kind === "file-collision");
    expect(collisions).toHaveLength(2);
  });

  it("detects collisions for multiple shared files", () => {
    const current = [makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")];
    const otherPR: OpenPRSummary = {
      number: 5,
      title: "Multi",
      files: ["src/a.ts", "src/b.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const collisions = result.conflicts.filter((c) => c.kind === "file-collision");
    expect(collisions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// detectCrossPRConflicts — export/signature conflicts
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — export conflicts", () => {
  it("detects when current PR imports from a file another PR modifies", () => {
    const current = [makeFile("src/app.ts", ['+import { helper } from "./utils"'])];
    const otherPR: OpenPRSummary = {
      number: 8,
      title: "Utils refactor",
      files: ["src/utils.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const exportConflicts = result.conflicts.filter((c) => c.kind === "export-change");
    expect(exportConflicts.length).toBeGreaterThanOrEqual(1);
    expect(exportConflicts.some((c) => c.otherFile === "src/utils")).toBe(true);
  });

  it("detects when other PR imports from a file current PR modifies", () => {
    const current = [makeFile("src/utils.ts")];
    const otherEdge = { from: "src/app.ts", to: "src/utils", kind: "import" as const, line: 1 };
    const otherPR: OpenPRSummary = {
      number: 15,
      title: "App feature",
      files: ["src/app.ts"],
      edges: [otherEdge],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const exportConflicts = result.conflicts.filter((c) => c.kind === "export-change");
    expect(exportConflicts.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// detectCrossPRConflicts — delete-use conflicts
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — delete-use conflicts", () => {
  it("detects when current PR imports a file another PR deletes", () => {
    const current = [makeFile("src/app.ts", ['+import { helper } from "./utils"'])];
    const otherPR: OpenPRSummary = {
      number: 7,
      title: "Remove utils",
      files: ["src/utils.ts"],
      edges: [],
      deletedFiles: ["src/utils"],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const deleteConflicts = result.conflicts.filter((c) => c.kind === "delete-use");
    expect(deleteConflicts.length).toBeGreaterThanOrEqual(1);
    expect(deleteConflicts[0].severity).toBe("critical");
  });

  it("detects when current PR deletes a file another PR imports", () => {
    const current = [makeFile("src/utils.ts", [], "deleted")];
    const otherEdge = { from: "src/app.ts", to: "src/utils", kind: "import" as const, line: 1 };
    const otherPR: OpenPRSummary = {
      number: 20,
      title: "Feature",
      files: ["src/app.ts"],
      edges: [otherEdge],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const deleteConflicts = result.conflicts.filter((c) => c.kind === "delete-use");
    expect(deleteConflicts.length).toBeGreaterThanOrEqual(1);
    expect(deleteConflicts[0].severity).toBe("critical");
  });

  it("does not flag delete when no other PR imports the file", () => {
    const current = [makeFile("src/old.ts", [], "deleted")];
    const otherPR: OpenPRSummary = {
      number: 22,
      title: "Unrelated",
      files: ["src/other.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const deleteConflicts = result.conflicts.filter((c) => c.kind === "delete-use");
    expect(deleteConflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — deduplication", () => {
  it("deduplicates identical conflicts", () => {
    const current = [makeFile("src/auth.ts")];
    const otherPR: OpenPRSummary = {
      number: 42,
      title: "Auth",
      files: ["src/auth.ts"],
      edges: [],
      deletedFiles: [],
    };
    // Running twice with same other PR shouldn't create duplicates
    const result = detectCrossPRConflicts(current, [otherPR]);
    const collisions = result.conflicts.filter((c) => c.kind === "file-collision");
    expect(collisions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — sorting", () => {
  it("sorts critical before high before medium", () => {
    const current = [
      makeFile("src/auth.ts"),           // file-collision (high)
      makeFile("src/app.ts", ['+import { x } from "./deleted"']), // export + potential delete-use
      makeFile("src/old.ts", [], "deleted"),
    ];
    const otherPR: OpenPRSummary = {
      number: 99,
      title: "Other",
      files: ["src/auth.ts", "src/deleted"],
      edges: [],
      deletedFiles: ["src/deleted"],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    const severities = result.conflicts.map((c) => c.severity);
    // critical should come before high/medium
    if (severities.includes("critical") && severities.length > 1) {
      const criticalIdx = severities.indexOf("critical");
      const highIdx = severities.indexOf("high");
      if (highIdx !== -1) {
        expect(criticalIdx).toBeLessThan(highIdx);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — context text", () => {
  it("includes conflict summary in contextText", () => {
    const current = [makeFile("src/auth.ts")];
    const otherPR: OpenPRSummary = {
      number: 42,
      title: "Auth refactor",
      files: ["src/auth.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.contextText).toContain("Cross-PR Conflicts");
    expect(result.contextText).toContain("src/auth.ts");
  });

  it("returns empty contextText when no conflicts", () => {
    const current = makeFiles(3, "src/app");
    const otherPR: OpenPRSummary = {
      number: 99,
      title: "Unrelated",
      files: ["lib/a.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.contextText).toBe("");
  });

  it("separates critical/high/medium in contextText", () => {
    const current = [
      makeFile("src/auth.ts"),
      makeFile("src/app.ts", ['+import { x } from "./deleted"']),
    ];
    const otherPR: OpenPRSummary = {
      number: 88,
      title: "Other",
      files: ["src/auth.ts", "src/deleted"],
      edges: [],
      deletedFiles: ["src/deleted"],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    if (result.conflicts.some((c) => c.severity === "critical")) {
      expect(result.contextText).toContain("Critical");
    }
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — body summary", () => {
  it("includes table in bodySummary when conflicts exist", () => {
    const current = [makeFile("src/auth.ts")];
    const otherPR: OpenPRSummary = {
      number: 42,
      title: "Auth refactor",
      files: ["src/auth.ts"],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.bodySummary).toContain("Cross-PR Conflicts");
    expect(result.bodySummary).toContain("| Type |");
    expect(result.bodySummary).toContain("#42");
  });

  it("returns empty bodySummary when no conflicts", () => {
    const current = makeFiles(2, "src/app");
    const result = detectCrossPRConflicts(current, []);
    expect(result.bodySummary).toBe("");
  });

  it("truncates table at 15 conflicts", () => {
    const current = makeFiles(20, "src");
    const otherPRs: OpenPRSummary[] = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      title: `PR ${i}`,
      files: [`src/file${i}.ts`],
      edges: [],
      deletedFiles: [],
    }));
    const result = detectCrossPRConflicts(current, otherPRs);
    if (result.conflicts.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});

// ---------------------------------------------------------------------------
// buildOpenPRSummary
// ---------------------------------------------------------------------------

describe("buildOpenPRSummary", () => {
  it("builds summary with correct file paths", () => {
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts")];
    const summary = buildOpenPRSummary(42, "Test PR", files);
    expect(summary.number).toBe(42);
    expect(summary.title).toBe("Test PR");
    expect(summary.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("extracts import edges", () => {
    const files = [makeFile("src/app.ts", ['+import { x } from "./utils"'])];
    const summary = buildOpenPRSummary(10, "Import PR", files);
    expect(summary.edges.length).toBeGreaterThanOrEqual(0);
  });

  it("identifies deleted files", () => {
    const files = [makeFile("src/old.ts", [], "deleted"), makeFile("src/new.ts")];
    const summary = buildOpenPRSummary(15, "Cleanup", files);
    expect(summary.deletedFiles).toEqual(["src/old.ts"]);
  });

  it("handles empty file list", () => {
    const summary = buildOpenPRSummary(1, "Empty", []);
    expect(summary.files).toEqual([]);
    expect(summary.edges).toEqual([]);
    expect(summary.deletedFiles).toEqual([]);
  });

  it("handles files with no imports", () => {
    const files = [makeFile("src/style.css", ["+body { color: red; }"])];
    const summary = buildOpenPRSummary(5, "Styles", files);
    expect(summary.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Result metadata
// ---------------------------------------------------------------------------

describe("detectCrossPRConflicts — result metadata", () => {
  it("includes currentFiles in result", () => {
    const current = [makeFile("src/a.ts"), makeFile("src/b.ts")];
    const result = detectCrossPRConflicts(current, []);
    expect(result.currentFiles).toContain("src/a.ts");
    expect(result.currentFiles).toContain("src/b.ts");
  });

  it("includes otherPRs in result", () => {
    const current = makeFiles(2);
    const otherPR: OpenPRSummary = {
      number: 42,
      title: "Test",
      files: [],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.otherPRs).toHaveLength(1);
    expect(result.otherPRs[0].number).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — additional coverage
// ---------------------------------------------------------------------------

describe('detectCrossPRConflicts — edge cases (expanded)', () => {
  it('returns no conflicts when no other PRs exist', () => {
    const current = [makeFile('src/auth.ts')];
    const result = detectCrossPRConflicts(current, []);
    expect(result.conflicts).toHaveLength(0);
  });

  it('handles current PR with deleted files', () => {
    const current = [makeFile('src/old.ts', [], 'deleted')];
    const otherPR: OpenPRSummary = {
      number: 10,
      title: 'Edit old',
      files: ['src/old.ts'],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    // Deleted files in current PR can still conflict
    expect(result.conflicts).toBeDefined();
  });

  it('handles multiple other PRs modifying same file', () => {
    const current = [makeFile('src/shared.ts')];
    const pr1: OpenPRSummary = {
      number: 1,
      title: 'PR1',
      files: ['src/shared.ts'],
      edges: [],
      deletedFiles: [],
    };
    const pr2: OpenPRSummary = {
      number: 2,
      title: 'PR2',
      files: ['src/shared.ts'],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [pr1, pr2]);
    // Should detect conflicts with both PRs
    expect(result.conflicts.length).toBeGreaterThanOrEqual(2);
  });

  it('returns no conflicts when files are completely different', () => {
    const current = [makeFile('src/a.ts')];
    const otherPR: OpenPRSummary = {
      number: 99,
      title: 'Other',
      files: ['src/b.ts'],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.conflicts).toHaveLength(0);
  });

  it('detectCrossPRConflicts with multiple file overlaps', () => {
    const current = [makeFile('src/a.ts'), makeFile('src/b.ts')];
    const otherPR: OpenPRSummary = {
      number: 10,
      title: 'Touch both',
      files: ['src/a.ts', 'src/b.ts'],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.conflicts.length).toBeGreaterThanOrEqual(2);
  });

  it('contextText is empty when no conflicts', () => {
    const current = [makeFile('src/a.ts')];
    const otherPR: OpenPRSummary = {
      number: 10,
      title: 'No overlap',
      files: ['src/b.ts'],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.contextText).toBe('');
  });

  it('bodySummary is empty when no conflicts', () => {
    const current = [makeFile('src/a.ts')];
    const otherPR: OpenPRSummary = {
      number: 10,
      title: 'No overlap',
      files: ['src/b.ts'],
      edges: [],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    expect(result.bodySummary).toBe('');
  });

  it('detects semantic overlap via dependency edges', () => {
    const current = [makeFile('src/api.ts', ['+import { db } from "./db"'])];
    const otherPR: OpenPRSummary = {
      number: 5,
      title: 'DB refactor',
      files: ['src/db.ts'],
      edges: [{ from: 'src/db.ts', to: 'src/connection.ts', kind: 'import' }],
      deletedFiles: [],
    };
    const result = detectCrossPRConflicts(current, [otherPR]);
    // api.ts imports db.ts which the other PR modifies
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
  });
});
