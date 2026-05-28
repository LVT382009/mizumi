import { describe, it, expect } from "vitest";
import { detectVelocityRisks } from "../velocity-risk-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[], status: "added" | "modified" | "deleted" = "modified"): DiffFile {
  return {
    path,
    status,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: addedLines.map((content, idx) => ({
          type: "add" as const,
          content: `+${content}`,
          line: idx + 1,
        })),
      },
    ],
  };
}

function makeFileWithRemoved(path: string, addedLines: string[], removedLines: string[]): DiffFile {
  return {
    path,
    status: "modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: [
          ...removedLines.map((content, idx) => ({
            type: "delete" as const,
            content: `-${content}`,
            line: idx + 1,
          })),
          ...addedLines.map((content, idx) => ({
            type: "add" as const,
            content: `+${content}`,
            line: idx + 1,
          })),
        ],
      },
    ],
  };
}

function makeLargeNewFile(path: string, lineCount: number): DiffFile {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`const line${i} = ${i};`);
  }
  return makeFile(path, lines, "added");
}

// ---------------------------------------------------------------------------
// large-new-file
// ---------------------------------------------------------------------------

describe("detectVelocityRisks — large-new-file", () => {
  it("detects new file with 150+ lines and no tests", () => {
    const file = makeLargeNewFile("src/service.ts", 150);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("no test coverage");
  });

  it("does not flag new file under 100 lines", () => {
    const file = makeLargeNewFile("src/small.ts", 50);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues).toHaveLength(0);
  });

  it("does not flag new test file even if large", () => {
    const testLines = Array.from({ length: 150 }, (_, i) => `expect(result${i}).toBe(${i});`);
    const file = makeFile("src/__tests__/service.test.ts", testLines, "added");
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues).toHaveLength(0);
  });

  it("does not flag large new file when matching test exists", () => {
    const file = makeLargeNewFile("src/utils.ts", 150);
    const testFile = makeFile("src/__tests__/utils.test.ts", ["test('works', () => { expect(1).toBe(1); })"], "added");
    const result = detectVelocityRisks([file, testFile]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues).toHaveLength(0);
  });

  it("does not flag modified file even if large", () => {
    const file = makeLargeNewFile("src/existing.ts", 150);
    file.status = "modified";
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    // Should not flag since status is not "added"
    expect(issues).toHaveLength(0);
  });

  it("detects large new file with inline assertions as safe", () => {
    const lines = Array.from({ length: 150 }, (_, i) =>
      i < 10 ? `expect(fn(${i})).toBe(${i});` : `const line${i} = ${i};`
    );
    const file = makeFile("src/assertions.ts", lines, "added");
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    // Has assertions, so should not flag
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// boilerplate-proliferation
// ---------------------------------------------------------------------------

describe("detectVelocityRisks — boilerplate-proliferation", () => {
  it("detects same function name in 3+ files", () => {
    const files = [
      makeFile("src/a.ts", ["export function processData(data: any) { return data; }"]),
      makeFile("src/b.ts", ["export function processData(data: any) { return data; }"]),
      makeFile("src/c.ts", ["export function processData(data: any) { return data; }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].description).toContain("processData");
  });

  it("detects same class name in 3+ files", () => {
    const files = [
      makeFile("src/a.ts", ["export class DataValidator { validate() { return true; } }"]),
      makeFile("src/b.ts", ["export class DataValidator { validate() { return true; } }"]),
      makeFile("src/c.ts", ["export class DataValidator { validate() { return true; } }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag unique function names", () => {
    const files = [
      makeFile("src/a.ts", ["export function parseInput(data: any) { }"]),
      makeFile("src/b.ts", ["export function formatOutput(data: any) { }"]),
      makeFile("src/c.ts", ["export function validateSchema(data: any) { }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues).toHaveLength(0);
  });

  it("does not flag function appearing in only 2 files", () => {
    const files = [
      makeFile("src/a.ts", ["export function helper() { }"]),
      makeFile("src/b.ts", ["export function helper() { }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sweep-no-safety
// ---------------------------------------------------------------------------

describe("detectVelocityRisks — sweep-no-safety", () => {
  it("detects sweep refactor with no type annotations or tests", () => {
    const file = makeFileWithRemoved(
      "src/old.ts",
      Array.from({ length: 25 }, (_, i) => `const newLine${i} = ${i};`),
      Array.from({ length: 80 }, (_, i) => `const oldLine${i} = ${i};`),
    );
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].description).toContain("refactor");
  });

  it("does not flag PR with type annotations on additions", () => {
    const addedLines = Array.from({ length: 30 }, (_, i) => `const val${i}: number = ${i};`);
    const removedLines = Array.from({ length: 60 }, (_, i) => `const old${i} = ${i};`);
    const file = makeFileWithRemoved("src/typed.ts", addedLines, removedLines);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    // Type annotations should lower the risk enough
    expect(issues).toHaveLength(0);
  });

  it("does not flag PR with test additions", () => {
    const addedLines = Array.from({ length: 15 }, (_, i) => `expect(result${i}).toBe(${i});`);
    const removedLines = Array.from({ length: 30 }, (_, i) => `const old${i} = ${i};`);
    const file = makeFileWithRemoved("src/test.ts", addedLines, removedLines);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues).toHaveLength(0);
  });

  it("does not flag small PRs", () => {
    const addedLines = ["const x = 1;"];
    const removedLines = Array.from({ length: 20 }, (_, i) => `const old${i} = ${i};`);
    const file = makeFileWithRemoved("src/small.ts", addedLines, removedLines);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// copy-paste-pattern
// ---------------------------------------------------------------------------

describe("detectVelocityRisks — copy-paste-pattern", () => {
  it("detects identical code block in 3+ files", () => {
    const block = [
      "async function fetchAndParseDataFromExternalAPI(endpoint: string) {",
      "  const response = await fetch(endpoint);",
      "  const data = await response.json();",
      "  return data.items.filter(item => item.active);",
      "}",
    ];
    const files = [
      makeFile("src/a.ts", block),
      makeFile("src/b.ts", block),
      makeFile("src/c.ts", block),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("does not flag unique code in different files", () => {
    const files = [
      makeFile("src/a.ts", ["function parseUserData(input: string) { return JSON.parse(input); }"]),
      makeFile("src/b.ts", ["function formatResponse(data: Record<string, unknown>) { return JSON.stringify(data); }"]),
      makeFile("src/c.ts", ["function validateInput(input: unknown) { return typeof input === 'string'; }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues).toHaveLength(0);
  });

  it("does not flag code in only 2 files", () => {
    const block = [
      "async function fetchExternalDataFromAPI(endpoint: string) {",
      "  const response = await fetch(endpoint);",
      "  return response.json();",
      "}",
    ];
    const files = [
      makeFile("src/a.ts", block),
      makeFile("src/b.ts", block),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectVelocityRisks — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectVelocityRisks([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectVelocityRisks([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no velocity risks", () => {
    const file = makeFile("src/utils.ts", [
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    const result = detectVelocityRisks([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips import lines in boilerplate detection", () => {
    const files = [
      makeFile("src/a.ts", ["import type { Data } from './types';"]),
      makeFile("src/b.ts", ["import type { Data } from './types';"]),
      makeFile("src/c.ts", ["import type { Data } from './types';"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    // import type lines should be skipped
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectVelocityRisks — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeLargeNewFile("src/service.ts", 150);
    const result = detectVelocityRisks([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Velocity Risk Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", ["const x = 1;"]);
    const result = detectVelocityRisks([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeLargeNewFile("src/service.ts", 150);
    const result = detectVelocityRisks([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", ["const x = 1;"]);
    const result = detectVelocityRisks([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const large = makeLargeNewFile("src/new.ts", 150);
    const files = [
      makeFile("src/a.ts", ["export function processData(data: any) { return data; }"]),
      makeFile("src/b.ts", ["export function processData(data: any) { return data; }"]),
      makeFile("src/c.ts", ["export function processData(data: any) { return data; }"]),
    ];
    const result = detectVelocityRisks([large, ...files]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeLargeNewFile("src/service.ts", 150);
    const result = detectVelocityRisks([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});
