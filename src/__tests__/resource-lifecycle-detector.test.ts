import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectResourceLifecycleViolations } from "../resource-lifecycle-detector.js";
import type { ResourceLifecycleIssue, ResourceLifecycleResult } from "../resource-lifecycle-detector.js";
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

describe("detectResourceLifecycleViolations — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const data = await fetchData();",
      "+console.log(data);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+db.connect(connectionString);",
    ], "deleted")];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag code with proper cleanup", () => {
    const files = [makeFile("src/app.ts", [
      "+stream.open(path);",
      "+stream.close();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unclosed resources
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — unclosed resources", () => {
  it("detects createReadStream without close/end/destroy", () => {
    const files = [makeFile("src/files.ts", [
      "+const stream = fs.createReadStream(path);",
      "+stream.pipe(dest);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0].severity).toBe("critical");
  });

  it("detects createWriteStream without close/end/destroy", () => {
    const files = [makeFile("src/files.ts", [
      "+const ws = fs.createWriteStream(output);",
      "+ws.write(data);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(1);
  });

  it("does not flag when close is present", () => {
    const files = [makeFile("src/files.ts", [
      "+const stream = fs.createReadStream(path);",
      "+stream.on('end', () => stream.close());",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(0);
  });

  it("does not flag when destroy is present", () => {
    const files = [makeFile("src/files.ts", [
      "+const ws = fs.createWriteStream(output);",
      "+ws.destroy();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(0);
  });

  it("detects open without close", () => {
    const files = [makeFile("src/files.ts", [
      "+const fd = open('/tmp/data', 'r');",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Unreleased connections
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — unreleased connections", () => {
  it("detects mysql.createConnection without end/disconnect", () => {
    const files = [makeFile("src/db.ts", [
      "+const conn = mysql.createConnection(config);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
    expect(unreleased[0].severity).toBe("critical");
  });

  it("detects .connect() without .disconnect()", () => {
    const files = [makeFile("src/db.ts", [
      "+client.connect(host, port);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
  });

  it("detects redis.createClient without quit", () => {
    const files = [makeFile("src/cache.ts", [
      "+const redis = redis.createClient(url);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
  });

  it("does not flag when end/disconnect/release is present", () => {
    const files = [makeFile("src/db.ts", [
      "+const conn = mysql.createConnection(config);",
      "+conn.end();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(0);
  });

  it("does not flag when release is present", () => {
    const files = [makeFile("src/db.ts", [
      "+client.connect(host, port);",
      "+client.release();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unsubscribed listeners
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — unsubscribed listeners", () => {
  it("detects .on() without .off()", () => {
    const files = [makeFile("src/events.ts", [
      "+emitter.on('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(1);
    expect(unsub[0].severity).toBe("critical");
  });

  it("detects addEventListener without removeEventListener", () => {
    const files = [makeFile("src/ui.ts", [
      "+document.addEventListener('click', onClick);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(1);
  });

  it("detects .subscribe() without .unsubscribe()", () => {
    const files = [makeFile("src/rx.ts", [
      "+observable.subscribe(observer);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(1);
  });

  it("does not flag when off/removeEventListener is present", () => {
    const files = [makeFile("src/events.ts", [
      "+emitter.on('data', handler);",
      "+emitter.off('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(0);
  });

  it("does not flag when removeEventListener is present", () => {
    const files = [makeFile("src/ui.ts", [
      "+window.addEventListener('resize', onResize);",
      "+window.removeEventListener('resize', onResize);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing finally cleanup
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — missing finally", () => {
  it("detects try with resource acquire but no finally", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  const stream = fs.createReadStream(path);",
      "+  process(stream);",
      "+} catch (e) {",
      "+  logger.error(e);",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const missingFinally = result.issues.filter((i) => i.category === "missing-finally-cleanup");
    expect(missingFinally.length).toBeGreaterThanOrEqual(1);
    expect(missingFinally[0].severity).toBe("warning");
  });

  it("does not flag try with finally", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  const stream = fs.createReadStream(path);",
      "+  process(stream);",
      "+} finally {",
      "+  stream.close();",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const missingFinally = result.issues.filter((i) => i.category === "missing-finally-cleanup");
    expect(missingFinally).toHaveLength(0);
  });

  it("does not flag try without resource acquire", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  const result = compute();",
      "+} catch (e) {",
      "+  logger.error(e);",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const missingFinally = result.issues.filter((i) => i.category === "missing-finally-cleanup");
    expect(missingFinally).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// React missing cleanup
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — React missing cleanup", () => {
  it("detects useEffect with subscribe but no return cleanup", () => {
    const files = [makeFile("src/Component.tsx", [
      "+useEffect(() => {",
      "+  websocket.on('message', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
    expect(reactCleanup[0].severity).toBe("warning");
  });

  it("detects useEffect with addEventListener but no return cleanup", () => {
    const files = [makeFile("src/Hook.tsx", [
      "+useEffect(() => {",
      "+  window.addEventListener('resize', onResize);",
      "+}, [width]);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag useEffect with proper return cleanup", () => {
    const files = [makeFile("src/Component.tsx", [
      "+useEffect(() => {",
      "+  websocket.on('message', handler);",
      "+  return () => websocket.off('message', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup).toHaveLength(0);
  });

  it("does not flag useEffect without subscriptions", () => {
    const files = [makeFile("src/Component.tsx", [
      "+useEffect(() => {",
      "+  document.title = title;",
      "+}, [title]);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup).toHaveLength(0);
  });

  it("detects cleanup with return function syntax", () => {
    const files = [makeFile("src/Component.tsx", [
      "+useEffect(() => {",
      "+  emitter.on('event', handler);",
      "+  return function cleanup() {",
      "+    emitter.off('event', handler);",
      "+  };",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/app.ts", [
      "+emitter.on('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.contextText).toContain("Resource Lifecycle Violations");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+emitter.on('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.bodySummary).toContain("Resource Lifecycle Violations");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+emitter.on('data', handler);",
      "+try {",
      "+  const stream = fs.createReadStream(path);",
      "+} catch (e) {",
      "+  logger.error(e);",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    if (result.issues.some((i) => i.severity === "critical") && result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  const stream = fs.createReadStream(path);",
      "+} catch (e) {",
      "+  logger.error(e);",
      "+}",
      "+emitter.on('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
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

describe("detectResourceLifecycleViolations — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-emitter.on('data', handler);",
      "+const x = 42;",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+emitter.on('data', handler);"]),
      makeFile("src/b.ts", ["+client.connect(host);"]),
    ];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("skips comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+// emitter.on('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(0);
  });

  it("skips import lines", () => {
    const files = [makeFile("src/app.ts", [
      "+import { EventEmitter } from 'events';",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects .addListener() without .removeListener()", () => {
    const files = [makeFile("src/events.ts", [
      "+emitter.addListener('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(1);
  });

  it("does not flag when removeAllListeners is present", () => {
    const files = [makeFile("src/events.ts", [
      "+emitter.on('data', handler);",
      "+emitter.removeAllListeners();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    expect(unsub).toHaveLength(0);
  });

  it("detects mongoose.connect without disconnect", () => {
    const files = [makeFile("src/db.ts", [
      "+mongoose.connect(uri);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
  });

  it("does not run React cleanup detection on non-React files", () => {
    const files = [makeFile("src/server.py", [
      "+useEffect(() => {",
      "+  emitter.on('data', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup).toHaveLength(0);
  });

  it("detects pg.Pool without end", () => {
    const files = [makeFile("src/db.ts", [
      "+const pool = new pg.Pool(config);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased.length).toBeGreaterThanOrEqual(1);
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push(`+emitter${i}.on('event${i}', handler${i});`);
    }
    const files = [makeFile("src/events.ts", changes)];
    const result = detectResourceLifecycleViolations(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});

// ---------------------------------------------------------------------------
// Skip line patterns (false positive prevention)
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — skip line patterns", () => {
  it("skips block comment start lines (/* ... */)", () => {
    const files = [makeFile("src/app.ts", [
      "+/* emitter.on('data', handler); */",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips block comment continuation lines (* ...)", () => {
    const files = [makeFile("src/app.ts", [
      "+ * emitter.on('data', handler);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips export declaration lines even with .on() pattern", () => {
    const files = [makeFile("src/app.ts", [
      "+export const handler = emitter.on('data', cb);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type alias declarations with open() pattern", () => {
    const files = [makeFile("src/app.ts", [
      "+type StreamHandle = fs.open(path, 'r');",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips interface declarations with .open() pattern", () => {
    const files = [makeFile("src/app.ts", [
      "+interface FileStream { open(): void; close(): void; }",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips enum declarations", () => {
    const files = [makeFile("src/app.ts", [
      "+enum ConnectionStatus { Connected, Disconnected }",
    ])];
    const result = detectResourceLifecycleViolations(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unclosed resource edge cases
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — unclosed resource edge cases", () => {
  it("detects standalone openSync without closeSync", () => {
    const files = [makeFile("src/files.ts", [
      "+const fd = openSync('/tmp/data', 'r');",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag standalone openSync when closeSync is present", () => {
    const files = [makeFile("src/files.ts", [
      "+const fd = openSync('/tmp/data', 'r');",
      "+closeSync(fd);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(0);
  });

  it("does not flag createReadStream when .end() is present", () => {
    const files = [makeFile("src/files.ts", [
      "+const stream = fs.createReadStream(path);",
      "+stream.on('end', () => stream.end());",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(0);
  });

  it("detects .fopen() without .fclose()", () => {
    const files = [makeFile("src/files.ts", [
      "+const fp = libc.fopen('/var/log/app.log', 'a');",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(1);
    expect(unclosed[0].severity).toBe("critical");
  });

  it("does not flag .fopen() when .fclose() is present", () => {
    const files = [makeFile("src/files.ts", [
      "+const fp = libc.fopen('/var/log/app.log', 'a');",
      "+libc.fclose(fp);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Connection edge cases
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — connection edge cases", () => {
  it("detects amqp.connect() standalone", () => {
    const files = [makeFile("src/mq.ts", [
      "+amqp.connect(url);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
    expect(unreleased[0].severity).toBe("critical");
  });

  it("detects .socket() as connection acquire", () => {
    const files = [makeFile("src/net.ts", [
      "+const sock = io.socket(host, port);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
  });

  it("detects .createPool() as connection acquire", () => {
    const files = [makeFile("src/db.ts", [
      "+const pool = mysql.createPool(config);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
  });

  it("detects .acquire() as connection acquire", () => {
    const files = [makeFile("src/db.ts", [
      "+const conn = pool.acquire();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(1);
  });

  it("does not flag when .quit() is present (Redis release)", () => {
    const files = [makeFile("src/cache.ts", [
      "+const client = redis.createClient(url);",
      "+await client.quit();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(0);
  });

  it("does not flag when .endConnection() is present", () => {
    const files = [makeFile("src/db.ts", [
      "+client.connect(host, port);",
      "+client.endConnection();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unreleased = result.issues.filter((i) => i.category === "unreleased-connection");
    expect(unreleased).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication edge cases
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — deduplication", () => {
  it("deduplicates same category+file+line from multiple hunks", () => {
    const multiHunkFile: DiffFile = {
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      hunks: [
        {
          header: "@@ -1 +1 @@",
          changes: [
            { type: "add", content: "+emitter.on('data', handler);", line: 5 },
          ],
        },
        {
          header: "@@ -10 +10 @@",
          changes: [
            { type: "add", content: "+emitter.on('data', handler);", line: 5 },
          ],
        },
      ],
    };
    const result = detectResourceLifecycleViolations([multiHunkFile]);
    const unsub = result.issues.filter((i) => i.category === "unsubscribed-listener");
    // Same (category, file, line) appears from two hunks but gets deduped to one
    expect(unsub).toHaveLength(1);
  });

  it("does not deduplicate different categories at same file and line", () => {
    // A try block acquiring a resource at the same line triggers both
    // missing-finally-cleanup and unclosed-resource
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  const stream = fs.createReadStream(path);",
      "+} catch (e) {",
      "+  logger.error(e);",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const categories = new Set(result.issues.map((i) => i.category));
    // Both unclosed-resource and missing-finally-cleanup should appear
    expect(categories.has("unclosed-resource")).toBe(true);
    expect(categories.has("missing-finally-cleanup")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// React cleanup edge cases
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — React cleanup edge cases", () => {
  it("detects missing cleanup in .jsx files", () => {
    const files = [makeFile("src/Component.jsx", [
      "+useEffect(() => {",
      "+  websocket.on('message', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
  });

  it("detects missing cleanup in .ts files", () => {
    const files = [makeFile("src/hooks.ts", [
      "+useEffect(() => {",
      "+  bus.on('event', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
  });

  it("detects missing cleanup in .js files", () => {
    const files = [makeFile("src/hooks.js", [
      "+useEffect(() => {",
      "+  source.addEventListener('message', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
  });

  it("detects .addListener() in useEffect as missing cleanup", () => {
    const files = [makeFile("src/Component.tsx", [
      "+useEffect(() => {",
      "+  emitter.addListener('data', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
  });

  it("stops searching at next useEffect boundary", () => {
    const files = [makeFile("src/Component.tsx", [
      "+useEffect(() => {",
      "+  document.title = title;",
      "+}, [title]);",
      "+useEffect(() => {",
      "+  emitter.on('data', handler);",
      "+}, []);",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const reactCleanup = result.issues.filter((i) => i.category === "react-missing-cleanup");
    // Only the second useEffect with .on() should be flagged
    expect(reactCleanup.length).toBeGreaterThanOrEqual(1);
    // The first useEffect should NOT trigger a flag
    const firstEffectIssues = reactCleanup.filter((i) => i.code.includes("document.title"));
    expect(firstEffectIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing finally edge cases
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — missing finally edge cases", () => {
  it("detects try with .connect() acquire but no finally", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  client.connect(host, port);",
      "+} catch (e) {",
      "+  logger.error(e);",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const missingFinally = result.issues.filter((i) => i.category === "missing-finally-cleanup");
    expect(missingFinally.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag try-with-finally when finally appears before acquire", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+} finally {",
      "+  const stream = fs.createReadStream(path);",
      "+}",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const missingFinally = result.issues.filter((i) => i.category === "missing-finally-cleanup");
    expect(missingFinally).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Release/acquire interplay and false positive/negative documentation
// ---------------------------------------------------------------------------

describe("detectResourceLifecycleViolations — release/acquire interplay", () => {
  it("flags when release is in a deleted line (removal of cleanup)", () => {
    const files = [makeFile("src/app.ts", [
      "+stream.open(path);",
      "-stream.close();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    expect(unclosed).toHaveLength(1);
  });

  it("flags when release only exists in unchanged (normal) lines", () => {
    const files = [makeFile("src/app.ts", [
      "+const stream = fs.createReadStream(path);",
      " stream.close();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    // Normal lines are not added content, so the release is not found
    expect(unclosed).toHaveLength(1);
  });

  it("does not flag when two acquires exist but one release is present (known limitation)", () => {
    const files = [makeFile("src/app.ts", [
      "+const s1 = fs.createReadStream(a);",
      "+const s2 = fs.createReadStream(b);",
      "+s1.close();",
    ])];
    const result = detectResourceLifecycleViolations(files);
    const unclosed = result.issues.filter((i) => i.category === "unclosed-resource");
    // Detector only checks if ANY release exists in added content,
    // not whether it matches the specific acquire. This is a known limitation.
    expect(unclosed).toHaveLength(0);
  });
});
