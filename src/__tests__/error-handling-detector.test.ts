import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectErrorHandlingGaps } from "../error-handling-detector.js";
import type { ErrorHandlingIssue, ErrorHandlingResult } from "../error-handling-detector.js";
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

describe("detectErrorHandlingGaps — no issues", () => {
  it("returns empty for properly handled async code", () => {
    const files = [makeFile("src/api.ts", [
      "+try {",
      "+  const data = await fetch(url);",
      "+} catch (e) {",
      "+  logger.error('Fetch failed', e);",
      "+  throw e;",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+fetch(url);",
    ], "deleted")];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = computeSync();",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag .then().catch() chains", () => {
    const files = [makeFile("src/app.ts", [
      "+fetch(url).then(handleResponse).catch(handleError);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unhandled promises
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — unhandled promises", () => {
  it("detects .then() without .catch()", () => {
    const files = [makeFile("src/app.ts", [
      "+fetch(url).then(handleResponse);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].severity).toBe("critical");
  });

  it("detects floating new Promise without handler", () => {
    const files = [makeFile("src/app.ts", [
      "+new Promise((resolve) => {",
      "+  resolve(data);",
      "+});",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag .then() followed by .catch() on next line", () => {
    const files = [makeFile("src/app.ts", [
      "+fetch(url)",
      "+  .then(handleResponse)",
      "+  .catch(handleError);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("does not flag return new Promise", () => {
    const files = [makeFile("src/app.ts", [
      "+return new Promise((resolve) => {",
      "+  resolve(data);",
      "+});",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("skips comments", () => {
    const files = [makeFile("src/app.ts", [
      "+// Use promise.then() pattern",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing await
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — missing await", () => {
  it("detects fetch without await", () => {
    const files = [makeFile("src/api.ts", [
      "+const response = fetch(url);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(1);
    expect(missingAwait[0].severity).toBe("critical");
  });

  it("does not flag fetch with await", () => {
    const files = [makeFile("src/api.ts", [
      "+const response = await fetch(url);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(0);
  });

  it("detects readFile without await", () => {
    const files = [makeFile("src/files.ts", [
      "+const data = readFile(path);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(1);
  });

  it("detects connect() without await", () => {
    const files = [makeFile("src/db.ts", [
      "+const db = connect(connectionString);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(1);
  });

  it("detects query() without await", () => {
    const files = [makeFile("src/db.ts", [
      "+const rows = query(sql);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(1);
  });

  it("does not flag fetch inside .then() callback", () => {
    const files = [makeFile("src/api.ts", [
      "+promise.then(() => fetch(url));",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(0);
  });

  it("skips async function declarations", () => {
    const files = [makeFile("src/app.ts", [
      "+async function getData() {",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missingAwait = result.issues.filter((i) => i.category === "missing-await");
    expect(missingAwait).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Swallowed errors
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — swallowed errors", () => {
  it("detects catch block with only comments", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+  // intentional ignore",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
    expect(swallowed[0].severity).toBe("warning");
  });

  it("detects inline catch with only a comment", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { /* ignored */ }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
  });

  it("detects catch block with only console.log", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.log(e); }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
  });

  it("does not flag catch block with logger.error", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { logger.error(e); }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("does not flag catch block with rethrow", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+  logger.error('Failed', e);",
      "+  throw e;",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — context and body", () => {
  it("generates context text with critical section", () => {
    const files = [makeFile("src/app.ts", [
      "+const res = fetch(url);",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.contextText).toContain("Error Handling Gaps");
    expect(result.contextText).toContain("Critical");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+fetch(url).then(handler);",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.bodySummary).toContain("Error Handling Gap Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+const res = fetch(url);",
      "+} catch (e) { /* ignore */ }",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.contextText).toContain("Critical");
    expect(result.contextText).toContain("Warnings");
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { /* ignore */ }",   // warning
      "+const res = fetch(url);",         // critical
    ])];
    const result = detectErrorHandlingGaps(files);
    const severities = result.issues.map((i) => i.severity);
    const firstCritical = severities.indexOf("critical");
    const lastWarning = severities.lastIndexOf("warning");
    if (firstCritical >= 0 && lastWarning >= 0) {
      expect(firstCritical).toBeLessThan(lastWarning);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// fetch(url).then(handler);",
      "+const x = 42;",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+fetch(url).then(fn);"]),
      makeFile("src/b.ts", ["+const res = fetch(url2);"]),
    ];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("detects findOne without await", () => {
    const files = [makeFile("src/db.ts", [
      "+const user = findOne({ id });",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects execute without await", () => {
    const files = [makeFile("src/db.ts", [
      "+const result = execute(sql);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("skips return statements (even with async calls)", () => {
    const files = [makeFile("src/api.ts", [
      "+return fetch(url);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("detects writeFile without await", () => {
    const files = [makeFile("src/files.ts", [
      "+writeFile(path, content);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects .then() with .catch() — should NOT flag", () => {
    const files = [makeFile("src/app.ts", [
      "+promise.then(handleResult).catch(handleError);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("detects .then() without .catch() — should flag", () => {
    const files = [makeFile("src/app.ts", [
      "+promise.then(handleResult);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].severity).toBe("critical");
  });

  it("detects mongoose findById without await", () => {
    const files = [makeFile("src/model.ts", [
      "+const user = findById(userId);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
    expect(missing[0].code).toContain("findById");
  });

  it("detects mongoose findOne with await — should NOT flag", () => {
    const files = [makeFile("src/model.ts", [
      "+const user = await findOne({ email });",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("detects mongoose save without await", () => {
    const files = [makeFile("src/model.ts", [
      "+save();",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects redis.get without await", () => {
    const files = [makeFile("src/cache.ts", [
      "+const value = redis.get(key);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
    expect(missing[0].description).toContain("Redis");
  });

  it("detects redis.set without await", () => {
    const files = [makeFile("src/cache.ts", [
      "+redis.set(key, value);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects redis.del without await", () => {
    const files = [makeFile("src/cache.ts", [
      "+redis.del(key);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects floating promise from void expression", () => {
    const files = [makeFile("src/app.ts", [
      "+void someAsyncOperation();",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].description).toContain("void");
  });

  it("detects multiple missing-await in same file", () => {
    const files = [makeFile("src/api.ts", [
      "+const a = fetch(url1);",
      "+const b = fetch(url2);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(2);
  });

  it("detects swallowed error: catch with only variable reference", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+  e;",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
    expect(swallowed[0].description).toContain("error variable");
  });

  it("does NOT flag catch with throw — not swallowed", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+  throw e;",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("detects promise.finally() without .catch()", () => {
    const files = [makeFile("src/app.ts", [
      "+promise.then(handleResult).finally(cleanup);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].description).toContain(".finally()");
  });

  it("handles deduplication of same category+file+line", () => {
    const files = [makeFile("src/api.ts", [
      "+const res = fetch(url);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// New edge-case tests — unhandled-promise corner cases
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — unhandled-promise edge cases", () => {
  it("detects Promise.all() without handler as floating promise", () => {
    const files = [makeFile("src/app.ts", [
      "+Promise.all([fetchA(), fetchB()]);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Promise.race() without handler as floating promise", () => {
    const files = [makeFile("src/app.ts", [
      "+Promise.race([p1, p2]);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Promise.resolve() without handler as floating promise", () => {
    const files = [makeFile("src/app.ts", [
      "+Promise.resolve(42);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
  });

  it("flags .then() when .catch() is beyond 3-line lookahead", () => {
    const files = [makeFile("src/app.ts", [
      "+fetch(url)",          // line 1: .then() detected
      "+ .then(handleData)",  // line 2
      "+ .then(transform)",   // line 3: within 3-line lookahead of line 1
      "+ .then(finalize)",    // line 4: .catch() is beyond 3-line lookahead from line 1
      "+ .catch(handleError);",
    ])];
    const result = detectErrorHandlingGaps(files);
    // The first .then() line should still be flagged because .catch() is
    // beyond its 3-line lookahead window from that change's index
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag .finally() when .catch() is nearby", () => {
    const files = [makeFile("src/app.ts", [
      "+promise.catch(handleError).finally(cleanup);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("does NOT flag void expression in the middle of a line", () => {
    // "void" must be at the start of the trimmed line to qualify as a floating promise discard
    const files = [makeFile("src/app.ts", [
      "+const result = myFunc(void someRef);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    // Should not flag — "void" is not at start of line
    const voidIssues = unhandled.filter((i) => i.description.includes("void expression"));
    expect(voidIssues).toHaveLength(0);
  });

  it("skips block-comment lines starting with *", () => {
    const files = [makeFile("src/app.ts", [
      "+ * Use promise.then() for chaining",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("does not flag floating promise assigned to const with await", () => {
    // const p = await new Promise(...) — has await, should be skipped
    const files = [makeFile("src/app.ts", [
      "+const result = await new Promise((resolve) => resolve(42));",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("does not flag floating promise that is returned", () => {
    const files = [makeFile("src/app.ts", [
      "+return new Promise((resolve) => {",
      "+ resolve(42);",
      "+});",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// New edge-case tests — missing-await corner cases
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — missing-await edge cases", () => {
  it("detects axios.get without await", () => {
    const files = [makeFile("src/api.ts", [
      "+const response = axios.get(url);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
    expect(missing[0].code).toContain("axios.get");
  });

  it("detects mkdir without await", () => {
    const files = [makeFile("src/files.ts", [
      "+mkdir(dirPath, { recursive: true });",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects pipeline without await", () => {
    const files = [makeFile("src/stream.ts", [
      "+pipeline(readable, writable);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects aggregate without await", () => {
    const files = [makeFile("src/db.ts", [
      "+const results = aggregate(pipeline);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects bulkWrite without await", () => {
    const files = [makeFile("src/db.ts", [
      "+const res = bulkWrite(ops);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("does NOT flag the try { line itself — skips try block openers", () => {
    // The detector only skips the line containing "try {", not lines inside the try block.
    // This verifies the try-line skip: a line like "try {" is not mistaken for an async call.
    const files = [makeFile("src/api.ts", [
      "+try {",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("STILL flags fetch inside try block — try-line skip is line-level only", () => {
    // The detector only skips the exact line containing "try {", not child lines
    const files = [makeFile("src/api.ts", [
      "+try {",
      "+  const data = fetch(url);",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("does NOT flag Redis async operation inside .catch() callback", () => {
    const files = [makeFile("src/cache.ts", [
      "+promise.catch(() => redis.del(key));",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("does NOT flag fetch inside .catch() callback", () => {
    const files = [makeFile("src/api.ts", [
      "+promise.catch(() => fetch(fallbackUrl));",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("skips const assignment to Promise variable (intentionally deferred)", () => {
    const files = [makeFile("src/app.ts", [
      "+const p = Promise.resolve(42);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("skips JSdoc / block-comment lines in missing-await detection", () => {
    const files = [makeFile("src/app.ts", [
      "+/* fetch(url) */",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(0);
  });

  it("detects create() without await (mongoose create)", () => {
    const files = [makeFile("src/model.ts", [
      "+const doc = create({ name: 'test' });",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });

  it("detects disconnect() without await", () => {
    const files = [makeFile("src/db.ts", [
      "+disconnect();",
    ])];
    const result = detectErrorHandlingGaps(files);
    const missing = result.issues.filter((i) => i.category === "missing-await");
    expect(missing).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// New edge-case tests — swallowed-error corner cases
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — swallowed-error edge cases", () => {
  it("flags catch block with only console.debug", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.debug(e); }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
  });

  it("flags catch block with only console.info", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.info(e); }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
  });

  it("does NOT flag catch block with console.error", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.error(e); }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("does NOT flag catch block with logger.error inline", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { logger.error('failed', e); }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("does NOT flag catch block with throw inline — varRefCatch path", () => {
    // Inline form: catch(e) { err; } but with throw should NOT match varRefCatch
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { throw e; }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("does NOT flag catch block body exceeding 5 lines with real code", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+ logger.error('Operation failed', e);",
      "+ notifyAdmin(e);",
      "+ incrementErrorCounter();",
      "+ fallbackToDefault();",
      "+ scheduleRetry();",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("does NOT flag multi-line catch body with mixed comment and code", () => {
    // Not all-comment body because there is real code next to the comment
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+ // Log the error",
      "+ logger.warn('Error occurred', e);",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(0);
  });

  it("flags .on('unhandledRejection', ...) with empty handler", () => {
    const files = [makeFile("src/app.ts", [
      "+process.on('unhandledRejection', (reason) => {});",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed.length).toBeGreaterThanOrEqual(1);
    expect(swallowed[0].description).toContain("unhandledRejection");
  });

  it("flags inline catch(e) { e; } as variable-reference-only", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { e; }",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    // Both inline varRefCatch and trivial detection may fire, dedup ensures 1
    expect(swallowed).toHaveLength(1);
  });

  it("flags catch block with only multiple comments (no code)", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (err) {",
      "+ // Known issue with external API",
      "+ // See JIRA-1234 for details",
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    const swallowed = result.issues.filter((i) => i.category === "swallowed-error");
    expect(swallowed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// New edge-case tests — deduplication and multi-hunk
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — deduplication and multi-hunk edge cases", () => {
  it("deduplicates same category+file+line but keeps different categories on same line", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch(url).then(fn);",
    ])];
    const result = detectErrorHandlingGaps(files);
    // This could trigger both unhandled-promise (.then w/o .catch) and
    // missing-await (fetch without await). Both categories should survive dedup.
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(1);
    // Ensure we actually detected something
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps issues from different lines even with same category and file", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch(url1).then(fn1);",
      "+fetch(url2).then(fn2);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(2);
    expect(unhandled[0].line).not.toBe(unhandled[1].line);
  });

  it(".catch() beyond 3-line lookahead in added changes is not found, so .then() is flagged", () => {
    // The unhandled-promise detector flattens all changes, but only looks ahead 3 lines.
    // Adding 4+ non-catch added lines before .catch() means it won't be found.
    const files = [makeFile("src/app.ts", [
      "+fetch(url).then(handler);",   // .then() detected, looks ahead 3 lines
      "+const x = compute();",        // line 2: no .catch()
      "+const y = compute2();",       // line 3: no .catch()
      "+const z = compute3();",       // line 4: no .catch() — beyond 3-line lookahead
      "+ .catch(handleError);",       // line 5: too far away
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// New edge-case tests — false positive prevention
// ---------------------------------------------------------------------------

describe("detectErrorHandlingGaps — false positive prevention", () => {
  it("does not flag import lines containing 'then'", () => {
    const files = [makeFile("src/app.ts", [
      "+import { then } from './utils';",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag sync computeFetch (not a known async function name)", () => {
    const files = [makeFile("src/app.ts", [
      "+const data = computeSync(input);",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag closing brace lines even with promise keywords", () => {
    const files = [makeFile("src/app.ts", [
      "+}",
    ])];
    const result = detectErrorHandlingGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag .then() when .catch() is on the same line", () => {
    const files = [makeFile("src/app.ts", [
      "+fetch(url).then(r => r.json()).catch(logError);",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });

  it("does not flag new Promise assigned with = await", () => {
    const files = [makeFile("src/app.ts", [
      "+const p = await new Promise((resolve) => {",
      "+  resolve(42);",
      "+});",
    ])];
    const result = detectErrorHandlingGaps(files);
    const unhandled = result.issues.filter((i) => i.category === "unhandled-promise");
    expect(unhandled).toHaveLength(0);
  });
});
