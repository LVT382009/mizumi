import { describe, it, expect, vi } from "vitest";
import { parseDiff, stripPatchPII, fetchDiff } from "../diff.js";

// ---------------------------------------------------------------------------
// parseDiff — pure function logic
// ---------------------------------------------------------------------------

describe("parseDiff", () => {
  const SAMPLE_DIFF = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index abc1234..def5678 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,4 +1,6 @@",
    " import { x } from 'y';",
    "+import { z } from 'w';",
    "+import { a } from 'b';",
    " ",
    "-const old = 1;",
    "+const new = 2;",
    " // end",
  ].join("\n");

  it("produces correct DiffFile structure from a unified diff", async () => {
    const result = await parseDiff(SAMPLE_DIFF, []);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/foo.ts");
    expect(result.files[0].status).toBe("modified");
    expect(result.files[0].hunks.length).toBeGreaterThanOrEqual(1);
  });

  it("counts additions and deletions", async () => {
    const result = await parseDiff(SAMPLE_DIFF, []);
    // 3 added lines (+import z, +import a, +const new)
    expect(result.totalAdditions).toBe(3);
    // 1 deleted line (-const old)
    expect(result.totalDeletions).toBe(1);
  });

  it("extracts hunk header info and changes", async () => {
    const result = await parseDiff(SAMPLE_DIFF, []);
    const hunk = result.files[0].hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(4);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(6);
    expect(hunk.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("classifies change types correctly", async () => {
    const result = await parseDiff(SAMPLE_DIFF, []);
    const hunk = result.files[0].hunks[0];
    const added = hunk.changes.filter((c) => c.type === "add");
    const deleted = hunk.changes.filter((c) => c.type === "delete");
    const normal = hunk.changes.filter((c) => c.type === "normal");
    expect(added.length).toBe(3);
    expect(deleted.length).toBe(1);
    expect(normal.length).toBeGreaterThanOrEqual(1);
  });

  it("handles empty diff text", async () => {
    const result = await parseDiff("", []);
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
  });

  it("handles new file (added status)", async () => {
    const newFileDiff = [
      "diff --git a/newfile.ts b/newfile.ts",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/newfile.ts",
      "@@ -0,0 +1,3 @@",
      "+export function hello() {",
      "+  return 'world';",
      "+}",
    ].join("\n");

    const result = await parseDiff(newFileDiff, []);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("added");
    expect(result.files[0].path).toBe("newfile.ts");
  });

  it("handles deleted file", async () => {
    const deletedFileDiff = [
      "diff --git a/oldfile.ts b/oldfile.ts",
      "deleted file mode 100644",
      "index abc1234..0000000",
      "--- a/oldfile.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export function old() {",
      "-  return 'gone';",
    ].join("\n");

    const result = await parseDiff(deletedFileDiff, []);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("deleted");
    // parse-diff reports file.to as "/dev/null" for deleted files,
    // and parseDiff uses `file.to || file.from`, so path is "/dev/null"
    expect(result.files[0].path).toBe("/dev/null");
  });

  it("handles renamed file", async () => {
    const renamedDiff = [
      "diff --git a/old-name.ts b/new-name.ts",
      "similarity index 95%",
      "rename from old-name.ts",
      "rename to new-name.ts",
      "index abc1234..def5678 100644",
      "--- a/old-name.ts",
      "+++ b/new-name.ts",
      "@@ -1,2 +1,2 @@",
      " // context",
      "-old line",
      "+new line",
    ].join("\n");

    const result = await parseDiff(renamedDiff, []);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].status).toBe("renamed");
    expect(result.files[0].path).toBe("new-name.ts");
  });

  it("preserves rawDiff from input", async () => {
    const result = await parseDiff(SAMPLE_DIFF, []);
    expect(result.rawDiff).toBe(SAMPLE_DIFF);
  });
});

// ---------------------------------------------------------------------------
// parseDiff — excludePatterns
// ---------------------------------------------------------------------------

