import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectAICodePathologies } from "../ai-code-pathology-detector.js";
import type { AICodePathologyIssue, AICodePathologyResult } from "../ai-code-pathology-detector.js";
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

describe("detectAICodePathologies — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = 'Alice';",
      "+const count = 42;",
    ])];
    const result = detectAICodePathologies(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+import { pandas } from 'numpy';",
    ], "deleted")];
    const result = detectAICodePathologies(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectAICodePathologies(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag legitimate imports", () => {
    const files = [makeFile("src/app.ts", [
      "+import { Octokit } from '@octokit/rest';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(0);
  });

  it("does not flag legitimate getters", () => {
    const files = [makeFile("src/utils.ts", [
      "+function isEnabled() { return true; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(0);
  });

  it("flags getData returning empty array as stub", () => {
    const files = [makeFile("src/api.ts", [
      "+function getData() { return []; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hallucinated imports
// ---------------------------------------------------------------------------

describe("detectAICodePathologies — hallucinated imports", () => {
  it("detects import from python package in JS code", () => {
    const files = [makeFile("src/ml.ts", [
      "+import { DataFrame } from 'pandas';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
    expect(hall[0].severity).toBe("critical");
  });

  it("detects import from numpy in JS code", () => {
    const files = [makeFile("src/math.ts", [
      "+import { array } from 'numpy';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects import from tensorflow in JS code", () => {
    const files = [makeFile("src/ai.ts", [
      "+import { Model } from 'tensorflow';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects wrong deep subpath import", () => {
    const files = [makeFile("src/api.ts", [
      "+import { GitHub } from '@actions/github/lib/github';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects hallucinated function from @actions/core", () => {
    const files = [makeFile("src/ci.ts", [
      "+import { QueryClient } from '@actions/core';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects hallucinated function from express", () => {
    const files = [makeFile("src/server.ts", [
      "+import { DataProvider } from 'express';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects django import in JS repo", () => {
    const files = [makeFile("src/web.ts", [
      "+import { View } from 'django';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sycophantic stubs
// ---------------------------------------------------------------------------

describe("detectAICodePathologies — sycophantic stubs", () => {
  it("detects function always returning true", () => {
    const files = [makeFile("src/validate.ts", [
      "+function validate() { return true; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
    expect(stubs[0].severity).toBe("warning");
  });

  it("detects function always returning null", () => {
    const files = [makeFile("src/factory.ts", [
      "+function createInstance() { return null; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
  });

  it("detects function always returning empty array", () => {
    const files = [makeFile("src/search.ts", [
      "+function search() { return []; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
  });

  it("detects function always returning empty object", () => {
    const files = [makeFile("src/config.ts", [
      "+function getConfig() { return {}; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
  });

  it("detects identity function returning input unchanged", () => {
    const files = [makeFile("src/transform.ts", [
      "+function transform(data) { return data; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag isEmpty returning true", () => {
    const files = [makeFile("src/utils.ts", [
      "+function isEmpty(arr) { return true; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(0);
  });

  it("does not flag hasPermission returning false", () => {
    const files = [makeFile("src/auth.ts", [
      "+function hasPermission() { return false; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Confident wrong API
// ---------------------------------------------------------------------------

describe("detectAICodePathologies — confident wrong API", () => {
  it("detects Set.includes instead of Set.has", () => {
    const files = [makeFile("src/cache.ts", [
      "+if (validSet.includes(key)) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
    expect(wrong[0].severity).toBe("critical");
  });

  it("detects Array.has instead of Array.includes", () => {
    const files = [makeFile("src/search.ts", [
      "+if (itemList.has(target)) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("detects dataArray.has wrong method", () => {
    const files = [makeFile("src/data.ts", [
      "+if (dataArray.has('key')) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("detects Array.size instead of Array.length", () => {
    const files = [makeFile("src/app.ts", [
      "+if (itemsArray.size > 0) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("detects Map.length instead of Map.size", () => {
    const files = [makeFile("src/store.ts", [
      "+if (configMap.length > 0) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("does not flag Array.includes correctly used", () => {
    const files = [makeFile("src/app.ts", [
      "+if (arr.includes(item)) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(0);
  });

  it("does not flag Map.has correctly used", () => {
    const files = [makeFile("src/store.ts", [
      "+if (userMap.has(id)) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Boilerplate expansion
// ---------------------------------------------------------------------------

describe("detectAICodePathologies — boilerplate expansion", () => {
  it("detects empty try/catch", () => {
    const files = [makeFile("src/risky.ts", [
      "+try {} catch (e) {}",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(1);
    expect(boiler[0].severity).toBe("warning");
  });

  it("detects commented alternative", () => {
    const files = [makeFile("src/app.ts", [
      "+// alternative: use fetch instead of axios",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(1);
  });

  it("detects 3+ consecutive blank lines", () => {
    const files = [makeFile("src/app.ts", [
      "+const a = 1;",
      "+",
      "+",
      "+",
      "+const b = 2;",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(1);
  });

  it("does not flag valid try/catch with body", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doSomething(); } catch (e) { handleError(e); }",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(0);
  });

  it("does not flag single blank line", () => {
    const files = [makeFile("src/app.ts", [
      "+const a = 1;",
      "+",
      "+const b = 2;",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(0);
  });

  it("detects // or: alternative comment", () => {
    const files = [makeFile("src/app.ts", [
      "+// or: could also use a Set here",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectAICodePathologies — context and body", () => {
  it("generates context text with pathologies", () => {
    const files = [makeFile("src/ml.ts", [
      "+import { DataFrame } from 'pandas';",
    ])];
    const result = detectAICodePathologies(files);
    expect(result.contextText).toContain("AI-Generated Code Pathologies");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/ml.ts", [
      "+import { DataFrame } from 'pandas';",
    ])];
    const result = detectAICodePathologies(files);
    expect(result.bodySummary).toContain("AI Code Pathology Detection");
    expect(result.bodySummary).toContain("<details>");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectAICodePathologies — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// import { DataFrame } from 'pandas';",
      "+const x = 42;",
    ])];
    const result = detectAICodePathologies(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectAICodePathologies(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+import { Model } from 'tensorflow';"]),
      makeFile("src/b.ts", ["+function validate() { return true; }"]),
    ];
    const result = detectAICodePathologies(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("detects torch import hallucination", () => {
    const files = [makeFile("src/ai.ts", [
      "+import { Tensor } from 'torch';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects flask import hallucination", () => {
    const files = [makeFile("src/server.ts", [
      "+import { Flask } from 'flask';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects collectionList.has wrong API", () => {
    const files = [makeFile("src/data.ts", [
      "+if (collectionList.has(item)) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("detects activeSet.includes wrong API", () => {
    const files = [makeFile("src/sets.ts", [
      "+if (activeSet.includes(value)) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("detects sklearn import hallucination", () => {
    const files = [makeFile("src/ml.ts", [
      "+import { SVC } from 'sklearn';",
    ])];
    const result = detectAICodePathologies(files);
    const hall = result.issues.filter((i) => i.category === "hallucinated-import");
    expect(hall).toHaveLength(1);
  });

  it("detects 0 return stub", () => {
    const files = [makeFile("src/calc.ts", [
      "+function calculateTotal() { return 0; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
  });

  it("detects empty string return stub", () => {
    const files = [makeFile("src/format.ts", [
      "+function formatName() { return ''; }",
    ])];
    const result = detectAICodePathologies(files);
    const stubs = result.issues.filter((i) => i.category === "sycophantic-stub");
    expect(stubs).toHaveLength(1);
  });

  it("detects dictMap.length wrong API", () => {
    const files = [makeFile("src/dict.ts", [
      "+if (dictMap.length > 10) {",
    ])];
    const result = detectAICodePathologies(files);
    const wrong = result.issues.filter((i) => i.category === "confident-wrong-api");
    expect(wrong).toHaveLength(1);
  });

  it("does not flag normal comments", () => {
    const files = [makeFile("src/app.ts", [
      "+// This function validates input",
    ])];
    const result = detectAICodePathologies(files);
    const boiler = result.issues.filter((i) => i.category === "boilerplate-expansion");
    expect(boiler).toHaveLength(0);
  });
});
