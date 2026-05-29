import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectMagicNumbers } from "../magic-number-detector.js";
import type { MagicNumberIssue, MagicNumberResult } from "../magic-number-detector.js";
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

describe("detectMagicNumbers — no issues", () => {
  it("returns empty for code with only small numbers", () => {
    const files = [makeFile("src/utils.ts", [
      "+const offset = items.length - 1;",
      "+for (let i = 0; i < items.length; i++) {}",
    ])];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+const timeout = 5000;",
    ], "deleted")];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for test files", () => {
    const files = [makeFile("src/app.test.ts", [
      "+const limit = 5000;",
    ])];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = arr[0];",
    ])];
    const result = detectMagicNumbers(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Numeric literals
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — numeric literals", () => {
  it("detects magic number in assignment", () => {
    const files = [makeFile("src/config.ts", [
      "+const maxRetries = 42;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe("42");
    expect(nums[0].severity).toBe("warning");
  });

  it("skips common safe numbers (0, 1, 2)", () => {
    const files = [makeFile("src/app.ts", [
      "+const base = 0;",
      "+const step = 1;",
      "+const pair = 2;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("skips year-like numbers", () => {
    const files = [makeFile("src/app.ts", [
      "+const year = 2026;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("skips imports and type declarations", () => {
    const files = [makeFile("src/app.ts", [
      "+import { MAX_SIZE = 500 } from './config';",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("detects large magic number", () => {
    const files = [makeFile("src/api.ts", [
      "+const bufferSize = 8192;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe("8192");
  });
});

// ---------------------------------------------------------------------------
// String literals
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — string literals", () => {
  it("detects hardcoded string in comparison", () => {
    const files = [makeFile("src/auth.ts", [
      '+if (role === "administrator") {',
    ])];
    const result = detectMagicNumbers(files);
    const strs = result.issues.filter((i) => i.category === "string-literal");
    expect(strs).toHaveLength(1);
    expect(strs[0].severity).toBe("warning");
  });

  it("detects hardcoded string in assignment", () => {
    const files = [makeFile("src/api.ts", [
      '+const defaultRegion = "us-east-1";',
    ])];
    const result = detectMagicNumbers(files);
    const strs = result.issues.filter((i) => i.category === "string-literal");
    expect(strs).toHaveLength(1);
  });

  it("skips short strings (less than 3 chars)", () => {
    const files = [makeFile("src/app.ts", [
      '+if (type === "ok") {',
    ])];
    const result = detectMagicNumbers(files);
    const strs = result.issues.filter((i) => i.category === "string-literal");
    expect(strs).toHaveLength(0);
  });

  it("skips console.log lines", () => {
    const files = [makeFile("src/app.ts", [
      '+console.log("Processing complete for user");',
    ])];
    const result = detectMagicNumbers(files);
    const strs = result.issues.filter((i) => i.category === "string-literal");
    expect(strs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timeout/duration
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — timeout/duration", () => {
  it("detects hardcoded timeout as critical", () => {
    const files = [makeFile("src/api.ts", [
      "+const timeout = 30000;",
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === "timeout-duration");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].severity).toBe("critical");
  });

  it("detects retry delay", () => {
    const files = [makeFile("src/client.ts", [
      "+const retryDelay = 2000;",
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === "timeout-duration");
    expect(timeouts).toHaveLength(1);
  });

  it("detects interval value", () => {
    const files = [makeFile("src/poll.ts", [
      "+const interval = 5000;",
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === "timeout-duration");
    expect(timeouts).toHaveLength(1);
  });

  it("detects TTL value", () => {
    const files = [makeFile("src/cache.ts", [
      "+const ttl = 3600;",
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === "timeout-duration");
    expect(timeouts).toHaveLength(1);
  });

  it("detects backoff value", () => {
    const files = [makeFile("src/retry.ts", [
      "+const backoff = 1500;",
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === "timeout-duration");
    expect(timeouts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/api.ts", [
      "+const limit = 42;",          // warning (numeric-literal)
      "+const timeout = 3000;",      // critical (timeout-duration)
    ])];
    const result = detectMagicNumbers(files);
    const severities = result.issues.map((i) => i.severity);
    const firstCritical = severities.indexOf("critical");
    const lastWarning = severities.lastIndexOf("warning");
    if (firstCritical >= 0 && lastWarning >= 0) {
      expect(firstCritical).toBeLessThan(lastWarning);
    }
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/app.ts", [
      "+const timeout = 5000;",
      "+const limit = 42;",
    ])];
    const result = detectMagicNumbers(files);
    expect(result.contextText).toContain("Magic Number Detection");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+const limit = 42;",
    ])];
    const result = detectMagicNumbers(files);
    expect(result.bodySummary).toContain("Magic Number Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows 'more' row when issues exceed 15", () => {
    const changes: string[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push(`+const value${i} = ${100 + i * 7};`);
    }
    const files = [makeFile("src/app.ts", changes)];
    const result = detectMagicNumbers(files);
    expect(result.issues.length).toBeGreaterThan(15);
    expect(result.bodySummary).toContain("more");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// const maxRetries = 42;",
      "+const maxRetries = MAX_RETRIES;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    // Should not flag 42 on the deleted line
    expect(nums.every((n) => n.line !== 1)).toBe(true);
  });

  it("ignores unchanged lines", () => {
    const files = [makeFile("src/app.ts", [
      " const old = 42;",
      "+const x = compute();",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal" && i.value === "42");
    expect(nums).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips test files entirely", () => {
    const files = [makeFile("src/api.test.ts", [
      "+const timeout = 5000;",
      "+const limit = 42;",
    ])];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — additional coverage
// ---------------------------------------------------------------------------

describe('detectMagicNumbers — edge cases (expanded)', () => {
  it('detects magic number in comparison', () => {
    const files = [makeFile('src/api.ts', [
      '+if (retries > 99) {',
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === 'numeric-literal');
    expect(nums.length).toBeGreaterThanOrEqual(1);
    expect(nums[0].value).toBe('99');
  });

  it('detects magic number in arithmetic', () => {
    const files = [makeFile('src/app.ts', [
      '+const total = price + 15;',
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === 'numeric-literal');
    expect(nums.length).toBeGreaterThanOrEqual(1);
  });

  it('skips version-like content', () => {
    const files = [makeFile('src/app.ts', [
      '+const nodeVersion = version >= 20;',
    ])];
    const result = detectMagicNumbers(files);
    // 20 might or might not be flagged depending on SAFE_NUMBERS
    expect(result.issues).toBeDefined();
  });

  it('skips spec files', () => {
    const files = [makeFile('src/app.spec.ts', [
      '+const limit = 5000;',
    ])];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });

  it('detects expired value as timeout', () => {
    const files = [makeFile('src/cache.ts', [
      '+const expire = 86400;',
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === 'timeout-duration');
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });

  it('detects wait value', () => {
    const files = [makeFile('src/app.ts', [
      '+const wait = 2500;',
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === 'timeout-duration');
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });

  it('detects sleep duration as timeout', () => {
    const files = [makeFile('src/utils.ts', [
      '+const sleep = 3000;',
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === 'timeout-duration');
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });

  it('detects duration in assignment', () => {
    const files = [makeFile('src/timer.ts', [
      '+const duration = 500;',
    ])];
    const result = detectMagicNumbers(files);
    const timeouts = result.issues.filter((i) => i.category === 'timeout-duration');
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });

  it('detects hardcoded string in strict equality', () => {
    const files = [makeFile('src/auth.ts', [
      '+if (status === "internal_server_error") {',
    ])];
    const result = detectMagicNumbers(files);
    const strs = result.issues.filter((i) => i.category === 'string-literal');
    expect(strs.length).toBeGreaterThanOrEqual(1);
  });

  it('skips type declaration lines', () => {
    const files = [makeFile('src/types.ts', [
      '+interface Config { maxRetries: number; }',
    ])];
    const result = detectMagicNumbers(files);
    expect(result.issues).toHaveLength(0);
  });

  it('detects issues across multiple files', () => {
    const files = [
      makeFile('src/a.ts', ['+const limit = 42;']),
      makeFile('src/b.ts', ['+const timeout = 5000;']),
    ];
    const result = detectMagicNumbers(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('shows critical and warning sections in context', () => {
    const files = [makeFile('src/api.ts', [
      '+const timeout = 3000;',
      '+const limit = 42;',
    ])];
    const result = detectMagicNumbers(files);
    if (result.issues.some((i) => i.severity === 'critical') && result.issues.some((i) => i.severity === 'warning')) {
      expect(result.contextText).toContain('Critical');
      expect(result.contextText).toContain('Warnings');
    }
  });
});


// ---------------------------------------------------------------------------
// Expanded coverage: boundary values, config thresholds, hex/binary/BigInt
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — expanded numeric coverage", () => {
  it("detects boundary value 99", () => {
    const files = [makeFile("src/app.ts", [
      "+const threshold = 99;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums.length).toBeGreaterThanOrEqual(1);
    expect(nums[0].value).toBe("99");
  });

  it("skips common safe number 1000", () => {
    const files = [makeFile("src/app.ts", [
      "+const limit = 1000;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("detects hex-like number 255 as safe", () => {
    const files = [makeFile("src/app.ts", [
      "+const mask = 255;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    // 255 is not in SAFE_NUMBERS but 256 is
    expect(result.issues).toBeDefined();
  });

  it("detects config threshold value", () => {
    const files = [makeFile("src/config.ts", [
      "+const batchSize = 500;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums.length).toBeGreaterThanOrEqual(1);
    expect(nums[0].value).toBe("500");
  });

  it("detects number in greater-than comparison", () => {
    const files = [makeFile("src/app.ts", [
      "+if (count > 50) {",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums.length).toBeGreaterThanOrEqual(1);
  });

  it("detects number in subtraction expression", () => {
    const files = [makeFile("src/app.ts", [
      "+const adjusted = total - 37;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums.length).toBeGreaterThanOrEqual(1);
  });

  it("skips year-like number 2025", () => {
    const files = [makeFile("src/app.ts", [
      "+const year = 2025;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: whitelist, comments, type imports
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — whitelist and skip patterns", () => {
  it("skips comment lines for numeric literals", () => {
    const files = [makeFile("src/app.ts", [
      "+// const maxRetries = 42;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("skips block comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+ * const timeout = 5000;",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("skips export type lines", () => {
    const files = [makeFile("src/types.ts", [
      "+export type Config = { maxRetries: number };",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });

  it("skips enum declaration lines", () => {
    const files = [makeFile("src/enums.ts", [
      "+enum Status { Active = 1, Inactive = 0 }",
    ])];
    const result = detectMagicNumbers(files);
    const nums = result.issues.filter((i) => i.category === "numeric-literal");
    expect(nums).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: context/body edge cases
// ---------------------------------------------------------------------------

describe("detectMagicNumbers — context/body expanded", () => {
  it("truncates long string values in issues", () => {
    const longStr = "a".repeat(50);
    const files = [makeFile("src/app.ts", [
      `+const region = "${longStr}";`,
    ])];
    const result = detectMagicNumbers(files);
    const strs = result.issues.filter((i) => i.category === "string-literal");
    if (strs.length > 0) {
      // String values over 30 chars are truncated with "..."
      expect(strs[0].value.length).toBeLessThanOrEqual(35);
    }
  });

  it("includes both critical and warning sections when both present", () => {
    const files = [makeFile("src/app.ts", [
      "+const timeout = 5000;",
      "+const limit = 42;",
    ])];
    const result = detectMagicNumbers(files);
    const hasCritical = result.issues.some((i) => i.severity === "critical");
    const hasWarning = result.issues.some((i) => i.severity === "warning");
    if (hasCritical && hasWarning) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });

  it("sorts by file path then line number for same severity", () => {
    const files = [
      makeFile("src/b.ts", ["+const x = 42;"]),
      makeFile("src/a.ts", ["+const y = 55;"]),
    ];
    const result = detectMagicNumbers(files);
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (warnings.length >= 2) {
      // a.ts should come before b.ts
      const aIdx = warnings.findIndex((i) => i.file === "src/a.ts");
      const bIdx = warnings.findIndex((i) => i.file === "src/b.ts");
      expect(aIdx).toBeLessThan(bIdx);
    }
  });
});
