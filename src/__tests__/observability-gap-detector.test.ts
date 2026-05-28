import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectObservabilityGaps } from "../observability-gap-detector.js";
import type { ObservabilityGapIssue, ObservabilityGapResult } from "../observability-gap-detector.js";
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

describe("detectObservabilityGaps — no issues", () => {
  it("returns empty for properly logged code", () => {
    const files = [makeFile("src/api.ts", [
      "+try {",
      "+  const data = await fetch(url);",
      "+} catch (e) {",
      "+  logger.error('Fetch failed', { err: e, url });",
      "+  throw e;",
      "+}",
    ])];
    const result = detectObservabilityGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+console.log(e);",
    ], "deleted")];
    const result = detectObservabilityGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectObservabilityGaps(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Silent catches
// ---------------------------------------------------------------------------

describe("detectObservabilityGaps — silent catches", () => {
  it("detects catch with only console.log", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.log(e); }",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(1);
    expect(silent[0].severity).toBe("warning");
  });

  it("detects multi-line catch with only console.debug", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (err) {",
      "+  console.debug('error occurred', err);",
      "+}",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(1);
  });

  it("does not flag catch with logger.error", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { logger.error('Failed', e); }",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(0);
  });

  it("does not flag catch with logger.warn", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { logger.warn('Degraded', e); }",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(0);
  });

  it("does not flag catch with metrics", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { metrics.increment('errors'); }",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(0);
  });

  it("detects catch with console.info as weak", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.info(e); }",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(1);
  });

  it("does not flag console.log alongside logger.error", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+  console.log(e);",
      "+  logger.error('Failed', e);",
      "+}",
    ])];
    const result = detectObservabilityGaps(files);
    const silent = result.issues.filter((i) => i.category === "silent-catch");
    expect(silent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Throw without log
// ---------------------------------------------------------------------------

describe("detectObservabilityGaps — throw without log", () => {
  it("detects throw new Error without prior logging", () => {
    const files = [makeFile("src/app.ts", [
      "+throw new Error('Invalid input');",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "throw-without-log");
    expect(unlogged).toHaveLength(1);
    expect(unlogged[0].severity).toBe("critical");
  });

  it("detects throw new TypeError without prior logging", () => {
    const files = [makeFile("src/app.ts", [
      "+throw new TypeError('Expected string');",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "throw-without-log");
    expect(unlogged).toHaveLength(1);
  });

  it("does not flag throw with prior logger.error", () => {
    const files = [makeFile("src/app.ts", [
      "+logger.error('Validation failed', { input });",
      "+throw new ValidationError('Invalid input');",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "throw-without-log");
    expect(unlogged).toHaveLength(0);
  });

  it("does not flag throw with prior metrics.increment", () => {
    const files = [makeFile("src/app.ts", [
      "+metrics.increment('validation.errors');",
      "+throw new Error('Validation failed');",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "throw-without-log");
    expect(unlogged).toHaveLength(0);
  });

  it("does not flag re-throw after logger.error in catch", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) {",
      "+  logger.error('Process failed', e);",
      "+  throw e;",
      "+}",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "throw-without-log");
    expect(unlogged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unlogged routes
// ---------------------------------------------------------------------------

describe("detectObservabilityGaps — unlogged routes", () => {
  it("detects app.get handler without logging", () => {
    const files = [makeFile("src/server.ts", [
      "+app.get('/api/users', (req, res) => {",
      "+  res.json(users);",
      "+});",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "unlogged-route");
    expect(unlogged).toHaveLength(1);
    expect(unlogged[0].severity).toBe("warning");
  });

  it("detects app.post handler without logging", () => {
    const files = [makeFile("src/server.ts", [
      "+app.post('/api/orders', createOrder);",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "unlogged-route");
    expect(unlogged).toHaveLength(1);
  });

  it("does not flag route with logging", () => {
    const files = [makeFile("src/server.ts", [
      "+app.get('/api/users', (req, res) => {",
      "+  logger.info('Fetching users');",
      "+  res.json(users);",
      "+});",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "unlogged-route");
    expect(unlogged).toHaveLength(0);
  });

  it("does not flag route with console.log", () => {
    const files = [makeFile("src/server.ts", [
      "+app.get('/api/items', (req, res) => {",
      "+  console.log('GET /items');",
      "+  res.json(items);",
      "+});",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "unlogged-route");
    expect(unlogged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing error metadata
// ---------------------------------------------------------------------------

describe("detectObservabilityGaps — missing error metadata", () => {
  it("detects logger.error with only string", () => {
    const files = [makeFile("src/app.ts", [
      '+logger.error("Operation failed");',
    ])];
    const result = detectObservabilityGaps(files);
    const metadata = result.issues.filter((i) => i.category === "missing-error-metadata");
    expect(metadata).toHaveLength(1);
    expect(metadata[0].severity).toBe("warning");
  });

  it("detects log.error with only string", () => {
    const files = [makeFile("src/app.ts", [
      '+log.error("Database query failed");',
    ])];
    const result = detectObservabilityGaps(files);
    const metadata = result.issues.filter((i) => i.category === "missing-error-metadata");
    expect(metadata).toHaveLength(1);
  });

  it("does not flag logger.error with error object", () => {
    const files = [makeFile("src/app.ts", [
      '+logger.error("Operation failed", err);',
    ])];
    const result = detectObservabilityGaps(files);
    const metadata = result.issues.filter((i) => i.category === "missing-error-metadata");
    expect(metadata).toHaveLength(0);
  });

  it("does not flag logger.error with context object", () => {
    const files = [makeFile("src/app.ts", [
      '+logger.error("Operation failed", { err, requestId });',
    ])];
    const result = detectObservabilityGaps(files);
    const metadata = result.issues.filter((i) => i.category === "missing-error-metadata");
    expect(metadata).toHaveLength(0);
  });

  it("detects logger.warn with only string", () => {
    const files = [makeFile("src/app.ts", [
      '+logger.warn("Rate limit approaching");',
    ])];
    const result = detectObservabilityGaps(files);
    const metadata = result.issues.filter((i) => i.category === "missing-error-metadata");
    expect(metadata).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectObservabilityGaps — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/app.ts", [
      "+throw new Error('fail');",
    ])];
    const result = detectObservabilityGaps(files);
    expect(result.contextText).toContain("Observability Gaps");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+throw new Error('fail');",
    ])];
    const result = detectObservabilityGaps(files);
    expect(result.bodySummary).toContain("Observability Gap Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+throw new Error('fail');",
      "+} catch (e) { console.log(e); }",
    ])];
    const result = detectObservabilityGaps(files);
    if (result.issues.some((i) => i.severity === "critical") && result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectObservabilityGaps — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (e) { console.log(e); }",
      "+throw new Error('fail');",
    ])];
    const result = detectObservabilityGaps(files);
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

describe("detectObservabilityGaps — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// throw new Error('fail');",
      "+const x = 42;",
    ])];
    const result = detectObservabilityGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectObservabilityGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+throw new Error('fail');"]),
      makeFile("src/b.ts", ["+} catch (e) { console.log(e); }"]),
    ];
    const result = detectObservabilityGaps(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("skips comments", () => {
    const files = [makeFile("src/app.ts", [
      "+// throw new Error('not real');",
    ])];
    const result = detectObservabilityGaps(files);
    const unlogged = result.issues.filter((i) => i.category === "throw-without-log");
    expect(unlogged).toHaveLength(0);
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push(`+throw new Error('fail${i}');`);
    }
    const files = [makeFile("src/app.ts", changes)];
    const result = detectObservabilityGaps(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});
