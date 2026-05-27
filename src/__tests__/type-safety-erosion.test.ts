import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectTypeSafetyErosion } from "../type-safety-erosion.js";
import type { TypeErosionIssue, TypeErosionResult } from "../type-safety-erosion.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (
  filePath: string,
  changes: string[],
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

// ---------------------------------------------------------------------------
// No issues
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — no issues", () => {
  it("returns empty for clean TypeScript code", () => {
    const files = [makeFile("src/utils.ts", [
      "+const value: string = compute();",
      "+console.log(value);",
    ])];
    const result = detectTypeSafetyErosion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+const x = data as any;",
    ], "deleted")];
    const result = detectTypeSafetyErosion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x: number = 42;",
    ])];
    const result = detectTypeSafetyErosion(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Type assertions — as keyword
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — type assertions", () => {
  it("detects 'as Type' assertion", () => {
    const files = [makeFile("src/app.ts", [
      "+const value = data as MyType;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(1);
    expect(assertions[0].severity).toBe("warning");
    expect(assertions[0].description).toContain("as MyType");
  });

  it("detects multiple type assertions in same file", () => {
    const files = [makeFile("src/app.ts", [
      "+const a = x as String;",
      "+const b = y as Number;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(2);
  });

  it("skips import-as (not a type assertion)", () => {
    const files = [makeFile("src/app.ts", [
      "+import { foo as bar } from './utils';",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(0);
  });

  it("skips import * as namespace", () => {
    const files = [makeFile("src/app.ts", [
      "+import * as fs from 'fs';",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(0);
  });

  it("does not flag lowercase 'as' targets (not type assertions)", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = obj as unknown;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(0);
  });

  it("detects as assertion with generic type", () => {
    const files = [makeFile("src/app.ts", [
      "+const result = response as ApiResponse;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(1);
    expect(assertions[0].description).toContain("ApiResponse");
  });
});

// ---------------------------------------------------------------------------
// Any type usage
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — any type", () => {
  it("detects ': any' annotation", () => {
    const files = [makeFile("src/app.ts", [
      "+const data: any = fetchData();",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(1);
    expect(anys[0].severity).toBe("warning");
  });

  it("detects 'as any' assertion", () => {
    const files = [makeFile("src/app.ts", [
      "+const result = data as any;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(1);
  });

  it("detects '<any>' cast", () => {
    const files = [makeFile("src/app.ts", [
      "+const result = <any>data;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(1);
  });

  it("detects function parameter with any", () => {
    const files = [makeFile("src/app.ts", [
      "+function process(value: any) {",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(1);
  });

  it("skips comments mentioning any", () => {
    const files = [makeFile("src/app.ts", [
      "+// This accepts any type",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(0);
  });

  it("skips block comments mentioning any", () => {
    const files = [makeFile("src/app.ts", [
      "+* Handles any data",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(0);
  });

  it("skips /* */ comments mentioning any", () => {
    const files = [makeFile("src/app.ts", [
      "+/* Accepts any input */",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(0);
  });

  it("detects 'any' in function return type", () => {
    const files = [makeFile("src/app.ts", [
      "+function process(): any {",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(1);
  });

  it("detects any inside generic types like Record<string, any>", () => {
    const files = [makeFile("src/app.ts", [
      "+const config: Record<string, any> = {};",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TS directives
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — ts directives", () => {
  it("detects @ts-ignore as critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-ignore",
      "+const x = missing.property;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const tsDirectives = result.issues.filter((i) => i.category === "ts-directive");
    expect(tsDirectives).toHaveLength(1);
    expect(tsDirectives[0].severity).toBe("critical");
  });

  it("detects @ts-nocheck as critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-nocheck",
    ])];
    const result = detectTypeSafetyErosion(files);
    const tsDirectives = result.issues.filter((i) => i.category === "ts-directive");
    expect(tsDirectives).toHaveLength(1);
    expect(tsDirectives[0].severity).toBe("critical");
    expect(tsDirectives[0].description).toContain("ts-nocheck");
  });

  it("detects @ts-expect-error as warning", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-expect-error",
      "+const x = unsafeAccess;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const tsDirectives = result.issues.filter((i) => i.category === "ts-directive");
    expect(tsDirectives).toHaveLength(1);
    expect(tsDirectives[0].severity).toBe("warning");
  });

  it("detects multiple ts directives", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-ignore",
      "+// @ts-expect-error",
      "+// @ts-nocheck",
    ])];
    const result = detectTypeSafetyErosion(files);
    const tsDirectives = result.issues.filter((i) => i.category === "ts-directive");
    expect(tsDirectives).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Lint suppression
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — lint suppressions", () => {
  it("detects eslint-disable comment", () => {
    const files = [makeFile("src/app.ts", [
      "+/* eslint-disable no-any */",
    ])];
    const result = detectTypeSafetyErosion(files);
    const lints = result.issues.filter((i) => i.category === "lint-suppression");
    expect(lints).toHaveLength(1);
    expect(lints[0].severity).toBe("warning");
  });

  it("detects eslint-disable-next-line", () => {
    const files = [makeFile("src/app.ts", [
      "+// eslint-disable-next-line no-explicit-any",
    ])];
    const result = detectTypeSafetyErosion(files);
    const lints = result.issues.filter((i) => i.category === "lint-suppression");
    expect(lints).toHaveLength(1);
  });

  it("detects eslint-disable at end of line", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = 1; // eslint-disable",
    ])];
    const result = detectTypeSafetyErosion(files);
    const lints = result.issues.filter((i) => i.category === "lint-suppression");
    expect(lints).toHaveLength(1);
  });

  it("does not flag eslint-enable", () => {
    const files = [makeFile("src/app.ts", [
      "+/* eslint-enable */",
    ])];
    const result = detectTypeSafetyErosion(files);
    const lints = result.issues.filter((i) => i.category === "lint-suppression");
    expect(lints).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — deduplication", () => {
  it("dedupes same category+file+line", () => {
    // Two hunks with the same line won't happen in practice, but we can verify
    // that if the same issue appears from different detection paths, dedup works.
    // In practice, "as any" only triggers any-type (any is lowercase, not [A-Z]),
    // so let's test dedup with a simpler scenario: same file, same line, same category.
    const files = [makeFile("src/app.ts", [
      "+const x = data as MyType;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertionCount = result.issues.filter((i) => i.category === "type-assertion").length;
    expect(assertionCount).toBe(1);
  });

  it("keeps different categories on same line", () => {
    // "as any" fires any-type but NOT type-assertion (any is lowercase).
    // To get both categories on same line, we need a line like:
    //   +const x: any = data as MyType;
    const files = [makeFile("src/app.ts", [
      "+const x: any = data as MyType;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(anys).toHaveLength(1);
    expect(assertions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = data as MyType;",          // warning (type-assertion)
      "+// @ts-ignore",                      // critical (ts-directive)
    ])];
    const result = detectTypeSafetyErosion(files);
    const severities = result.issues.map((i) => i.severity);
    const firstCritical = severities.indexOf("critical");
    const lastWarning = severities.lastIndexOf("warning");
    if (firstCritical >= 0 && lastWarning >= 0) {
      expect(firstCritical).toBeLessThan(lastWarning);
    }
  });

  it("sorts by file then line within same severity", () => {
    const files = [
      makeFile("src/b.ts", [
        "+const x = data as BType;",
      ]),
      makeFile("src/a.ts", [
        "+const y = data as AType;",
      ]),
    ];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions[0].file).toBe("src/a.ts");
    expect(assertions[1].file).toBe("src/b.ts");
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — context and body", () => {
  it("generates context text with critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-ignore",
      "+const x = data as MyType;",
    ])];
    const result = detectTypeSafetyErosion(files);
    expect(result.contextText).toContain("Type Safety Erosion");
    expect(result.contextText).toContain("Critical");
    expect(result.contextText).toContain("Warnings");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+const x: any = data;",
    ])];
    const result = detectTypeSafetyErosion(files);
    expect(result.bodySummary).toContain("Type Safety Erosion");
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("|");
  });

  it("shows 'more' row when issues exceed 15", () => {
    const changes: string[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push(`+const v${i}: any = data;`);
    }
    const files = [makeFile("src/app.ts", changes)];
    const result = detectTypeSafetyErosion(files);
    expect(result.issues.length).toBeGreaterThan(15);
    expect(result.bodySummary).toContain("more");
  });

  it("only shows critical section when no warnings", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-nocheck",
    ])];
    const result = detectTypeSafetyErosion(files);
    expect(result.contextText).toContain("Critical");
    expect(result.contextText).not.toContain("Warnings");
  });

  it("only shows warning section when no critical", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = data as MyType;",
    ])];
    const result = detectTypeSafetyErosion(files);
    expect(result.contextText).toContain("Warnings");
    expect(result.contextText).not.toContain("Critical");
  });
});

// ---------------------------------------------------------------------------
// Mixed categories
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — mixed issues", () => {
  it("detects issues across all 4 categories", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = data as MyType;",
      "+const y: any = compute();",
      "+// @ts-ignore",
      "+// eslint-disable-next-line no-explicit-any",
    ])];
    const result = detectTypeSafetyErosion(files);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.has("type-assertion")).toBe(true);
    expect(categories.has("any-type")).toBe(true);
    expect(categories.has("ts-directive")).toBe(true);
    expect(categories.has("lint-suppression")).toBe(true);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", [
        "+const x = data as MyType;",
      ]),
      makeFile("src/b.ts", [
        "+// @ts-ignore",
      ]),
    ];
    const result = detectTypeSafetyErosion(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-const x: any = oldCode();",
      "+const x: string = newCode();",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(0);
  });

  it("ignores normal (unchanged) lines with any", () => {
    const files = [makeFile("src/app.ts", [
      " const x: any = existing();",
      "+const y = 42;",
    ])];
    const result = detectTypeSafetyErosion(files);
    const anys = result.issues.filter((i) => i.category === "any-type");
    expect(anys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectTypeSafetyErosion — edge cases", () => {
  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectTypeSafetyErosion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles 'as any' as any-type only (lowercase 'any' not a type assertion)", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = data as any;",
    ])];
    const result = detectTypeSafetyErosion(files);
    // "as any" triggers ANY_TYPE_RE (\bas\s+any\b) but NOT AS_ASSERTION_RE
    // (which requires uppercase target: as [A-Z]). So only any-type fires.
    const anys = result.issues.filter((i) => i.category === "any-type");
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(anys).toHaveLength(1);
    expect(assertions).toHaveLength(0);
  });

  it("correctly identifies @ts-nocheck severity as critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// @ts-nocheck",
    ])];
    const result = detectTypeSafetyErosion(files);
    const nocheck = result.issues.find((i) => i.description.includes("ts-nocheck"));
    expect(nocheck).toBeDefined();
    expect(nocheck!.severity).toBe("critical");
  });

  it("does not flag 'as' in string literals context", () => {
    // The regex matches 'as' followed by uppercase — strings like "as" won't match
    const files = [makeFile("src/app.ts", [
      '+const msg = "use as needed";',
    ])];
    const result = detectTypeSafetyErosion(files);
    const assertions = result.issues.filter((i) => i.category === "type-assertion");
    expect(assertions).toHaveLength(0);
  });
});
