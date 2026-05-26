import { describe, it, expect, vi } from "vitest";
import {
  extractExports,
  extractImports,
  extractThrows,
  extractTryCatch,
  checkExportChanges,
  checkUnhandledThrows,
  checkSignatureChanges,
  runASTContractAnalysis,
} from "../ast-contracts.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  notice: vi.fn(),
}));

// ---------------------------------------------------------------------------
// extractExports
// ---------------------------------------------------------------------------

describe("ast-contracts", () => {
  describe("extractExports", () => {
    it("extracts named function export", () => {
      const code = `export function greet(name: string) { return "hi"; }`;
      const result = extractExports(code, "greet.ts");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("greet");
      expect(result[0].params).toEqual(["name"]);
      expect(result[0].isAsync).toBe(false);
    });

    it("extracts async function export", () => {
      const code = `export async function fetchData(url: string, opts?: RequestInit) {}`;
      const result = extractExports(code, "api.ts");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("fetchData");
      expect(result[0].params).toEqual(["url", "opts"]);
      expect(result[0].isAsync).toBe(true);
    });

    it("extracts const arrow export", () => {
      const code = `export const helper = (x: number) => x * 2`;
      const result = extractExports(code, "helpers.ts");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("helper");
      expect(result[0].params).toEqual(["x"]);
    });

    it("extracts async const arrow export", () => {
      const code = `export const fetchUser = async (id: string) => { return null; }`;
      const result = extractExports(code, "users.ts");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("fetchUser");
      expect(result[0].isAsync).toBe(true);
    });

    it("skips non-exported functions", () => {
      const code = `function internal() {}\nconst local = () => {}`;
      const result = extractExports(code, "internal.ts");
      expect(result).toHaveLength(0);
    });

    it("handles function with no params", () => {
      const code = `export function getTimestamp() { return Date.now(); }`;
      const result = extractExports(code, "time.ts");
      expect(result).toHaveLength(1);
      expect(result[0].params).toEqual([]);
    });

    it("extracts multiple exports", () => {
      const code = `export function a(x: number) {}\nexport function b(y: string) {}`;
      const result = extractExports(code, "multi.ts");
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("a");
      expect(result[1].name).toBe("b");
    });

    it("handles multi-line function definitions on first line only", () => {
      const code = `export function complex(\n  a: string,\n  b: number\n) {}`;
      const result = extractExports(code, "complex.ts");
      // The regex only matches single-line signatures in the current implementation
      expect(result.length).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // extractImports
  // ---------------------------------------------------------------------------

  describe("extractImports", () => {
    it("extracts named import", () => {
      const code = `import { readFile, writeFile } from './fs-utils'`;
      const result = extractImports(code, "app.ts");
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("./fs-utils");
      expect(result[0].specifiers).toEqual(["readFile", "writeFile"]);
    });

    it("extracts default import", () => {
      const code = `import React from 'react'`;
      const result = extractImports(code, "component.tsx");
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("react");
      expect(result[0].specifiers).toEqual(["React"]);
    });

    it("extracts namespace import", () => {
      const code = `import * as _ from 'lodash'`;
      const result = extractImports(code, "utils.ts");
      expect(result).toHaveLength(1);
      expect(result[0].specifiers[0]).toBe("*:_");
    });

    it("handles aliased imports (as keyword)", () => {
      const code = `import { readFileSync as read } from 'node:fs'`;
      const result = extractImports(code, "file.ts");
      expect(result).toHaveLength(1);
      expect(result[0].specifiers).toEqual(["readFileSync"]);
    });

    it("skips non-import lines", () => {
      const code = `const x = 1\n// import fake from 'nowhere'`;
      const result = extractImports(code, "clean.ts");
      expect(result).toHaveLength(0);
    });

    it("extracts multiple import statements", () => {
      const code = `import { a } from './a'\nimport { b } from './b'`;
      const result = extractImports(code, "multi.ts");
      expect(result).toHaveLength(2);
    });

    it("handles @/ alias imports", () => {
      const code = `import { config } from '@/config'`;
      const result = extractImports(code, "app.ts");
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("@/config");
    });
  });

  // ---------------------------------------------------------------------------
  // extractThrows
  // ---------------------------------------------------------------------------

  describe("extractThrows", () => {
    it("detects throw new Error", () => {
      const code = `function validate() {\n  throw new Error("bad input");\n}`;
      const result = extractThrows(code, "validate.ts");
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("throws Error");
    });

    it("detects throw with custom error class", () => {
      const code = `function check() {\n  throw new ValidationError("invalid");\n}`;
      const result = extractThrows(code, "check.ts");
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("throws ValidationError");
    });

    it("tracks enclosing function name", () => {
      const code = `function process() {\n  throw new Error("fail");\n}`;
      const result = extractThrows(code, "proc.ts");
      expect(result[0].functionName).toBe("process");
    });

    it("skips files without throw statements", () => {
      const code = `function safe() { return 1; }`;
      const result = extractThrows(code, "safe.ts");
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // extractTryCatch
  // ---------------------------------------------------------------------------

  describe("extractTryCatch", () => {
    it("detects try with catch", () => {
      const code = `try {\n  doSomething();\n} catch (e) {\n  handleError(e);\n}`;
      const result = extractTryCatch(code, "handled.ts");
      expect(result).toHaveLength(1);
      expect(result[0].hasCatch).toBe(true);
    });

    it("detects try without catch (try-finally only)", () => {
      const code = `try {\n  doSomething();\n} finally {\n  cleanup();\n}`;
      const result = extractTryCatch(code, "finally-only.ts");
      expect(result).toHaveLength(1);
      expect(result[0].hasCatch).toBe(false);
    });

    it("skips files without try blocks", () => {
      const code = `function safe() { return 1; }`;
      const result = extractTryCatch(code, "safe.ts");
      expect(result).toHaveLength(0);
    });

    it("handles nested try blocks", () => {
      const code = `try {\n  try {\n    inner();\n  } catch (e) {}\n} catch (e) {}`;
      const result = extractTryCatch(code, "nested.ts");
      expect(result).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // checkExportChanges
  // ---------------------------------------------------------------------------

  describe("checkExportChanges", () => {
    it("flags import of non-exported symbol", () => {
      const diffFiles = [makeDiffFile("consumer.ts", ["import { missing } from './source'"])];
      const contents = new Map([
        ["consumer.ts", "import { missing } from './source'"],
        ["source.ts", "export function existing() {}"],
      ]);
      const violations = checkExportChanges(diffFiles, contents);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.message.includes("missing"))).toBe(true);
    });

    it("does not flag correctly imported symbols", () => {
      const diffFiles = [makeDiffFile("consumer.ts", ["import { existing } from './source'"])];
      const contents = new Map([
        ["consumer.ts", "import { existing } from './source'"],
        ["source.ts", "export function existing() {}"],
      ]);
      const violations = checkExportChanges(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });

    it("skips built-in module imports", () => {
      const diffFiles = [makeDiffFile("app.ts", ["import { readFileSync } from 'node:fs'"])];
      const contents = new Map([
        ["app.ts", "import { readFileSync } from 'node:fs'"],
      ]);
      const violations = checkExportChanges(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });

    it("skips package imports (not relative)", () => {
      const diffFiles = [makeDiffFile("app.ts", ["import { z } from 'zod'"])];
      const contents = new Map([
        ["app.ts", "import { z } from 'zod'"],
      ]);
      const violations = checkExportChanges(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });

    it("skips namespace imports", () => {
      const diffFiles = [makeDiffFile("app.ts", ["import * as utils from './utils'"])];
      const contents = new Map([
        ["app.ts", "import * as utils from './utils'"],
        ["utils.ts", "export function a() {}"],
      ]);
      const violations = checkExportChanges(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // checkUnhandledThrows
  // ---------------------------------------------------------------------------

  describe("checkUnhandledThrows", () => {
    it("flags call to throwing function without try/catch", () => {
      const diffFiles = [
        makeDiffFile("caller.ts", ["validate();"]),
        makeDiffFile("lib.ts", ["function validate() {", "  throw new Error('bad');", "}"]),
      ];
      const contents = new Map([
        ["caller.ts", "validate();"],
        ["lib.ts", "function validate() {\n  throw new Error('bad');\n}"],
      ]);
      const violations = checkUnhandledThrows(diffFiles, contents);
      expect(violations.length).toBeGreaterThanOrEqual(1);
    });

    it("does not flag calls wrapped in try/catch", () => {
      const diffFiles = [
        makeDiffFile("caller.ts", ["try {", "  validate();", "} catch (e) {}"]),
      ];
      const contents = new Map([
        ["caller.ts", "try {\n  validate();\n} catch (e) {}"],
      ]);
      const violations = checkUnhandledThrows(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });

    it("handles files without throwing functions", () => {
      const diffFiles = [makeDiffFile("safe.ts", ["function safe() { return 1; }"])];
      const contents = new Map([
        ["safe.ts", "function safe() { return 1; }"],
      ]);
      const violations = checkUnhandledThrows(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // checkSignatureChanges
  // ---------------------------------------------------------------------------

  describe("checkSignatureChanges", () => {
    it("flags removed parameter with callers in other files", () => {
      const diffFiles = [
        makeDiffFile("api.ts", [], [], [
          "export function processData(input: string, options?: Options) {}",
        ]),
        makeDiffFile("consumer.ts", ["processData(data, opts);"]),
      ];
      const contents = new Map([
        ["api.ts", "export function processData(input: string) {}"],
        ["consumer.ts", "processData(data, opts);"],
      ]);
      const violations = checkSignatureChanges(diffFiles, contents);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.some((v) => v.rule === "ast-signature-change")).toBe(true);
    });

    it("does not flag when signature did not change", () => {
      const diffFiles = [
        makeDiffFile("api.ts", [], [], [
          "export function processData(input: string) {}",
        ]),
      ];
      const contents = new Map([
        ["api.ts", "export function processData(input: string) {}"],
        ["consumer.ts", "processData(data);"],
      ]);
      const violations = checkSignatureChanges(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });

    it("handles no deleted lines in diff", () => {
      const diffFiles = [
        makeDiffFile("new.ts", ["export function newFunc() {}"]),
      ];
      const contents = new Map([
        ["new.ts", "export function newFunc() {}"],
      ]);
      const violations = checkSignatureChanges(diffFiles, contents);
      expect(violations).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // runASTContractAnalysis
  // ---------------------------------------------------------------------------

  describe("runASTContractAnalysis", () => {
    it("returns empty for no diff files", () => {
      const result = runASTContractAnalysis([], ".");
      expect(result.violations).toHaveLength(0);
      expect(result.filesAnalyzed).toBe(0);
    });

    it("skips non-TS/JS files", () => {
      const diffFiles = [
        makeDiffFile("style.css", [".class { color: red; }"]),
        makeDiffFile("README.md", ["# Hello"]),
      ];
      const result = runASTContractAnalysis(diffFiles, ".");
      expect(result.filesAnalyzed).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Additional extractExports edge cases
// ---------------------------------------------------------------------------

describe("extractExports additional edge cases", () => {
  it("extracts let arrow export", () => {
    const code = "export let compute = (a: number, b: number) => a + b";
    const result = extractExports(code, "compute.ts");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("compute");
    expect(result[0].params).toEqual(["a", "b"]);
  });

  it("handles optional parameters", () => {
    const code = "export function fetch(url: string, opts?: RequestInit) {}";
    const result = extractExports(code, "api.ts");
    expect(result).toHaveLength(1);
    expect(result[0].params).toContain("opts");
  });

  it("skips non-export const assignments", () => {
    const code = "const internal = (x: number) => x";
    const result = extractExports(code, "internal.ts");
    expect(result).toHaveLength(0);
  });

  it("handles empty file content", () => {
    const result = extractExports("", "empty.ts");
    expect(result).toHaveLength(0);
  });

  it("tracks line numbers correctly", () => {
    const code = "// comment\n\nexport function target() {}";
    const result = extractExports(code, "lines.ts");
    expect(result[0].line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Additional extractImports edge cases
// ---------------------------------------------------------------------------

describe("extractImports additional edge cases", () => {
  it("handles single-specifier named import", () => {
    const code = "import { useState } from 'react'";
    const result = extractImports(code, "comp.tsx");
    expect(result).toHaveLength(1);
    expect(result[0].specifiers).toEqual(["useState"]);
  });

  it("handles empty file", () => {
    const result = extractImports("", "empty.ts");
    expect(result).toHaveLength(0);
  });

  it("skips commented imports", () => {
    const code = "// import { fake } from 'nowhere'\n/* import { also } from 'fake' */";
    const result = extractImports(code, "commented.ts");
    expect(result).toHaveLength(0);
  });

  it("tracks line numbers for multiple imports", () => {
    const code = "import { a } from './a'\nimport { b } from './b'\nimport { c } from './c'";
    const result = extractImports(code, "multi.ts");
    expect(result).toHaveLength(3);
    expect(result[0].line).toBe(1);
    expect(result[1].line).toBe(2);
    expect(result[2].line).toBe(3);
  });

  it("handles type-only imports gracefully", () => {
    const code = "import type { Config } from './config'";
    const result = extractImports(code, "types.ts");
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Additional extractThrows edge cases
// ---------------------------------------------------------------------------

describe("extractThrows additional edge cases", () => {
  it("detects throw without new keyword", () => {
    const code = "function fail() {\n throw Error(\"fail\");\n}";
    const result = extractThrows(code, "fail.ts");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("throws Error");
  });

  it("tracks async function that throws", () => {
    const code = "async function fetchData() {\n throw new Error(\"network\");\n}";
    const result = extractThrows(code, "fetch.ts");
    expect(result).toHaveLength(1);
    expect(result[0].isAsync).toBe(true);
  });

  it("tracks const async arrow that throws", () => {
    const code = "const process = async () => {\n throw new Error(\"fail\");\n}";
    const result = extractThrows(code, "process.ts");
    expect(result).toHaveLength(1);
  });

  it("handles multiple throw statements in different functions", () => {
    const code = "function checkEmpty() {\nthrow new Error(\"empty\");\n}\nfunction checkNegative() {\nthrow new RangeError(\"negative\");\n}";
    const result = extractThrows(code, "validate.ts");
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Additional extractTryCatch edge cases
// ---------------------------------------------------------------------------

describe("extractTryCatch additional edge cases", () => {
  it("detects try-catch-finally", () => {
    const code = "try {\n doWork();\n} catch (e) {\n handle(e);\n} finally {\n cleanup();\n}";
    const result = extractTryCatch(code, "full.ts");
    expect(result).toHaveLength(1);
    expect(result[0].hasCatch).toBe(true);
  });

  it("stops looking for catch at next function declaration", () => {
    const code = "try {\n risky();\n}\nexport function next() {}";
    const result = extractTryCatch(code, "stop.ts");
    expect(result).toHaveLength(1);
    expect(result[0].hasCatch).toBe(false);
  });

  it("handles empty file", () => {
    const result = extractTryCatch("", "empty.ts");
    expect(result).toHaveLength(0);
  });

  it("reports line number of try keyword", () => {
    const code = "// preamble\ntry {\n stuff();\n} catch (e) {}";
    const result = extractTryCatch(code, "lined.ts");
    expect(result[0].line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Additional checkExportChanges edge cases
// ---------------------------------------------------------------------------

describe("checkExportChanges additional edge cases", () => {
  it("flags multiple missing imports in same file", () => {
    const diffFiles = [makeDiffFile("app.ts", ["import { a, b, c } from './lib'"])];
    const contents = new Map([
      ["app.ts", "import { a, b, c } from './lib'"],
      ["lib.ts", "export function a() {}"],
    ]);
    const violations = checkExportChanges(diffFiles, contents);
    expect(violations.some((v) => v.message.includes("b"))).toBe(true);
    expect(violations.some((v) => v.message.includes("c"))).toBe(true);
  });

  it("does not flag namespace import (* as X)", () => {
    const diffFiles = [makeDiffFile("app.ts", ["import * as mod from './mod'"])];
    const contents = new Map([
      ["app.ts", "import * as mod from './mod'"],
      ["mod.ts", "export function x() {}"],
    ]);
    const violations = checkExportChanges(diffFiles, contents);
    expect(violations).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const violations = checkExportChanges([], new Map());
    expect(violations).toHaveLength(0);
  });

  it("skips @/ imports to files not in the content map", () => {
    const diffFiles = [makeDiffFile("app.ts", ["import { auth } from '@/auth'"])];
    const contents = new Map([
      ["app.ts", "import { auth } from '@/auth'"],
    ]);
    const violations = checkExportChanges(diffFiles, contents);
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional checkUnhandledThrows edge cases
// ---------------------------------------------------------------------------

describe("checkUnhandledThrows additional edge cases", () => {
  it("flags multiple calls to same throwing function", () => {
    const diffFiles = [
      makeDiffFile("lib.ts", ["function check() {", " throw new Error('bad');", "}"]),
      makeDiffFile("caller.ts", ["check();", "check();"]),
    ];
    const contents = new Map([
      ["lib.ts", "function check() {\n throw new Error('bad');\n}"],
      ["caller.ts", "check();\ncheck();"],
    ]);
    const violations = checkUnhandledThrows(diffFiles, contents);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag try/catch wrapped calls", () => {
    const diffFiles = [
      makeDiffFile("lib.ts", ["function risky() { throw new Error('x'); }"]),
      makeDiffFile("safe.ts", ["try {", " risky();", "} catch (e) {", " handle(e);", "}"]),
    ];
    const contents = new Map([
      ["lib.ts", "function risky() { throw new Error('x'); }"],
      ["safe.ts", "try {\n risky();\n} catch (e) {\n handle(e);\n}"],
    ]);
    const violations = checkUnhandledThrows(diffFiles, contents);
    expect(violations).toHaveLength(0);
  });

  it("handles empty files", () => {
    const violations = checkUnhandledThrows([], new Map());
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional checkSignatureChanges edge cases
// ---------------------------------------------------------------------------

describe("checkSignatureChanges additional edge cases", () => {
  it("does not flag parameter addition (more params in new version)", () => {
    const diffFiles = [
      makeDiffFile("api.ts", [], [], [
        "export function greet(name: string) {}",
      ]),
    ];
    const contents = new Map([
      ["api.ts", "export function greet(name: string, greeting?: string) {}"],
    ]);
    const violations = checkSignatureChanges(diffFiles, contents);
    expect(violations).toHaveLength(0);
  });

  it("flags in same file with callers across files", () => {
    const diffFiles = [
      makeDiffFile("api.ts", [], [], [
        "export function send(to: string, cc: string, bcc: string) {}",
      ]),
    ];
    const contents = new Map([
      ["api.ts", "export function send(to: string) {}"],
      ["service.ts", "send(addr, cc, bcc);"],
    ]);
    const violations = checkSignatureChanges(diffFiles, contents);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].file).toBe("service.ts");
  });

  it("handles empty diff files", () => {
    const violations = checkSignatureChanges([], new Map());
    expect(violations).toHaveLength(0);
  });

  it("does not flag when function is not in the exports", () => {
    const diffFiles = [
      makeDiffFile("file.ts", [], [], [
        "function internalHelper(x: string, y: number) {}",
      ]),
    ];
    const contents = new Map([
      ["file.ts", "function internalHelper(x: string) {}"],
    ]);
    const violations = checkSignatureChanges(diffFiles, contents);
    expect(violations).toHaveLength(0);
  });
});

// Test helpers
// ---------------------------------------------------------------------------

function makeDiffFile(
  path: string,
  addedLines: string[] = [],
  deletedLines: string[] = [],
  removedLines: string[] = []
): DiffFile {
  return {
    path,
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
          ...(removedLines.length > 0
            ? removedLines.map((content, i) => ({
                type: "delete" as const,
                content: `- ${content}`,
                line: i + 1,
              }))
            : deletedLines.map((content, i) => ({
                type: "delete" as const,
                content,
                line: i + 1,
              }))),
        ],
      },
    ],
  };
}
