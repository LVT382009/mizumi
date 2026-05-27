import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectTechDebt } from "../todo-debt-detector.js";
import type { TechDebtIssue, TechDebtResult } from "../todo-debt-detector.js";
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

describe("detectTechDebt — no issues", () => {
  it("returns empty for code without debt markers", () => {
    const files = [makeFile("src/utils.ts", [
      "+const value = compute();",
      "+console.log(value);",
    ])];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+// TODO: clean this up",
    ], "deleted")];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x: number = 42;",
    ])];
    const result = detectTechDebt(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TODO detection
// ---------------------------------------------------------------------------

describe("detectTechDebt — TODO", () => {
  it("detects TODO in comment", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: implement error handling",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0].severity).toBe("warning");
    expect(todos[0].marker).toBe("TODO");
  });

  it("detects TODO with colon", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: fix this later",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0].description).toContain("fix this later");
  });

  it("detects TODO with dash", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO - refactor this",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
  });

  it("detects TODO in block comment", () => {
    const files = [makeFile("src/app.ts", [
      "+ * TODO: add proper validation",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
  });

  it("detects TODO without description", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FIXME detection
// ---------------------------------------------------------------------------

describe("detectTechDebt — FIXME", () => {
  it("detects FIXME as critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// FIXME: this crashes on null input",
    ])];
    const result = detectTechDebt(files);
    const fixmes = result.issues.filter((i) => i.category === "fixme");
    expect(fixmes).toHaveLength(1);
    expect(fixmes[0].severity).toBe("critical");
    expect(fixmes[0].marker).toBe("FIXME");
  });

  it("detects FIXME in code line", () => {
    const files = [makeFile("src/api.ts", [
      "+result = parse(input); // FIXME: broken for empty strings",
    ])];
    const result = detectTechDebt(files);
    const fixmes = result.issues.filter((i) => i.category === "fixme");
    expect(fixmes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// HACK detection
// ---------------------------------------------------------------------------

describe("detectTechDebt — HACK", () => {
  it("detects HACK as critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// HACK: bypassing validation for demo",
    ])];
    const result = detectTechDebt(files);
    const hacks = result.issues.filter((i) => i.category === "hack");
    expect(hacks).toHaveLength(1);
    expect(hacks[0].severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// XXX detection
// ---------------------------------------------------------------------------

describe("detectTechDebt — XXX", () => {
  it("detects XXX as critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// XXX: race condition here",
    ])];
    const result = detectTechDebt(files);
    const xxxs = result.issues.filter((i) => i.category === "xxx");
    expect(xxxs).toHaveLength(1);
    expect(xxxs[0].severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// WORKAROUND detection
// ---------------------------------------------------------------------------

describe("detectTechDebt — WORKAROUND", () => {
  it("detects WORKAROUND as warning", () => {
    const files = [makeFile("src/app.ts", [
      "+// WORKAROUND: API returns wrong status code",
    ])];
    const result = detectTechDebt(files);
    const was = result.issues.filter((i) => i.category === "workaround");
    expect(was).toHaveLength(1);
    expect(was[0].severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// Multiple markers
// ---------------------------------------------------------------------------

describe("detectTechDebt — multiple markers", () => {
  it("detects all 5 marker types in one file", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: add test",
      "+// FIXME: broken",
      "+// HACK: workaround",
      "+// XXX: dangerous",
      "+// WORKAROUND: temp fix",
    ])];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(5);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBe(5);
  });

  it("detects markers across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+// TODO: implement"]),
      makeFile("src/b.ts", ["+// FIXME: crash"]),
    ];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(2);
  });

  it("counts critical and warning correctly", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: improve",
      "+// FIXME: bug",
      "+// HACK: temp",
    ])];
    const result = detectTechDebt(files);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(critical).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectTechDebt — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: improve",       // warning
      "+// FIXME: bug",          // critical
    ])];
    const result = detectTechDebt(files);
    const severities = result.issues.map((i) => i.severity);
    expect(severities[0]).toBe("critical");
    expect(severities[1]).toBe("warning");
  });

  it("sorts by file name within same severity", () => {
    const files = [
      makeFile("src/z.ts", ["+// FIXME: bug z"]),
      makeFile("src/a.ts", ["+// FIXME: bug a"]),
    ];
    const result = detectTechDebt(files);
    expect(result.issues[0].file).toBe("src/a.ts");
    expect(result.issues[1].file).toBe("src/z.ts");
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectTechDebt — context and body", () => {
  it("generates context text with critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+// FIXME: crash",
      "+// TODO: improve later",
    ])];
    const result = detectTechDebt(files);
    expect(result.contextText).toContain("Tech Debt Detection");
    expect(result.contextText).toContain("Critical");
    expect(result.contextText).toContain("Warnings");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: fix this",
    ])];
    const result = detectTechDebt(files);
    expect(result.bodySummary).toContain("Tech Debt Detection");
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("|");
  });

  it("shows 'more' row when issues exceed 15", () => {
    const changes: string[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push(`+// TODO: item ${i}`);
    }
    const files = [makeFile("src/app.ts", changes)];
    const result = detectTechDebt(files);
    expect(result.issues.length).toBeGreaterThan(15);
    expect(result.bodySummary).toContain("more");
  });

  it("only shows critical section when no warnings", () => {
    const files = [makeFile("src/app.ts", [
      "+// FIXME: crash",
    ])];
    const result = detectTechDebt(files);
    expect(result.contextText).toContain("Critical");
    expect(result.contextText).not.toContain("Warnings");
  });

  it("only shows warning section when no critical", () => {
    const files = [makeFile("src/app.ts", [
      "+// TODO: clean up",
    ])];
    const result = detectTechDebt(files);
    expect(result.contextText).toContain("Warnings");
    expect(result.contextText).not.toContain("Critical");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectTechDebt — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// TODO: old todo removed",
      "+const x = 42;",
    ])];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(0);
  });

  it("ignores normal (unchanged) lines", () => {
    const files = [makeFile("src/app.ts", [
      " // TODO: existing todo",
      "+const y = 42;",
    ])];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(0);
  });

  it("truncates long descriptions", () => {
    const longDesc = "a".repeat(100);
    const files = [makeFile("src/app.ts", [
      `+// TODO: ${longDesc}`,
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
    expect(todos[0].description.length).toBeLessThanOrEqual(83);
  });

  it("detects TODO inline in code", () => {
    const files = [makeFile("src/app.ts", [
      "+const x = hack(); // TODO: replace with proper solution",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
  });

  it("detects FIXME in multi-line comment", () => {
    const files = [makeFile("src/app.ts", [
      "+ * FIXME: this is broken",
    ])];
    const result = detectTechDebt(files);
    const fixmes = result.issues.filter((i) => i.category === "fixme");
    expect(fixmes).toHaveLength(1);
  });

  it("skips empty closing braces", () => {
    const files = [makeFile("src/app.ts", [
      "+}",
    ])];
    const result = detectTechDebt(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles marker at start of line (no preceding comment)", () => {
    const files = [makeFile("src/app.ts", [
      "+TODO: add feature",
    ])];
    const result = detectTechDebt(files);
    const todos = result.issues.filter((i) => i.category === "todo");
    expect(todos).toHaveLength(1);
  });

  it("works with multiple FIXME markers across files", () => {
    const files = [
      makeFile("src/a.ts", ["+// FIXME: bug in a"]),
      makeFile("src/b.ts", ["+// FIXME: bug in b"]),
      makeFile("src/c.ts", ["+// FIXME: bug in c"]),
    ];
    const result = detectTechDebt(files);
    const fixmes = result.issues.filter((i) => i.category === "fixme");
    expect(fixmes).toHaveLength(3);
  });
});
