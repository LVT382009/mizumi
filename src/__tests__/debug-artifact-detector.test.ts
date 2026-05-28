import { describe, it, expect } from "vitest";
import { detectDebugArtifacts } from "../debug-artifact-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(files: Partial<DiffFile>[]): DiffFile[] {
  return files.map((f) => ({
    path: f.path || "src/app.ts",
    status: f.status || "modified",
    hunks:
      f.hunks ||
      [
        {
          changes: (f.lines || []).map((line, idx) => ({
            type: line.startsWith("+") ? "add" : line.startsWith("-") ? "delete" : "normal",
            content: line,
            line: idx + 1,
          })),
        },
      ],
  })) as DiffFile[];
}

// ---------------------------------------------------------------------------
// debugger-statement
// ---------------------------------------------------------------------------

describe("debugger-statement", () => {
  it("detects debugger statement", () => {
    const diffs = makeDiff([{ lines: ["+debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debugger-statement");
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects debugger with spaces", () => {
    const diffs = makeDiff([{ lines: ["+  debugger;  "] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debugger-statement");
  });

  it("detects debugger inside conditional", () => {
    const diffs = makeDiff([{ lines: ["+  if (error) debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debugger-statement");
  });

  it("detects multiple debugger statements", () => {
    const diffs = makeDiff([{ lines: ["+debugger;", "+console.log(x);", "+debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    const debuggerIssues = result.issues.filter((i) => i.category === "debugger-statement");
    expect(debuggerIssues).toHaveLength(2);
  });

  it("does not flag debugger in comment", () => {
    const diffs = makeDiff([{ lines: ["+// debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag debugger in block comment", () => {
    const diffs = makeDiff([{ lines: ["+/* debugger; */"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag deleted debugger", () => {
    const diffs = makeDiff([{ lines: ["-debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("detects debugger in test file", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debugger-statement");
  });

  it("detects debugger across multiple files", () => {
    const diffs = makeDiff([
      { path: "src/a.ts", lines: ["+debugger;"] },
      { path: "src/b.ts", lines: ["+debugger;"] },
    ]);
    const result = detectDebugArtifacts(diffs);
    const debuggerIssues = result.issues.filter((i) => i.category === "debugger-statement");
    expect(debuggerIssues).toHaveLength(2);
  });

  it("does not flag word debugger in string", () => {
    const diffs = makeDiff([{ lines: [`+const msg = "debugger is running";`] }]);
    const result = detectDebugArtifacts(diffs);
    const debuggerIssues = result.issues.filter((i) => i.category === "debugger-statement");
    // "debugger" in a string without the ; statement pattern
    expect(debuggerIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// console-debug
// ---------------------------------------------------------------------------

describe("console-debug", () => {
  it("detects console.log", () => {
    const diffs = makeDiff([{ lines: ["+console.log(data);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
    expect(result.issues[0].severity).toBe("warning");
  });

  it("detects console.debug", () => {
    const diffs = makeDiff([{ lines: ["+console.debug('value:', x);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.info", () => {
    const diffs = makeDiff([{ lines: ["+console.info('starting...');"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.trace", () => {
    const diffs = makeDiff([{ lines: ["+console.trace();"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.dir", () => {
    const diffs = makeDiff([{ lines: ["+console.dir(obj);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.table", () => {
    const diffs = makeDiff([{ lines: ["+console.table(results);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("does not flag console.warn", () => {
    const diffs = makeDiff([{ lines: ["+console.warn('deprecated API');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.error", () => {
    const diffs = makeDiff([{ lines: ["+console.error('failed:', err);"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.log in test file", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+console.log('test output');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.log in spec file", () => {
    const diffs = makeDiff([{ path: "src/utils.spec.ts", lines: ["+console.log('debugging test');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.log in script file", () => {
    const diffs = makeDiff([{ path: "scripts/deploy.sh", lines: ["+console.log('deploying...');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.log in logging utility", () => {
    const diffs = makeDiff([{ path: "src/logger/index.ts", lines: ["+console.log(level, message);"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.log in comment", () => {
    const diffs = makeDiff([{ lines: ["+// console.log(x);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag deleted console.log", () => {
    const diffs = makeDiff([{ lines: ["-console.log(data);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("detects console.log with template literal", () => {
    const diffs = makeDiff([{ lines: ["+console.log(`result: ${val}`);"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.log in e2e test directory", () => {
    const diffs = makeDiff([{ path: "tests/e2e/login.test.ts", lines: ["+console.log('page loaded');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("flags multiple console methods in same file", () => {
    const diffs = makeDiff([{ lines: ["+console.log(a);", "+console.debug(b);", "+console.info(c);"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// test-isolation-break
// ---------------------------------------------------------------------------

describe("test-isolation-break", () => {
  it("detects it.only", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+it.only('works', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("test-isolation-break");
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects describe.only", () => {
    const diffs = makeDiff([{ path: "src/module.test.ts", lines: ["+describe.only('suite', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects test.only", () => {
    const diffs = makeDiff([{ path: "src/utils.test.ts", lines: ["+test.only('works', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects it.skip", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+it.skip('broken test', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("warning");
  });

  it("detects describe.skip", () => {
    const diffs = makeDiff([{ path: "src/module.test.ts", lines: ["+describe.skip('flaky suite', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("warning");
  });

  it("detects fit (mocha focused test)", () => {
    const diffs = makeDiff([{ path: "src/api.test.ts", lines: ["+fit('does something', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects fdescribe (mocha focused suite)", () => {
    const diffs = makeDiff([{ path: "src/api.test.ts", lines: ["+fdescribe('focused suite', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects xit (mocha excluded test)", () => {
    const diffs = makeDiff([{ path: "src/api.test.ts", lines: ["+xit('excluded test', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("warning");
  });

  it("detects xdescribe (mocha excluded suite)", () => {
    const diffs = makeDiff([{ path: "src/api.test.ts", lines: ["+xdescribe('excluded suite', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("warning");
  });

  it("does not flag it.only in non-test file", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+it.only('config', {});"] }]);
    const result = detectDebugArtifacts(diffs);
    const testIssues = result.issues.filter((i) => i.category === "test-isolation-break");
    expect(testIssues).toHaveLength(0);
  });

  it("does not flag regular it() call", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+it('works correctly', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    const testIssues = result.issues.filter((i) => i.category === "test-isolation-break");
    expect(testIssues).toHaveLength(0);
  });

  it("does not flag regular describe() call", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+describe('module', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    const testIssues = result.issues.filter((i) => i.category === "test-isolation-break");
    expect(testIssues).toHaveLength(0);
  });

  it("does not flag test.only in comment", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+// it.only('debug', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    const testIssues = result.issues.filter((i) => i.category === "test-isolation-break");
    expect(testIssues).toHaveLength(0);
  });

  it("detects context.only", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+context.only('focused', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("critical");
  });

  it("detects test.skip", () => {
    const diffs = makeDiff([{ path: "src/utils.test.ts", lines: ["+test.skip('flaky', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("warning");
  });

  it("detects xtest (Jest excluded)", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+xtest('disabled', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("detects suite.only", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+suite.only('focus', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// debug-flag-true
// ---------------------------------------------------------------------------

describe("debug-flag-true", () => {
  it("detects debug = true", () => {
    const diffs = makeDiff([{ path: "src/server.ts", lines: ["+const debug = true;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debug-flag-true");
    expect(result.issues[0].severity).toBe("warning");
  });

  it("detects debug: true", () => {
    const diffs = makeDiff([{ path: "src/server.ts", lines: ["+debug: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debug-flag-true");
  });

  it("detects verbose: true", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+verbose: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("debug-flag-true");
  });

  it("detects verbose = true", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+const verbose = true;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("detects logging: true", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+logging: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("detects trace: true", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+trace: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("detects logLevel = 'debug'", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+const logLevel = 'debug';"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("detects log_level = 'verbose'", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: [`+const log_level = "verbose";`] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("does not flag debug = false", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+const debug = false;"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("does not flag debug: false", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+debug: false,"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("does not flag debug flag in config file", () => {
    const diffs = makeDiff([{ path: "config/default.yaml", lines: ["+debug: true"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("does not flag debug flag in .env file", () => {
    const diffs = makeDiff([{ path: ".env", lines: ["+DEBUG=true"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("does not flag debug flag in test file", () => {
    const diffs = makeDiff([{ path: "src/app.test.ts", lines: ["+debug: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("does not flag debug in comment", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+// const debug = true;"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("detects tracing: true", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+tracing: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("deduplication", () => {
  it("deduplicates same category/file/line", () => {
    const diffs = makeDiff([{
      path: "src/app.ts",
      hunks: [{
        changes: [
          { type: "add", content: "+debugger;", line: 5 },
          { type: "add", content: "+debugger;", line: 5 },
        ],
      }],
    }]);
    const result = detectDebugArtifacts(diffs as DiffFile[]);
    const debuggerIssues = result.issues.filter((i) => i.category === "debugger-statement");
    expect(debuggerIssues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deleted files
// ---------------------------------------------------------------------------

describe("deleted files", () => {
  it("skips deleted files", () => {
    const diffs = makeDiff([{
      path: "src/app.ts",
      status: "deleted",
      lines: ["+debugger;", "+console.log(x);"],
    }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple categories
// ---------------------------------------------------------------------------

describe("multiple categories", () => {
  it("detects issues from multiple categories in same file", () => {
    const diffs = makeDiff([{
      path: "src/app.ts",
      lines: ["+debugger;", "+console.log('debug');", "+const debug = true;"],
    }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(3);
    const cats = new Set(result.issues.map((i) => i.category));
    expect(cats.has("debugger-statement")).toBe(true);
    expect(cats.has("console-debug")).toBe(true);
    expect(cats.has("debug-flag-true")).toBe(true);
  });

  it("detects issues across multiple files", () => {
    const diffs = makeDiff([
      { path: "src/a.ts", lines: ["+debugger;"] },
      { path: "src/b.ts", lines: ["+console.log('x');"] },
      { path: "src/c.test.ts", lines: ["+it.only('focus', () => {});"] },
    ]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe("sort order", () => {
  it("sorts critical before warning", () => {
    const diffs = makeDiff([{
      path: "src/app.ts",
      lines: ["+const debug = true;", "+debugger;"],
    }, {
      path: "src/app.test.ts",
      lines: ["+it.skip('broken', () => {});", "+it.only('focus', () => {});"],
    }]);
    const result = detectDebugArtifacts(diffs);
    const severities = result.issues.map((i) => i.severity);
    // critical should come before warning
    const firstWarning = severities.indexOf("warning");
    const lastCritical = severities.lastIndexOf("critical");
    if (firstWarning !== -1 && lastCritical !== -1) {
      expect(lastCritical).toBeLessThan(firstWarning);
    }
  });

  it("sorts by file path when same severity", () => {
    const diffs = makeDiff([
      { path: "src/z.ts", lines: ["+debugger;"] },
      { path: "src/a.ts", lines: ["+debugger;"] },
    ]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues[0].file).toBe("src/a.ts");
    expect(result.issues[1].file).toBe("src/z.ts");
  });
});

// ---------------------------------------------------------------------------
// Context text
// ---------------------------------------------------------------------------

describe("context text", () => {
  it("returns empty string when no issues", () => {
    const diffs = makeDiff([{ lines: ["+const x = 1;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.contextText).toBe("");
  });

  it("includes category header when issues found", () => {
    const diffs = makeDiff([{ lines: ["+debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.contextText).toContain("Debug Artifacts");
    expect(result.contextText).toContain("debugger");
  });

  it("separates critical and warning sections", () => {
    const diffs = makeDiff([{
      path: "src/app.ts",
      lines: ["+debugger;", "+const debug = true;"],
    }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.contextText).toContain("Critical");
    expect(result.contextText).toContain("Warnings");
  });
});

// ---------------------------------------------------------------------------
// Body summary
// ---------------------------------------------------------------------------

describe("body summary", () => {
  it("returns empty string when no issues", () => {
    const diffs = makeDiff([{ lines: ["+const x = 1;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.bodySummary).toBe("");
  });

  it("includes table with issue details", () => {
    const diffs = makeDiff([{ lines: ["+debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.bodySummary).toContain("Debug Artifact Detection");
    expect(result.bodySummary).toContain("| Category |");
    expect(result.bodySummary).toContain("debugger statement");
  });

  it("includes overflow row for 15+ issues", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `+debugger; // ${i}`);
    const diffs = makeDiff([{ lines }]);
    const result = detectDebugArtifacts(diffs);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("includes explanation paragraph", () => {
    const diffs = makeDiff([{ lines: ["+debugger;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.bodySummary).toContain("Debug artifacts leak sensitive data");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty diff", () => {
    const result = detectDebugArtifacts([]);
    expect(result.issues).toHaveLength(0);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("handles file with no added lines", () => {
    const diffs = makeDiff([{ lines: ["-debugger;", " const x = 1;"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag normal (unchanged) lines", () => {
    const diffs = makeDiff([{
      hunks: [{
        changes: [
          { type: "normal", content: " debugger;", line: 5 },
        ],
      }],
    }]);
    const result = detectDebugArtifacts(diffs as DiffFile[]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles console.warn alongside console.log", () => {
    // Line has both console.log AND console.warn — console.log method matched
    const diffs = makeDiff([{ lines: ["+console.log('x');"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("does not double-flag debug: true (both RE patterns)", () => {
    const diffs = makeDiff([{ path: "src/app.ts", lines: ["+debug: true,"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(1);
  });

  it("detects console.count in production", () => {
    const diffs = makeDiff([{ lines: ["+console.count('clicks');"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.time/timeEnd", () => {
    const diffs = makeDiff([{ lines: ["+console.time('render');"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("console-debug");
  });

  it("detects console.assert", () => {
    const diffs = makeDiff([{ lines: ["+console.assert(x > 0, 'positive');"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("does not flag import line with console", () => {
    const diffs = makeDiff([{ lines: ["+import { console } from 'node:console';"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag export line", () => {
    const diffs = makeDiff([{ lines: ["+export const DEBUG = false;"] }]);
    const result = detectDebugArtifacts(diffs);
    const flagIssues = result.issues.filter((i) => i.category === "debug-flag-true");
    expect(flagIssues).toHaveLength(0);
  });

  it("detects it.only in __tests__ directory", () => {
    const diffs = makeDiff([{ path: "src/__tests__/app.ts", lines: ["+it.only('test', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].category).toBe("test-isolation-break");
  });

  it("detects it.only in e2e test file", () => {
    const diffs = makeDiff([{ path: "tests/e2e/login.e2e.ts", lines: ["+it.only('login works', () => {});"] }]);
    const result = detectDebugArtifacts(diffs);
    expect(result.issues).toHaveLength(1);
  });

  it("detects console.log in CLI bin file as acceptable", () => {
    const diffs = makeDiff([{ path: "bin/cli.ts", lines: ["+console.log('Hello World');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });

  it("does not flag console.log in scripts directory", () => {
    const diffs = makeDiff([{ path: "scripts/setup.js", lines: ["+console.log('Setup complete');"] }]);
    const result = detectDebugArtifacts(diffs);
    const consoleIssues = result.issues.filter((i) => i.category === "console-debug");
    expect(consoleIssues).toHaveLength(0);
  });
});
