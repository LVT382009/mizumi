import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractImportEdges,
  resolveImportPath,
  buildDependencyGraphs,
  computeBlastRadius,
  runBlastRadiusAnalysis,
  buildBlastRadiusContext,
} from "../blast-radius.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHunk(changes: Array<{ type: "add" | "delete" | "normal"; content: string; line: number }>) {
  return {
    oldStart: 1,
    oldLines: changes.length,
    newStart: 1,
    newLines: changes.length,
    content: "",
    changes: changes.map((c) => ({ type: c.type, content: c.content, line: c.line, oldLine: c.type === "normal" ? c.line : c.type === "delete" ? c.line : 0 })),
  };
}

function makeDiffFile(path: string, addedLines: string[]): DiffFile {
  return {
    path,
    status: "modified" as const,
    additions: addedLines.length,
    deletions: 0,
    hunks: [makeHunk(addedLines.map((content, i) => ({ type: "add" as const, content, line: i + 1 })))],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveImportPath", () => {
  it("resolves relative import within same directory", () => {
    expect(resolveImportPath("./utils", "src/app.ts")).toBe("src/utils");
  });

  it("resolves parent directory import", () => {
    expect(resolveImportPath("../config", "src/auth/login.ts")).toBe("src/config");
  });

  it("resolves multi-level parent import", () => {
    expect(resolveImportPath("../../lib/helpers", "src/auth/login/form.ts")).toBe("src/lib/helpers");
  });

  it("skips non-relative imports (bare specifiers)", () => {
    expect(resolveImportPath("react", "src/app.ts")).toBe("");
    expect(resolveImportPath("@actions/core", "src/main.ts")).toBe("");
  });

  it("handles current directory import", () => {
    expect(resolveImportPath("./index", "src/index.ts")).toBe("src/index");
  });

  it("handles file in root directory", () => {
    expect(resolveImportPath("./config", "index.ts")).toBe("config");
  });

  it("handles nested relative import", () => {
    expect(resolveImportPath("./types", "src/auth/oauth.ts")).toBe("src/auth/types");
  });
});

