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
});