describe("parseDiff with excludePatterns", () => {
  const multiFileDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index aaa..bbb 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/package-lock.json b/package-lock.json",
    "index ccc..ddd 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "-old-lock",
    "+new-lock",
    "diff --git a/src/util.ts b/src/util.ts",
    "index eee..fff 100644",
    "--- a/src/util.ts",
    "+++ b/src/util.ts",
    "@@ -1 +1 @@",
    "-old2",
    "+new2",
  ].join("\n");

  it("excludes files matching glob patterns", async () => {
    const result = await parseDiff(multiFileDiff, ["package-lock.json"]);
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain("package-lock.json");
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("src/util.ts");
  });

  it("excludes files matching wildcard patterns", async () => {
    const result = await parseDiff(multiFileDiff, ["*.json"]);
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain("package-lock.json");
    // .ts files are not matched by *.json
    expect(paths).toContain("src/app.ts");
  });

  it("excludes files with directory glob patterns", async () => {
    const diffWithDist = [
      "diff --git a/dist/bundle.js b/dist/bundle.js",
      "index aaa..bbb 100644",
      "--- a/dist/bundle.js",
      "+++ b/dist/bundle.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/main.ts b/src/main.ts",
      "index ccc..ddd 100644",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1 +1 @@",
      "-old2",
      "+new2",
    ].join("\n");

    const result = await parseDiff(diffWithDist, ["dist/**"]);
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths).toContain("src/main.ts");
  });

  it("includes all files when excludePatterns is empty", async () => {
    const result = await parseDiff(multiFileDiff, []);
    expect(result.files).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// stripPatchPII
// ---------------------------------------------------------------------------

describe("stripPatchPII", () => {
  const patchWithPII = [
    "From: John Doe <john@example.com>",
    "Author: Jane Smith <jane@corp.com>",
    "Date: Tue May 20 14:30:00 2025 +0000",
    "",
    "diff --git a/src/app.ts b/src/app.ts",
    "index abc..def 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  it("removes From line", () => {
    const result = stripPatchPII(patchWithPII);
    expect(result).not.toContain("From: John Doe");
    expect(result).not.toContain("john@example.com");
  });

  it("removes Author line", () => {
    const result = stripPatchPII(patchWithPII);
    expect(result).not.toContain("Author: Jane Smith");
    expect(result).not.toContain("jane@corp.com");
  });

  it("removes Date line", () => {
    const result = stripPatchPII(patchWithPII);
    expect(result).not.toContain("Date: Tue May 20");
  });

  it("preserves diff file paths and content", () => {
    const result = stripPatchPII(patchWithPII);
    expect(result).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(result).toContain("--- a/src/app.ts");
    expect(result).toContain("+++ b/src/app.ts");
    expect(result).toContain("+new");
  });

  it("redacts index hash lines", () => {
    const result = stripPatchPII(patchWithPII);
    expect(result).not.toContain("index abc..def");
    expect(result).toContain("index [REDACTED]");
  });

  it("handles patch with no PII (only index lines redacted)", () => {
    const cleanPatch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const result = stripPatchPII(cleanPatch);
    expect(result).toContain("diff --git");
    expect(result).toContain("index [REDACTED]");
    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  it("removes commit hash lines", () => {
    const patchWithCommit = [
      "commit abc123def456",
      "diff --git a/a.ts b/a.ts",
      "index aaa..bbb 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const result = stripPatchPII(patchWithCommit);
    expect(result).not.toContain("commit abc123def456");
    expect(result).toContain("commit [REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// fetchDiff — mock octokit
// ---------------------------------------------------------------------------

describe("fetchDiff", () => {
  it("calls octokit.pulls.get with correct parameters", async () => {
    const mockOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: "diff --git a/a.ts b/a.ts\nindex abc..def 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
        }),
      },
    } as any;

    await fetchDiff(mockOctokit, "owner", "repo", 42, []);
    expect(mockOctokit.pulls.get).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
      mediaType: { format: "diff" },
    });
  });

  it("returns parsed diff with rawDiff", async () => {
    const diffText = "diff --git a/a.ts b/a.ts\nindex abc..def 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const mockOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: diffText }),
      },
    } as any;

    const result = await fetchDiff(mockOctokit, "owner", "repo", 42, []);
    expect(result.rawDiff).toBe(diffText);
    expect(result.files).toHaveLength(1);
  });

  it("applies excludePatterns to fetched diff", async () => {
    const diffText = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index abc..def 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/yarn.lock b/yarn.lock",
      "index eee..fff 100644",
      "--- a/yarn.lock",
      "+++ b/yarn.lock",
      "@@ -1 +1 @@",
      "-old-lock",
      "+new-lock",
    ].join("\n");
    const mockOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: diffText }),
      },
    } as any;

    const result = await fetchDiff(mockOctokit, "owner", "repo", 42, ["yarn.lock"]);
    const paths = result.files.map((f) => f.path);
    expect(paths).not.toContain("yarn.lock");
    expect(paths).toContain("src/app.ts");
  });

  it("falls back to compare commits when diff media type fails", async () => {
    const diffText = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index abc..def 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const mockOctokit = {
      pulls: {
        get: vi.fn().mockRejectedValueOnce(new Error("404 Not Found")),
      },
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: { base: { sha: "abc123" }, head: { sha: "def456" } },
          }),
        },
        repos: {
          compareCommits: vi.fn().mockResolvedValue({ data: diffText }),
        },
      },
    } as any;

    const result = await fetchDiff(mockOctokit, "owner", "repo", 42, []);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/app.ts");
    expect(mockOctokit.rest.repos.compareCommits).toHaveBeenCalled();
  });
});
