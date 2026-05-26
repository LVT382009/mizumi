import { describe, it, expect } from "vitest";
import { classifyIntents } from "../intent-classifier.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: overrides.path ?? "src/api/users.ts",
    status: overrides.status ?? "modified",
    additions: overrides.additions ?? 20,
    deletions: overrides.deletions ?? 5,
    hunks: overrides.hunks ?? [
      {
        oldStart: 1, oldLines: 5, newStart: 1, newLines: 8,
        content: "",
        changes: [
          { type: "add", line: 1, oldLine: 0, content: "export function newUser() {}" },
          { type: "add", line: 2, oldLine: 0, content: "  return { name: 'test' };" },
          { type: "normal", line: 3, oldLine: 3, content: "export function getUser() {}" },
        ],
      },
    ],
  };
}

function makeHundksWithContent(lines: string[]): DiffFile["hunks"] {
  return [{
    oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length,
    content: "",
    changes: lines.map((l, i) => ({ type: "add" as const, line: i + 1, oldLine: 0, content: l })),
  }];
}

// ---------------------------------------------------------------------------
// Test file intent classification
// ---------------------------------------------------------------------------

describe("classifyIntents test files", () => {
  it("classifies test files by path pattern", () => {
    const files = [makeDiffFile({ path: "src/__tests__/users.test.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("test");
    expect(result.fileIntents[0].signals).toContain("test file path");
  });

  it("classifies spec files as test", () => {
    const files = [makeDiffFile({ path: "src/utils/math.spec.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("test");
  });

  it("classifies files in tests/ directory as test", () => {
    const files = [makeDiffFile({ path: "tests/integration/api.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("test");
  });

  it("classifies story files as test", () => {
    const files = [makeDiffFile({ path: "src/components/Button.stories.tsx" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Documentation file intent
// ---------------------------------------------------------------------------

describe("classifyIntents documentation", () => {
  it("classifies .md files as docs", () => {
    const files = [makeDiffFile({ path: "README.md" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("docs");
  });

  it("classifies docs/ directory as docs", () => {
    const files = [makeDiffFile({ path: "docs/api-reference.md" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("docs");
  });

  it("classifies CHANGELOG as docs", () => {
    const files = [makeDiffFile({ path: "CHANGELOG.md" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("docs");
  });

  it("classifies .rst files as docs", () => {
    const files = [makeDiffFile({ path: "docs/guide.rst" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("docs");
  });
});

// ---------------------------------------------------------------------------
// Config file intent
// ---------------------------------------------------------------------------

describe("classifyIntents config", () => {
  it("classifies .yml files as config", () => {
    const files = [makeDiffFile({ path: "docker-compose.yml" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("config");
  });

  it("classifies tsconfig as config", () => {
    const files = [makeDiffFile({ path: "tsconfig.json" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("config");
  });

  it("classifies CI workflow files as config", () => {
    const files = [makeDiffFile({ path: ".github/workflows/ci.yml" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("config");
  });

  it("classifies Dockerfile as config", () => {
    const files = [makeDiffFile({ path: "Dockerfile" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("config");
  });
});

// ---------------------------------------------------------------------------
// Security intent
// ---------------------------------------------------------------------------

describe("classifyIntents security", () => {
  it("classifies /auth/ path as security", () => {
    const files = [makeDiffFile({ path: "src/auth/login.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("security");
  });

  it("classifies /crypto/ path as security", () => {
    const files = [makeDiffFile({ path: "src/crypto/hash.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("security");
  });

  it("classifies password in path as security", () => {
    const files = [makeDiffFile({ path: "src/utils/password-validator.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("security");
  });

  it("classifies security keywords in diff content", () => {
    const files = [makeDiffFile({
      path: "src/api/handler.ts",
      hunks: makeHundksWithContent([
        "export function sanitizeInput(input: string) {",
        "  return input.replace(/[<>]/g, '');",
        "}",
      ]),
    })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("security");
    expect(result.fileIntents[0].signals).toContain("security keywords in diff");
  });
});

// ---------------------------------------------------------------------------
// Bugfix intent
// ---------------------------------------------------------------------------

describe("classifyIntents bugfix", () => {
  it("classifies fix/bug keywords in diff content", () => {
    const files = [makeDiffFile({
      path: "src/api/handler.ts",
      hunks: makeHundksWithContent([
        "// Fix: handle null case in response",
        "export function handleResponse(data: any) {",
        "  if (!data) return null;",
        "}",
      ]),
    })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("bugfix");
  });

  it("classifies regression keyword as bugfix", () => {
    const files = [makeDiffFile({
      path: "src/api/handler.ts",
      hunks: makeHundksWithContent([
        "// Regression fix: restore previous behavior",
      ]),
    })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("bugfix");
  });
});

// ---------------------------------------------------------------------------
// Performance intent
// ---------------------------------------------------------------------------

describe("classifyIntents perf", () => {
  it("classifies /cache/ path as perf", () => {
    const files = [makeDiffFile({ path: "src/cache/lru.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("perf");
  });

  it("classifies /benchmark path as perf", () => {
    const files = [makeDiffFile({ path: "src/benchmark/runner.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("perf");
  });

  it("classifies perf keywords in diff content", () => {
    const files = [makeDiffFile({
      path: "src/service.ts",
      hunks: makeHundksWithContent([
        "// Optimize: use memoization for repeated calculations",
        "const cache = new Map();",
      ]),
    })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("perf");
  });
});

// ---------------------------------------------------------------------------
// Dead code / deletion intent
// ---------------------------------------------------------------------------

describe("classifyIntents dead_code", () => {
  it("classifies deleted file as dead_code", () => {
    const files = [makeDiffFile({ path: "src/old-module.ts", status: "deleted" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("dead_code");
  });

  it("classifies deletion-heavy files as dead_code", () => {
    const files = [makeDiffFile({ path: "src/cleanup.ts", additions: 2, deletions: 50 })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("dead_code");
  });

  it("classifies deprecated keyword in path as dead_code", () => {
    const files = [makeDiffFile({ path: "src/deprecated/helpers.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("dead_code");
  });
});

// ---------------------------------------------------------------------------
// Feature intent
// ---------------------------------------------------------------------------

describe("classifyIntents feature", () => {
  it("classifies new file addition as feature", () => {
    const files = [makeDiffFile({ path: "src/features/payments.ts", status: "added", additions: 100, deletions: 0 })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("feature");
  });

  it("classifies addition-heavy files as feature", () => {
    const files = [makeDiffFile({ path: "src/api/new-endpoint.ts", additions: 80, deletions: 5 })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("feature");
  });
});

// ---------------------------------------------------------------------------
// Refactor intent
// ---------------------------------------------------------------------------

describe("classifyIntents refactor", () => {
  it("classifies renamed files as refactor", () => {
    const files = [makeDiffFile({ path: "src/utils/format.ts", status: "renamed" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("refactor");
  });

  it("classifies balanced add/delete as refactor", () => {
    const files = [makeDiffFile({ path: "src/service.ts", additions: 30, deletions: 25 })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("refactor");
  });

  it("classifies refactor keywords in diff content", () => {
    const files = [makeDiffFile({
      path: "src/service.ts",
      hunks: makeHundksWithContent([
        "// Refactor: extract helper function",
        "export const extractHelper = () => {}",
      ]),
    })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("refactor");
  });
});

// ---------------------------------------------------------------------------
// Intent priority and conflict resolution
// ---------------------------------------------------------------------------

describe("classifyIntents priority", () => {
  it("security beats refactor for auth path with balanced changes", () => {
    const files = [makeDiffFile({ path: "src/auth/middleware.ts", additions: 15, deletions: 12 })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("security");
  });

  it("bugfix beats feature when bugfix keywords are strong", () => {
    const files = [makeDiffFile({
      path: "src/api/handler.ts",
      additions: 15,
      deletions: 10,
      hunks: makeHundksWithContent([
        "// Bug fix: handle edge case",
        "// Fix regression from commit abc",
        "export function newHandler() {}",
      ]),
    })];
    const result = classifyIntents(files);
    // bugfix keywords (0.4*2 matches) + balanced ratio + no new file signal
    expect(result.fileIntents[0].intent).toBe("bugfix");
  });
});

// ---------------------------------------------------------------------------
// IntentResult structure
// ---------------------------------------------------------------------------

describe("classifyIntents result structure", () => {
  it("returns correct structure", () => {
    const files = [makeDiffFile()];
    const result = classifyIntents(files);
    expect(result).toHaveProperty("fileIntents");
    expect(result).toHaveProperty("intentCounts");
    expect(result).toHaveProperty("dominantIntent");
    expect(result).toHaveProperty("contextText");
    expect(result).toHaveProperty("bodySummary");
    expect(Array.isArray(result.fileIntents)).toBe(true);
    expect(typeof result.dominantIntent).toBe("string");
  });

  it("counts intents correctly", () => {
    const files = [
      makeDiffFile({ path: "src/__tests__/a.test.ts" }),
      makeDiffFile({ path: "src/__tests__/b.test.ts" }),
      makeDiffFile({ path: "README.md" }),
    ];
    const result = classifyIntents(files);
    expect(result.intentCounts.test).toBe(2);
    expect(result.intentCounts.docs).toBe(1);
  });

  it("dominant intent is the most common", () => {
    const files = [
      makeDiffFile({ path: "src/__tests__/a.test.ts" }),
      makeDiffFile({ path: "src/__tests__/b.test.ts" }),
      makeDiffFile({ path: "src/__tests__/c.test.ts" }),
      makeDiffFile({ path: "README.md" }),
    ];
    const result = classifyIntents(files);
    expect(result.dominantIntent).toBe("test");
  });

  it("empty files array returns chore dominant", () => {
    const result = classifyIntents([]);
    expect(result.dominantIntent).toBe("chore");
    expect(result.fileIntents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("classifyIntents contextText", () => {
  it("includes dominant intent in context", () => {
    const files = [makeDiffFile({ path: "src/auth/middleware.ts" })];
    const result = classifyIntents(files);
    expect(result.contextText).toContain("security");
  });

  it("includes risk prioritization guidance", () => {
    const files = [makeDiffFile({ path: "src/auth/middleware.ts" })];
    const result = classifyIntents(files);
    expect(result.contextText).toContain("high-risk");
    expect(result.contextText).toContain("deep");
  });

  it("returns empty context for empty files", () => {
    const result = classifyIntents([]);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("classifyIntents bodySummary", () => {
  it("includes markdown table with intent counts", () => {
    const files = [
      makeDiffFile({ path: "src/auth/middleware.ts" }),
      makeDiffFile({ path: "src/__tests__/auth.test.ts" }),
    ];
    const result = classifyIntents(files);
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("Change Intent");
    expect(result.bodySummary).toContain("| security |");
    expect(result.bodySummary).toContain("| test |");
  });

  it("lists high-risk files explicitly", () => {
    const files = [makeDiffFile({ path: "src/auth/middleware.ts" })];
    const result = classifyIntents(files);
    expect(result.bodySummary).toContain("High-risk");
    expect(result.bodySummary).toContain("src/auth/middleware.ts");
  });

  it("returns empty body for empty files", () => {
    const result = classifyIntents([]);
    expect(result.bodySummary).toBe("");
  });

  it("includes closing details tag", () => {
    const files = [makeDiffFile({ path: "src/api/handler.ts" })];
    const result = classifyIntents(files);
    expect(result.bodySummary).toContain("</details>");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("classifyIntents edge cases", () => {
  it("classifies file with no signals as chore when no path/content signals match", () => {
    const files = [makeDiffFile({ path: "src/utils/index.ts", additions: 8, deletions: 8 })];
    const result = classifyIntents(files);
    // balanced add/delete gives refactor signal, so this is refactor not chore
    expect(result.fileIntents[0].intent).toBe("refactor");
  });

  it("classifies truly ambiguous file as chore", () => {
    const files = [{
      path: "src/utils/index.ts",
      status: "modified" as const,
      additions: 2,
      deletions: 1,
      hunks: [{
        oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
        content: "",
        changes: [
          { type: "add" as const, line: 1, oldLine: 0, content: "export const x = 1;" },
          { type: "normal" as const, line: 2, oldLine: 2, content: "export const y = 2;" },
        ],
      }],
    }];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("chore");
  });

  it("handles large number of files", () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      makeDiffFile({ path: `src/module${i}/file.ts` })
    );
    const result = classifyIntents(files);
    expect(result.fileIntents).toHaveLength(50);
  });

  it("handles mixed file types", () => {
    const files = [
      makeDiffFile({ path: "src/__tests__/a.test.ts" }),
      makeDiffFile({ path: "src/auth/login.ts" }),
      makeDiffFile({ path: "README.md" }),
      makeDiffFile({ path: "tsconfig.json" }),
      makeDiffFile({ path: "src/api/users.ts", status: "added", additions: 100, deletions: 0 }),
    ];
    const result = classifyIntents(files);
    expect(result.fileIntents).toHaveLength(5);
    const intents = result.fileIntents.map(f => f.intent);
    expect(intents).toContain("test");
    expect(intents).toContain("security");
    expect(intents).toContain("docs");
    expect(intents).toContain("config");
    expect(intents).toContain("feature");
  });

  it("confidence is between 0 and 1", () => {
    const files = [makeDiffFile({ path: "src/auth/middleware.ts" })];
    const result = classifyIntents(files);
    for (const fi of result.fileIntents) {
      expect(fi.confidence).toBeGreaterThanOrEqual(0);
      expect(fi.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("signals are non-empty for classified files", () => {
    const files = [makeDiffFile({ path: "src/__tests__/a.test.ts" })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].signals.length).toBeGreaterThan(0);
  });

  it("security intent with both path and keyword signals", () => {
    const files = [makeDiffFile({
      path: "src/auth/validate.ts",
      hunks: makeHundksWithContent([
        "// Sanitize user input to prevent XSS",
        "export function validate(input: string) {",
        "  return input.replace(/<script>/g, '');",
        "}",
      ]),
    })];
    const result = classifyIntents(files);
    expect(result.fileIntents[0].intent).toBe("security");
    const signals = result.fileIntents[0].signals;
    // Should have both path signal and keyword signal
    expect(signals.length).toBeGreaterThanOrEqual(2);
  });

  it("small config changes detected", () => {
    const files = [makeDiffFile({ path: "tsconfig.json", additions: 1, deletions: 1 })];
    const result = classifyIntents(files);
    // Small config change should have "small config change" signal
    expect(result.fileIntents[0].signals).toContain("small config change");
  });
});
