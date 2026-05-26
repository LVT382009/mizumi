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
  inferTestFilePath,
  getAllTestConventions,
  countNewSymbols,
  runTestGapDetection,
  buildTestGapContext,
} from "../test-gap.js";
import type { TestGap, TestGapResult } from "../test-gap.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(
  filePath: string,
  addedLines: string[] = [],
  deletedLines: string[] = []
): DiffFile {
  return {
    path: filePath,
    additions: addedLines.length,
    deletions: deletedLines.length,
    hunks: [
      {
        changes: [
          ...addedLines.map((content, i) => ({
            type: "add" as const,
            content,
            line: i + 1,
          })),
          ...deletedLines.map((content, i) => ({
            type: "delete" as const,
            content,
            line: addedLines.length + i + 1,
          })),
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// inferTestFilePath
// ---------------------------------------------------------------------------

describe("inferTestFilePath", () => {
  it("infers co-located __tests__ path", () => {
    const result = inferTestFilePath("src/auth/login.ts");
    expect(result).toContain("__tests__");
    expect(result).toContain("login.test.ts");
  });

  it("handles nested source paths", () => {
    const result = inferTestFilePath("src/api/v2/users.ts");
    expect(result).toContain("users.test.ts");
  });

  it("handles .tsx files", () => {
    const result = inferTestFilePath("src/components/Button.tsx");
    expect(result).toContain("Button.test.tsx");
  });

  it("handles root-level files", () => {
    const result = inferTestFilePath("index.ts");
    expect(result).toContain("index.test.ts");
  });
});

// ---------------------------------------------------------------------------
// getAllTestConventions
// ---------------------------------------------------------------------------

describe("getAllTestConventions", () => {
  it("returns multiple convention paths", () => {
    const conventions = getAllTestConventions("src/auth/login.ts");
    expect(conventions.length).toBeGreaterThanOrEqual(4);
  });

  it("includes co-located __tests__ convention", () => {
    const conventions = getAllTestConventions("src/auth/login.ts");
    expect(conventions.some((c) => c.includes("__tests__/login.test"))).toBe(true);
  });

  it("includes spec convention", () => {
    const conventions = getAllTestConventions("src/auth/login.ts");
    expect(conventions.some((c) => c.includes(".spec.ts"))).toBe(true);
  });

  it("includes sibling test file convention", () => {
    const conventions = getAllTestConventions("src/auth/login.ts");
    expect(conventions.some((c) => c.includes("auth/login.test.ts") && !c.includes("__tests__"))).toBe(true);
  });

  it("includes separate test/ directory convention", () => {
    const conventions = getAllTestConventions("src/auth/login.ts");
    expect(conventions.some((c) => c.startsWith("test/") || c.startsWith("tests/"))).toBe(true);
  });

  it("handles .tsx extension", () => {
    const conventions = getAllTestConventions("src/ui/Modal.tsx");
    expect(conventions.every((c) => c.endsWith(".tsx"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countNewSymbols
// ---------------------------------------------------------------------------

describe("countNewSymbols", () => {
  it("counts exported function declarations", () => {
    const diffFile = makeDiffFile("src/math.ts", [
      "export function add(a: number, b: number) { return a + b; }",
    ]);
    expect(countNewSymbols(diffFile)).toBe(1);
  });

  it("counts async exported functions", () => {
    const diffFile = makeDiffFile("src/api.ts", [
      "export async function fetchData(url: string) { return fetch(url); }",
    ]);
    expect(countNewSymbols(diffFile)).toBe(1);
  });

  it("counts exported classes", () => {
    const diffFile = makeDiffFile("src/models.ts", [
      "export class User { constructor(public name: string) {} }",
    ]);
    expect(countNewSymbols(diffFile)).toBe(1);
  });

  it("counts exported arrow functions", () => {
    const diffFile = makeDiffFile("src/utils.ts", [
      "export const helper = (x: number) => x * 2",
    ]);
    expect(countNewSymbols(diffFile)).toBe(1);
  });

  it("counts async arrow functions", () => {
    const diffFile = makeDiffFile("src/api.ts", [
      "export const fetchUser = async (id: string) => { return null; }",
    ]);
    expect(countNewSymbols(diffFile)).toBe(1);
  });

  it("counts multiple symbols in same file", () => {
    const diffFile = makeDiffFile("src/lib.ts", [
      "export function a() {}",
      "export function b() {}",
      "export class C {}",
    ]);
    expect(countNewSymbols(diffFile)).toBe(3);
  });

  it("ignores non-exported functions", () => {
    const diffFile = makeDiffFile("src/lib.ts", [
      "function internalHelper() {}",
    ]);
    expect(countNewSymbols(diffFile)).toBe(0);
  });

  it("ignores deleted lines", () => {
    const diffFile = makeDiffFile("src/lib.ts", [], [
      "export function removed() {}",
    ]);
    expect(countNewSymbols(diffFile)).toBe(0);
  });

  it("counts indented method definitions", () => {
    const diffFile = makeDiffFile("src/service.ts", [
      "  public process(data: string) {",
    ]);
    expect(countNewSymbols(diffFile)).toBeGreaterThanOrEqual(1);
  });

  it("ignores control flow keywords that look like methods", () => {
    const diffFile = makeDiffFile("src/logic.ts", [
      "  if (condition) {",
      "  for (const item of items) {",
      "  return value;",
    ]);
    expect(countNewSymbols(diffFile)).toBe(0);
  });

  it("returns 0 for empty diff", () => {
    const diffFile = makeDiffFile("src/empty.ts", []);
    expect(countNewSymbols(diffFile)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runTestGapDetection
// ---------------------------------------------------------------------------

describe("runTestGapDetection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-testgap-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result for no production files", () => {
    const diffFiles = [
      makeDiffFile("README.md", ["# Hello"]),
      makeDiffFile("style.css", [".class { color: red; }"]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(0);
    expect(result.productionFilesChanged).toBe(0);
    expect(result.coverageRatio).toBe(1);
  });

  it("detects production file with no test file", () => {
    const diffFiles = [
      makeDiffFile("src/auth.ts", [
        "export function login(user: string) { return true; }",
      ]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toBe("no-test-file");
    expect(result.gaps[0].newSymbolsCount).toBe(1);
  });

  it("detects production file when test file exists but not changed", () => {
    // Create the test file in workspace
    const testDir = path.join(tmpDir, "src", "__tests__");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "auth.test.ts"), "test stuff");

    const diffFiles = [
      makeDiffFile("src/auth.ts", [
        "export function logout() { return false; }",
      ]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toBe("test-file-not-changed");
    expect(result.gaps[0].testFileExists).toBe(true);
  });

  it("marks covered when test file is also changed in PR", () => {
    const testDir = path.join(tmpDir, "src", "__tests__");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "auth.test.ts"), "test stuff");

    const diffFiles = [
      makeDiffFile("src/auth.ts", [
        "export function login(user: string) { return true; }",
      ]),
      makeDiffFile("src/__tests__/auth.test.ts", [
        "test('login works', () => {})",
      ]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(0);
    expect(result.coveredFiles).toBe(1);
  });

  it("skips test files from gap detection", () => {
    const diffFiles = [
      makeDiffFile("src/__tests__/auth.test.ts", ["test('x', () => {})"]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(0);
  });

  it("skips config files", () => {
    const diffFiles = [
      makeDiffFile("jest.config.ts", ["export default {}"]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(0);
  });

  it("skips type definition files", () => {
    const diffFiles = [
      makeDiffFile("src/types/global.d.ts", ["declare module 'foo' {}"]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(0);
  });

  it("skips files with no new symbols", () => {
    const diffFiles = [
      makeDiffFile("src/util.ts", [
        "// just a comment",
        "const x = 1;",
      ]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(0);
  });

  it("computes coverage ratio correctly", () => {
    const testDir = path.join(tmpDir, "src", "__tests__");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "covered.test.ts"), "test");

    const diffFiles = [
      makeDiffFile("src/covered.ts", [
        "export function fn1() {}",
      ]),
      makeDiffFile("src/__tests__/covered.test.ts", ["test fn1"]),
      makeDiffFile("src/uncovered.ts", [
        "export function fn2() {}",
      ]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(1);
    expect(result.coverageRatio).toBeGreaterThan(0);
    expect(result.coverageRatio).toBeLessThanOrEqual(1);
  });

  it("handles multiple production files", () => {
    const diffFiles = [
      makeDiffFile("src/a.ts", ["export function fa() {}"]),
      makeDiffFile("src/b.ts", ["export function fb() {}"]),
      makeDiffFile("src/c.ts", ["export function fc() {}"]),
    ];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.gaps).toHaveLength(3);
    expect(result.productionFilesChanged).toBe(3);
  });

  it("returns empty context text when no gaps", () => {
    const diffFiles = [makeDiffFile("README.md", ["hello"])];
    const result = runTestGapDetection(diffFiles, tmpDir);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildTestGapContext
// ---------------------------------------------------------------------------

describe("buildTestGapContext", () => {
  it("returns empty string for no gaps", () => {
    const result: TestGapResult = {
      gaps: [],
      productionFilesChanged: 0,
      coveredFiles: 0,
      coverageRatio: 1,
      contextText: "",
    };
    expect(buildTestGapContext(result)).toBe("");
  });

  it("includes Test Gap Detection header", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/auth.ts",
        expectedTestFile: "src/__tests__/auth.test.ts",
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: 2,
        reason: "no-test-file",
      }],
      productionFilesChanged: 1,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("Test Gap Detection");
  });

  it("includes source file paths", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/auth.ts",
        expectedTestFile: "src/__tests__/auth.test.ts",
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: 1,
        reason: "no-test-file",
      }],
      productionFilesChanged: 1,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("src/auth.ts");
  });

  it("indicates no test file exists", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/new.ts",
        expectedTestFile: "src/__tests__/new.test.ts",
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: 3,
        reason: "no-test-file",
      }],
      productionFilesChanged: 1,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("No test file found");
  });

  it("indicates test file not changed", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/old.ts",
        expectedTestFile: "src/__tests__/old.test.ts",
        testFileExists: true,
        testFileChanged: false,
        newSymbolsCount: 1,
        reason: "test-file-not-changed",
      }],
      productionFilesChanged: 1,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("NOT modified");
  });

  it("includes expected test file path", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/api.ts",
        expectedTestFile: "src/__tests__/api.test.ts",
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: 2,
        reason: "no-test-file",
      }],
      productionFilesChanged: 1,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("api.test.ts");
  });

  it("includes coverage ratio percentage", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/x.ts",
        expectedTestFile: "src/__tests__/x.test.ts",
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: 1,
        reason: "no-test-file",
      }],
      productionFilesChanged: 2,
      coveredFiles: 1,
      coverageRatio: 0.5,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("50%");
  });

  it("includes new symbol count", () => {
    const result: TestGapResult = {
      gaps: [{
        sourceFile: "src/large.ts",
        expectedTestFile: "src/__tests__/large.test.ts",
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: 5,
        reason: "no-test-file",
      }],
      productionFilesChanged: 1,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("5 new symbol(s)");
  });

  it("formats multiple gaps", () => {
    const result: TestGapResult = {
      gaps: [
        {
          sourceFile: "src/a.ts",
          expectedTestFile: "src/__tests__/a.test.ts",
          testFileExists: false,
          testFileChanged: false,
          newSymbolsCount: 1,
          reason: "no-test-file",
        },
        {
          sourceFile: "src/b.ts",
          expectedTestFile: "src/__tests__/b.test.ts",
          testFileExists: true,
          testFileChanged: false,
          newSymbolsCount: 2,
          reason: "test-file-not-changed",
        },
      ],
      productionFilesChanged: 2,
      coveredFiles: 0,
      coverageRatio: 0,
      contextText: "",
    };
    const ctx = buildTestGapContext(result);
    expect(ctx).toContain("src/a.ts");
    expect(ctx).toContain("src/b.ts");
  });
});
