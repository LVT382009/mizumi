import { describe, it, expect } from "vitest";
import {
  parsePackageJsonDiff,
  classifyVersionChange,
  parseSemver,
  detectLockfileChanges,
  isDepFile,
  extractPackageName,
  traceImportImpact,
  analyzeDepImpact,
} from "../dep-impact.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: overrides.path ?? "src/api/users.ts",
    status: overrides.status ?? "modified",
    additions: overrides.additions ?? 20,
    deletions: overrides.deletions ?? 5,
    hunks: overrides.hunks ?? [
      {
        oldStart: 1, oldLines: 5, newStart: 1, newLines: 8,
        content: "",
        changes: [
          { type: "add", line: 1, oldLine: 0, content: "export function newUser() {}" },
          { type: "add", line: 2, oldLine: 0, content: "  return { name: 'test' };" },
          { type: "normal", line: 3, oldLine: 3, content: "export function getUser() {}" },
        ],
      },
    ],
  };
}

function makePackageJsonHunk(
  deletedDeps: Record<string, string>,
  addedDeps: Record<string, string>,
  group: string = "dependencies",
): DiffFile["hunks"] {
  const changes: DiffFile["hunks"][0]["changes"] = [];

  // Delete old lines first
  for (const [name, ver] of Object.entries(deletedDeps)) {
    changes.push({ type: "delete", line: 0, oldLine: changes.length + 1, content: `    "${name}": "${ver}"` });
  }

  // Add new lines
  for (const [name, ver] of Object.entries(addedDeps)) {
    changes.push({ type: "add", line: changes.length + 1, oldLine: 0, content: `    "${name}": "${ver}"` });
  }

  // Surround with section markers
  const allChanges: DiffFile["hunks"][0]["changes"] = [
    { type: "delete", line: 0, oldLine: 1, content: `  "${group}": {` },
    ...changes.filter(c => c.type === "delete"),
    { type: "delete", line: 0, oldLine: 99, content: "  }" },
    { type: "add", line: 1, oldLine: 0, content: `  "${group}": {` },
    ...changes.filter(c => c.type === "add"),
    { type: "add", line: 99, oldLine: 0, content: "  }" },
  ];

  return [{
    oldStart: 1, oldLines: 10, newStart: 1, newLines: 12,
    content: "",
    changes: allChanges,
  }];
}

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
  it("parses standard semver", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("parses semver with caret", () => {
    expect(parseSemver("^1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("parses semver with tilde", () => {
    expect(parseSemver("~1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("parses semver with >= prefix", () => {
    expect(parseSemver(">=2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it("parses major-only version", () => {
    expect(parseSemver("1")).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it("parses major.minor version", () => {
    expect(parseSemver("1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
  });

  it("returns null for file: references", () => {
    expect(parseSemver("file:../local-pkg")).toBeNull();
  });

  it("returns null for workspace: references", () => {
    expect(parseSemver("workspace:*")).toBeNull();
  });

  it("returns null for github: references", () => {
    expect(parseSemver("github:user/repo")).toBeNull();
  });

  it("returns null for git+ references", () => {
    expect(parseSemver("git+https://example.com/repo.git")).toBeNull();
  });

  it("returns null for npm: references", () => {
    expect(parseSemver("npm:pkg@1.0.0")).toBeNull();
  });

  it("returns null for non-semver strings", () => {
    expect(parseSemver("latest")).toBeNull();
    expect(parseSemver("*")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyVersionChange
// ---------------------------------------------------------------------------

describe("classifyVersionChange", () => {
  it("detects major bump", () => {
    expect(classifyVersionChange("1.0.0", "2.0.0")).toBe("bumped-major");
  });

  it("detects minor bump", () => {
    expect(classifyVersionChange("1.0.0", "1.1.0")).toBe("bumped-minor");
  });

  it("detects patch bump", () => {
    expect(classifyVersionChange("1.0.0", "1.0.1")).toBe("bumped-patch");
  });

  it("detects downgrade", () => {
    expect(classifyVersionChange("2.0.0", "1.0.0")).toBe("downgraded");
  });

  it("detects minor downgrade", () => {
    expect(classifyVersionChange("1.2.0", "1.1.0")).toBe("downgraded");
  });

  it("handles same version (prerelease change)", () => {
    expect(classifyVersionChange("1.0.0", "1.0.0")).toBe("bumped-patch");
  });

  it("handles unparseable versions as minor", () => {
    expect(classifyVersionChange("latest", "next")).toBe("bumped-minor");
  });

  it("handles caret-prefixed versions", () => {
    expect(classifyVersionChange("^1.0.0", "^2.0.0")).toBe("bumped-major");
  });
});

// ---------------------------------------------------------------------------
// extractPackageName
// ---------------------------------------------------------------------------

describe("extractPackageName", () => {
  it("extracts simple package name", () => {
    expect(extractPackageName("lodash")).toBe("lodash");
  });

  it("extracts package from subpath import", () => {
    expect(extractPackageName("lodash/map")).toBe("lodash");
  });

  it("extracts scoped package name", () => {
    expect(extractPackageName("@angular/core")).toBe("@angular/core");
  });

  it("extracts scoped package with subpath", () => {
    expect(extractPackageName("@angular/core/testing")).toBe("@angular/core");
  });

  it("handles bare scoped package", () => {
    expect(extractPackageName("@scope")).toBe("@scope");
  });
});

// ---------------------------------------------------------------------------
// isDepFile
// ---------------------------------------------------------------------------

describe("isDepFile", () => {
  it("detects package.json", () => {
    expect(isDepFile("package.json")).toBe(true);
  });

  it("detects nested package.json", () => {
    expect(isDepFile("packages/core/package.json")).toBe(true);
  });

  it("detects package-lock.json", () => {
    expect(isDepFile("package-lock.json")).toBe(true);
  });

  it("detects yarn.lock", () => {
    expect(isDepFile("yarn.lock")).toBe(true);
  });

  it("detects pnpm-lock.yaml", () => {
    expect(isDepFile("pnpm-lock.yaml")).toBe(true);
  });

  it("detects bun.lockb", () => {
    expect(isDepFile("bun.lockb")).toBe(true);
  });

  it("detects requirements.txt", () => {
    expect(isDepFile("requirements.txt")).toBe(true);
  });

  it("detects go.mod", () => {
    expect(isDepFile("go.mod")).toBe(true);
  });

  it("detects Cargo.toml", () => {
    expect(isDepFile("Cargo.toml")).toBe(true);
  });

  it("rejects non-dep files", () => {
    expect(isDepFile("src/index.ts")).toBe(false);
  });

  it("rejects unrelated json files", () => {
    expect(isDepFile("tsconfig.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectLockfileChanges
// ---------------------------------------------------------------------------

describe("detectLockfileChanges", () => {
  it("detects lockfile changes", () => {
    const files = [
      makeDiffFile({ path: "package-lock.json", additions: 500, deletions: 200 }),
    ];
    const result = detectLockfileChanges(files);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("package-lock.json");
    expect(result[0].additions).toBe(500);
  });

  it("detects multiple lockfile types", () => {
    const files = [
      makeDiffFile({ path: "yarn.lock", additions: 300, deletions: 100 }),
      makeDiffFile({ path: "pnpm-lock.yaml", additions: 200, deletions: 80 }),
    ];
    const result = detectLockfileChanges(files);
    expect(result).toHaveLength(2);
  });

  it("ignores non-lockfile files", () => {
    const files = [
      makeDiffFile({ path: "src/index.ts", additions: 10, deletions: 5 }),
      makeDiffFile({ path: "package.json", additions: 2, deletions: 1 }),
    ];
    const result = detectLockfileChanges(files);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parsePackageJsonDiff
// ---------------------------------------------------------------------------

describe("parsePackageJsonDiff", () => {
  it("detects added dependency", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk({}, { "express": "^4.18.0" }),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe("express");
    expect(changes[0].kind).toBe("added");
    expect(changes[0].newVersion).toBe("^4.18.0");
    expect(changes[0].group).toBe("dependencies");
  });

  it("detects removed dependency", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk({ "lodash": "^3.0.0" }, {}),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe("lodash");
    expect(changes[0].kind).toBe("removed");
    expect(changes[0].oldVersion).toBe("^3.0.0");
  });

  it("detects version bump", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk({ "axios": "^0.27.0" }, { "axios": "^1.0.0" }),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes).toHaveLength(1);
    expect(changes[0].name).toBe("axios");
    expect(changes[0].kind).toBe("bumped-major");
    expect(changes[0].oldVersion).toBe("^0.27.0");
    expect(changes[0].newVersion).toBe("^1.0.0");
  });

  it("detects devDependency changes", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk({}, { "jest": "^29.0.0" }, "devDependencies"),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes).toHaveLength(1);
    expect(changes[0].group).toBe("devDependencies");
  });

  it("detects multiple changes in same diff", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk(
        { "lodash": "^3.0.0", "axios": "^0.21.0" },
        { "lodash": "^4.0.0", "express": "^4.18.0" },
      ),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    const names = changes.map(c => c.name);
    expect(names).toContain("lodash");
    expect(names).toContain("axios");
    expect(names).toContain("express");
  });

  it("returns empty for file without dep sections", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: [{
        oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
        content: "",
        changes: [
          { type: "add", line: 1, oldLine: 0, content: '  "name": "my-app",' },
          { type: "add", line: 2, oldLine: 0, content: '  "version": "1.0.0",' },
        ],
      }],
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// traceImportImpact
// ---------------------------------------------------------------------------

describe("traceImportImpact", () => {
  it("finds ESM imports of changed packages", () => {
    const files = [
      makeDiffFile({
        path: "src/app.ts",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "import express from 'express';" },
            { type: "add", line: 2, oldLine: 0, content: "import cors from 'cors';" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["express"]);
    expect(impacted).toHaveLength(1);
    expect(impacted[0].package).toBe("express");
    expect(impacted[0].kind).toBe("import");
  });

  it("finds require imports of changed packages", () => {
    const files = [
      makeDiffFile({
        path: "src/server.js",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "const lodash = require('lodash');" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["lodash"]);
    expect(impacted).toHaveLength(1);
    expect(impacted[0].kind).toBe("require");
  });

  it("finds dynamic imports", () => {
    const files = [
      makeDiffFile({
        path: "src/lazy.ts",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "const mod = await import('heavy-module');" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["heavy-module"]);
    expect(impacted).toHaveLength(1);
    expect(impacted[0].kind).toBe("dynamic-import");
  });

  it("finds scoped package imports", () => {
    const files = [
      makeDiffFile({
        path: "src/app.ts",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "import { Component } from '@angular/core';" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["@angular/core"]);
    expect(impacted).toHaveLength(1);
  });

  it("skips dependency manifest files", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "import 'express';" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["express"]);
    expect(impacted).toHaveLength(0);
  });

  it("returns empty for no matching packages", () => {
    const files = [
      makeDiffFile({
        path: "src/app.ts",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "import path from 'path';" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["express"]);
    expect(impacted).toHaveLength(0);
  });

  it("deduplicates file+package+kind", () => {
    const files = [
      makeDiffFile({
        path: "src/app.ts",
        hunks: [{
          oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "import express from 'express';" },
            { type: "add", line: 2, oldLine: 0, content: "import express from 'express';" },
          ],
        }],
      }),
    ];
    const impacted = traceImportImpact(files, ["express"]);
    expect(impacted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeDepImpact (integration)
// ---------------------------------------------------------------------------

describe("analyzeDepImpact", () => {
  it("returns empty result for no dep changes", () => {
    const files = [makeDiffFile({ path: "src/index.ts" })];
    const result = analyzeDepImpact(files);
    expect(result.changes).toHaveLength(0);
    expect(result.riskLevel).toBe("low");
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("detects package.json changes", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({}, { "express": "^4.18.0" }),
      }),
      makeDiffFile({
        path: "src/app.ts",
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: "import express from 'express';" },
          ],
        }],
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.changes).toHaveLength(1);
    expect(result.addedDeps).toBe(1);
    expect(result.impactedFiles).toHaveLength(1);
  });

  it("classifies risk as high for major bumps", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({ "lodash": "^3.0.0" }, { "lodash": "^4.0.0" }),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.majorBumps).toBe(1);
    expect(result.riskLevel).toBe("high");
  });

  it("classifies risk as medium for new production deps", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({}, { "new-pkg": "^1.0.0" }),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.riskLevel).toBe("medium");
  });

  it("classifies risk as low for dev bumps", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({ "jest": "^29.0.0" }, { "jest": "^29.1.0" }, "devDependencies"),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.riskLevel).toBe("low");
  });

  it("handles lockfile-only changes", () => {
    const files = [
      makeDiffFile({ path: "package-lock.json", additions: 500, deletions: 200 }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.riskLevel).toBe("low");
    expect(result.contextText).toContain("lockfile");
  });

  it("generates context text with risk guidance", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({}, { "express": "^4.18.0" }),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.contextText).toContain("Dependency Change Impact");
    expect(result.contextText).toContain("high-risk");
  });

  it("generates body summary with markdown table", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({}, { "express": "^4.18.0" }),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("Dependency Impact");
    expect(result.bodySummary).toContain("express");
    expect(result.bodySummary).toContain("</details>");
  });

  it("counts prod vs dev changes correctly", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({}, { "express": "^4.18.0" }, "dependencies"),
      }),
      makeDiffFile({
        path: "packages/core/package.json",
        hunks: makePackageJsonHunk({}, { "jest": "^29.0.0" }, "devDependencies"),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.prodChanges).toBe(1);
    expect(result.devChanges).toBe(1);
  });

  it("classifies high risk for 3+ new production deps", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk({}, {
          "pkg1": "^1.0.0",
          "pkg2": "^2.0.0",
          "pkg3": "^3.0.0",
        }),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.addedDeps).toBe(3);
    expect(result.riskLevel).toBe("high");
  });

  it("classifies high risk for high-risk packages", () => {
    const files = [
      makeDiffFile({
        path: "package.json",
        hunks: makePackageJsonHunk(
          { "express": "^4.17.0", "next": "^13.0.0" },
          { "express": "^4.18.0", "next": "^13.1.0" },
        ),
      }),
    ];
    const result = analyzeDepImpact(files);
    expect(result.riskLevel).toBe("high");
  });

  it("handles peerDependencies", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk({}, { "react": "^18.0.0" }, "peerDependencies"),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes[0].group).toBe("peerDependencies");
  });

  it("handles optionalDependencies", () => {
    const file = makeDiffFile({
      path: "package.json",
      hunks: makePackageJsonHunk({}, { "fsevents": "^2.3.0" }, "optionalDependencies"),
    });
    const changes = parsePackageJsonDiff(file);
    expect(changes[0].group).toBe("optionalDependencies");
  });
});
