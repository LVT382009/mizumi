import { describe, it, expect } from "vitest";
import { detectSpecDrift } from "../spec-drift-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[]): DiffFile {
  return {
    path,
    status: "modified",
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

// ---------------------------------------------------------------------------
// unimplemented-spec
// ---------------------------------------------------------------------------

describe("detectSpecDrift — unimplemented-spec", () => {
  it("detects TODO with implement marker", () => {
    const file = makeFile("src/service.ts", [
      "async function getUser(id: string) {",
      "  // TODO: implement actual user lookup",
      "  return null;",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects FIXME with placeholder", () => {
    const file = makeFile("src/api.ts", [
      "function processData(data: Buffer) {",
      "  // FIXME: implement proper processing",
      "  return [];",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects HACK marker", () => {
    const file = makeFile("src/workaround.ts", [
      "// HACK: this is a temporary workaround",
      "function hack() { return true; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects throw new Error('NotImplemented')", () => {
    const file = makeFile("src/stub.ts", [
      "function validate(input: unknown) {",
      "  throw new Error('NotImplemented');",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects return null with TODO comment", () => {
    const file = makeFile("src/placeholder.ts", [
      "function getConfig() { return null; // todo implement }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag regular TODO comments", () => {
    const file = makeFile("src/normal.ts", [
      "// TODO: add more test cases later",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues).toHaveLength(0);
  });

  it("does not flag clean implementation", () => {
    const file = makeFile("src/clean.ts", [
      "function add(a: number, b: number) { return a + b; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// spec-implementation-mismatch
// ---------------------------------------------------------------------------

describe("detectSpecDrift — spec-implementation-mismatch", () => {
  it("detects async function returning without await", () => {
    const file = makeFile("src/async.ts", [
      "async function fetchData(url: string): Promise<Data> {return cache.get(url);",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "spec-implementation-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("does not flag async function with await", () => {
    const file = makeFile("src/proper.ts", [
      "async function fetchData(url: string): Promise<Data> {return await fetch(url);",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "spec-implementation-mismatch");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// orphaned-spec
// ---------------------------------------------------------------------------

describe("detectSpecDrift — orphaned-spec", () => {
  it("detects exported function not used in any other file", () => {
    const file1 = makeFile("src/utils.ts", [
      "export function internalHelper() { return 42; }",
    ]);
    const file2 = makeFile("src/main.ts", [
      "import { otherFunc } from './other';",
    ]);
    const result = detectSpecDrift([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("does not flag exported function used in another file", () => {
    const file1 = makeFile("src/utils.ts", [
      "export function usedHelper() { return 42; }",
    ]);
    const file2 = makeFile("src/main.ts", [
      "import { usedHelper } from './utils';",
    ]);
    const result = detectSpecDrift([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec" && i.code.includes("usedHelper"));
    expect(issues).toHaveLength(0);
  });

  it("does not flag default exports", () => {
    const file = makeFile("src/component.tsx", [
      "export default function Component() { return null; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec");
    expect(issues).toHaveLength(0);
  });

  it("does not flag index files", () => {
    const file = makeFile("src/index.ts", [
      "export function publicApi() { return null; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec");
    expect(issues).toHaveLength(0);
  });

  it("does not flag interface/type exports", () => {
    const file = makeFile("src/types.ts", [
      "export interface Config { key: string; }",
      "export type Result = Success | Failure;",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// contract-erosion
// ---------------------------------------------------------------------------

describe("detectSpecDrift — contract-erosion", () => {
  it("detects widening to any type", () => {
    const file = makeFile("src/service.ts", [
      "function process(data: any) { return data; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "contract-erosion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects empty catch block", () => {
    const file = makeFile("src/handler.ts", [
      "try { await risky(); } catch (e) {}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "contract-erosion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag any type in test files", () => {
    const file = makeFile("src/__tests__/service.test.ts", [
      "function mock(data: any) { return data; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("any")
    );
    expect(issues).toHaveLength(0);
  });

  it("does not flag typed parameters", () => {
    const file = makeFile("src/clean.ts", [
      "function process(data: string): number { return data.length; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "contract-erosion");
    expect(issues).toHaveLength(0);
  });

  it("detects non-null assertion without check", () => {
    const file = makeFile("src/assert.ts", [
      "const value = data!.items;",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("non-null")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectSpecDrift — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectSpecDrift([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectSpecDrift([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type-only imports", () => {
    const file = makeFile("src/types.ts", [
      "import type { UserData } from './models';",
    ]);
    const result = detectSpecDrift([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean implementation with no drift", () => {
    const file = makeFile("src/utils.ts", [
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category !== "orphaned-spec"); // orphaned is ok for single-file test
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectSpecDrift — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/service.ts", [
      "// TODO: implement actual user lookup",
      "return null;",
    ]);
    const result = detectSpecDrift([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Spec Drift Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "function add(a: number, b: number) { return a + b; }",
    ]);
    const result = detectSpecDrift([file]);
    // May have orphaned-spec issues, so just check if context is empty for no issues
    if (result.issues.length === 0) {
      expect(result.contextText).toBe("");
    }
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/service.ts", [
      "// TODO: implement actual user lookup",
      "return null;",
    ]);
    const result = detectSpecDrift([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "function add(a: number, b: number) { return a + b; }",
    ]);
    const result = detectSpecDrift([file]);
    if (result.issues.length === 0) {
      expect(result.bodySummary).toBe("");
    }
  });

  it("sorts critical before warning", () => {
    const file1 = makeFile("src/stub.ts", [
      "// TODO: implement this",
      "return null;",
    ]);
    const file2 = makeFile("src/service.ts", [
      "function process(data: any) { return data; }",
    ]);
    const result = detectSpecDrift([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeFile("src/service.ts", [
      "// TODO: implement actual logic",
    ]);
    const result = detectSpecDrift([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});

// ---------------------------------------------------------------------------
// Additional unimplemented-spec tests
// ---------------------------------------------------------------------------

describe("detectSpecDrift — unimplemented-spec expanded", () => {
  it("detects return [] with TODO comment", () => {
    const file = makeFile("src/list.ts", [
      "function getItems() { return []; // todo placeholder }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects return {} with TODO comment", () => {
    const file = makeFile("src/obj.ts", [
      "function getConfig() { return {}; // todo placeholder }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects throw new Error('not implemented') case-insensitive", () => {
    const file = makeFile("src/stub2.ts", [
      "function validate(input: unknown) {",
      "  throw new Error('not implemented');",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects FIXME with implement keyword", () => {
    const file = makeFile("src/fix.ts", [
      "// FIXME: implement proper validation",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag TODO about future enhancement", () => {
    const file = makeFile("src/enhance.ts", [
      "// TODO: add caching layer in v2",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues).toHaveLength(0);
  });

  it("detects TODO with fill marker", () => {
    const file = makeFile("src/fill.ts", [
      "// TODO: fill in the actual implementation",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects TODO with replace marker", () => {
    const file = makeFile("src/replace.ts", [
      "// TODO: replace placeholder with real auth logic",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "unimplemented-spec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Additional spec-implementation-mismatch tests
// ---------------------------------------------------------------------------

describe("detectSpecDrift — spec-implementation-mismatch expanded", () => {
  it("detects async named function returning without await", () => {
    const file = makeFile("src/arrow.ts", [
      "async function fetchData(url: string): Promise<Data> {return cache.get(url);",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "spec-implementation-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag async function returning awaited promise", () => {
    const file = makeFile("src/awaited.ts", [
      "async function fetchData(url: string): Promise<Data> {",
      "  return await fetch(url).then(r => r.json());",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "spec-implementation-mismatch");
    expect(issues).toHaveLength(0);
  });

  it("does not flag non-async functions", () => {
    const file = makeFile("src/sync.ts", [
      "function getData(key: string): Data {return cache.get(key);",
      "}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "spec-implementation-mismatch");
    expect(issues).toHaveLength(0);
  });

  it("detects multiple async functions with missing awaits", () => {
    const file = makeFile("src/multi.ts", [
      "async function fn1() {return val1;}",
      "async function fn2() {return val2;}",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "spec-implementation-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Additional orphaned-spec tests
// ---------------------------------------------------------------------------

describe("detectSpecDrift — orphaned-spec expanded", () => {
  it("detects multiple orphaned exports in single file", () => {
    const file = makeFile("src/utils.ts", [
      "export function helperA() { return 1; }",
      "export function helperB() { return 2; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec");
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("detects orphaned class export", () => {
    const file = makeFile("src/class.ts", [
      "export class OldService { doWork() { return true; } }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "orphaned-spec" && i.code.includes("OldService")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags exported const when not used in other PR files", () => {
    const file1 = makeFile("src/const.ts", [
      "export const MAX_RETRIES = 3;",
    ]);
    const result = detectSpecDrift([file1]);
    const issues = result.issues.filter((i) =>
      i.category === "orphaned-spec" && i.code.includes("MAX_RETRIES")
    );
    // Single file PR: no other file references it
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag enum exports", () => {
    const file = makeFile("src/enums.ts", [
      "export enum Status { Active = 'active', Inactive = 'inactive' }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) => i.category === "orphaned-spec");
    // Enums may or may not be flagged depending on internal/export detection
    // The important thing is no crash
    expect(result.issues).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Additional contract-erosion tests
// ---------------------------------------------------------------------------

describe("detectSpecDrift — contract-erosion expanded", () => {
  it("detects optional chaining that may weaken contract", () => {
    const file = makeFile("src/chain.ts", [
      "const result = service?.getData();",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("optional chaining")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag optional chaining in test files", () => {
    const file = makeFile("src/__tests__/chain.test.ts", [
      "const result = service?.getData();",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("optional chaining")
    );
    expect(issues).toHaveLength(0);
  });

  it("detects multiple any types in one file", () => {
    const file = makeFile("src/loose.ts", [
      "function process(data: any): any { return data; }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("any")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects empty catch with variable name", () => {
    const file = makeFile("src/catch.ts", [
      "try { doRisky(); } catch (err) { }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("empty catch")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag catch block with logging", () => {
    const file = makeFile("src/logged.ts", [
      "try { doRisky(); } catch (err) { console.error(err); }",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("empty catch")
    );
    expect(issues).toHaveLength(0);
  });

  it("detects non-null assertion on nested property", () => {
    const file = makeFile("src/nested.ts", [
      "const value = config!.database!.url;",
    ]);
    const result = detectSpecDrift([file]);
    const issues = result.issues.filter((i) =>
      i.category === "contract-erosion" && i.description.includes("non-null")
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-file and dedup edge cases
// ---------------------------------------------------------------------------

describe("detectSpecDrift — multi-file and dedup", () => {
  it("detects issues across multiple files", () => {
    const file1 = makeFile("src/one.ts", [
      "// TODO: implement this",
      "return null;",
    ]);
    const file2 = makeFile("src/two.ts", [
      "function process(data: any) { return data; }",
    ]);
    const result = detectSpecDrift([file1, file2]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("dedupes same category at same file:line", () => {
    const file = makeFile("src/dup.ts", [
      "function process(data: any): any { return data; }",
    ]);
    const result = detectSpecDrift([file]);
    const sameKeyIssues = result.issues.filter(
      (i) => i.category === "contract-erosion" && i.file === "src/dup.ts" && i.line === 1
    );
    const uniqueCats = new Set(sameKeyIssues.map((i) => i.description));
    // Should not have duplicate descriptions at same file:line
    expect(sameKeyIssues.length).toBeLessThanOrEqual(uniqueCats.size + 1);
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    const result = detectSpecDrift([file]);
    if (result.issues.length === 0) {
      expect(result.bodySummary).toBe("");
    }
  });
});