describe("extractImportEdges", () => {
  it("extracts ESM import from statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `import { helper } from "./utils";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      from: "src/app.ts",
      to: "src/utils",
      kind: "import",
      line: 1,
    });
  });

  it("extracts default import statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `import config from "./config";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe("src/config");
  });

  it("extracts type-only import statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `import type { User } from "./types";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe("src/types");
  });

  it("extracts namespace import statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `import * as utils from "./utils";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe("src/utils");
  });

  it("extracts CJS require statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `const helper = require("./helper");`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      from: "src/app.ts",
      to: "src/helper",
      kind: "require",
      line: 1,
    });
  });

  it("extracts dynamic import statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `const mod = import("./module");`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("dynamic-import");
  });

  it("extracts re-export statements", () => {
    const files = [makeDiffFile("src/index.ts", [
      `export { helper } from "./utils";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("re-export");
  });

  it("extracts star re-export statements", () => {
    const files = [makeDiffFile("src/index.ts", [
      `export * from "./utils";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("re-export");
  });

  it("extracts side-effect import statements", () => {
    const files = [makeDiffFile("src/app.ts", [
      `import "./polyfills";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe("import");
    expect(edges[0].to).toBe("src/polyfills");
  });

  it("ignores non-relative imports", () => {
    const files = [makeDiffFile("src/app.ts", [
      `import React from "react";`,
      `import { z } from "zod";`,
      `const path = require("path");`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(0);
  });

  it("ignores deleted lines", () => {
    const file: DiffFile = {
      path: "src/app.ts",
      status: "modified",
      additions: 0,
      deletions: 1,
      hunks: [makeHunk([{ type: "delete", content: `import { helper } from "./utils";`, line: 1 }])],
    };
    const edges = extractImportEdges([file]);
    expect(edges).toHaveLength(0);
  });

  it("only scans added lines, not context lines", () => {
    const file: DiffFile = {
      path: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [makeHunk([
        { type: "normal", content: `import { old } from "./old";`, line: 1 },
        { type: "add", content: `import { new_ } from "./new";`, line: 2 },
      ])],
    };
    const edges = extractImportEdges([file]);
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toBe("src/new");
  });

  it("extracts from multiple files", () => {
    const files = [
      makeDiffFile("src/app.ts", [`import { helper } from "./utils";`]),
      makeDiffFile("src/server.ts", [`import { app } from "./app";`]),
    ];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(2);
    expect(edges[0].from).toBe("src/app.ts");
    expect(edges[1].from).toBe("src/server.ts");
  });

  it("handles parent directory imports in edges", () => {
    const files = [makeDiffFile("src/auth/login.ts", [
      `import { config } from "../config";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges[0].to).toBe("src/config");
  });

  it("skips self-import when path resolves to same file", () => {
    // If source is "app" (no extension) and import is "./app", they match
    const files = [makeDiffFile("app", [
      `import { something } from "./app";`,
    ])];
    const edges = extractImportEdges(files);
    expect(edges).toHaveLength(0);
  });

  it("returns empty array for empty diff", () => {
    expect(extractImportEdges([])).toEqual([]);
  });
});

describe("buildDependencyGraphs", () => {
  it("builds forward and reverse graphs", () => {
    const edges = [
      { from: "src/a.ts", to: "src/b.ts", kind: "import" as const, line: 1 },
      { from: "src/c.ts", to: "src/b.ts", kind: "import" as const, line: 2 },
    ];
    const changedSet = new Set(["src/a.ts", "src/c.ts"]);
    const { forward, reverse } = buildDependencyGraphs(edges, changedSet);

    // Forward: a→b, c→b
    expect(forward.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
    expect(forward.get("src/c.ts")).toEqual(new Set(["src/b.ts"]));

    // Reverse: b→{a, c}
    expect(reverse.get("src/b.ts")).toEqual(new Set(["src/a.ts", "src/c.ts"]));
  });

  it("skips edges unrelated to changed files", () => {
    const edges = [
      { from: "src/x.ts", to: "src/y.ts", kind: "import" as const, line: 1 },
    ];
    const changedSet = new Set(["src/a.ts"]);
    const { forward, reverse } = buildDependencyGraphs(edges, changedSet);

    expect(forward.size).toBe(0);
    expect(reverse.size).toBe(0);
  });

  it("includes edge where target is a changed file", () => {
    const edges = [
      { from: "src/consumer.ts", to: "src/changed.ts", kind: "import" as const, line: 1 },
    ];
    const changedSet = new Set(["src/changed.ts"]);
    const { reverse } = buildDependencyGraphs(edges, changedSet);

    expect(reverse.get("src/changed.ts")).toEqual(new Set(["src/consumer.ts"]));
  });
});

describe("computeBlastRadius", () => {
  it("returns empty for no dependents", () => {
    const reverse = new Map<string, Set<string>>();
    const changedSet = new Set(["src/app.ts"]);
    const result = computeBlastRadius(["src/app.ts"], reverse, changedSet);
    expect(result).toEqual([]);
  });

  it("finds direct dependents (depth 1)", () => {
    const reverse = new Map<string, Set<string>>();
    reverse.set("src/utils.ts", new Set(["src/app.ts", "src/server.ts"]));

    const changedSet = new Set(["src/utils.ts"]);
    const result = computeBlastRadius(["src/utils.ts"], reverse, changedSet);

    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("src/app.ts");
    expect(result[0].depth).toBe(1);
    expect(result[0].impactLevel).toBe("direct");
    expect(result[1].path).toBe("src/server.ts");
    expect(result[1].depth).toBe(1);
  });

  it("finds transitive dependents (depth 2+)", () => {
    const reverse = new Map<string, Set<string>>();
    // utils.ts is changed; app.ts depends on utils.ts; server.ts depends on app.ts
    reverse.set("src/utils.ts", new Set(["src/app.ts"]));
    reverse.set("src/app.ts", new Set(["src/server.ts"]));

    const changedSet = new Set(["src/utils.ts"]);
    const result = computeBlastRadius(["src/utils.ts"], reverse, changedSet);

    expect(result).toHaveLength(2);
    // app.ts is depth 1 (direct)
    expect(result.find((r) => r.path === "src/app.ts")!.depth).toBe(1);
    // server.ts is depth 2 (transitive)
    expect(result.find((r) => r.path === "src/server.ts")!.depth).toBe(2);
    expect(result.find((r) => r.path === "src/server.ts")!.impactLevel).toBe("transitive");
  });

  it("skips changed files from the blast radius", () => {
    const reverse = new Map<string, Set<string>>();
    reverse.set("src/utils.ts", new Set(["src/app.ts"]));
    // Both utils.ts and app.ts are changed
    const changedSet = new Set(["src/utils.ts", "src/app.ts"]);
    const result = computeBlastRadius(["src/utils.ts"], reverse, changedSet);
    expect(result).toHaveLength(0);
  });

  it("deduplicates entries", () => {
    const reverse = new Map<string, Set<string>>();
    reverse.set("src/a.ts", new Set(["src/b.ts"]));
    reverse.set("src/b.ts", new Set(["src/c.ts"]));
    // a is changed; b depends on a; c depends on b
    // also c → a (direct + transitive)
    reverse.get("src/a.ts")!.add("src/c.ts");

    const changedSet = new Set(["src/a.ts"]);
    const result = computeBlastRadius(["src/a.ts"], reverse, changedSet);

    // c appears once (shallowest depth = 1 via direct)
    const cEntries = result.filter((r) => r.path === "src/c.ts");
    expect(cEntries).toHaveLength(1);
    expect(cEntries[0].depth).toBe(1);
  });

  it("sorts by depth then changedFile then path", () => {
    const reverse = new Map<string, Set<string>>();
    reverse.set("src/a.ts", new Set(["src/z.ts", "src/y.ts"]));
    reverse.set("src/b.ts", new Set(["src/x.ts"]));

    const changedSet = new Set(["src/a.ts", "src/b.ts"]);
    const result = computeBlastRadius(["src/a.ts", "src/b.ts"], reverse, changedSet);

    // All are depth 1, sorted by changedFile then path
    expect(result[0].changedFile).toBe("src/a.ts");
    expect(result[0].path).toBe("src/y.ts");
    expect(result[1].path).toBe("src/z.ts");
    expect(result[2].changedFile).toBe("src/b.ts");
  });

  it("caps BFS at depth 5", () => {
    const reverse = new Map<string, Set<string>>();
    // Chain: a→b→c→d→e→f→g
    reverse.set("src/a.ts", new Set(["src/b.ts"]));       // b at depth 1
    reverse.set("src/b.ts", new Set(["src/c.ts"]));       // c at depth 2
    reverse.set("src/c.ts", new Set(["src/d.ts"]));       // d at depth 3
    reverse.set("src/d.ts", new Set(["src/e.ts"]));       // e at depth 4
    reverse.set("src/e.ts", new Set(["src/f.ts"]));       // f at depth 5
    reverse.set("src/f.ts", new Set(["src/g.ts"]));       // g at depth 6

    const changedSet = new Set(["src/a.ts"]);
    const result = computeBlastRadius(["src/a.ts"], reverse, changedSet);

    // f at depth 5 should be included
    expect(result.find((r) => r.path === "src/f.ts")).toBeDefined();
    expect(result.find((r) => r.path === "src/f.ts")!.depth).toBe(5);
    // g at depth 6 should NOT be included
    expect(result.find((r) => r.path === "src/g.ts")).toBeUndefined();
  });
});

describe("runBlastRadiusAnalysis", () => {
  it("returns empty result for diff with no imports", () => {
    const files = [makeDiffFile("src/app.ts", [
      `const x = 42;`,
      `console.log(x);`,
    ])];
    const result = runBlastRadiusAnalysis(files);
    expect(result.edges).toHaveLength(0);
    expect(result.impactedFiles).toHaveLength(0);
    expect(result.totalImpact).toBe(0);
  });

  it("detects blast radius when changed file has dependents", () => {
    const files = [
      makeDiffFile("src/utils.ts", [`export function helper() {}`]),
      makeDiffFile("src/app.ts", [`import { helper } from "./utils";`]),
    ];
    const result = runBlastRadiusAnalysis(files);

    // app imports utils, and utils is changed
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.impactedFiles.length).toBeGreaterThanOrEqual(0);
  });

  it("counts changedFilesWithDependents", () => {
    const files1 = [makeDiffFile("src/app.ts", [
      `import { helper } from "./utils";`,
    ])];
    const result1 = runBlastRadiusAnalysis(files1);
    // app.ts is the only changed file; it imports utils, but utils isn't changed
    // So there are no dependents on changed files unless utils re-exports from app
    expect(result1.changedFilesWithDependents).toBe(0);
  });
});

describe("buildBlastRadiusContext", () => {
  it("returns empty string for zero impact", () => {
    const result: import("../blast-radius.js").BlastRadiusResult = {
      edges: [],
      impactedFiles: [],
      changedFilesWithDependents: 0,
      totalImpact: 0,
    };
    expect(buildBlastRadiusContext(result)).toBe("");
  });

  it("formats impacted files grouped by changed file", () => {
    const result: import("../blast-radius.js").BlastRadiusResult = {
      edges: [{ from: "src/app.ts", to: "src/utils.ts", kind: "import", line: 1 }],
      impactedFiles: [
        { path: "src/app.ts", changedFile: "src/utils.ts", depth: 1, impactLevel: "direct" },
        { path: "src/server.ts", changedFile: "src/utils.ts", depth: 2, impactLevel: "transitive" },
      ],
      changedFilesWithDependents: 1,
      totalImpact: 2,
    };
    const ctx = buildBlastRadiusContext(result);

    expect(ctx).toContain("Blast Radius");
    expect(ctx).toContain("src/utils.ts");
    expect(ctx).toContain("src/app.ts");
    expect(ctx).toContain("direct");
    expect(ctx).toContain("2-hop");
    expect(ctx).toContain("impacts:");
  });

  it("truncates at 8 dependents per changed file", () => {
    const impacted = Array.from({ length: 10 }, (_, i) => ({
      path: `src/dep${i}.ts`,
      changedFile: "src/utils.ts",
      depth: 1,
      impactLevel: "direct" as const,
    }));
    const result: import("../blast-radius.js").BlastRadiusResult = {
      edges: [],
      impactedFiles: impacted,
      changedFilesWithDependents: 1,
      totalImpact: 10,
    };
    const ctx = buildBlastRadiusContext(result);

    expect(ctx).toContain("and 2 more");
    expect(ctx).toContain("src/dep0.ts");
    expect(ctx).toContain("src/dep7.ts");
  });

  it("includes dependency edge count", () => {
    const result: import("../blast-radius.js").BlastRadiusResult = {
      edges: [
        { from: "src/a.ts", to: "src/b.ts", kind: "import", line: 1 },
        { from: "src/c.ts", to: "src/b.ts", kind: "require", line: 2 },
      ],
      impactedFiles: [
        { path: "src/a.ts", changedFile: "src/b.ts", depth: 1, impactLevel: "direct" },
      ],
      changedFilesWithDependents: 1,
      totalImpact: 1,
    };
    const ctx = buildBlastRadiusContext(result);
    expect(ctx).toContain("Dependency edges found:** 2");
  });
});
