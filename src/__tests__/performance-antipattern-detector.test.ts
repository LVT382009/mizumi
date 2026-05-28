import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectPerformanceAntiPatterns } from "../performance-antipattern-detector.js";
import type { PerfAntiPatternIssue, PerfAntiPatternResult } from "../performance-antipattern-detector.js";
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

describe("detectPerformanceAntiPatterns — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const data = await query(sql);",
      "+const cached = cache.get(key);",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+const data = readFileSync(path);",
    ], "deleted")];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// N+1 queries
// ---------------------------------------------------------------------------

describe("detectPerformanceAntiPatterns — N+1 queries", () => {
  it("detects query inside for loop", () => {
    const files = [makeFile("src/api.ts", [
      "+for (const id of ids) {",
      "+  const item = await query(`SELECT * FROM items WHERE id = ${id}`);",
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === "n-plus-1-query");
    expect(nplus1).toHaveLength(1);
    expect(nplus1[0].severity).toBe("critical");
  });

  it("detects query inside forEach", () => {
    const files = [makeFile("src/db.ts", [
      "+items.forEach((item) => {",
      "+  save(item);",
      "+});",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === "n-plus-1-query");
    expect(nplus1).toHaveLength(1);
  });

  it("detects fetch inside map", () => {
    const files = [makeFile("src/api.ts", [
      "+const results = ids.map((id) => {",
      "+  return fetch(`/api/items/${id}`);",
      "+});",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === "n-plus-1-query");
    expect(nplus1).toHaveLength(1);
  });

  it("does not flag query outside loop", () => {
    const files = [makeFile("src/api.ts", [
      "+const result = await query(sql);",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === "n-plus-1-query");
    expect(nplus1).toHaveLength(0);
  });

  it("detects findById inside while loop", () => {
    const files = [makeFile("src/db.ts", [
      "+while (hasMore) {",
      "+  const doc = await findById(cursor);",
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === "n-plus-1-query");
    expect(nplus1).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sync I/O in async context
// ---------------------------------------------------------------------------

describe("detectPerformanceAntiPatterns — sync in async", () => {
  it("detects readFileSync in async function", () => {
    const files = [makeFile("src/files.ts", [
      "+async function loadConfig() {",
      "+  const data = readFileSync(configPath, 'utf-8');",
      "+  return JSON.parse(data);",
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === "sync-in-async");
    expect(syncIo).toHaveLength(1);
    expect(syncIo[0].severity).toBe("critical");
  });

  it("detects writeFileSync in async arrow", () => {
    const files = [makeFile("src/files.ts", [
      "+const save = async () => {",
      "+  writeFileSync(path, content);",
      "+};",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === "sync-in-async");
    expect(syncIo).toHaveLength(1);
  });

  it("detects existsSync as warning outside async", () => {
    const files = [makeFile("src/files.ts", [
      "+if (existsSync(path)) {",
      "+  loadFile(path);",
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === "sync-in-async");
    expect(syncIo).toHaveLength(1);
    expect(syncIo[0].severity).toBe("warning");
  });

  it("detects mkdirSync", () => {
    const files = [makeFile("src/files.ts", [
      "+async function ensureDir() {",
      "+  mkdirSync(dirPath, { recursive: true });",
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === "sync-in-async");
    expect(syncIo).toHaveLength(1);
  });

  it("does not flag async readFile", () => {
    const files = [makeFile("src/files.ts", [
      "+const data = await readFile(path, 'utf-8');",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === "sync-in-async");
    expect(syncIo).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Waterfall awaits
// ---------------------------------------------------------------------------

describe("detectPerformanceAntiPatterns — waterfall awaits", () => {
  it("detects two sequential independent awaits", () => {
    const files = [makeFile("src/api.ts", [
      "+const users = await fetchUsers();",
      "+const orders = await fetchOrders();",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const waterfall = result.issues.filter((i) => i.category === "waterfall-await");
    expect(waterfall).toHaveLength(1);
    expect(waterfall[0].severity).toBe("warning");
  });

  it("does not flag a single await", () => {
    const files = [makeFile("src/api.ts", [
      "+const data = await fetch(url);",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const waterfall = result.issues.filter((i) => i.category === "waterfall-await");
    expect(waterfall).toHaveLength(0);
  });

  it("does not flag dependent awaits (same source)", () => {
    const files = [makeFile("src/api.ts", [
      "+const token = await getToken();",
      "+const data = await getToken();", // same function — might be intentional
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const waterfall = result.issues.filter((i) => i.category === "waterfall-await");
    expect(waterfall).toHaveLength(0);
  });

  it("detects waterfall across three awaits", () => {
    const files = [makeFile("src/api.ts", [
      "+const a = await fetchA();",
      "+const b = await fetchB();",
      "+const c = await fetchC();",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const waterfall = result.issues.filter((i) => i.category === "waterfall-await");
    // Should flag at least the first pair
    expect(waterfall.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Unnecessary await
// ---------------------------------------------------------------------------

describe("detectPerformanceAntiPatterns — unnecessary await", () => {
  it("detects await on numeric literal", () => {
    const files = [makeFile("src/app.ts", [
      "+const value = await 42;",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === "unnecessary-await");
    expect(unnecessary).toHaveLength(1);
    expect(unnecessary[0].severity).toBe("warning");
  });

  it("detects await on string literal", () => {
    const files = [makeFile("src/app.ts", [
      '+const name = await "hello";',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === "unnecessary-await");
    expect(unnecessary).toHaveLength(1);
  });

  it("detects await on JSON.parse", () => {
    const files = [makeFile("src/app.ts", [
      "+const obj = await JSON.parse(text);",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === "unnecessary-await");
    expect(unnecessary).toHaveLength(1);
  });

  it("does not flag await on fetch (legitimate)", () => {
    const files = [makeFile("src/app.ts", [
      "+const data = await fetch(url);",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === "unnecessary-await");
    expect(unnecessary).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectPerformanceAntiPatterns — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/api.ts", [
      "+for (const id of ids) {",
      "+  await query(sql);",
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.contextText).toContain("Performance Anti-Patterns");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/api.ts", [
      "+const a = await fetchA();",
      "+const b = await fetchB();",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.bodySummary).toContain("Performance Anti-Patterns");
    expect(result.bodySummary).toContain("<details>");
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectPerformanceAntiPatterns — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+const a = await fetchA();",
      "+const b = await fetchB();",   // warning (waterfall)
      "+async function load() {",      // ...
      "+  const data = readFileSync(p);", // critical (sync-in-async)
      "+}",
    ])];
    const result = detectPerformanceAntiPatterns(files);
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

describe("detectPerformanceAntiPatterns — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// const data = readFileSync(path);",
      "+const data = await readFile(path);",
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === "sync-in-async");
    expect(syncIo).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", [
        "+for (const id of ids) {",
        "+  await query(sql);",
        "+}",
      ]),
      makeFile("src/b.ts", [
        "+const a = await fnA();",
        "+const b = await fnB();",
      ]),
    ];
    const result = detectPerformanceAntiPatterns(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — additional coverage
// ---------------------------------------------------------------------------

describe('detectPerformanceAntiPatterns — edge cases (expanded)', () => {
  it('detects execute inside reduce', () => {
    const files = [makeFile('src/db.ts', [
      '+items.reduce((acc, item) => {',
      '+  execute(sql);',
      '+  return acc;',
      '+}, 0);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === 'n-plus-1-query');
    expect(nplus1.length).toBeGreaterThanOrEqual(1);
  });

  it('detects save inside filter', () => {
    const files = [makeFile('src/orm.ts', [
      '+items.filter((item) => {',
      '+ save(item);',
      '+ return item.active;',
      '+});',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === 'n-plus-1-query');
    expect(nplus1.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag query outside of loop', () => {
    const files = [makeFile('src/api.ts', [
      '+const result = await query(sql);',
      '+const items = await fetch(url);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const nplus1 = result.issues.filter((i) => i.category === 'n-plus-1-query');
    expect(nplus1).toHaveLength(0);
  });

  it('detects readdirSync', () => {
    const files = [makeFile('src/files.ts', [
      '+async function listFiles() {',
      '+ const entries = readdirSync(dir);',
      '+}',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === 'sync-in-async');
    expect(syncIo.length).toBeGreaterThanOrEqual(1);
  });

  it('detects copyFileSync outside async', () => {
    const files = [makeFile('src/files.ts', [
      '+copyFileSync(src, dst);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === 'sync-in-async');
    expect(syncIo.length).toBeGreaterThanOrEqual(1);
    expect(syncIo[0].severity).toBe('warning');
  });

  it('detects waterfall with let assignments', () => {
    const files = [makeFile('src/api.ts', [
      '+let users = await fetchUsers();',
      '+let orders = await fetchOrders();',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const waterfall = result.issues.filter((i) => i.category === 'waterfall-await');
    expect(waterfall.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag waterfall with await on same function', () => {
    const files = [makeFile('src/api.ts', [
      '+const page1 = await fetchPage(1);',
      '+const page2 = await fetchPage(2);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const waterfall = result.issues.filter((i) => i.category === 'waterfall-await');
    // Same function — might be intentional pagination
    expect(waterfall).toHaveLength(0);
  });

  it('detects unnecessary await on Object.keys', () => {
    const files = [makeFile('src/app.ts', [
      '+const keys = await Object.keys(obj);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === 'unnecessary-await');
    expect(unnecessary.length).toBeGreaterThanOrEqual(1);
  });

  it('detects unnecessary await on Math.max', () => {
    const files = [makeFile('src/app.ts', [
      '+const max = await Math.max(a, b);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === 'unnecessary-await');
    expect(unnecessary.length).toBeGreaterThanOrEqual(1);
  });

  it('skips comments for unnecessary await', () => {
    const files = [makeFile('src/app.ts', [
      '+// await 42 is fine in comments',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === 'unnecessary-await');
    expect(unnecessary).toHaveLength(0);
  });

  it('detects statSync in async context', () => {
    const files = [makeFile('src/files.ts', [
      '+async function checkFile() {',
      '+ const info = statSync(filepath);',
      '+ return info.isFile();',
      '+}',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const syncIo = result.issues.filter((i) => i.category === 'sync-in-async');
    expect(syncIo.length).toBeGreaterThanOrEqual(1);
    expect(syncIo[0].severity).toBe('critical');
  });

  it('generates context with both critical and warning sections', () => {
    const files = [makeFile('src/api.ts', [
      '+async function run() {',
      '+ const data = readFileSync(p);',
      '+}',
      '+const a = await fetchA();',
      '+const b = await fetchB();',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    if (result.issues.some((i) => i.severity === 'critical') && result.issues.some((i) => i.severity === 'warning')) {
      expect(result.contextText).toContain('Critical');
      expect(result.contextText).toContain('Warnings');
    }
  });

  it('detects unnecessary await on Boolean()', () => {
    const files = [makeFile('src/app.ts', [
      '+const flag = await Boolean(value);',
    ])];
    const result = detectPerformanceAntiPatterns(files);
    const unnecessary = result.issues.filter((i) => i.category === 'unnecessary-await');
    expect(unnecessary.length).toBeGreaterThanOrEqual(1);
  });
});
