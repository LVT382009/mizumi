import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock octokit before importing context
const mockPullsGet = vi.fn();
const mockOctokit = {
  rest: {
    pulls: { get: mockPullsGet },
  },
};

// Mock memory functions
vi.mock("../memory.js", () => ({
  readMemory: vi.fn().mockReturnValue("# Memory patterns\n- Use parameterized queries"),
  readRules: vi.fn().mockReturnValue("# Rules\n- No hardcoded secrets"),
  ghostWarnings: vi.fn().mockReturnValue([]),
}));

// Mock diff.stripPatchPII to pass through
vi.mock("../diff.js", () => ({
  stripPatchPII: vi.fn((s: string) => s),
}));

// Mock strip-ansi
vi.mock("strip-ansi", () => ({
  default: (s: string) => s,
  __esModule: true,
}));

import { buildContext } from "../context.js";
import type { ParsedDiff } from "../diff.js";

describe("buildContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullsGet.mockResolvedValue({
      data: {
        title: "Add login feature",
        body: "Implements OAuth2 login flow",
      },
    });
  });

  const sampleDiff: ParsedDiff = {
    files: [
      {
        path: "src/auth.ts",
        status: "modified",
        additions: 5,
        deletions: 2,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            content: "@@ -1,2 +1,3 @@",
            changes: [
              { type: "normal", line: 1, oldLine: 1, content: "import express" },
              { type: "add", line: 2, oldLine: 0, content: "import { OAuth2 } from 'oauth'" },
              { type: "add", line: 3, oldLine: 0, content: "  token = process.env.SECRET" },
              { type: "normal", line: 4, oldLine: 2, content: "" },
            ],
          },
        ],
      },
    ],
    totalAdditions: 5,
    totalDeletions: 2,
    rawDiff: "fake raw diff",
  };

  it("builds context with PR metadata", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.prTitle).toBe("Add login feature");
    expect(ctx.prDescription).toBe("Implements OAuth2 login flow");
  });

  it("includes diff text with prefixes", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.diffText).toContain("src/auth.ts");
    expect(ctx.diffText).toContain("+import { OAuth2 } from 'oauth'");
    expect(ctx.diffText).toContain(" import express");
  });

  it("includes file paths in changedFiles", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.changedFiles).toContain("src/auth.ts");
  });

  it("includes memory and rules content", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.memoryContent).toContain("Memory patterns");
    expect(ctx.rulesContent).toContain("No hardcoded secrets");
  });

  it("handles empty PR description", async () => {
    mockPullsGet.mockResolvedValue({
      data: { title: "Fix bug", body: null },
    });

    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.prDescription).toBe("");
  });

  it("includes file status in diff text header", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.diffText).toContain("(modified, +5/-2)");
  });

  it("includes classification in diff text when provided", async () => {
    const classification = { category: "security" as const, confidence: 75, reason: "security-sensitive file: src/auth.ts" };
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace",
      classification
    );

    expect(ctx.diffText).toContain("PR Classification");
    expect(ctx.diffText).toContain("security");
    expect(ctx.classification).toBe(classification);
  });

  it("omits classification from diff text when not provided", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.diffText).not.toContain("PR Classification");
    expect(ctx.classification).toBeUndefined();
  });
});
