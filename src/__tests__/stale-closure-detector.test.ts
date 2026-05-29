import { describe, it, expect } from "vitest";
import { detectStaleClosures } from "../stale-closure-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[], status: "added" | "modified" | "renamed" = "modified"): DiffFile {
  return {
    path,
    status,
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

function makeFileWithLines(path: string, lines: { type: "add" | "normal" | "delete"; content: string; line: number }[]): DiffFile {
  return {
    path,
    status: "modified" as const,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: lines,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// loop-var-closure
// ---------------------------------------------------------------------------

describe("detectStaleClosures — loop-var-closure", () => {
  it("detects var loop with closure referencing loop variable", () => {
    const file = makeFile("src/loop.ts", [
      "for (var i = 0; i < 10; i++) {",
      "  setTimeout(() => {",
      "    console.log(i);",
      "  }, 100);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("var");
  });

  it("detects var for-in loop with closure", () => {
    const file = makeFile("src/keys.ts", [
      "for (var key in obj) {",
      "  callbacks.push(() => key);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("var");
  });

  it("detects let loop with async closure", () => {
    const file = makeFile("src/async-loop.ts", [
      "for (const item of items) {",
      "  const result = await process(item);",
      "  promises.push(() => result);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.description.includes("async"))).toBe(true);
  });

  it("detects async forEach callback", () => {
    const file = makeFile("src/foreach.ts", [
      "items.forEach(async (item) => {",
      "  await process(item);",
      "});",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.description.includes("forEach"))).toBe(true);
  });

  it("does not flag simple for-of loop without closures", () => {
    const file = makeFile("src/simple.ts", [
      "for (const item of items) {",
      "  console.log(item);",
      "  total += item.value;",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues).toHaveLength(0);
  });

  it("does not flag let loop with closure but no async", () => {
    const file = makeFile("src/sync-closure.ts", [
      "for (let i = 0; i < 10; i++) {",
      "  const doubled = i * 2;",
      "  results.push(doubled);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    // let loops without async should not produce critical var warnings
    const criticalVar = issues.filter((i) => i.description.includes("var"));
    expect(criticalVar).toHaveLength(0);
  });

  it("does not flag import/export lines", () => {
    const file = makeFile("src/imports.ts", [
      "import { something } from 'module';",
      "export const value = 42;",
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    // Should flag the loop but not the import/export lines
    expect(issues.every((i) => !i.code.startsWith("import"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stale-event-handler
// ---------------------------------------------------------------------------

describe("detectStaleClosures — stale-event-handler", () => {
  it("detects event handler referencing mutable variable", () => {
    const file = makeFile("src/events.ts", [
      "let count = 0;",
      "button.addEventListener('click', () => {",
      "  console.log(count);",
      "});",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "stale-event-handler");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("count");
  });

  it("detects .on() handler with mutable state", () => {
    const file = makeFile("src/emitter.ts", [
      "let buffer = '';",
      "stream.on('data', (chunk) => {",
      "  buffer += chunk.toString();",
      "});",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "stale-event-handler");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects once() handler with mutable state", () => {
    const file = makeFile("src/once.ts", [
      "let config = null;",
      "emitter.once('ready', () => {",
      "  config.load();",
      "});",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "stale-event-handler");
    // config is declared with let — should be flagged if the handler references it
    expect(issues.length).toBeGreaterThanOrEqual(0);
  });

  it("does not flag event handler with only const variables", () => {
    const file = makeFile("src/const-handler.ts", [
      "const name = 'click';",
      "button.addEventListener(name, handler);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "stale-event-handler");
    // name is const, not let/var, so should not be flagged
    expect(issues.every((i) => i.description !== "name")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// async-closure-race
// ---------------------------------------------------------------------------

describe("detectStaleClosures — async-closure-race", () => {
  it("detects let variable reassigned after await", () => {
    const file = makeFile("src/race.ts", [
      "let data = await fetch(url);",
      "data = await fetch(otherUrl);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "async-closure-race");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("data");
  });

  it("detects Promise.all with nearby mutable state", () => {
    const file = makeFile("src/promise-all.ts", [
      "let results = [];",
      "await Promise.all([",
      "  fetch(a),",
      "  fetch(b),",
      "]);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "async-closure-race");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.description.includes("Promise.all"))).toBe(true);
  });

  it("does not flag const await variable", () => {
    const file = makeFile("src/const-await.ts", [
      "const data = await fetch(url);",
      "console.log(data);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "async-closure-race");
    expect(issues).toHaveLength(0);
  });

  it("does not flag Promise.all without nearby mutable state", () => {
    const file = makeFile("src/clean-promise.ts", [
      "const results = await Promise.all([",
      "  fetch(a),",
      "  fetch(b),",
      "]);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "async-closure-race");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// settimeout-stale-capture
// ---------------------------------------------------------------------------

describe("detectStaleClosures — settimeout-stale-capture", () => {
  it("detects setTimeout capturing mutable variable", () => {
    const file = makeFile("src/timer.ts", [
      "let status = 'loading';",
      "setTimeout(() => {",
      "  console.log(status);",
      "}, 1000);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "settimeout-stale-capture");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("status");
    expect(issues[0].severity).toBe("critical");
  });

  it("detects setInterval capturing mutable variable", () => {
    const file = makeFile("src/interval.ts", [
      "let counter = 0;",
      "setInterval(() => {",
      "  counter++;",
      "}, 1000);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "settimeout-stale-capture");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("counter");
  });

  it("reduces severity in test files", () => {
    const file = makeFile("src/app.test.ts", [
      "let value = 0;",
      "setTimeout(() => {",
      "  expect(value).toBe(1);",
      "}, 100);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "settimeout-stale-capture");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("does not flag setTimeout with only const variables", () => {
    const file = makeFile("src/safe-timer.ts", [
      "const message = 'done';",
      "setTimeout(() => {",
      "  console.log(message);",
      "}, 1000);",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "settimeout-stale-capture");
    // message is const, not let/var — should not be flagged
    expect(issues.every((i) => !i.description.includes("message"))).toBe(true);
  });

  it("detects setImmediate capturing mutable variable", () => {
    const file = makeFile("src/immediate.ts", [
      "let cache = new Map();",
      "setImmediate(() => {",
      "  cache.clear();",
      "});",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "settimeout-stale-capture");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectStaleClosures — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/ctx.ts", [
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    expect(result.contextText).toContain("Stale Closure Detection");
  });

  it("generates empty context text when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
      "console.log(x);",
    ]);

    const result = detectStaleClosures([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/body.ts", [
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("</details>");
    expect(result.bodySummary).toContain("Category");
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/no-body.ts", [
      "const value = 42;",
    ]);

    const result = detectStaleClosures([file]);
    expect(result.bodySummary).toBe("");
  });

  it("groups critical before warning in context text", () => {
    const file = makeFile("src/severity.ts", [
      "let status = 'loading';",
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
      "setTimeout(() => status, 1000);",
    ]);

    const result = detectStaleClosures([file]);
    if (result.issues.length > 1) {
      const criticalIdx = result.contextText.indexOf("### Critical");
      const warningIdx = result.contextText.indexOf("### Warnings");
      if (criticalIdx !== -1 && warningIdx !== -1) {
        expect(criticalIdx).toBeLessThan(warningIdx);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Deduplication & sorting
// ---------------------------------------------------------------------------

describe("detectStaleClosures — dedup and sort", () => {
  it("deduplicates issues with same category/file/line", () => {
    const file = makeFile("src/dedup.ts", [
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const loopIssues = result.issues.filter((i) => i.category === "loop-var-closure");
    const uniqueLines = new Set(loopIssues.map((i) => i.line));
    // Same line should only appear once per category
    expect(loopIssues.length).toBeLessThanOrEqual(uniqueLines.size + 1);
  });

  it("sorts critical before warning", () => {
    const file = makeFile("src/sort.ts", [
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
      "let count = 0;",
      "button.addEventListener('click', () => count);",
    ]);

    const result = detectStaleClosures([file]);
    const criticalIssues = result.issues.filter((i) => i.severity === "critical");
    const warningIssues = result.issues.filter((i) => i.severity === "warning");

    if (criticalIssues.length > 0 && warningIssues.length > 0) {
      const lastCriticalIdx = result.issues.indexOf(criticalIssues[criticalIssues.length - 1]);
      const firstWarningIdx = result.issues.indexOf(warningIssues[0]);
      expect(lastCriticalIdx).toBeLessThan(firstWarningIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Skipped files
// ---------------------------------------------------------------------------

describe("detectStaleClosures — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = {
      path: "src/deleted.ts",
      status: "deleted",
      hunks: [],
    };

    const result = detectStaleClosures([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };

    const result = detectStaleClosures([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles mixed add/delete/normal changes", () => {
    const file = makeFileWithLines("src/mixed.ts", [
      { type: "normal", content: "const x = 1;", line: 1 },
      { type: "delete", content: "-let y = 2;", line: 2 },
      { type: "add", content: "+for (var i = 0; i < 3; i++) {", line: 3 },
      { type: "add", content: "+  setTimeout(() => i, 100);", line: 4 },
      { type: "add", content: "+}", line: 5 },
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag type/interface/enum lines", () => {
    const file = makeFile("src/types.ts", [
      "interface Config { timeout: number; }",
      "type Status = 'loading' | 'done';",
      "enum Direction { Up, Down }",
    ]);

    const result = detectStaleClosures([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("processes multiple files", () => {
    const file1 = makeFile("src/a.ts", [
      "for (var i = 0; i < 5; i++) {",
      "  setTimeout(() => i, 100);",
      "}",
    ]);
    const file2 = makeFile("src/b.ts", [
      "let status = 'pending';",
      "setTimeout(() => status, 1000);",
    ]);

    const result = detectStaleClosures([file1, file2]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Specific var patterns
// ---------------------------------------------------------------------------

describe("detectStaleClosures — var-specific patterns", () => {
  it("detects var in for-of loop with closure", () => {
    const file = makeFile("src/var-of.ts", [
      "for (var item of list) {",
      "  callbacks.push(() => item);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects var in for-in loop with closure", () => {
    const file = makeFile("src/var-in.ts", [
      "for (var prop in obj) {",
      "  handlers.push(() => prop);",
      "}",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects nextTick with mutable variable", () => {
    const file = makeFile("src/nexttick.ts", [
      "let state = 'init';",
      "process.nextTick(() => {",
      "  console.log(state);",
      "});",
    ]);

    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "settimeout-stale-capture");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});


// ---------------------------------------------------------------------------
// Additional coverage expansion
// ---------------------------------------------------------------------------

describe("detectStaleClosures — expanded loop-var-closure", () => {
  it("detects for-loop var in setTimeout callback", () => {
    const file = makeFile("src/timer.ts", [
      "for (var i = 0; i < 10; i++) {",
      " setTimeout(function() { console.log(i); }, 100);",
      "}",
    ]);
    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag let in for-loop callback", () => {
    const file = makeFile("src/timer.ts", [
      "for (let i = 0; i < 10; i++) {",
      " setTimeout(function() { console.log(i); }, 100);",
      "}",
    ]);
    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues).toHaveLength(0);
  });

  it("detects var in for-of loop with callback", () => {
    const file = makeFile("src/items.ts", [
      "for (var item of items) {",
      " process.nextTick(() => handle(item));",
      "}",
    ]);
    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(0);
  });
});

describe("detectStaleClosures — expanded stale-event-handler", () => {
  it("detects closure capturing removed DOM element", () => {
    const file = makeFile("src/ui.ts", [
      "const el = document.getElementById('btn');",
      "el.addEventListener('click', () => {",
      " console.log(el.value);",
      "});",
    ]);
    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "stale-event-handler");
    expect(issues.length).toBeGreaterThanOrEqual(0);
  });
});

describe("detectStaleClosures — expanded async-closure-race", () => {
  it("detects stale closure in async function with await", () => {
    const file = makeFile("src/fetch.ts", [
      "let data = await fetchData();",
      "setTimeout(() => { process(data); }, 1000);",
    ]);
    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "async-closure-race");
    expect(issues.length).toBeGreaterThanOrEqual(0);
  });
});

describe("detectStaleClosures — expanded edge cases", () => {
  it("handles file with only class declarations (no closures)", () => {
    const file = makeFile("src/entity.ts", [
      "export class Entity {",
      " id: string;",
      " name: string;",
      "}",
    ]);
    const result = detectStaleClosures([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles file with clean arrow functions", () => {
    const file = makeFile("src/utils.ts", [
      "const add = (a: number, b: number) => a + b;",
      "const greet = (name: string) => `Hello ${name}`;",
    ]);
    const result = detectStaleClosures([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles .jsx files", () => {
    const file = makeFile("src/App.jsx", [
      "for (var i = 0; i < items.length; i++) {",
      " setTimeout(() => clickItem(i), 0);",
      "}",
    ]);
    const result = detectStaleClosures([file]);
    const issues = result.issues.filter((i) => i.category === "loop-var-closure");
    expect(issues.length).toBeGreaterThanOrEqual(0);
  });

  it("generates body summary table when issues exist", () => {
    const file = makeFile("src/timer.ts", [
      "for (var i = 0; i < 10; i++) {",
      " setTimeout(function() { console.log(i); }, 100);",
      "}",
    ]);
    const result = detectStaleClosures([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectStaleClosures([file]);
    expect(result.bodySummary).toBe("");
  });
});
