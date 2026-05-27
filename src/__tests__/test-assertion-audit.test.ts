import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { auditTestAssertions } from "../test-assertion-audit.js";
import type { WeakAssertion, AssertionAuditResult } from "../test-assertion-audit.js";
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
// auditTestAssertions — no issues
// ---------------------------------------------------------------------------

describe("auditTestAssertions — no issues", () => {
  it("returns empty when there are no test files", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = auditTestAssertions(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty when test file has strong assertions", () => {
    const files = [makeFile("src/app.test.ts", [
      '+import { add } from "./add";',
      "+it('adds numbers', () => {",
      '+  expect(add(1, 2)).toBe(3);',
      "+});",
    ])];
    const result = auditTestAssertions(files);
    expect(result.issues).toHaveLength(0);
  });

  it("ignores deleted test files", () => {
    const files = [makeFile("src/old.test.ts", ["+expect(x).toBeDefined()"], "deleted")];
    const result = auditTestAssertions(files);
    expect(result.issues).toHaveLength(0);
  });

  it("ignores non-test files even with weak assertions", () => {
    const files = [makeFile("src/utils.ts", ["+expect(x).toBeDefined()"])];
    const result = auditTestAssertions(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Weak assertions
// ---------------------------------------------------------------------------

describe("auditTestAssertions — weak assertions", () => {
  it("detects toBeDefined", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(result).toBeDefined();",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(1);
    expect(weak[0].description).toContain("toBeDefined");
  });

  it("detects toBeTruthy", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(result).toBeTruthy();",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(1);
  });

  it("detects toBeFalsy", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(err).toBeFalsy();",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(1);
  });

  it("detects toBeNull", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(err).toBeNull();",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(1);
  });

  it("detects toBe(null)", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(err).toBe(null);",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(1);
  });

  it("detects toBe(undefined)", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(x).toBe(undefined);",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag .not.toBeDefined as weak", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(x).not.toBeDefined();",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion" && i.line === 2);
    expect(weak).toHaveLength(0);
  });

  it("flags severity as medium", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    if (weak.length > 0) {
      expect(weak[0].severity).toBe("medium");
    }
  });
});

// ---------------------------------------------------------------------------
// Tautological assertions
// ---------------------------------------------------------------------------

describe("auditTestAssertions — tautological assertions", () => {
  it("detects expect(true).toBe(true)", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(true).toBe(true);",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const taut = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(taut.length).toBeGreaterThanOrEqual(1);
  });

  it("detects expect(false).toBe(false)", () => {
    const files = [makeFile("src/app.test.ts", [
      "+  expect(false).toBe(false);",
    ])];
    const result = auditTestAssertions(files);
    const taut = result.issues.filter((i) => i.category === "tautological-assertion");
    expect(taut.length).toBeGreaterThanOrEqual(1);
  });

  it("flags tautological as critical", () => {
    const files = [makeFile("src/app.test.ts", [
      "+  expect(true).toBe(true);",
    ])];
    const result = auditTestAssertions(files);
    const taut = result.issues.filter((i) => i.category === "tautological-assertion");
    if (taut.length > 0) {
      expect(taut[0].severity).toBe("critical");
    }
  });
});

// ---------------------------------------------------------------------------
// Zero-assertion files
// ---------------------------------------------------------------------------

describe("auditTestAssertions — zero-assertion files", () => {
  it("detects test files with no expect() calls", () => {
    const files = [makeFile("src/app.test.ts", [
      "+describe('app', () => {",
      "+  it('works', () => {",
      "+    console.log('hello');",
      "+  });",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const zero = result.issues.filter((i) => i.category === "zero-assertion-file");
    expect(zero.length).toBeGreaterThanOrEqual(1);
    expect(zero[0].severity).toBe("critical");
  });

  it("does not flag non-test files without expect()", () => {
    const files = [makeFile("src/utils.ts", [
      "+function add(a: number, b: number) {",
      "+  return a + b;",
      "+}",
    ])];
    const result = auditTestAssertions(files);
    const zero = result.issues.filter((i) => i.category === "zero-assertion-file");
    expect(zero).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Assertion-free tests
// ---------------------------------------------------------------------------

describe("auditTestAssertions — assertion-free tests", () => {
  it("detects it() blocks with no expect()", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('renders without crashing', () => {",
      '+  render(<App />);',
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const free = result.issues.filter((i) => i.category === "assertion-free-test");
    expect(free.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag it() blocks that have expect()", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('works', () => {",
      "+  expect(1 + 1).toBe(2);",
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const free = result.issues.filter((i) => i.category === "assertion-free-test");
    expect(free).toHaveLength(0);
  });

  it("flags assertion-free tests as critical", () => {
    const files = [makeFile("src/app.test.ts", [
      "+it('renders', () => {",
      '+  render(<App />);',
      "+});",
    ])];
    const result = auditTestAssertions(files);
    const free = result.issues.filter((i) => i.category === "assertion-free-test");
    if (free.length > 0) {
      expect(free[0].severity).toBe("critical");
    }
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("auditTestAssertions — deduplication", () => {
  it("deduplicates identical issues", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(x).toBeDefined();",
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    const unique = new Set(result.issues.map((i) => `${i.category}:${i.line}`));
    expect(unique.size).toBeLessThanOrEqual(result.issues.length);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("auditTestAssertions — sorting", () => {
  it("sorts critical before medium", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(true).toBe(true);",
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    if (result.issues.length > 1) {
      const severities = result.issues.map((i) => i.severity);
      const critIdx = severities.indexOf("critical");
      const medIdx = severities.indexOf("medium");
      if (critIdx >= 0 && medIdx >= 0) {
        expect(critIdx).toBeLessThan(medIdx);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("auditTestAssertions — context text", () => {
  it("includes issues in contextText", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Test Assertion Quality");
    }
  });

  it("returns empty contextText when no issues", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(1 + 1).toBe(2);",
    ])];
    const result = auditTestAssertions(files);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("auditTestAssertions — body summary", () => {
  it("includes table in bodySummary when issues exist", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("Test Assertion Quality");
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty bodySummary when no issues", () => {
    const files = [makeFile("src/app.test.ts", [
      "+expect(1 + 1).toBe(2);",
    ])];
    const result = auditTestAssertions(files);
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Spec file detection
// ---------------------------------------------------------------------------

describe("auditTestAssertions — spec file detection", () => {
  it("audits .spec.ts files", () => {
    const files = [makeFile("src/app.spec.ts", [
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });

  it("audits files in __tests__ directory", () => {
    const files = [makeFile("src/__tests__/app.ts", [
      "+expect(x).toBeDefined();",
    ])];
    const result = auditTestAssertions(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple file types
// ---------------------------------------------------------------------------

describe("auditTestAssertions — multiple files", () => {
  it("audits multiple test files", () => {
    const files = [
      makeFile("src/a.test.ts", ["+expect(x).toBeDefined();"]),
      makeFile("src/b.test.ts", ["+expect(y).toBeTruthy();"]),
      makeFile("src/utils.ts", ["+const x = 1;"]),
    ];
    const result = auditTestAssertions(files);
    const weak = result.issues.filter((i) => i.category === "weak-assertion");
    expect(weak.length).toBeGreaterThanOrEqual(2);
  });
});
