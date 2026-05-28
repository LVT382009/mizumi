import { describe, it, expect } from "vitest";
import { detectCallbackMisuse } from "../callback-misuse-detector.js";
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
// callback-promise-mix
// ---------------------------------------------------------------------------

describe("callback-promise-mix", () => {
  it("detects fetch called with error-first callback", () => {
    const diffs = makeDiff([{ lines: ["+fetch(url, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const mixIssues = result.issues.filter((i) => i.category === "callback-promise-mix");
    expect(mixIssues).toHaveLength(1);
    expect(mixIssues[0].severity).toBe("warning");
  });

  it("detects axios.get with callback argument", () => {
    const diffs = makeDiff([{ lines: ["+axios.get(url, (err, response) => { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const mixIssues = result.issues.filter((i) => i.category === "callback-promise-mix");
    expect(mixIssues).toHaveLength(1);
  });

  it("detects readFile with error-first callback", () => {
    const diffs = makeDiff([{ lines: ["+readFile(path, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const mixIssues = result.issues.filter((i) => i.category === "callback-promise-mix");
    expect(mixIssues).toHaveLength(1);
  });

  it("does not flag fetch with options object (no callback)", () => {
    const diffs = makeDiff([{ lines: ["+fetch(url, { method: 'POST' })"] }]);
    const result = detectCallbackMisuse(diffs);
    const mixIssues = result.issues.filter((i) => i.category === "callback-promise-mix");
    expect(mixIssues).toHaveLength(0);
  });

  it("does not flag regular fetch with await", () => {
    const diffs = makeDiff([{ lines: ["+const response = await fetch(url);"] }]);
    const result = detectCallbackMisuse(diffs);
    const mixIssues = result.issues.filter((i) => i.category === "callback-promise-mix");
    expect(mixIssues).toHaveLength(0);
  });

  it("does not flag fetch in comment", () => {
    const diffs = makeDiff([{ lines: ["+// fetch(url, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("detects mkdir with callback argument", () => {
    const diffs = makeDiff([{ lines: ["+mkdir(dir, function(err, result) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const mixIssues = result.issues.filter((i) => i.category === "callback-promise-mix");
    expect(mixIssues).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// promise-callback-wrap
// ---------------------------------------------------------------------------

describe("promise-callback-wrap", () => {
  it("detects new Promise wrapping fs.readFile", () => {
    const lines = [
      "+new Promise((resolve, reject) => {",
      "+  fs.readFile(path, (err, data) => {",
      "+    if (err) reject(err);",
      "+    else resolve(data);",
      "+  });",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects new Promise wrapping http.get", () => {
    const lines = [
      "+new Promise((resolve, reject) => {",
      "+  http.get(url, (res) => {",
      "+    resolve(res);",
      "+  });",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag regular new Promise without callback API", () => {
    const lines = [
      "+new Promise((resolve, reject) => {",
      "+  resolve(42);",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues).toHaveLength(0);
  });

  it("does not flag Promise wrap in comment", () => {
    const lines = [
      "+// new Promise((resolve, reject) => {",
      "+//   fs.readFile(path, callback);",
      "+// });",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues).toHaveLength(0);
  });

  it("detects new Promise wrapping child_process.exec", () => {
    const lines = [
      "+new Promise((resolve, reject) => {",
      "+  child_process.exec(cmd, (err, stdout) => {",
      "+    if (err) reject(err);",
      "+    else resolve(stdout);",
      "+  });",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// unhandled-callback-error
// ---------------------------------------------------------------------------

describe("unhandled-callback-error", () => {
  it("detects callback with unused err parameter", () => {
    const lines = [
      "+fs.readFile(path, (err, data) => {",
      "+  console.log(data);",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const errIssues = result.issues.filter((i) => i.category === "unhandled-callback-error");
    expect(errIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects function(err, data) with no error check", () => {
    const lines = [
      "+someApi(function(err, result) {",
      "+  processResult(result);",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const errIssues = result.issues.filter((i) => i.category === "unhandled-callback-error");
    expect(errIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag callback that checks err", () => {
    const lines = [
      "+db.query(sql, (err, result) => {",
      "+  if (err) throw err;",
      "+  return result;",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const errIssues = result.issues.filter((i) => i.category === "unhandled-callback-error");
    // Debug: show all issues
    if (errIssues.length > 0) {
      console.log('unhandled-callback-error issues:', errIssues.map(i => ({ line: i.line, code: i.code })));
    }
    expect(errIssues).toHaveLength(0);
  });

  it("does not flag callback that throws err", () => {
    const lines = [
      "+someApi(function(err, result) {",
      "+  if (err) throw new Error(err.message);",
      "+  return result;",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const errIssues = result.issues.filter((i) => i.category === "unhandled-callback-error");
    expect(errIssues).toHaveLength(0);
  });

  it("does not flag inline callback with error check", () => {
    const diffs = makeDiff([{ lines: ["+someApi((err, data) => { if (err) return; processData(data); })"] }]);
    const result = detectCallbackMisuse(diffs);
    const errIssues = result.issues.filter((i) => i.category === "unhandled-callback-error");
    expect(errIssues).toHaveLength(0);
  });

  it("detects (error, result) style callback", () => {
    const lines = [
      "+db.query(sql, (error, rows) => {",
      "+  return rows;",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const errIssues = result.issues.filter((i) => i.category === "unhandled-callback-error");
    expect(errIssues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// deprecated-callback-api
// ---------------------------------------------------------------------------

describe("deprecated-callback-api", () => {
  it("detects fs.readFile with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.readFile(path, 'utf8', function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.writeFile with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.writeFile(path, data, (err) => {})"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.mkdir with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.mkdir(dir, function(err) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.readdir with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.readdir(dir, (err, files) => {})"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.unlink with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.unlink(path, function(err) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag fs.promises.readFile", () => {
    const diffs = makeDiff([{ lines: ["+await fs.promises.readFile(path, 'utf8');"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues).toHaveLength(0);
  });

  it("does not flag fs.readFile in comment", () => {
    const diffs = makeDiff([{ lines: ["+// fs.readFile(path, callback)"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("detects fs.stat with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.stat(path, function(err, stats) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.access with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.access(path, (err) => {})"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.rename with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.rename(oldPath, newPath, function(err) {})"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
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
          { type: "add", content: "+fs.readFile(path, function(err, data) { })", line: 5 },
          { type: "add", content: "+fs.readFile(path, function(err, data) { })", line: 5 },
        ],
      }],
    }]);
    const result = detectCallbackMisuse(diffs as DiffFile[]);
    // Should dedup by category:file:line
    const seen = new Set<string>();
    for (const issue of result.issues) {
      const key = `${issue.category}:${issue.file}:${issue.line}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
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
      lines: ["+fs.readFile(path, function(err, data) { })"],
    }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple categories
// ---------------------------------------------------------------------------

describe("multiple categories", () => {
  it("detects issues from multiple categories in same file", () => {
    const lines = [
      "+fs.readFile(path, function(err, data) { })",
      "+new Promise((resolve, reject) => {",
      "+  fs.readFile(path, (err, data) => {",
      "+    if (err) reject(err);",
      "+    else resolve(data);",
      "+  });",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const cats = new Set(result.issues.map((i) => i.category));
    expect(cats.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe("sort order", () => {
  it("sorts by file path when same severity", () => {
    const diffs = makeDiff([
      { path: "src/z.ts", lines: ["+fs.readFile(a, function(err, data) { })"] },
      { path: "src/a.ts", lines: ["+fs.readFile(b, function(err, data) { })"] },
    ]);
    const result = detectCallbackMisuse(diffs);
    if (result.issues.length >= 2) {
      expect(result.issues[0].file.localeCompare(result.issues[1].file)).toBeLessThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Context text
// ---------------------------------------------------------------------------

describe("context text", () => {
  it("returns empty string when no issues", () => {
    const diffs = makeDiff([{ lines: ["+const x = 1;"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.contextText).toBe("");
  });

  it("includes header when issues found", () => {
    const diffs = makeDiff([{ lines: ["+fetch(url, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.contextText).toContain("Callback/Promise Misuse");
  });
});

// ---------------------------------------------------------------------------
// Body summary
// ---------------------------------------------------------------------------

describe("body summary", () => {
  it("returns empty string when no issues", () => {
    const diffs = makeDiff([{ lines: ["+const x = 1;"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.bodySummary).toBe("");
  });

  it("includes table with issue details", () => {
    const diffs = makeDiff([{ lines: ["+fetch(url, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.bodySummary).toContain("Callback/Promise Misuse Detection");
    expect(result.bodySummary).toContain("| Category |");
  });

  it("includes explanation paragraph", () => {
    const diffs = makeDiff([{ lines: ["+fetch(url, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.bodySummary).toContain("Callback/Promise mixing");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty diff", () => {
    const result = detectCallbackMisuse([]);
    expect(result.issues).toHaveLength(0);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("handles file with no added lines", () => {
    const diffs = makeDiff([{ lines: ["-fs.readFile(path, callback);"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag normal (unchanged) lines", () => {
    const diffs = makeDiff([{
      hunks: [{
        changes: [
          { type: "normal", content: " fs.readFile(path, function(err, data) { })", line: 5 },
        ],
      }],
    }]);
    const result = detectCallbackMisuse(diffs as DiffFile[]);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag import lines", () => {
    const diffs = makeDiff([{ lines: ["+import { readFile } from 'fs';"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag export lines", () => {
    const diffs = makeDiff([{ lines: ["+export const readFile = promisify(fs.readFile);"] }]);
    const result = detectCallbackMisuse(diffs);
    expect(result.issues).toHaveLength(0);
  });

  it("detects fs.rm with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.rm(path, function(err) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.copyFile with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.copyFile(src, dest, function(err) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.appendFile with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.appendFile(path, data, (err) => {})"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects crypto API inside new Promise wrapper", () => {
    const lines = [
      "+new Promise((resolve, reject) => {",
      "+  crypto.pbkdf2(password, salt, 1000, 64, (err, key) => {",
      "+    if (err) reject(err);",
      "+    else resolve(key);",
      "+  });",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects dns API inside new Promise wrapper", () => {
    const lines = [
      "+new Promise((resolve, reject) => {",
      "+  dns.resolve(hostname, (err, addresses) => {",
      "+    if (err) reject(err);",
      "+    else resolve(addresses);",
      "+  });",
      "+});",
    ];
    const diffs = makeDiff([{ path: "src/app.ts", lines }]);
    const result = detectCallbackMisuse(diffs);
    const wrapIssues = result.issues.filter((i) => i.category === "promise-callback-wrap");
    expect(wrapIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.watchFile with callback", () => {
    const diffs = makeDiff([{ lines: ["+fs.watchFile(path, function(err, stats) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    const depIssues = result.issues.filter((i) => i.category === "deprecated-callback-api");
    expect(depIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not double-flag same line for callback-promise-mix and deprecated-callback-api", () => {
    const diffs = makeDiff([{ lines: ["+fs.readFile(path, function(err, data) { })"] }]);
    const result = detectCallbackMisuse(diffs);
    // Line 1 should appear at most once per category
    const line1Issues = result.issues.filter((i) => i.line === 1);
    const catCounts = new Map<string, number>();
    for (const iss of line1Issues) {
      catCounts.set(iss.category, (catCounts.get(iss.category) || 0) + 1);
    }
    for (const count of catCounts.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });
});
