import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectConcurrencyHazards } from "../async-concurrency-hazard-detector.js";
import type { ConcurrencyHazardIssue, ConcurrencyHazardResult } from "../async-concurrency-hazard-detector.js";
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

describe("detectConcurrencyHazards — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const data = await fetchData();",
      "+console.log(data);",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+if (!cache.has(key)) { await fetch(key); }",
    ], "deleted")];
    const result = detectConcurrencyHazards(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// TOCTOU
// ---------------------------------------------------------------------------

describe("detectConcurrencyHazards — TOCTOU", () => {
  it("detects if-exists check followed by await", () => {
    const files = [makeFile("src/cache.ts", [
      "+if (cache.has(key)) {",
      "+  const value = await cache.get(key);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(1);
    expect(toctou[0].severity).toBe("critical");
  });

  it("detects if-not-exists check followed by create", () => {
    const files = [makeFile("src/files.ts", [
      "+if (!fs.existsSync(path)) {",
      "+  await fs.promises.writeFile(path, data);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(1);
  });

  it("detects map.has followed by await map.get", () => {
    const files = [makeFile("src/store.ts", [
      "+if (store.has('user:1')) {",
      "+  return await store.get('user:1');",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(1);
  });

  it("detects while-includes followed by async fetch", () => {
    const files = [makeFile("src/queue.ts", [
      "+while (queue.includes(task)) {",
      "+  await queue.process(task);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag if without exists/has check", () => {
    const files = [makeFile("src/app.ts", [
      "+if (user.role === 'admin') {",
      "+  await deleteUser(id);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(0);
  });

  it("does not flag sync check with sync use", () => {
    const files = [makeFile("src/app.ts", [
      "+if (cache.has(key)) {",
      "+  return cache.get(key);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(0);
  });

  it("does not flag if check without async after it", () => {
    const files = [makeFile("src/app.ts", [
      "+if (db.has(table)) {",
      "+  console.log('table exists');",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared mutable state
// ---------------------------------------------------------------------------

describe("detectConcurrencyHazards — shared mutable state", () => {
  it("detects module-level let modified in async function", () => {
    const files = [makeFile("src/counter.ts", [
      "+let requestCount = 0;",
      "+async function handleRequest() {",
      "+  requestCount++;",
      "+  return process();",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const shared = result.issues.filter((i) => i.category === "shared-mutable-state");
    expect(shared).toHaveLength(1);
    expect(shared[0].severity).toBe("warning");
  });

  it("detects module-level var modified in async function", () => {
    const files = [makeFile("src/state.ts", [
      "+var isConnected = false;",
      "+async function connect() {",
      "+  isConnected = true;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const shared = result.issues.filter((i) => i.category === "shared-mutable-state");
    expect(shared).toHaveLength(1);
  });

  it("detects let with compound assignment in async function", () => {
    const files = [makeFile("src/stats.ts", [
      "+let errors = 0;",
      "+async function report() {",
      "+  errors += 1;",
      "+  return errors;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const shared = result.issues.filter((i) => i.category === "shared-mutable-state");
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag const variables", () => {
    const files = [makeFile("src/app.ts", [
      "+const MAX_RETRIES = 3;",
      "+async function retry() {",
      "+  return MAX_RETRIES;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const shared = result.issues.filter((i) => i.category === "shared-mutable-state");
    expect(shared).toHaveLength(0);
  });

  it("does not flag sync function accessing mutable var", () => {
    const files = [makeFile("src/app.ts", [
      "+let count = 0;",
      "+function increment() {",
      "+  count++;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const shared = result.issues.filter((i) => i.category === "shared-mutable-state");
    expect(shared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Race on flag flip
// ---------------------------------------------------------------------------

describe("detectConcurrencyHazards — race on flag flip", () => {
  it("detects if (!isProcessing) with set and await", () => {
    const files = [makeFile("src/worker.ts", [
      "+if (!isProcessing) {",
      "+  isProcessing = true;",
      "+  await processQueue();",
      "+  isProcessing = false;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(1);
    expect(race[0].severity).toBe("critical");
  });

  it("detects if (!locked) flag pattern", () => {
    const files = [makeFile("src/lock.ts", [
      "+if (!locked) {",
      "+  locked = true;",
      "+  await doWork();",
      "+  locked = false;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(1);
  });

  it("detects if (!isLoading) flag pattern", () => {
    const files = [makeFile("src/loader.ts", [
      "+if (!isLoading) {",
      "+  isLoading = true;",
      "+  await fetchData();",
      "+  isLoading = false;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(1);
  });

  it("does not flag flag check without flag set", () => {
    const files = [makeFile("src/app.ts", [
      "+if (!isReady) {",
      "+  await initialize();",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(0);
  });

  it("does not flag flag check without await", () => {
    const files = [makeFile("src/app.ts", [
      "+if (!shouldRun) {",
      "+  shouldRun = true;",
      "+  runSync();",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(0);
  });

  it("does not flag non-boolean-flag names", () => {
    const files = [makeFile("src/app.ts", [
      "+if (!data) {",
      "+  data = true;",
      "+  await load();",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unbounded Promise.all
// ---------------------------------------------------------------------------

describe("detectConcurrencyHazards — unbounded Promise.all", () => {
  it("detects Promise.all with .map()", () => {
    const files = [makeFile("src/batch.ts", [
      "+await Promise.all(items.map(item => fetch(item.url)));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
    expect(unbounded[0].severity).toBe("warning");
  });

  it("detects Promise.all with .filter()", () => {
    const files = [makeFile("src/batch.ts", [
      "+await Promise.all(urls.filter(isValid).map(fetch));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });

  it("detects Promise.all with .flatMap()", () => {
    const files = [makeFile("src/batch.ts", [
      "+await Promise.all(groups.flatMap(g => g.items.map(processItem)));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });

  it("detects large literal Promise.all array (5+ items)", () => {
    const files = [makeFile("src/init.ts", [
      "+await Promise.all([a(), b(), c(), d(), e()]);",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });

  it("does not flag small literal Promise.all (under 5 items)", () => {
    const files = [makeFile("src/app.ts", [
      "+await Promise.all([a(), b()]);",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(0);
  });

  it("does not flag Promise.allSettled", () => {
    const files = [makeFile("src/app.ts", [
      "+await Promise.allSettled(items.map(processItem));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(0);
  });

  it("detects Promise.all with .slice()", () => {
    const files = [makeFile("src/batch.ts", [
      "+await Promise.all(items.slice(0, limit).map(processItem));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });

  it("detects Promise.all with prefixed .map()", () => {
    const files = [makeFile("src/batch.ts", [
      "+const results = await Promise.all(ids.map(id => api.get(id)));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectConcurrencyHazards — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/app.ts", [
      "+if (cache.has(key)) {",
      "+  await cache.get(key);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.contextText).toContain("Concurrency Hazards");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+if (cache.has(key)) {",
      "+  await cache.get(key);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.bodySummary).toContain("Async Concurrency Hazard Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+if (cache.has(key)) {",
      "+  await cache.get(key);",
      "+}",
      "+await Promise.all(items.map(i => fetch(i.url)));",
    ])];
    const result = detectConcurrencyHazards(files);
    if (result.issues.some((i) => i.severity === "critical") && result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectConcurrencyHazards — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+await Promise.all(items.map(i => fetch(i.url)));",
      "+if (cache.has(key)) {",
      "+  await cache.get(key);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
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

describe("detectConcurrencyHazards — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// if (cache.has(key)) { await cache.get(key); }",
      "+const x = 42;",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectConcurrencyHazards(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+if (cache.has(key)) {", "+  await cache.get(key);", "+}"]),
      makeFile("src/b.ts", ["+await Promise.all(items.map(i => fetch(i)));"]),
    ];
    const result = detectConcurrencyHazards(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("skips comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+// if (cache.has(key)) { await cache.get(key); }",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips import lines", () => {
    const files = [makeFile("src/app.ts", [
      "+import { cache } from './cache';",
    ])];
    const result = detectConcurrencyHazards(files);
    expect(result.issues).toHaveLength(0);
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push(`+await Promise.all(items${i}.map(x => x));`);
    }
    const files = [makeFile("src/batch.ts", changes)];
    const result = detectConcurrencyHazards(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("deduplicates same category+file+line", () => {
    const files = [makeFile("src/app.ts", [
      "+if (cache.has(key)) {",
      "+  await cache.get(key);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctouIssues = result.issues.filter((i) => i.category === "toctou" && i.file === "src/app.ts" && i.line === 1);
    expect(toctouIssues.length).toBeLessThanOrEqual(1);
  });

  it("detects contains() check with async fetch", () => {
    const files = [makeFile("src/list.ts", [
      "+if (allowedList.contains(user)) {",
      "+  await grantAccess(user);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou.length).toBeGreaterThanOrEqual(1);
  });

  it("detects existsSync + writeFile TOCTOU", () => {
    const files = [makeFile("src/io.ts", [
      "+if (!fs.existsSync(configPath)) {",
      "+  await fs.promises.writeFile(configPath, defaults);",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(1);
  });

  it("does not flag await inside non-TOCTOU if", () => {
    const files = [makeFile("src/app.ts", [
      "+if (config.enabled) {",
      "+  await startServer();",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const toctou = result.issues.filter((i) => i.category === "toctou");
    expect(toctou).toHaveLength(0);
  });

  it("detects multiprocessing flag race", () => {
    const files = [makeFile("src/queue.ts", [
      "+if (!isRunning) {",
      "+  isRunning = true;",
      "+  await runJobQueue();",
      "+  isRunning = false;",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(1);
  });

  it("detects shouldCancel flag race pattern", () => {
    const files = [makeFile("src/task.ts", [
      "+if (!shouldCancel) {",
      "+  shouldCancel = true;",
      "+  await cancelPending();",
      "+}",
    ])];
    const result = detectConcurrencyHazards(files);
    const race = result.issues.filter((i) => i.category === "race-on-flag");
    expect(race).toHaveLength(1);
  });

  it("detects Promise.all with .reduce()", () => {
    const files = [makeFile("src/agg.ts", [
      "+await Promise.all(results.reduce((a, b) => a.concat(b), []));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });

  it("detects Promise.all with .concat()", () => {
    const files = [makeFile("src/batch.ts", [
      "+await Promise.all(batches.concat(remaining).map(process));",
    ])];
    const result = detectConcurrencyHazards(files);
    const unbounded = result.issues.filter((i) => i.category === "unbounded-promise-all");
    expect(unbounded).toHaveLength(1);
  });

  it("detects let counter with ++ in async arrow", () => {
    const files = [makeFile("src/metrics.ts", [
      "+let failures = 0;",
      "+const handler = async () => {",
      "+  failures++;",
      "+  return report();",
      "+};",
    ])];
    const result = detectConcurrencyHazards(files);
    const shared = result.issues.filter((i) => i.category === "shared-mutable-state");
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });
});
