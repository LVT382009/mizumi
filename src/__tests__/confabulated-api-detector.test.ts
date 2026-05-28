import { describe, it, expect } from "vitest";
import { detectConfabulatedAPI } from "../confabulated-api-detector.js";
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
// non-existent-method
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — non-existent-method", () => {
  it("detects .contains() which doesn't exist on JS strings", () => {
    const file = makeFile("src/utils.ts", [
      "const hasWord = text.contains('hello');",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("includes()");
  });

  it("detects .add() which doesn't exist on JS arrays", () => {
    const file = makeFile("src/list.ts", [
      "items.add(newItem);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("push()");
  });

  it("detects .abs() on number (should be Math.abs)", () => {
    const file = makeFile("src/calc.ts", [
      "const magnitude = val.abs();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("Math.abs()");
  });

  it("does not flag .includes() which is valid", () => {
    const file = makeFile("src/utils.ts", [
      "const hasWord = text.includes('hello');",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues).toHaveLength(0);
  });

  it("caps at 5 issues to avoid noise", () => {
    const file = makeFile("src/mess.ts", [
      "items.add(1);",
      "items.add(2);",
      "items.add(3);",
      "items.add(4);",
      "items.add(5);",
      "items.add(6);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// wrong-arity
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — wrong-arity", () => {
  it("detects parseInt called with 0 arguments", () => {
    const file = makeFile("src/parse.ts", [
      "const num = parseInt();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "wrong-arity");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("parseInt");
  });

  it("detects Math.abs called with 2 arguments", () => {
    const file = makeFile("src/math.ts", [
      "const result = Math.abs(x, y);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "wrong-arity");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag correct arity calls", () => {
    const file = makeFile("src/ok.ts", [
      "const num = parseInt(str, 10);",
      "const abs = Math.abs(x);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "wrong-arity");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fantasy-optional-chain
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — fantasy-optional-chain", () => {
  it("detects optional chaining on numeric literal", () => {
    const file = makeFile("src/bad.ts", [
      "const len = 42?.toString();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "fantasy-optional-chain");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects optional chaining on string literal", () => {
    const file = makeFile("src/bad.ts", [
      "const upper = 'hello'?.toUpperCase();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "fantasy-optional-chain");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag optional chaining on variables", () => {
    const file = makeFile("src/ok.ts", [
      "const name = user?.name;",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "fantasy-optional-chain");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// confabulated-import
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — confabulated-import", () => {
  it("detects readFile imported from node:http", () => {
    const file = makeFile("src/server.ts", [
      "import { readFile } from 'node:http';",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "confabulated-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("readFile");
    expect(issues[0].severity).toBe("critical");
  });

  it("detects fetch imported from node:fs", () => {
    const file = makeFile("src/fetch.ts", [
      "import { fetch } from 'node:fs';",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "confabulated-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag valid imports from node:http", () => {
    const file = makeFile("src/server.ts", [
      "import { createServer } from 'node:http';",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "confabulated-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag valid imports from node:fs", () => {
    const file = makeFile("src/files.ts", [
      "import { readFile } from 'node:fs';",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "confabulated-import");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectConfabulatedAPI([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectConfabulatedAPI([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file = makeFile("src/a.ts", [
      "// items.add(newItem);",
      "/* val.abs() */",
    ]);
    const result = detectConfabulatedAPI([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type-only imports", () => {
    const file = makeFile("src/types.ts", [
      "import type { readFile } from 'node:http';",
    ]);
    const result = detectConfabulatedAPI([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/bad.ts", [
      "const has = text.contains('x');",
    ]);
    const result = detectConfabulatedAPI([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Confabulated API Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectConfabulatedAPI([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/bad.ts", [
      "const has = text.contains('x');",
    ]);
    const result = detectConfabulatedAPI([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("sorts critical before warning", () => {
    const file1 = makeFile("src/bad.ts", [
      "import { readFile } from 'node:http';",
    ]);
    const file2 = makeFile("src/bad2.ts", [
      "const has = text.contains('x');",
    ]);
    const result = detectConfabulatedAPI([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });
});

// ---------------------------------------------------------------------------
// Additional coverage
// ---------------------------------------------------------------------------

describe("detectConfabulatedAPI — additional coverage", () => {
  it("detects .isEmpty() which doesn't exist on JS strings", () => {
    const file = makeFile("src/check.ts", [
      "if (name.isEmpty()) { return; }",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain(".length === 0");
  });

  it("detects .flatten() which doesn't exist on JS arrays", () => {
    const file = makeFile("src/array.ts", [
      "const flat = nested.flatten();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain(".flat()");
  });

  it("detects .collect() which is Ruby for .map()", () => {
    const file = makeFile("src/ruby.ts", [
      "const results = items.collect(x => x * 2);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain(".map()");
  });

  it("detects .size() with parens which is Java style", () => {
    const file = makeFile("src/java.ts", [
      "const len = items.size();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects .ceil() on number (should be Math.ceil)", () => {
    const file = makeFile("src/round.ts", [
      "const rounded = value.ceil();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("Math.ceil()");
  });

  it("detects Object.keys with no arguments", () => {
    const file = makeFile("src/obj.ts", [
      "const keys = Object.keys();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "wrong-arity");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("Object.keys");
  });

  it("detects Math.pow called with 1 argument", () => {
    const file = makeFile("src/math.ts", [
      "const result = Math.pow(base);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "wrong-arity");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag Math.max with spread args (variadic)", () => {
    const file = makeFile("src/math.ts", [
      "const max = Math.max(...values);",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "wrong-arity");
    expect(issues).toHaveLength(0);
  });

  it("detects optional chaining on boolean literal", () => {
    const file = makeFile("src/bool.ts", [
      "const str = true?.toString();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "fantasy-optional-chain");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects optional chaining on null literal", () => {
    const file = makeFile("src/null.ts", [
      "const val = null?.valueOf();",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "fantasy-optional-chain");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fetch imported from 'fs' module", () => {
    const file = makeFile("src/fs-fetch.ts", [
      "import { fetch } from 'fs';",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "confabulated-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("does not flag valid node:crypto import", () => {
    const file = makeFile("src/crypto.ts", [
      "import { createHash } from 'node:crypto';",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "confabulated-import");
    expect(issues).toHaveLength(0);
  });

  it("body summary includes table when issues exist", () => {
    const file = makeFile("src/bad.ts", [
      "const has = text.contains('x');",
    ]);
    const result = detectConfabulatedAPI([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
      expect(result.bodySummary).toContain("|----------|");
    }
  });

  it("handles .hasKey() which is Java Map style", () => {
    const file = makeFile("src/map.ts", [
      "if (obj.hasKey('name')) { return obj.name; }",
    ]);

    const result = detectConfabulatedAPI([file]);
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain(".has()");
  });

  it("does not flag method definitions (only calls)", () => {
    const file = makeFile("src/def.ts", [
      "export function contains(str: string) { return str.includes(this); }",
    ]);

    const result = detectConfabulatedAPI([file]);
    // The .includes() is valid JS; the function name "contains" is just a definition, not a call
    const issues = result.issues.filter((i) => i.category === "non-existent-method");
    expect(issues).toHaveLength(0);
  });
});
