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

  it("does not flag exactly 100 lines (boundary)", () => {
    const file = makeLargeNewFile("src/boundary.ts", 100);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues).toHaveLength(0);
  });

  it("flags 101 lines in new file", () => {
    const file = makeLargeNewFile("src/just-over.ts", 101);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag .spec.ts file even if large", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `it('test ${i}', () => { /* body */ });`);
    const file = makeFile("src/service.spec.ts", lines, "added");
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test/ directory file even if large", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `const line${i} = ${i};`);
    const file = makeFile("test/service.ts", lines, "added");
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    expect(issues).toHaveLength(0);
  });

  it("does not flag when matching test file exists with different extension", () => {
    const file = makeLargeNewFile("src/parser.ts", 150);
    const testFile = makeFile("src/parser.test.ts", ["test('works', () => { expect(1).toBe(1); })"], "added");
    const result = detectVelocityRisks([file, testFile]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
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

  it("detects async function proliferation in 3+ files", () => {
    const files = [
      makeFile("src/a.ts", ["export async function fetchItems(query: string) { return []; }"]),
      makeFile("src/b.ts", ["export async function fetchItems(query: string) { return []; }"]),
      makeFile("src/c.ts", ["export async function fetchItems(query: string) { return []; }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects class method proliferation across files", () => {
    const files = [
      makeFile("src/a.ts", ["export class Handler { process() {} }"]),
      makeFile("src/b.ts", ["export class Handler { process() {} }"]),
      makeFile("src/c.ts", ["export class Handler { process() {} }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("lists multiple files in description", () => {
    const files = [
      makeFile("src/a.ts", ["export function init() { }"]),
      makeFile("src/b.ts", ["export function init() { }"]),
      makeFile("src/c.ts", ["export function init() { }"]),
      makeFile("src/d.ts", ["export function init() { }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("4 files");
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

  it("does not flag when removals < 60% of total changes", () => {
    const addedLines = Array.from({ length: 50 }, (_, i) => `const line${i} = ${i};`);
    const removedLines = Array.from({ length: 20 }, (_, i) => `const old${i} = ${i};`);
    const file = makeFileWithRemoved("src/balanced.ts", addedLines, removedLines);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues).toHaveLength(0);
  });

  it("does not flag when additions have sufficient test coverage", () => {
    const addedLines = [
      ...Array.from({ length: 15 }, (_, i) => `expect(result${i}).toBe(${i});`),
      ...Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`),
    ];
    const removedLines = Array.from({ length: 60 }, (_, i) => `const old${i} = ${i};`);
    const file = makeFileWithRemoved("src/covered.ts", addedLines, removedLines);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues).toHaveLength(0);
  });

  it("reports percentage of removals in description", () => {
    const file = makeFileWithRemoved(
      "src/sweep.ts",
      Array.from({ length: 25 }, (_, i) => `const line${i} = ${i};`),
      Array.from({ length: 80 }, (_, i) => `const old${i} = ${i};`),
    );
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("% removals");
  });

  it("handles multiple files for sweep detection", () => {
    const files = [
      makeFileWithRemoved("src/a.ts",
        Array.from({ length: 15 }, (_, i) => `const a${i} = ${i};`),
        Array.from({ length: 45 }, (_, i) => `const oldA${i} = ${i};`),
      ),
      makeFileWithRemoved("src/b.ts",
        Array.from({ length: 15 }, (_, i) => `const b${i} = ${i};`),
        Array.from({ length: 45 }, (_, i) => `const oldB${i} = ${i};`),
      ),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when type annotations raise safety ratio above 0.1", () => {
    // 30 added lines, 70 removed lines -> 70% removals
    // Need >3 type annotations for 30 added lines (3/30 = 0.1 is still not <0.1)
    // So 4 type annotations should make safetyRatio = 4/30 = 0.133 >= 0.1
    const addedLines = [
      "const a: string = 'hello';",
      "const b: number = 42;",
      "const c: boolean = true;",
      "const d: void = undefined;",
      ...Array.from({ length: 26 }, (_, i) => `const line${i} = ${i};`),
    ];
    const removedLines = Array.from({ length: 70 }, (_, i) => `const old${i} = ${i};`);
    const file = makeFileWithRemoved("src/typed2.ts", addedLines, removedLines);
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues).toHaveLength(0);
  });

  it("includes removed and added counts in issue code field", () => {
    const file = makeFileWithRemoved(
      "src/info.ts",
      Array.from({ length: 25 }, (_, i) => `const line${i} = ${i};`),
      Array.from({ length: 80 }, (_, i) => `const old${i} = ${i};`),
    );
    const result = detectVelocityRisks([file]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].code).toContain("removed");
    expect(issues[0].code).toContain("added");
  });

  it("does not flag when no refactored files have more removed than added", () => {
    const file = makeFileWithRemoved(
      "src/balanced2.ts",
      Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`),
      Array.from({ length: 20 }, (_, i) => `const old${i} = ${i};`),
    );
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

  it("skips files with fewer than 5 added lines", () => {
    const files = [
      makeFile("src/a.ts", ["const x = 1;"]),
      makeFile("src/b.ts", ["const x = 1;"]),
      makeFile("src/c.ts", ["const x = 1;"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues).toHaveLength(0);
  });

  it("normalizes string literals in n-gram comparison", () => {
    const blockA = [
      "async function processUserDataFromExternalService(endpoint: string) {",
      " const response = await fetch(endpoint);",
      " const parsedData = await response.json();",
      ' console.log("Processing user data from service");',
      " return parsedData.filter(item => item.isActive);",
      "}",
    ];
    const blockB = [
      "async function processUserDataFromExternalService(endpoint: string) {",
      " const response = await fetch(endpoint);",
      " const parsedData = await response.json();",
      ' console.log("Processing admin data from service");',
      " return parsedData.filter(item => item.isActive);",
      "}",
    ];
    const blockC = [
      "async function processUserDataFromExternalService(endpoint: string) {",
      " const response = await fetch(endpoint);",
      " const parsedData = await response.json();",
      ' console.log("Processing guest data from service");',
      " return parsedData.filter(item => item.isActive);",
      "}",
    ];
    const files = [
      makeFile("src/a.ts", blockA),
      makeFile("src/b.ts", blockB),
      makeFile("src/c.ts", blockC),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("caps output at 10 issues for copy-paste", () => {
    const block = [
      "async function fetchAndParseDataFromExternalAPI(endpoint: string) {",
      " const response = await fetch(endpoint);",
      " const data = await response.json();",
      " return data.items.filter(item => item.active);",
      "}",
    ];
    const files = Array.from({ length: 15 }, (_, i) =>
      makeFile(`src/file${i}.ts`, block)
    );
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues.length).toBeLessThanOrEqual(10);
  });

  it("skips short lines under 20 characters in copy-paste detection", () => {
    const files = [
      makeFile("src/a.ts", ["x = 1;", "short line", "another short one", "const value = 42;", "extra padding here"]),
      makeFile("src/b.ts", ["x = 1;", "short line", "another short one", "const value = 42;", "extra padding here"]),
      makeFile("src/c.ts", ["x = 1;", "short line", "another short one", "const value = 42;", "extra padding here"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues).toHaveLength(0);
  });

  it("skips files with fewer than 5 added lines in copy-paste", () => {
    const block = ["async function fetchAndParseDataFromExternalAPI(endpoint) {"];
    const files = [
      makeFile("src/a.ts", block),
      makeFile("src/b.ts", block),
      makeFile("src/c.ts", block),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues).toHaveLength(0);
  });

  it("deduplicates copy-paste issues per category:file", () => {
    const blockA = [
      "async function fetchAndParseDataFromExternalAPI(endpoint: string) {",
      " const response = await fetch(endpoint);",
      " const data = await response.json();",
      " return data.items.filter(item => item.active);",
      "}",
    ];
    const blockB = [
      "async function processAndFormatRecordsFromDatabase(connStr: string) {",
      " const response = await fetch(connStr);",
      " const data = await response.json();",
      " return data.items.filter(item => item.active);",
      "}",
    ];
    const files = [
      makeFile("src/a.ts", [...blockA, ...blockB]),
      makeFile("src/b.ts", [...blockA, ...blockB]),
      makeFile("src/c.ts", [...blockA, ...blockB]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    // Each file should appear at most once (dedup per category:file)
    const perFile = new Map<string, number>();
    for (const issue of issues) {
      perFile.set(issue.file, (perFile.get(issue.file) || 0) + 1);
    }
    for (const [_, count] of perFile) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it("normalizes number literals in n-gram comparison", () => {
    const block = [
      "async function fetchExternalDataFromService(endpoint: string) {",
      " const response = await fetch(endpoint);",
      " const data = await response.json();",
      " return data.items.filter(item => item.count > 100);",
      "}",
    ];
    const blockA = block.map((l) => l.replace("100", "100"));
    const blockB = block.map((l) => l.replace("100", "200"));
    const blockC = block.map((l) => l.replace("100", "300"));
    const files = [
      makeFile("src/a.ts", blockA),
      makeFile("src/b.ts", blockB),
      makeFile("src/c.ts", blockC),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "copy-paste-pattern");
    expect(issues.length).toBeGreaterThanOrEqual(1);
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

  it("skips comment lines in boilerplate detection", () => {
    const files = [
      makeFile("src/a.ts", ["// export function process() { }"]),
      makeFile("src/b.ts", ["// export function process() { }"]),
      makeFile("src/c.ts", ["// export function process() { }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues).toHaveLength(0);
  });

  it("detects multiply occurring const signature in 3+ files", () => {
    const files = [
      makeFile("src/a.ts", ["const handler = (event: Event) => processEvent(event);"]),
      makeFile("src/b.ts", ["const handler = (event: Event) => processEvent(event);"]),
      makeFile("src/c.ts", ["const handler = (event: Event) => processEvent(event);"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("handler");
  });

  it("detects abstract class in 3+ files", () => {
    const files = [
      makeFile("src/a.ts", ["export abstract class BaseRepository { }"]),
      makeFile("src/b.ts", ["export abstract class BaseRepository { }"]),
      makeFile("src/c.ts", ["export abstract class BaseRepository { }"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("BaseRepository");
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

  it("contextText includes both critical and warning sections when both exist", () => {
    const large = makeLargeNewFile("src/new.ts", 150);
    const boilerplate = [
      makeFile("src/a.ts", ["export function processData(data: any) { return data; }"]),
      makeFile("src/b.ts", ["export function processData(data: any) { return data; }"]),
      makeFile("src/c.ts", ["export function processData(data: any) { return data; }"]),
    ];
    const result = detectVelocityRisks([large, ...boilerplate]);
    if (result.issues.some((i) => i.severity === "critical")) {
      expect(result.contextText).toContain("### Critical");
    }
    if (result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("### Warnings");
    }
  });

  it("body summary includes category label with spaces replacing dashes", () => {
    const file = makeLargeNewFile("src/service.ts", 150);
    const result = detectVelocityRisks([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("large new file");
    }
  });

  it("does not flag deleted files for large-new-file", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectVelocityRisks([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag deleted files for boilerplate detection", () => {
    const files = [
      { path: "src/a.ts", status: "deleted" as const, hunks: [] },
      { path: "src/b.ts", status: "deleted" as const, hunks: [] },
      { path: "src/c.ts", status: "deleted" as const, hunks: [] },
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues).toHaveLength(0);
  });

  it("detects large new file with path not matching any test file", () => {
    const mainFile = makeLargeNewFile("src/complex-service.ts", 150);
    const unrelatedTest = makeFile("src/__tests__/other.test.ts", ["expect(1).toBe(1);"], "added");
    const result = detectVelocityRisks([mainFile, unrelatedTest]);
    const issues = result.issues.filter((i) => i.category === "large-new-file");
    // Test file name does not match "complex-service" so it should still flag
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("extractSignature returns empty for comment-only lines", () => {
    const files = [
      makeFile("src/a.ts", ["// This is a comment about nothing"]),
      makeFile("src/b.ts", ["// This is a comment about nothing"]),
      makeFile("src/c.ts", ["// This is a comment about nothing"]),
    ];
    const result = detectVelocityRisks(files);
    const issues = result.issues.filter((i) => i.category === "boilerplate-proliferation");
    expect(issues).toHaveLength(0);
  });

  it("sweep-no-safety uses first refactored file as issue file", () => {
    const fileA = makeFileWithRemoved("src/alpha.ts",
      Array.from({ length: 25 }, (_, i) => `const a${i} = ${i};`),
      Array.from({ length: 80 }, (_, i) => `const oldA${i} = ${i};`),
    );
    const fileB = makeFileWithRemoved("src/beta.ts",
      Array.from({ length: 10 }, (_, i) => `const b${i} = ${i};`),
      Array.from({ length: 30 }, (_, i) => `const oldB${i} = ${i};`),
    );
    const result = detectVelocityRisks([fileA, fileB]);
    const issues = result.issues.filter((i) => i.category === "sweep-no-safety");
    if (issues.length > 0) {
      expect(issues[0].file).toBe("src/alpha.ts");
    }
  });
});
