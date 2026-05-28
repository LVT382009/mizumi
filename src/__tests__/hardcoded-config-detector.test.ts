import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectHardcodedConfig } from "../hardcoded-config-detector.js";
import type { HardcodedConfigIssue, HardcodedConfigResult } from "../hardcoded-config-detector.js";
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

describe("detectHardcodedConfig — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = 'Alice';",
      "+const count = 42;",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+const API_URL = 'https://api.example.com/v2';",
    ], "deleted")];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag test files", () => {
    const files = [makeFile("src/app.test.ts", [
      "+fetch('https://api.prod.internal.com/data');",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag spec files", () => {
    const files = [makeFile("src/app.spec.ts", [
      "+const port = 3000;",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag config files", () => {
    const files = [makeFile("src/config.json", [
      "+{ \"port\": 3000 }",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag env files", () => {
    const files = [makeFile("src/.env", [
      "+PORT=3000",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag constant URL declarations", () => {
    const files = [makeFile("src/constants.ts", [
      "+export const API_BASE_URL = 'https://api.example.com/v2';",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag constant port declarations", () => {
    const files = [makeFile("src/constants.ts", [
      "+export const PORT = 3000;",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag github.com URLs", () => {
    const files = [makeFile("src/app.ts", [
      "+const repo = 'https://github.com/org/repo';",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag localhost URLs", () => {
    const files = [makeFile("src/app.ts", [
      "+const devUrl = 'http://localhost:3000/api';",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag npmjs.com URLs", () => {
    const files = [makeFile("src/app.ts", [
      "+const pkgUrl = 'https://www.npmjs.com/package/express';",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag process.env usage", () => {
    const files = [makeFile("src/app.ts", [
      "+const timeout = process.env.TIMEOUT || 5000;",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hardcoded URLs
// ---------------------------------------------------------------------------

describe("detectHardcodedConfig — hardcoded URLs", () => {
  it("detects hardcoded API URL in fetch call", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch('https://api.prod.internal.com/v2/data');",
    ])];
    const result = detectHardcodedConfig(files);
    const urls = result.issues.filter((i) => i.category === "hardcoded-url");
    expect(urls).toHaveLength(1);
    expect(urls[0].severity).toBe("warning");
  });

  it("detects hardcoded webhook URL", () => {
    const files = [makeFile("src/webhook.ts", [
      "+const webhook = 'https://hooks.slack.com/services/T00/B00/xxx';",
    ])];
    const result = detectHardcodedConfig(files);
    const urls = result.issues.filter((i) => i.category === "hardcoded-url");
    expect(urls).toHaveLength(1);
  });

  it("detects hardcoded database URL", () => {
    const files = [makeFile("src/db.ts", [
      "+const dbUrl = 'https://prod-db.cluster-abc.us-east-1.rds.amazonaws.com';",
    ])];
    const result = detectHardcodedConfig(files);
    const urls = result.issues.filter((i) => i.category === "hardcoded-url");
    expect(urls).toHaveLength(1);
  });

  it("detects hardcoded internal service URL", () => {
    const files = [makeFile("src/client.ts", [
      "+await post('https://billing.internal.corp.net/charge', payload);",
    ])];
    const result = detectHardcodedConfig(files);
    const urls = result.issues.filter((i) => i.category === "hardcoded-url");
    expect(urls).toHaveLength(1);
  });

  it("detects hardcoded analytics endpoint", () => {
    const files = [makeFile("src/analytics.ts", [
      "+sendToEndpoint('https://analytics.myapp.io/track');",
    ])];
    const result = detectHardcodedConfig(files);
    const urls = result.issues.filter((i) => i.category === "hardcoded-url");
    expect(urls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hardcoded ports
// ---------------------------------------------------------------------------

describe("detectHardcodedConfig — hardcoded ports", () => {
  it("detects hardcoded port in listen call", () => {
    const files = [makeFile("src/server.ts", [
      "+app.listen(3000);",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(1);
    expect(ports[0].severity).toBe("warning");
  });

  it("detects hardcoded port in createServer call", () => {
    const files = [makeFile("src/server.ts", [
      "+http.createServer(handler).listen(4200);",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(1);
  });

  it("detects hardcoded port in bind call", () => {
    const files = [makeFile("src/server.ts", [
      "+server.bind(3001);",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(1);
  });

  it("detects port as config property", () => {
    const files = [makeFile("src/db.ts", [
      "+port: 5433,",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(1);
  });

  it("does not flag well-known port 443 in listen", () => {
    const files = [makeFile("src/server.ts", [
      "+https.createServer(options, handler).listen(443);",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(0);
  });

  it("does not flag well-known port 80", () => {
    const files = [makeFile("src/server.ts", [
      "+server.listen(80);",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hardcoded limits
// ---------------------------------------------------------------------------

describe("detectHardcodedConfig — hardcoded limits", () => {
  it("detects MAX_RETRIES constant", () => {
    const files = [makeFile("src/retry.ts", [
      "+const MAX_RETRIES = 5;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects BATCH_SIZE constant", () => {
    const files = [makeFile("src/batch.ts", [
      "+const BATCH_SIZE = 100;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects default_timeout assignment", () => {
    const files = [makeFile("src/http.ts", [
      "+const default_timeout = 5000;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects TIMEOUT_MS constant", () => {
    const files = [makeFile("src/http.ts", [
      "+const TIMEOUT_MS = 30000;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects RATE_LIMIT constant", () => {
    const files = [makeFile("src/rate.ts", [
      "+const RATE_LIMIT = 1000;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects CONCURRENCY_LIMIT constant", () => {
    const files = [makeFile("src/pool.ts", [
      "+const CONCURRENCY_LIMIT = 10;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects retryCount = 3 hardcoded", () => {
    const files = [makeFile("src/app.ts", [
      "+const retryCount = 3;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects maxConnections = 50 hardcoded", () => {
    const files = [makeFile("src/pool.ts", [
      "+const maxConnections = 50;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects ttl = 3600 hardcoded", () => {
    const files = [makeFile("src/cache.ts", [
      "+const ttl = 3600;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects batchSize = 25 hardcoded", () => {
    const files = [makeFile("src/queue.ts", [
      "+const batchSize = 25;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hardcoded toggles
// ---------------------------------------------------------------------------

describe("detectHardcodedConfig — hardcoded toggles", () => {
  it("detects ENABLE_FEATURE flag", () => {
    const files = [makeFile("src/app.ts", [
      "+const ENABLE_FEATURE = true;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].severity).toBe("warning");
  });

  it("detects DEBUG flag", () => {
    const files = [makeFile("src/app.ts", [
      "+const DEBUG = false;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects VERBOSE flag", () => {
    const files = [makeFile("src/logger.ts", [
      "+const VERBOSE = true;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects DRY_RUN flag", () => {
    const files = [makeFile("src/app.ts", [
      "+const DRY_RUN = false;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects USE_CACHE config toggle", () => {
    const files = [makeFile("src/app.ts", [
      "+const USE_CACHE = true;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects enabled: true in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+enabled: true,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects debug: false in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+debug: false,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects dryRun: true in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+dryRun: true,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects requireAuth: true in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+requireAuth: true,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects allowRetry: false in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+allowRetry: false,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectHardcodedConfig — context and body", () => {
  it("generates context text with issues", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch('https://api.prod.internal.com/v2/data');",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.contextText).toContain("Hardcoded Configuration");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch('https://api.prod.internal.com/v2/data');",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.bodySummary).toContain("Hardcoded Configuration Detection");
    expect(result.bodySummary).toContain("<details>");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectHardcodedConfig — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-const API_URL = 'https://api.internal.com';",
      "+const x = 42;",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+fetch('https://api.prod.com/data');"]),
      makeFile("src/b.ts", ["+app.listen(4000);"]),
    ];
    const result = detectHardcodedConfig(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag import lines", () => {
    const files = [makeFile("src/app.ts", [
      "+import { config } from './config';",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+// Set timeout to 5000ms",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("deduplicates same category:file:line", () => {
    const files = [makeFile("src/app.ts", [
      "+const MAX_RETRIES = 3;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit" && i.line === 1);
    expect(limits).toHaveLength(1);
  });

  it("sorts by file and line", () => {
    const files = [
      makeFile("src/a.ts", ["+app.listen(3000);"]),
      makeFile("src/b.ts", ["+app.listen(3000);"]),
    ];
    const result = detectHardcodedConfig(files);
    expect(result.issues[0].file).toBe("src/a.ts");
    expect(result.issues[1].file).toBe("src/b.ts");
  });

  it("detects FORCE_SSL hardcoded toggle", () => {
    const files = [makeFile("src/app.ts", [
      "+const FORCE_SSL = true;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects SKIP_VALIDATION hardcoded toggle", () => {
    const files = [makeFile("src/app.ts", [
      "+const SKIP_VALIDATION = true;",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("detects MAX_CONNECTIONS hardcoded limit", () => {
    const files = [makeFile("src/pool.ts", [
      "+const MAX_CONNECTIONS = 20;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects strict: true in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+strict: true,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });

  it("does not flag example.com URLs", () => {
    const files = [makeFile("src/docs.ts", [
      "+const docsUrl = 'https://example.com/api-docs';",
    ])];
    const result = detectHardcodedConfig(files);
    const urls = result.issues.filter((i) => i.category === "hardcoded-url");
    expect(urls).toHaveLength(0);
  });

  it("does not flag __tests__ directory files", () => {
    const files = [makeFile("src/__tests__/api.test.ts", [
      "+fetch('https://api.prod.internal.com/v2/data');",
    ])];
    const result = detectHardcodedConfig(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects delay = 1000 hardcoded", () => {
    const files = [makeFile("src/queue.ts", [
      "+const delay = 1000;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("detects threshold = 500 hardcoded", () => {
    const files = [makeFile("src/monitor.ts", [
      "+const threshold = 500;",
    ])];
    const result = detectHardcodedConfig(files);
    const limits = result.issues.filter((i) => i.category === "hardcoded-limit");
    expect(limits).toHaveLength(1);
  });

  it("skips process.env.PORT for port detection", () => {
    const files = [makeFile("src/server.ts", [
      "+const port = process.env.PORT || 3000;",
    ])];
    const result = detectHardcodedConfig(files);
    const ports = result.issues.filter((i) => i.category === "hardcoded-port");
    expect(ports).toHaveLength(0);
  });

  it("detects mock: true in config object", () => {
    const files = [makeFile("src/app.ts", [
      "+mock: true,",
    ])];
    const result = detectHardcodedConfig(files);
    const toggles = result.issues.filter((i) => i.category === "hardcoded-toggle");
    expect(toggles).toHaveLength(1);
  });
});
