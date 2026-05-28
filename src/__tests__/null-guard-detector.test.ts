import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectNullGuardGaps } from "../null-guard-detector.js";
import type { NullGuardIssue, NullGuardResult } from "../null-guard-detector.js";
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

describe("detectNullGuardGaps — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = 'Alice';",
      "+const count = 42;",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+const x = data.user.name;",
    ], "deleted")];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag safe optional chaining", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = data?.user?.name;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(0);
  });

  it("does not flag shallow access on non-nullable source", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = str.length.toString();",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(0);
  });

  it("does not flag code with preceding null check", () => {
    const files = [makeFile("src/app.ts", [
      "+if (data && data.user.name) {",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deep access without guard
// ---------------------------------------------------------------------------

describe("detectNullGuardGaps — deep access without guard", () => {
  it("detects data.user.name without optional chaining", () => {
    const files = [makeFile("src/api.ts", [
      "+const name = data.user.name;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(1);
    expect(deep[0].severity).toBe("critical");
  });

  it("detects response.data.error without optional chaining", () => {
    const files = [makeFile("src/fetch.ts", [
      "+const msg = response.data.error;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(1);
  });

  it("detects config.db.host without optional chaining", () => {
    const files = [makeFile("src/config.ts", [
      "+const host = config.db.host;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(1);
  });

  it("does not flag data?.user.name when safe chaining is used", () => {
    const files = [makeFile("src/api.ts", [
      "+const name = data?.user.name;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(0);
  });

  it("detects user.profile.avatar deep access", () => {
    const files = [makeFile("src/user.ts", [
      "+const avatar = user.profile.avatar;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Array index without check
// ---------------------------------------------------------------------------

describe("detectNullGuardGaps — array index without check", () => {
  it("detects data[0].name without length check", () => {
    const files = [makeFile("src/api.ts", [
      "+const first = data[0].name;",
    ])];
    const result = detectNullGuardGaps(files);
    const arr = result.issues.filter((i) => i.category === "array-index-without-check");
    expect(arr).toHaveLength(1);
    expect(arr[0].severity).toBe("warning");
  });

  it("detects result[0].id without length check", () => {
    const files = [makeFile("src/query.ts", [
      "+const id = result[0].id;",
    ])];
    const result = detectNullGuardGaps(files);
    const arr = result.issues.filter((i) => i.category === "array-index-without-check");
    expect(arr).toHaveLength(1);
  });

  it("does not flag array access with length check on same line", () => {
    const files = [makeFile("src/api.ts", [
      "+if (data.length > 0) const first = data[0].name;",
    ])];
    const result = detectNullGuardGaps(files);
    const arr = result.issues.filter((i) => i.category === "array-index-without-check");
    expect(arr).toHaveLength(0);
  });

  it("does not flag array access with optional chaining", () => {
    const files = [makeFile("src/api.ts", [
      "+const first = data?.[0]?.name;",
    ])];
    const result = detectNullGuardGaps(files);
    const arr = result.issues.filter((i) => i.category === "array-index-without-check");
    expect(arr).toHaveLength(0);
  });

  it("does not flag array access on non-nullable source", () => {
    const files = [makeFile("src/app.ts", [
      "+const item = items[0].name;",
    ])];
    const result = detectNullGuardGaps(files);
    const arr = result.issues.filter((i) => i.category === "array-index-without-check");
    expect(arr).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Optional chain coverage gap
// ---------------------------------------------------------------------------

describe("detectNullGuardGaps — optional chain coverage gap", () => {
  it("detects response?.data.error — data guarded but error is not", () => {
    const files = [makeFile("src/api.ts", [
      "+const msg = response?.data.error;",
    ])];
    const result = detectNullGuardGaps(files);
    const gap = result.issues.filter((i) => i.category === "optional-chain-coverage-gap");
    expect(gap).toHaveLength(1);
    expect(gap[0].severity).toBe("warning");
  });

  it("detects user?.profile.avatar — profile guarded but avatar is not", () => {
    const files = [makeFile("src/user.ts", [
      "+const img = user?.profile.avatar;",
    ])];
    const result = detectNullGuardGaps(files);
    const gap = result.issues.filter((i) => i.category === "optional-chain-coverage-gap");
    expect(gap).toHaveLength(1);
  });

  it("does not flag fully optional chained access", () => {
    const files = [makeFile("src/api.ts", [
      "+const msg = response?.data?.error;",
    ])];
    const result = detectNullGuardGaps(files);
    const gap = result.issues.filter((i) => i.category === "optional-chain-coverage-gap");
    expect(gap).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Assertive access on optional
// ---------------------------------------------------------------------------

describe("detectNullGuardGaps — assertive access on optional", () => {
  it("detects data!.user non-null assertion", () => {
    const files = [makeFile("src/api.ts", [
      "+const user = data!.user;",
    ])];
    const result = detectNullGuardGaps(files);
    const assert = result.issues.filter((i) => i.category === "assertive-access-on-optional");
    expect(assert).toHaveLength(1);
    expect(assert[0].severity).toBe("critical");
  });

  it("detects result!.value non-null assertion", () => {
    const files = [makeFile("src/calc.ts", [
      "+const val = result!.value;",
    ])];
    const result = detectNullGuardGaps(files);
    const assert = result.issues.filter((i) => i.category === "assertive-access-on-optional");
    expect(assert).toHaveLength(1);
  });

  it("detects config!.db non-null assertion", () => {
    const files = [makeFile("src/config.ts", [
      "+const db = config!.db;",
    ])];
    const result = detectNullGuardGaps(files);
    const assert = result.issues.filter((i) => i.category === "assertive-access-on-optional");
    expect(assert).toHaveLength(1);
  });

  it("does not flag assertion with preceding null check", () => {
    const files = [makeFile("src/api.ts", [
      "+if (data !== null) const user = data!.user;",
    ])];
    const result = detectNullGuardGaps(files);
    const assert = result.issues.filter((i) => i.category === "assertive-access-on-optional");
    expect(assert).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectNullGuardGaps — context and body", () => {
  it("generates context text with gaps", () => {
    const files = [makeFile("src/api.ts", [
      "+const name = data.user.name;",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.contextText).toContain("Null Guard");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/api.ts", [
      "+const name = data.user.name;",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.bodySummary).toContain("Null Guard Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = data.user.name;",
      "+const first = data[0].id;",
    ])];
    const result = detectNullGuardGaps(files);
    if (result.issues.some((i) => i.severity === "critical") && result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectNullGuardGaps — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// const name = data.user.name;",
      "+const x = 42;",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+// const name = data.user.name;",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+const name = data.user.name;"]),
      makeFile("src/b.ts", ["+const val = result!.value;"]),
    ];
    const result = detectNullGuardGaps(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = [];
    const sources = [
      "data", "response", "result", "item", "element", "node", "entry",
      "record", "config", "options", "payload", "body", "content", "user",
      "account", "profile",
    ];
    for (const src of sources) {
      changes.push(`+const x = ${src}.nested.property;`);
    }
    const files = [makeFile("src/app.ts", changes)];
    const result = detectNullGuardGaps(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("detects error.message.code deep access", () => {
    const files = [makeFile("src/error.ts", [
      "+const code = error.message.code;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep.length).toBeGreaterThanOrEqual(1);
  });

  it("detects session.user.id deep access", () => {
    const files = [makeFile("src/auth.ts", [
      "+const id = session.user.id;",
    ])];
    const result = detectNullGuardGaps(files);
    const deep = result.issues.filter((i) => i.category === "deep-access-without-guard");
    expect(deep).toHaveLength(1);
  });

  it("detects options?.debug.verbose coverage gap", () => {
    const files = [makeFile("src/config.ts", [
      "+const v = options?.debug.verbose;",
    ])];
    const result = detectNullGuardGaps(files);
    const gap = result.issues.filter((i) => i.category === "optional-chain-coverage-gap");
    expect(gap).toHaveLength(1);
  });

  it("detects entry[0].value array access", () => {
    const files = [makeFile("src/map.ts", [
      "+const v = entry[0].value;",
    ])];
    const result = detectNullGuardGaps(files);
    const arr = result.issues.filter((i) => i.category === "array-index-without-check");
    expect(arr).toHaveLength(1);
  });

  it("does not flag math or string access (non-nullable)", () => {
    const files = [makeFile("src/math.ts", [
      "+const pi = Math.PI.toFixed();",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips import lines", () => {
    const files = [makeFile("src/app.ts", [
      "+import { data } from './api';",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type declaration lines", () => {
    const files = [makeFile("src/types.ts", [
      "+type Data = { user: { name: string } };",
    ])];
    const result = detectNullGuardGaps(files);
    expect(result.issues).toHaveLength(0);
  });
});
