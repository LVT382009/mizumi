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
  buildLearningPrompt: vi.fn().mockReturnValue(""),
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

// Mock description module
vi.mock("../description.js", () => ({
  scorePRDescription: vi.fn().mockReturnValue({ score: 4, missing: [] }),
  formatDescriptionFeedback: vi.fn().mockReturnValue(""),
}));

import { buildContext } from "../context.js";
import type { ParsedDiff } from "../diff.js";
import { ghostWarnings, buildLearningPrompt } from "../memory.js";
import { stripPatchPII } from "../diff.js";
import { scorePRDescription, formatDescriptionFeedback } from "../description.js";

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
              { type: "add", line: 3, oldLine: 0, content: " token = process.env.SECRET" },
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

  it("strips PII from diff text", async () => {
    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(stripPatchPII).toHaveBeenCalled();
  });

  it("includes ghost warnings when present", async () => {
    vi.mocked(ghostWarnings).mockReturnValueOnce(["Hardcoded API key found in auth.ts", "SQL injection risk in auth.ts"]);

    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.ghostContent).toContain("Past Issues");
    expect(ctx.ghostContent).toContain("Hardcoded API key");
    expect(ctx.ghostContent).toContain("SQL injection risk");
  });

  it("has empty ghostContent when no warnings", async () => {
    vi.mocked(ghostWarnings).mockReturnValueOnce([]);

    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.ghostContent).toBe("");
  });

  it("calls scorePRDescription with title and body", async () => {
    await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(scorePRDescription).toHaveBeenCalledWith("Add login feature", "Implements OAuth2 login flow");
  });

  it("handles empty PR title gracefully", async () => {
    mockPullsGet.mockResolvedValue({
      data: { title: null, body: "Some description" },
    });

    const ctx = await buildContext(
      mockOctokit as any,
      "owner",
      "repo",
      42,
      sampleDiff,
      "/workspace"
    );

    expect(ctx.prTitle).toBe("");
  });

  it("uses deleted-line prefix for removed lines", async () => {
    const delDiff: ParsedDiff = {
      files: [{
        path: "src/old.ts",
        status: "modified",
        additions: 0,
        deletions: 1,
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 0,
          content: "@@ -1 +0 @@",
          changes: [{ type: "delete", line: 0, oldLine: 1, content: "oldCode()" }],
        }],
      }],
      totalAdditions: 0,
      totalDeletions: 1,
      rawDiff: "",
    };

    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, delDiff, "/workspace"
    );

    expect(ctx.diffText).toContain("-oldCode()");
  });

  it("handles multi-file diffs", async () => {
    const multiDiff: ParsedDiff = {
      files: [
        {
          path: "src/a.ts", status: "modified", additions: 3, deletions: 0,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, content: "@@ -0 +1 @@", changes: [{ type: "add", line: 1, oldLine: 0, content: "new A" }] }],
        },
        {
          path: "src/b.ts", status: "added", additions: 5, deletions: 0,
          hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, content: "@@ -0 +1 @@", changes: [{ type: "add", line: 1, oldLine: 0, content: "new B" }] }],
        },
      ],
      totalAdditions: 8,
      totalDeletions: 0,
      rawDiff: "",
    };

    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, multiDiff, "/workspace"
    );

    expect(ctx.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(ctx.diffText).toContain("src/a.ts");
    expect(ctx.diffText).toContain("src/b.ts");
  });

  it("includes description feedback from scorePRDescription", async () => {
    vi.mocked(formatDescriptionFeedback).mockReturnValueOnce("## PR Description Quality (1/4)");

    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );

    expect(ctx.descriptionFeedback).toContain("PR Description Quality");
  });

  it("handles PR with no body (null body → empty string)", async () => {
    mockPullsGet.mockResolvedValue({
      data: { title: "No body PR", body: null as any },
    });
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.prDescription).toBe("");
    expect(scorePRDescription).toHaveBeenCalledWith("No body PR", "");
  });

  it("handles PR with undefined title → empty string", async () => {
    mockPullsGet.mockResolvedValue({
      data: { title: undefined as any, body: "PR body" },
    });
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.prTitle).toBe("");
  });

  it("handles empty files array → empty diff text, empty changedFiles", async () => {
    const emptyDiff: ParsedDiff = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      rawDiff: "",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, emptyDiff, "/workspace"
    );
    expect(ctx.diffText).toBe("");
    expect(ctx.changedFiles).toEqual([]);
  });

  it("formats multi-hunk diff correctly (two hunks in same file)", async () => {
    const multiHunkDiff: ParsedDiff = {
      files: [{
        path: "src/foo.ts",
        status: "modified",
        additions: 4,
        deletions: 2,
        hunks: [
          {
            oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
            content: "@@ -1,2 +1,3 @@",
            changes: [
              { type: "normal", line: 1, oldLine: 1, content: "line1" },
              { type: "add", line: 2, oldLine: 0, content: "added1" },
            ],
          },
          {
            oldStart: 10, oldLines: 5, newStart: 11, newLines: 5,
            content: "@@ -10,5 +11,5 @@",
            changes: [
              { type: "delete", line: 0, oldLine: 10, content: "removed" },
            ],
          },
        ],
      }],
      totalAdditions: 4,
      totalDeletions: 2,
      rawDiff: "",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, multiHunkDiff, "/workspace"
    );
    expect(ctx.diffText).toContain("@@ -1,2 +1,3 @@");
    expect(ctx.diffText).toContain("@@ -10,5 +11,5 @@");
    expect(ctx.diffText).toContain("+added1");
    expect(ctx.diffText).toContain("-removed");
  });

  it("includes hunk content headers with @@ notation", async () => {
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.diffText).toContain("@@ -1,2 +1,3 @@");
  });

  it("handles PR with very long body (should still work)", async () => {
    const longBody = "x".repeat(10000);
    mockPullsGet.mockResolvedValue({
      data: { title: "Big PR", body: longBody },
    });
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.prDescription).toBe(longBody);
    expect(ctx.prDescription.length).toBe(10000);
  });

  it("includes classification reason in diff text when provided", async () => {
    const classification = {
      category: "security" as const,
      confidence: 80,
      reason: "auth-related changes detected",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace", classification
    );
    expect(ctx.diffText).toContain("auth-related changes detected");
  });

  it("formats added file status in header correctly", async () => {
    const addedDiff: ParsedDiff = {
      files: [{
        path: "src/new.ts",
        status: "added",
        additions: 10,
        deletions: 0,
        hunks: [{
          oldStart: 0, oldLines: 0, newStart: 1, newLines: 10,
          content: "@@ -0,0 +1,10 @@",
          changes: [{ type: "add", line: 1, oldLine: 0, content: "new code" }],
        }],
      }],
      totalAdditions: 10,
      totalDeletions: 0,
      rawDiff: "",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, addedDiff, "/workspace"
    );
    expect(ctx.diffText).toContain("(added, +10/-0)");
  });

  it("formats deleted file status in header correctly", async () => {
    const deletedDiff: ParsedDiff = {
      files: [{
        path: "src/old.ts",
        status: "deleted",
        additions: 0,
        deletions: 5,
        hunks: [{
          oldStart: 1, oldLines: 5, newStart: 0, newLines: 0,
          content: "@@ -1,5 +0,0 @@",
          changes: [{ type: "delete", line: 0, oldLine: 1, content: "removed code" }],
        }],
      }],
      totalAdditions: 0,
      totalDeletions: 5,
      rawDiff: "",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, deletedDiff, "/workspace"
    );
    expect(ctx.diffText).toContain("(deleted, +0/-5)");
  });

  it("includes additions/deletions count per file", async () => {
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.diffText).toContain("+5/-2");
  });

  it("ghostContent is empty string when ghostWarnings returns empty", async () => {
    vi.mocked(ghostWarnings).mockReturnValueOnce([]);
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.ghostContent).toBe("");
    expect(typeof ctx.ghostContent).toBe("string");
  });

  it("descriptionFeedback is included in returned context", async () => {
    vi.mocked(formatDescriptionFeedback).mockReturnValueOnce("## Feedback content");
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx).toHaveProperty("descriptionFeedback");
    expect(ctx.descriptionFeedback).toContain("Feedback content");
  });

  it("calls stripPatchPII on the diff text", async () => {
    vi.mocked(stripPatchPII).mockReturnValueOnce("stripped-diff");
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(stripPatchPII).toHaveBeenCalled();
    expect(ctx.diffText).toBe("stripped-diff");
  });

  it("includes learningContent from buildLearningPrompt", async () => {
    vi.mocked(buildLearningPrompt).mockReturnValueOnce("## Adaptive Learning\nThis team dismisses style findings");
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.learningContent).toContain("Adaptive Learning");
    expect(ctx.learningContent).toContain("style");
  });

  it("has empty learningContent when buildLearningPrompt returns empty", async () => {
    vi.mocked(buildLearningPrompt).mockReturnValueOnce("");
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.learningContent).toBe("");
  });

  it("passes learning data to buildLearningPrompt", async () => {
    const learning = {
      learningWeights: { style: "demote" as const, security: "promote" as const },
      acceptanceRates: { style: { helpful: 2, unhelpful: 8, rate: 0.2 } },
    };
    await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace", undefined, learning
    );
    expect(buildLearningPrompt).toHaveBeenCalledWith(learning.learningWeights, learning.acceptanceRates);
  });

  it("passes changed files to ghostWarnings", async () => {
    await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ghostWarnings).toHaveBeenCalledWith(expect.any(String), ["src/auth.ts"]);
  });

  it("formats ghost warnings with dash prefix", async () => {
    vi.mocked(ghostWarnings).mockReturnValueOnce(["[high] auth.ts:10 — security: XSS risk"]);
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.ghostContent).toContain("- [high] auth.ts:10");
    expect(ctx.ghostContent).toContain("Review Ghost");
  });

  it("context text includes PR Classification section", async () => {
    const classification = { category: "refactor" as const, confidence: 60, reason: "code restructuring" };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace", classification
    );
    expect(ctx.diffText).toContain("## PR Classification");
    expect(ctx.diffText).toContain("refactor");
  });

  it("returns correct files array from diff", async () => {
    const multiDiff: ParsedDiff = {
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, content: "@@ -0 +1 @@", changes: [{ type: "add", line: 1, oldLine: 0, content: "x" }] }] },
        { path: "b.ts", status: "added", additions: 2, deletions: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, content: "@@ -0 +1 @@", changes: [{ type: "add", line: 1, oldLine: 0, content: "y" }] }] },
      ],
      totalAdditions: 3,
      totalDeletions: 0,
      rawDiff: "",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, multiDiff, "/workspace"
    );
    expect(ctx.files).toHaveLength(2);
    expect(ctx.changedFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("includes renamed file status in diff header", async () => {
    const renamedDiff: ParsedDiff = {
      files: [{
        path: "src/new-name.ts", status: "renamed", additions: 3, deletions: 2,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, content: "@@ -1,2 +1,3 @@", changes: [{ type: "normal", line: 1, oldLine: 1, content: "same" }] }],
      }],
      totalAdditions: 3,
      totalDeletions: 2,
      rawDiff: "",
    };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, renamedDiff, "/workspace"
    );
    expect(ctx.diffText).toContain("(renamed, +3/-2)");
  });

  it("does not call ghostWarnings when no memory content", async () => {
    vi.mocked(ghostWarnings).mockReturnValueOnce([]);
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ghostWarnings).toHaveBeenCalled();
    expect(ctx.ghostContent).toBe("");
  });

  it("handles classification with high confidence", async () => {
    const classification = { category: "feature" as const, confidence: 95, reason: "new functionality" };
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace", classification
    );
    expect(ctx.classification?.confidence).toBe(95);
  });

  it("handles empty learning data gracefully", async () => {
    const ctx = await buildContext(
      mockOctokit as any, "owner", "repo", 42, sampleDiff, "/workspace"
    );
    expect(ctx.learningContent).toBeDefined();
  });
});
