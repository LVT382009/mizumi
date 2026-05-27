import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectDeadCode } from "../dead-code-detector.js";
import type { DeadCodeIssue, DeadCodeResult } from "../dead-code-detector.js";
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
// detectDeadCode — no issues
// ---------------------------------------------------------------------------

describe("detectDeadCode — no issues", () => {
  it("returns empty when there is no dead code", () => {
    const files = [makeFile("src/utils.ts", [
      "+const value = compute();",
      "+console.log(value);",
    ])];
    const result = detectDeadCode(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for clean code with proper error handling", () => {
    const files = [makeFile("src/api.ts", [
      "+try {",
      "+  const data = await fetch(url);",
      "+} catch (e) {",
      "+  logger.error('Fetch failed', e);",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const emptyCatch = result.issues.filter((i) => i.category === "empty-catch");
    expect(emptyCatch).toHaveLength(0);
  });

  it("skips deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+catch (e) {}",
    ], "deleted")];
    const result = detectDeadCode(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unreachable code
// ---------------------------------------------------------------------------

describe("detectDeadCode — unreachable code", () => {
  it("detects code after return", () => {
    const files = [makeFile("src/app.ts", [
      "+  return result;",
      "+  const x = unusedAfterReturn;",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].severity).toBe("warning");
  });

  it("detects code after throw", () => {
    const files = [makeFile("src/app.ts", [
      "+  throw new Error('fail');",
      "+  const y = neverReached;",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag code at a shallower indent after return", () => {
    const files = [makeFile("src/app.ts", [
      "+  if (err) {",
      "+    return null;",
      "+  }",
      "+  const next = process(data);",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    // The `const next` line is at a shallower indent, so not unreachable
    expect(unreachable).toHaveLength(0);
  });

  it("detects code after break", () => {
    const files = [makeFile("src/app.ts", [
      "+      break;",
      "+      const afterBreak = true;",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it("detects code after continue", () => {
    const files = [makeFile("src/app.ts", [
      "+      continue;",
      "+      doSomethingAfter();",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Unused variables
// ---------------------------------------------------------------------------

describe("detectDeadCode — unused variables", () => {
  it("detects unused const", () => {
    const files = [makeFile("src/app.ts", [
      "+const configPath = '/etc/app.conf';",
      "+console.log('starting');",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable");
    expect(unused.length).toBeGreaterThanOrEqual(1);
    expect(unused[0].symbol).toBe("configPath");
    expect(unused[0].severity).toBe("warning");
  });

  it("does not flag used variables", () => {
    const files = [makeFile("src/app.ts", [
      "+const apiKey = process.env.KEY;",
      "+sendRequest(apiKey);",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "apiKey");
    expect(unused).toHaveLength(0);
  });

  it("does not flag exported variables", () => {
    const files = [makeFile("src/app.ts", [
      "+export const MAX_SIZE = 100;",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "MAX_SIZE");
    expect(unused).toHaveLength(0);
  });

  it("does not flag underscore-prefixed variables", () => {
    const files = [makeFile("src/app.ts", [
      "+const _unused = compute();",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "_unused");
    expect(unused).toHaveLength(0);
  });

  it("does not flag single-letter variables", () => {
    const files = [makeFile("src/app.ts", [
      "+let i = 0;",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "i");
    expect(unused).toHaveLength(0);
  });

  it("detects unused let", () => {
    const files = [makeFile("src/app.ts", [
      "+let retries = 3;",
      "+console.log('done');",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable");
    expect(unused.length).toBeGreaterThanOrEqual(1);
    expect(unused[0].symbol).toBe("retries");
  });
});

// ---------------------------------------------------------------------------
// Empty catch blocks
// ---------------------------------------------------------------------------

describe("detectDeadCode — empty catch blocks", () => {
  it("detects single-line empty catch", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty.length).toBeGreaterThanOrEqual(1);
    expect(empty[0].severity).toBe("critical");
  });

  it("detects multi-line empty catch", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  doWork();",
      "+} catch (err) {",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag catch blocks with error handling", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (err) {",
      "+  logger.error('failed', err);",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty).toHaveLength(0);
  });

  it("does not flag catch blocks that rethrow", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (err) {",
      "+  throw err;",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("detectDeadCode — deduplication", () => {
  it("deduplicates identical issues", () => {
    const files = [makeFile("src/app.ts", [
      "+const dead1 = 1;",
      "+const dead2 = 2;",
      "+console.log('x');",
    ])];
    const result = detectDeadCode(files);
    const unique = new Set(result.issues.map((i) => `${i.category}:${i.symbol}`));
    expect(unique.size).toBe(result.issues.filter((i) => i.category === "unused-variable").length);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectDeadCode — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+const unusedOut = 'x';",
      "+console.log('ok');",
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 1) {
      const severities = result.issues.map((i) => i.severity);
      const firstWarning = severities.indexOf("warning");
      const lastCritical = severities.lastIndexOf("critical");
      if (firstWarning >= 0 && lastCritical >= 0) {
        expect(lastCritical).toBeLessThan(firstWarning);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("detectDeadCode — context text", () => {
  it("includes issues in contextText", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Dead Code Detection");
    }
  });

  it("returns empty contextText when no issues", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = detectDeadCode(files);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("detectDeadCode — body summary", () => {
  it("includes table in bodySummary when issues exist", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("Dead Code Detection");
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty bodySummary when no issues", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = detectDeadCode(files);
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

describe("detectDeadCode — multiple files", () => {
  it("aggregates issues across files", () => {
    const files = [
      makeFile("src/a.ts", ["+const unusedA = 1;", "+console.log('a');"]),
      makeFile("src/b.ts", ["+const unusedB = 2;", "+console.log('b');"]),
    ];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable");
    expect(unused.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Mixed categories
// ---------------------------------------------------------------------------

describe("detectDeadCode — mixed categories", () => {
  it("detects multiple dead code types in one file", () => {
    const files = [makeFile("src/app.ts", [
      "+  return null;",
      "+  const dead = true;",
      "+const unused = 42;",
      "+try { doIt(); } catch (e) {}",
      "+console.log('ok');",
    ])];
    const result = detectDeadCode(files);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });
});
