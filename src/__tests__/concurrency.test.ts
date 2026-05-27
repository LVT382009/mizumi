import { describe, it, expect, vi } from "vitest";
import {
  analyzeConcurrency,
  buildConcurrencyContext,
  formatConcurrencySummary,
} from "../concurrency.js";
import type { DiffFile } from "../diff.js";
import type { ConcurrencyHazard, ConcurrencyAnalysisResult } from "../concurrency.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(path: string, addedLines: string[]): DiffFile {
  return {
    path,
    status: "modified" as const,
    additions: addedLines.length,
    deletions: 0,
    hunks: [{
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: addedLines.length,
      content: "",
      changes: addedLines.map((content, i) => ({
        type: "add" as const,
        line: i + 1,
        oldLine: 0,
        content,
      })),
    }],
  };
}

// ---------------------------------------------------------------------------
// analyzeConcurrency — shared mutable state
// ---------------------------------------------------------------------------

describe("analyzeConcurrency — shared mutable state", () => {
  it("detects module-level Map declaration", () => {
    const files = [makeDiffFile("src/cache.ts", [
      "const cache = new Map<string, number>();",
      "export function getCache() { return cache; }",
    ])];
    const result = analyzeConcurrency(files);
    expect(result.hazards.length).toBeGreaterThanOrEqual(1);
    expect(result.hazards[0].kind).toBe("shared-mutable-state");
    expect(result.hazards[0].variable).toBe("cache");
  });

  it("detects module-level Set declaration", () => {
    const files = [makeDiffFile("src/registry.ts", [
      "const activeUsers = new Set<string>();",
    ])];
    const result = analyzeConcurrency(files);
    const shared = result.hazards.filter((h) => h.kind === "shared-mutable-state" && h.variable === "activeUsers");
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });

  it("detects module-level array declaration", () => {
    const files = [makeDiffFile("src/queue.ts", [
      "const queue = [];",
    ])];
    const result = analyzeConcurrency(files);
    const shared = result.hazards.filter((h) => h.kind === "shared-mutable-state" && h.variable === "queue");
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });

  it("detects mutation of shared state in async function", () => {
    const files = [makeDiffFile("src/processor.ts", [
      "const results = new Map();",
      "",
      "async function process(item) {",
      "  results.set(item.id, item.value);",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const mutations = result.hazards.filter((h) => h.kind === "shared-mutable-state" && h.variable === "results");
    expect(mutations.length).toBeGreaterThanOrEqual(1);
  });

  it("detects array push on shared state", () => {
    const files = [makeDiffFile("src/queue.ts", [
      "const queue = [];",
      "",
      "async function enqueue(item) {",
      "  queue.push(item);",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const mutations = result.hazards.filter((h) => h.kind === "shared-mutable-state" && h.variable === "queue");
    expect(mutations.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag non-code files", () => {
    const files = [makeDiffFile("README.md", [
      "const data = new Map();",
    ])];
    const result = analyzeConcurrency(files);
    expect(result.hazards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeConcurrency — check-then-act (TOCTOU)
// ---------------------------------------------------------------------------

describe("analyzeConcurrency — check-then-act", () => {
  it("detects null-check then assign in async", () => {
    const files = [makeDiffFile("src/singleton.ts", [
      "async function getInstance() {",
      "  if (!instance) {",
      "    instance = await createInstance();",
      "  }",
      "  return instance;",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const toctou = result.hazards.filter((h) => h.kind === "check-then-act");
    expect(toctou.length).toBeGreaterThanOrEqual(1);
  });

  it("detects collection check-then-mutate in async", () => {
    const files = [makeDiffFile("src/cache.ts", [
      "async function updateCache(key, value) {",
      "  if (!cache.has(key)) {",
      "    cache.set(key, await computeValue(value));",
      "  }",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const toctou = result.hazards.filter((h) => h.kind === "check-then-act");
    expect(toctou.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeConcurrency — event loop blocking
// ---------------------------------------------------------------------------

describe("analyzeConcurrency — event loop blocking", () => {
  it("detects readFileSync in async function", () => {
    const files = [makeDiffFile("src/loader.ts", [
      "async function loadData(path) {",
      "  const data = fs.readFileSync(path, 'utf8');",
      "  return JSON.parse(data);",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const blocking = result.hazards.filter((h) => h.kind === "event-loop-block");
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking[0].evidence).toContain("readFileSync");
  });

  it("detects execSync in async function", () => {
    const files = [makeDiffFile("src/runner.ts", [
      "async function runCommand(cmd) {",
      "  const output = execSync(cmd, { encoding: 'utf8' });",
      "  return output.trim();",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const blocking = result.hazards.filter((h) => h.kind === "event-loop-block");
    expect(blocking.length).toBeGreaterThanOrEqual(1);
  });

  it("detects synchronous crypto in async function", () => {
    const files = [makeDiffFile("src/auth.ts", [
      "async function hashPassword(password) {",
      "  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512');",
      "  return hash.toString('hex');",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const blocking = result.hazards.filter((h) => h.kind === "event-loop-block" && h.evidence.includes("pbkdf2Sync"));
    expect(blocking.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag sync calls outside async functions", () => {
    const files = [makeDiffFile("src/config.ts", [
      "function loadConfig() {",
      "  return fs.readFileSync('/etc/config.json', 'utf8');",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const blocking = result.hazards.filter((h) => h.kind === "event-loop-block");
    // Should not flag since the function is synchronous (no async keyword)
    expect(blocking.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeConcurrency — error swallowing
// ---------------------------------------------------------------------------

describe("analyzeConcurrency — error swallowing", () => {
  it("detects empty catch block", () => {
    const files = [makeDiffFile("src/handler.ts", [
      "try {",
      "  await doSomething();",
      "} catch (e) {",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const swallowed = result.hazards.filter((h) => h.kind === "error-swallowed");
    expect(swallowed.length).toBeGreaterThanOrEqual(1);
  });

  it("detects empty .catch() handler", () => {
    const files = [makeDiffFile("src/api.ts", [
      "fetch(url).then(r => r.json()).catch(() => {});",
    ])];
    const result = analyzeConcurrency(files);
    const swallowed = result.hazards.filter((h) => h.kind === "error-swallowed");
    expect(swallowed.length).toBeGreaterThanOrEqual(1);
  });

  it("detects .catch(() => null)", () => {
    const files = [makeDiffFile("src/api.ts", [
      "const data = await fetch(url).catch(() => null);",
    ])];
    const result = analyzeConcurrency(files);
    const swallowed = result.hazards.filter((h) => h.kind === "error-swallowed");
    expect(swallowed.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeConcurrency — lock ordering
// ---------------------------------------------------------------------------

describe("analyzeConcurrency — lock ordering", () => {
  it("detects lock ordering violation between two sequences", () => {
    const files = [makeDiffFile("src/transfer.ts", [
      "async function transferA() {",
      "  await lockA.acquire();",
      "  await lockB.acquire();",
      "  // do work",
      "  lockB.release();",
      "  lockA.release();",
      "}",
      "",
      "async function transferB() {",
      "  await lockB.acquire();",
      "  await lockA.acquire();",
      "  // do work",
      "  lockA.release();",
      "  lockB.release();",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    const lockViolations = result.hazards.filter((h) => h.kind === "lock-ordering");
    expect(lockViolations.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeConcurrency — general
// ---------------------------------------------------------------------------

describe("analyzeConcurrency — general", () => {
  it("returns empty result for no code files", () => {
    const files = [makeDiffFile("style.css", [".red { color: red; }"])];
    const result = analyzeConcurrency(files);
    expect(result.hazards).toHaveLength(0);
  });

  it("returns empty result for clean code", () => {
    const files = [makeDiffFile("src/pure.ts", [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    expect(result.hazards).toHaveLength(0);
  });

  it("counts files and hunks", () => {
    const files = [
      makeDiffFile("src/a.ts", ["const x = 1;"]),
      makeDiffFile("src/b.ts", ["const y = 2;"]),
    ];
    const result = analyzeConcurrency(files);
    expect(result.fileCount).toBe(2);
    expect(result.hunkCount).toBe(2);
  });

  it("sorts hazards by confidence descending", () => {
    const files = [makeDiffFile("src/mixed.ts", [
      "const cache = new Map();",
      "async function process() {",
      "  if (!cache.has('key')) {",
      "    cache.set('key', await compute());",
      "  }",
      "  fs.readFileSync('/etc/data');",
      "} catch (e) {",
      "}",
    ])];
    const result = analyzeConcurrency(files);
    for (let i = 1; i < result.hazards.length; i++) {
      expect(result.hazards[i - 1].confidence).toBeGreaterThanOrEqual(result.hazards[i].confidence);
    }
  });

  it("deduplicates hazards at same location", () => {
    const files = [makeDiffFile("src/dup.ts", [
      "const cache = new Map();",
    ])];
    const result = analyzeConcurrency(files);
    const sameKey = result.hazards.filter((h) => h.file === "src/dup.ts" && h.kind === "shared-mutable-state");
    // Should not have duplicates at same file+line+kind
    const keys = sameKey.map((h) => `${h.kind}:${h.file}:${h.line}:${h.variable}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("analyzes Python files", () => {
    const files = [makeDiffFile("src/worker.py", [
      "results = {}",
      "",
      "async def process(item):",
      "    results[item.id] = item.value",
    ])];
    const result = analyzeConcurrency(files);
    expect(result.hazards.length).toBeGreaterThanOrEqual(1);
  });

  it("analyzes Go files", () => {
    const files = [makeDiffFile("src/handler.go", [
      "var cache = make(map[string]string)",
    ])];
    const result = analyzeConcurrency(files);
    expect(result.hazards.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// buildConcurrencyContext
// ---------------------------------------------------------------------------

describe("buildConcurrencyContext", () => {
  it("returns empty string for no hazards", () => {
    const ctx = buildConcurrencyContext({ hazards: [], fileCount: 1, hunkCount: 1 });
    expect(ctx).toBe("");
  });

  it("returns empty string for only low-confidence hazards", () => {
    const result: ConcurrencyAnalysisResult = {
      hazards: [{
        kind: "shared-mutable-state",
        file: "a.ts",
        line: 1,
        variable: "x",
        message: "Low confidence",
        confidence: 30,
        evidence: "let x = {}",
      }],
      fileCount: 1,
      hunkCount: 1,
    };
    const ctx = buildConcurrencyContext(result);
    expect(ctx).toBe("");
  });

  it("includes high-confidence hazards in context", () => {
    const result: ConcurrencyAnalysisResult = {
      hazards: [{
        kind: "event-loop-block",
        file: "src/loader.ts",
        line: 3,
        message: "Synchronous read in async function",
        confidence: 90,
        evidence: "fs.readFileSync(path)",
      }],
      fileCount: 1,
      hunkCount: 1,
    };
    const ctx = buildConcurrencyContext(result);
    expect(ctx).toContain("Concurrency Hazards Detected");
    expect(ctx).toContain("event-loop-block");
    expect(ctx).toContain("90%");
  });

  it("limits to 10 hazards in context", () => {
    const hazards: ConcurrencyHazard[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "shared-mutable-state" as const,
      file: `src/file${i}.ts`,
      line: i + 1,
      variable: `var${i}`,
      message: `Hazard ${i}`,
      confidence: 80,
      evidence: `const var${i} = new Map()`,
    }));
    const ctx = buildConcurrencyContext({ hazards, fileCount: 15, hunkCount: 15 });
    expect(ctx).toContain("5 more");
  });
});

// ---------------------------------------------------------------------------
// formatConcurrencySummary
// ---------------------------------------------------------------------------

describe("formatConcurrencySummary", () => {
  it("returns empty string for no hazards", () => {
    const text = formatConcurrencySummary({ hazards: [], fileCount: 1, hunkCount: 1 });
    expect(text).toBe("");
  });

  it("wraps in details block", () => {
    const result: ConcurrencyAnalysisResult = {
      hazards: [{
        kind: "shared-mutable-state",
        file: "a.ts",
        line: 1,
        message: "Module-level Map",
        confidence: 85,
        evidence: "const cache = new Map()",
      }],
      fileCount: 1,
      hunkCount: 1,
    };
    const text = formatConcurrencySummary(result);
    expect(text).toContain("<details>");
    expect(text).toContain("</details>");
  });

  it("includes kind counts table", () => {
    const result: ConcurrencyAnalysisResult = {
      hazards: [
        { kind: "shared-mutable-state", file: "a.ts", line: 1, message: "M1", confidence: 80, evidence: "e1" },
        { kind: "shared-mutable-state", file: "a.ts", line: 5, message: "M2", confidence: 75, evidence: "e2" },
        { kind: "event-loop-block", file: "b.ts", line: 3, message: "B1", confidence: 90, evidence: "e3" },
      ],
      fileCount: 2,
      hunkCount: 2,
    };
    const text = formatConcurrencySummary(result);
    expect(text).toContain("shared-mutable-state");
    expect(text).toContain("event-loop-block");
  });

  it("includes high-confidence details", () => {
    const result: ConcurrencyAnalysisResult = {
      hazards: [{
        kind: "check-then-act",
        file: "src/singleton.ts",
        line: 5,
        message: "TOCTOU race on singleton",
        confidence: 85,
        evidence: "if (!instance) { instance = await create(); }",
      }],
      fileCount: 1,
      hunkCount: 1,
    };
    const text = formatConcurrencySummary(result);
    expect(text).toContain("High-Confidence");
    expect(text).toContain("85%");
    expect(text).toContain("singleton.ts");
  });

  it("omits high-confidence section when all are low", () => {
    const result: ConcurrencyAnalysisResult = {
      hazards: [{
        kind: "shared-mutable-state",
        file: "a.ts",
        line: 1,
        message: "Low",
        confidence: 40,
        evidence: "let x = {}",
      }],
      fileCount: 1,
      hunkCount: 1,
    };
    const text = formatConcurrencySummary(result);
    expect(text).not.toContain("High-Confidence");
  });
});
