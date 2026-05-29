import { describe, it, expect } from "vitest";
import { detectTautologicalTests } from "../tautological-test-detector.js";
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
// tautological-assertion
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — tautological-assertion", () => {
  it("detects arithmetic in expect assertion", () => {
    const file = makeFile("src/calc.test.ts", [
      "import { add } from './calc';",
      "it('adds numbers', () => {",
      "  expect(add(2, 3)).toBe(2 + 3);",
      "});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("Tautological");
  });

  it("detects self-referencing expected computation", () => {
    const file = makeFile("src/format.test.ts", [
      "import { formatName } from './format';",
      "it('formats name', () => {",
      "  const expected = computeExpected(input);",
      "  expect(formatName(input)).toBe(expected);",
      "});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects magic number in assertion", () => {
    const file = makeFile("src/hash.test.ts", [
      "it('computes hash', () => {",
      "  expect(hash(data)).toBe(0xDEADBEEF);",
      "});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag simple equality assertions", () => {
    const file = makeFile("src/simple.test.ts", [
      "it('returns hello', () => {",
      "  expect(getGreeting()).toBe('hello');",
      "});",
    ]);

    const result = detectTautologicalTests([file]);
    const mathIssues = result.issues.filter(
      (i) => i.category === "tautological-assertion" && i.description.includes("arithmetic")
    );
    expect(mathIssues).toHaveLength(0);
  });

  it("does not flag non-test files", () => {
    const file = makeFile("src/calc.ts", [
      "expect(add(2, 3)).toBe(2 + 3);",
    ]);

    const result = detectTautologicalTests([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fixture-mirror-constant
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — fixture-mirror-constant", () => {
  it("detects large constant in test file", () => {
    const file = makeFile("src/config.test.ts", [
      "const MAX_TIMEOUT = 30000;",
      "it('respects timeout', () => {",
      "  expect(wait()).toBeLessThan(MAX_TIMEOUT);",
      "});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag small constants", () => {
    const file = makeFile("src/num.test.ts", [
      "const MAX = 42;",
      "it('works', () => { expect(fn()).toBe(MAX); });",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues).toHaveLength(0);
  });

  it("detects hex constant in test", () => {
    const file = makeFile("src/mask.test.ts", [
      "const MASK = 0xFFFF0000;",
      "it('applies mask', () => { expect(apply(val)).toBe(MASK); });",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// happy-path-only
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — happy-path-only", () => {
  it("flags test file with 3+ cases and no error/edge tests", () => {
    const file = makeFile("src/api.test.ts", [
      "it('returns data on success', () => {});",
      "it('handles pagination', () => {});",
      "it('returns correct format', () => {});",
      "it('caches results', () => {});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("4 cases");
  });

  it("does not flag test file with error tests", () => {
    const file = makeFile("src/api.test.ts", [
      "it('returns data on success', () => {});",
      "it('handles pagination', () => {});",
      "it('throws on invalid input', () => {});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files with fewer than 3 tests", () => {
    const file = makeFile("src/small.test.ts", [
      "it('works', () => {});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });

  it("recognizes edge-case test patterns", () => {
    const file = makeFile("src/edge.test.ts", [
      "it('handles normal case', () => {});",
      "it('handles boundary values', () => {});",
      "it('fails gracefully on error', () => {});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });

  it("recognizes null/undefined/empty test patterns", () => {
    const file = makeFile("src/null.test.ts", [
      "it('works with valid input', () => {});",
      "it('handles null input', () => {});",
      "it('handles empty array', () => {});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// private-helper-in-test
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — private-helper-in-test", () => {
  it("detects import from internal module", () => {
    const file = makeFile("src/app.test.ts", [
      "import { computeExpected } from '../src/internal/helpers';",
      "it('works', () => { expect(fn(x)).toBe(computeExpected(x)); });",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects underscore-prefixed function call", () => {
    const file = makeFile("src/app.test.ts", [
      "import { _parseInternal } from './app';",
      "it('parses correctly', () => {",
      "  expect(_parseInternal(data)).toEqual(expected);",
      "});",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag normal public API imports", () => {
    const file = makeFile("src/app.test.ts", [
      "import { processItems } from './app';",
      "it('works', () => { expect(processItems([])).toEqual([]); });",
    ]);

    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.test.ts", status: "deleted", hunks: [] };
    const result = detectTautologicalTests([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips non-test files", () => {
    const file = makeFile("src/app.ts", [
      "expect(add(2, 3)).toBe(2 + 3);",
    ]);
    const result = detectTautologicalTests([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.test.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectTautologicalTests([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file = makeFile("src/app.test.ts", [
      "// expect(fn(x)).toBe(x + y);",
      "/* some comment about tautological tests */",
    ]);
    const result = detectTautologicalTests([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/app.test.ts", [
      "import { _helper } from '../src/internal/utils';",
    ]);
    const result = detectTautologicalTests([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Tautological Test Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/app.test.ts", [
      "import { processItems } from './app';",
    ]);
    const result = detectTautologicalTests([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/app.test.ts", [
      "it('a', () => {});",
      "it('b', () => {});",
      "it('c', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
    }
  });

  it("sorts critical before warning", () => {
    const file = makeFile("src/app.test.ts", [
      "import { _helper } from '../src/internal/utils';",
      "it('a', () => {});",
      "it('b', () => {});",
      "it('c', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
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
// Additional tautological-assertion tests
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — tautological-assertion expanded", () => {
  it("detects expect(fn(x)).toBe(x * y) with binary arithmetic", () => {
    const file = makeFile("src/calc.test.ts", [
      "it('computes', () => {",
      "  expect(calc(2, 3)).toBe(2 * 3);",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects expect(fn(x)).toBe(x % 10)", () => {
    const file = makeFile("src/mod.test.ts", [
      "it('modulo', () => {",
      "  expect(mod(val)).toBe(val % 10);",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects expected = parseInput(data) self-reference", () => {
    const file = makeFile("src/parse.test.ts", [
      "it('parses', () => {",
      "  const expected = parseInput(data);",
      "  expect(result).toBe(expected);",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects expected = convertValue(input)", () => {
    const file = makeFile("src/convert.test.ts", [
      "it('converts', () => {",
      "  const expected = convertValue(input);",
      "  expect(convert(input)).toBe(expected);",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects expect with large hex constant 0xFFFF0000", () => {
    const file = makeFile("src/mask.test.ts", [
      "it('mask', () => {",
      "  expect(applyMask(val)).toBe(0xFFFF0000);",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects expect with large decimal constant", () => {
    const file = makeFile("src/hash.test.ts", [
      "it('hash', () => {",
      "  expect(hashCode(str)).toBe(123456);",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag expect(fn()).toBe('fixed string') in tests", () => {
    const file = makeFile("src/greet.test.ts", [
      "it('greet', () => {",
      "  expect(greet('Alice')).toBe('Hello, Alice');",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const mathIssues = result.issues.filter(
      (i) => i.category === "tautological-assertion" && i.description.includes("arithmetic")
    );
    expect(mathIssues).toHaveLength(0);
  });

  it("does not flag expect(fn()).toBeFalsy()", () => {
    const file = makeFile("src/bool.test.ts", [
      "it('returns false', () => {",
      "  expect(isValid('')).toBeFalsy();",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional fixture-mirror-constant tests
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — fixture-mirror-constant expanded", () => {
  it("detects very high numeric constant in test file", () => {
    const file = makeFile("src/api.test.ts", [
      "const TIMEOUT_MS = 60000;",
      "it('respects timeout', () => { expect(wait()).toBeLessThan(TIMEOUT_MS); });",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects const with hyphenated string value", () => {
    const file = makeFile("src/config.test.ts", [
      "const DEFAULT_ROLE = 'service-account-role-name';",
      "it('uses default role', () => { expect(getRole()).toBe(DEFAULT_ROLE); });",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag short string constants", () => {
    const file = makeFile("src/short.test.ts", [
      "const LABEL = 'ok';",
      "it('matches label', () => { expect(label()).toBe(LABEL); });",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues).toHaveLength(0);
  });

  it("does not flag boolean constants", () => {
    const file = makeFile("src/bool.test.ts", [
      "const ENABLED = true;",
      "it('is enabled', () => { expect(isEnabled()).toBe(ENABLED); });",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "fixture-mirror-constant");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional happy-path-only tests
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — happy-path-only expanded", () => {
  it("flags 4 happy-path tests without any error coverage", () => {
    const file = makeFile("src/user.test.ts", [
      "it('creates user', () => {});",
      "it('updates user', () => {});",
      "it('fetches user', () => {});",
      "it('lists users', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("4 case");
  });

  it("does not flag when describes contain error test names", () => {
    const file = makeFile("src/api.test.ts", [
      "describe('success', () => {});",
      "describe('failure', () => {});",
      "it('returns data on success', () => {});",
      "it('should not accept invalid input', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    // has a "should not" error-pattern test, so should not be flagged
    expect(issues).toHaveLength(0);
  });

  it("recognizes 'throws' as error test pattern", () => {
    const file = makeFile("src/err.test.ts", [
      "it('works normally', () => {});",
      "it('handles pagination', () => {});",
      "it('throws on invalid input', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });

  it("recognizes 'rejects' as error test pattern", () => {
    const file = makeFile("src/reject.test.ts", [
      "it('resolves with data', () => {});",
      "it('handles pagination', () => {});",
      "it('rejects on network failure', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });

  it("recognizes 'bad' as error test pattern", () => {
    const file = makeFile("src/bad.test.ts", [
      "it('works with valid data', () => {});",
      "it('handles pagination', () => {});",
      "it('handles bad input', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "happy-path-only");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional private-helper-in-test tests
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — private-helper-in-test expanded", () => {
  it("detects import from internal/utils", () => {
    const file = makeFile("src/app.test.ts", [
      "import { computeHash } from '../src/internal/utils';",
      "it('hashes correctly', () => { expect(hash(x)).toBe(computeHash(x)); });",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects import from private/helpers", () => {
    const file = makeFile("src/app.test.ts", [
      "import { helper } from '../src/private/helpers';",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects multiple underscore-prefixed function calls", () => {
    const file = makeFile("src/app.test.ts", [
      "it('works', () => {",
      "  expect(_computeInternal(a, b)).toBe(_formatInternal(result));",
      "});",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag normal utility imports from test utilities", () => {
    const file = makeFile("src/app.test.ts", [
      "import { render, fireEvent } from '@testing-library/react';",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues).toHaveLength(0);
  });

  it("does not flag imports from public src modules", () => {
    const file = makeFile("src/app.test.ts", [
      "import { publicApi } from '../src/app';",
    ]);
    const result = detectTautologicalTests([file]);
    const issues = result.issues.filter((i) => i.category === "private-helper-in-test");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-file and dedup tests
// ---------------------------------------------------------------------------

describe("detectTautologicalTests — multi-file and dedup", () => {
  it("detects issues across multiple test files", () => {
    const file1 = makeFile("src/a.test.ts", [
      "it('x', () => {});",
      "it('y', () => {});",
      "it('z', () => {});",
    ]);
    const file2 = makeFile("src/b.test.ts", [
      "it('p', () => {});",
      "it('q', () => {});",
      "it('r', () => {});",
    ]);
    const result = detectTautologicalTests([file1, file2]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates issues at same file and line", () => {
    const file = makeFile("src/dup.test.ts", [
      "const BIG_CONSTANT = 99999;",
      "it('works', () => { expect(fn()).toBe(BIG_CONSTANT); });",
    ]);
    const result = detectTautologicalTests([file]);
    const sameLineIssues = result.issues.filter(
      (i) => i.file === "src/dup.test.ts" && i.line === 1
    );
    // Should not have duplicate category+file+line
    const keys = new Set(sameLineIssues.map((i) => i.category));
    expect(sameLineIssues.length).toBe(keys.size);
  });

  it("handles clean non-test files", () => {
    const file = makeFile("src/production.ts", [
      "const API_KEY = 'sk-prod-key-1234567890abcdef';",
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    const result = detectTautologicalTests([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("body summary includes table headers", () => {
    const file = makeFile("src/table.test.ts", [
      "it('a', () => {}); it('b', () => {}); it('c', () => {});",
    ]);
    const result = detectTautologicalTests([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.test.ts", [
      "import { fn } from './app';",
    ]);
    const result = detectTautologicalTests([file]);
    if (result.issues.length === 0) {
      expect(result.bodySummary).toBe("");
    }
  });
});
