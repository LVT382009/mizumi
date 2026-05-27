import { describe, it, expect } from "vitest";
import {
  buildLineMapFromRawDiff,
  buildLineMap,
  isValidLine,
  resolveLine,
  buildPositionHint,
  validateFinding,
} from "../linemap.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// buildLineMapFromRawDiff
// ---------------------------------------------------------------------------

describe("buildLineMapFromRawDiff", () => {
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

  it("maps added and context lines to valid line numbers", () => {
    const map = buildLineMapFromRawDiff(SAMPLE_DIFF);
    const fileMap = map.get("src/foo.ts");
    expect(fileMap).toBeDefined();

    // Line 1: context "import { x }" → newLineNumber=1
    // Line 2: added "+import { z }" → newLineNumber=2
    // Line 3: added "+import { a }" → newLineNumber=3
    // Line 4: context " " → newLineNumber=4
    // Line 5: added "+const new = 2" → newLineNumber=5
    // Line 6: context "// end" → newLineNumber=6
    expect(fileMap!.has(1)).toBe(true);
    expect(fileMap!.has(2)).toBe(true);
    expect(fileMap!.has(3)).toBe(true);
    expect(fileMap!.has(4)).toBe(true);
    expect(fileMap!.has(5)).toBe(true);
    expect(fileMap!.has(6)).toBe(true);
  });

  it("does NOT include deleted lines in the line map", () => {
    const map = buildLineMapFromRawDiff(SAMPLE_DIFF);
    const fileMap = map.get("src/foo.ts");
    // The "-const old = 1;" line is a deletion — no new-file line number
    // Only valid new-file lines should be in the set
    expect(fileMap!.size).toBe(6); // 4 context + 3 added - 1 deletion offset
  });

  it("handles a diff with two files", () => {
    const multiDiff = [
      "diff --git a/a.ts b/a.ts",
      "index aaa..bbb 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/b.ts b/b.ts",
      "index ccc..ddd 100644",
      "--- b/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-old2",
      "+new2",
    ].join("\n");

    const map = buildLineMapFromRawDiff(multiDiff);
    expect(map.has("a.ts")).toBe(true);
    expect(map.has("b.ts")).toBe(true);
    expect(map.get("a.ts")!.has(1)).toBe(true); // "+new" is new line 1
    expect(map.get("b.ts")!.has(1)).toBe(true); // "+new2" is new line 1
  });

  it("returns empty map for empty diff", () => {
    const map = buildLineMapFromRawDiff("");
    expect(map.size).toBe(0);
  });

  it("resets newLineNumber when a new file starts", () => {
    const multiFileDiff = [
      "diff --git a/first.txt b/first.txt",
      "index aaa..bbb 100644",
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+added early",
      " line2",
      "diff --git a/second.txt b/second.txt",
      "index ccc..ddd 100644",
      "--- b/second.txt",
      "+++ b/second.txt",
      "@@ -5,2 +5,3 @@",
      " context5",
      "+added later",
      " context6",
    ].join("\n");

    const map = buildLineMapFromRawDiff(multiFileDiff);

    // first.txt: lines 1-3 are in the set
    const firstMap = map.get("first.txt");
    expect(firstMap!.has(1)).toBe(true);
    expect(firstMap!.has(2)).toBe(true);
    expect(firstMap!.has(3)).toBe(true);

    // second.txt: @@ -5,2 +5,3 @@ means context starts at newLineNumber=5
    // context5 → line 5, "+added later" → line 6, context6 → line 7
    const secondMap = map.get("second.txt");
    expect(secondMap!.has(5)).toBe(true);
    expect(secondMap!.has(6)).toBe(true);
    expect(secondMap!.has(7)).toBe(true);
  });

  it("returns a Set not a Map (position-free)", () => {
    const map = buildLineMapFromRawDiff(SAMPLE_DIFF);
    const fileMap = map.get("src/foo.ts");
    expect(fileMap).toBeInstanceOf(Set);
  });
});

// ---------------------------------------------------------------------------
// isValidLine
// ---------------------------------------------------------------------------

describe("isValidLine", () => {
  it("returns true for an exact match", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([10, 20, 30]));
    expect(isValidLine(map, "src/app.ts", 10)).toBe(true);
    expect(isValidLine(map, "src/app.ts", 20)).toBe(true);
  });

  it("returns false for an invalid line", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([10, 20, 30]));
    expect(isValidLine(map, "src/app.ts", 15)).toBe(false);
  });

  it("returns false for an unknown file", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([10]));
    expect(isValidLine(map, "src/other.ts", 10)).toBe(false);
  });

  it("returns false for empty set", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set());
    expect(isValidLine(map, "src/app.ts", 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLine
// ---------------------------------------------------------------------------

describe("resolveLine", () => {
  function makeMap(
    entries: Array<[string, number[]]>
  ): Map<string, Set<number>> {
    const map = new Map<string, Set<number>>();
    for (const [file, lines] of entries) {
      map.set(file, new Set(lines));
    }
    return map;
  }

  it("returns exact line number when it exists", () => {
    const map = makeMap([["src/app.ts", [10, 20, 30]]]);
    expect(resolveLine(map, "src/app.ts", 10)).toBe(10);
    expect(resolveLine(map, "src/app.ts", 20)).toBe(20);
  });

  it("falls back to nearest line within ±5 when exact line is missing", () => {
    const map = makeMap([["src/app.ts", [10, 16]]]);
    // Line 12 is not in the map, but 10 is within 5 lines
    const result = resolveLine(map, "src/app.ts", 12);
    expect(result).toBe(10); // 10 is distance 2, 16 is distance 4
  });

  it("picks the closer line when two candidates are equidistant", () => {
    // Line 12 requested; line 10 (dist 2) and line 14 (dist 2) both within 5
    const map = makeMap([["src/app.ts", [10, 14]]]);
    const result = resolveLine(map, "src/app.ts", 12);
    // Either 10 or 14 is acceptable; must be one of them
    expect([10, 14]).toContain(result);
  });

  it("returns null when no file match exists", () => {
    const map = makeMap([["src/app.ts", [10]]]);
    expect(resolveLine(map, "src/other.ts", 10)).toBeNull();
  });

  it("returns null when the nearest line is more than 5 lines away", () => {
    const map = makeMap([["src/app.ts", [10]]]);
    expect(resolveLine(map, "src/app.ts", 20)).toBeNull(); // distance 10 > 5
  });

  it("returns null when the file set is empty", () => {
    const map = makeMap([["src/app.ts", []]]);
    expect(resolveLine(map, "src/app.ts", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPositionHint
// ---------------------------------------------------------------------------

describe("buildPositionHint", () => {
  it("produces correct range strings for consecutive lines", () => {
    const files: DiffFile[] = [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 5,
            content: "@@ -1 +1,5 @@",
            changes: [
              { type: "normal", line: 1, oldLine: 1, content: "ctx" },
              { type: "add", line: 2, oldLine: 0, content: "new2" },
              { type: "add", line: 3, oldLine: 0, content: "new3" },
              { type: "add", line: 4, oldLine: 0, content: "new4" },
              { type: "normal", line: 5, oldLine: 5, content: "ctx" },
            ],
          },
        ],
      },
    ];

    const hint = buildPositionHint(files);
    expect(hint).toBe("src/app.ts: lines 1-5");
  });

  it("produces separate ranges for non-consecutive lines", () => {
    const files: DiffFile[] = [
      {
        path: "src/util.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            content: "@@ -1 +1,2 @@",
            changes: [
              { type: "add", line: 1, oldLine: 0, content: "a" },
              { type: "add", line: 5, oldLine: 0, content: "b" },
            ],
          },
        ],
      },
    ];

    const hint = buildPositionHint(files);
    expect(hint).toBe("src/util.ts: lines 1, 5");
  });

  it("handles multiple files separated by semicolons", () => {
    const files: DiffFile[] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            content: "@@ -0 +1 @@",
            changes: [{ type: "add", line: 1, oldLine: 0, content: "x" }],
          },
        ],
      },
      {
        path: "b.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 3,
            newLines: 1,
            content: "@@ -0 +3 @@",
            changes: [{ type: "add", line: 3, oldLine: 0, content: "y" }],
          },
        ],
      },
    ];

    const hint = buildPositionHint(files);
    expect(hint).toBe("a.ts: lines 1; b.ts: lines 3");
  });

  it("returns empty string when no files have valid lines", () => {
    const files: DiffFile[] = [
      {
        path: "removed.ts",
        status: "deleted",
        additions: 0,
        deletions: 5,
        hunks: [
          {
            oldStart: 1,
            oldLines: 5,
            newStart: 0,
            newLines: 0,
            content: "@@ -1,5 +0 @@",
            changes: [
              { type: "delete", line: 0, oldLine: 1, content: "d1" },
              { type: "delete", line: 0, oldLine: 2, content: "d2" },
            ],
          },
        ],
      },
    ];

    const hint = buildPositionHint(files);
    expect(hint).toBe("");
  });

  it("shows single-line range without dash when only one line in range", () => {
    const files: DiffFile[] = [
      {
        path: "solo.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 10,
            newLines: 1,
            content: "@@ -0 +10 @@",
            changes: [{ type: "add", line: 10, oldLine: 0, content: "z" }],
          },
        ],
      },
    ];

    const hint = buildPositionHint(files);
    expect(hint).toBe("solo.ts: lines 10");
  });
});

// ---------------------------------------------------------------------------
// buildLineMap — fallback builder from parsed DiffFile[]
// ---------------------------------------------------------------------------

describe("buildLineMap", () => {
  it("maps add and normal changes to valid lines", () => {
    const files: DiffFile[] = [
      {
        path: "src/app.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            content: "@@ -1,2 +1,3 @@",
            changes: [
              { type: "normal", line: 1, oldLine: 1, content: "ctx" },
              { type: "add", line: 2, oldLine: 0, content: "new1" },
              { type: "add", line: 3, oldLine: 0, content: "new2" },
              { type: "normal", line: 4, oldLine: 2, content: "ctx2" },
            ],
          },
        ],
      },
    ];

    const map = buildLineMap(files);
    expect(map.has("src/app.ts")).toBe(true);
    expect(map.get("src/app.ts")).toEqual(new Set([1, 2, 3, 4]));
  });

  it("excludes delete changes from line map", () => {
    const files: DiffFile[] = [
      {
        path: "src/del.ts",
        status: "modified",
        additions: 0,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 0,
            newLines: 0,
            content: "@@ -1 +0 @@",
            changes: [{ type: "delete", line: 0, oldLine: 1, content: "old" }],
          },
        ],
      },
    ];

    const map = buildLineMap(files);
    expect(map.has("src/del.ts")).toBe(true);
    expect(map.get("src/del.ts")!.size).toBe(0);
  });

  it("handles empty file list", () => {
    const map = buildLineMap([]);
    expect(map.size).toBe(0);
  });

  it("handles multiple files", () => {
    const files: DiffFile[] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, content: "@@ -0 +1 @@", changes: [{ type: "add", line: 1, oldLine: 0, content: "x" }] }],
      },
      {
        path: "b.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 5, newLines: 1, content: "@@ -0 +5 @@", changes: [{ type: "add", line: 5, oldLine: 0, content: "y" }] }],
      },
    ];

    const map = buildLineMap(files);
    expect(map.get("a.ts")!.has(1)).toBe(true);
    expect(map.get("b.ts")!.has(5)).toBe(true);
  });

  it("excludes changes with line <= 0", () => {
    const files: DiffFile[] = [
      {
        path: "src/zero.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [{
          oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          content: "@@ -1 +1 @@",
          changes: [
            { type: "normal", line: 0, oldLine: 0, content: "should be excluded" },
            { type: "add", line: 1, oldLine: 0, content: "valid" },
          ],
        }],
      },
    ];

    const map = buildLineMap(files);
    const lines = map.get("src/zero.ts")!;
    expect(lines.has(1)).toBe(true);
    expect(lines.has(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateFinding — resolves both start and end lines
// ---------------------------------------------------------------------------

describe("validateFinding", () => {
  function makeMap(entries: Array<[string, number[]]>): Map<string, Set<number>> {
    const map = new Map<string, Set<number>>();
    for (const [file, lines] of entries) {
      map.set(file, new Set(lines));
    }
    return map;
  }

  it("returns resolved line for valid single-line finding", () => {
    const map = makeMap([["src/app.ts", [10, 20, 30]]]);
    const result = validateFinding(map, "src/app.ts", 10);
    expect(result).toEqual({ line: 10 });
  });

  it("returns resolved line and endLine for multi-line finding", () => {
    const map = makeMap([["src/app.ts", [10, 11, 12, 13, 14]]]);
    const result = validateFinding(map, "src/app.ts", 10, 14);
    expect(result).toEqual({ line: 10, endLine: 14 });
  });

  it("returns null when file not found", () => {
    const map = makeMap([["src/app.ts", [10]]]);
    const result = validateFinding(map, "src/other.ts", 10);
    expect(result).toBeNull();
  });

  it("returns null when no valid line within proximity", () => {
    const map = makeMap([["src/app.ts", [100]]]);
    const result = validateFinding(map, "src/app.ts", 10);
    expect(result).toBeNull();
  });

  it("uses proximity resolution for start line", () => {
    const map = makeMap([["src/app.ts", [8, 12]]]);
    const result = validateFinding(map, "src/app.ts", 10);
    // Line 10 not in map, but 8 (dist 2) and 12 (dist 2) both within ±5
    expect(result).not.toBeNull();
    expect([8, 12]).toContain(result!.line);
  });

  it("omits endLine when it resolves to null", () => {
    const map = makeMap([["src/app.ts", [10, 11, 12]]]);
    const result = validateFinding(map, "src/app.ts", 10, 50);
    // endLine 50 is way out of range, so resolvedEnd will be null
    expect(result).toEqual({ line: 10 });
  });

  it("omits endLine when resolved endLine is not greater than resolved start line", () => {
    const map = makeMap([["src/app.ts", [10, 15]]]);
    const result = validateFinding(map, "src/app.ts", 10, 8);
    // endLine 8 is less than start line 10 — should not be included
    expect(result!.endLine).toBeUndefined();
  });

  it("returns null when start line is unresolvable even if endLine would be valid", () => {
    const map = makeMap([["src/app.ts", [100]]]);
    const result = validateFinding(map, "src/app.ts", 10, 100);
    expect(result).toBeNull();
  });

  it("handles finding without endLine", () => {
    const map = makeMap([["src/app.ts", [5]]]);
    const result = validateFinding(map, "src/app.ts", 5);
    expect(result).toEqual({ line: 5 });
    expect(result!.endLine).toBeUndefined();
  });

  it("resolves endLine via proximity as well", () => {
    const map = makeMap([["src/app.ts", [10, 12, 14]]]);
    const result = validateFinding(map, "src/app.ts", 10, 13);
    // start resolves to 10 (exact), end 13 resolves to 12 (dist 1) or 14 (dist 1)
    expect(result!.line).toBe(10);
    expect(result!.endLine).toBeDefined();
    expect([12, 14]).toContain(result!.endLine);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for buildLineMapFromRawDiff
  // ---------------------------------------------------------------------------

  it("should handle binary file marker in diff", () => {
    const binaryDiff = [
      "diff --git a/image.png b/image.png",
      "Binary files /dev/null and b/image.png differ",
    ].join("\n");
    const map = buildLineMapFromRawDiff(binaryDiff);
    // File is registered but has no valid lines
    expect(map.has("image.png")).toBe(true);
    expect(map.get("image.png")!.size).toBe(0);
  });

  it("should handle diff with only rename (no content changes)", () => {
    const renameDiff = [
      "diff --git a/old_name.ts b/new_name.ts",
      "similarity index 100%",
      "rename from old_name.ts",
      "rename to new_name.ts",
    ].join("\n");
    const map = buildLineMapFromRawDiff(renameDiff);
    // File new_name.ts is registered from the diff header
    // Non-standard lines like "similarity index..." are treated as context lines
    // by the raw diff walker (they don't match any skip prefix), so they get counted
    expect(map.has("new_name.ts")).toBe(true);
    // The raw diff walker counts "similarity index 100%", "rename from old_name.ts",
    // and "rename to new_name.ts" as context lines (3 non-special lines)
    expect(map.get("new_name.ts")!.size).toBe(3);
  });

  it("should handle very large line numbers in hunk header", () => {
    const largeDiff = [
      "diff --git a/big.ts b/big.ts",
      "index aaa..bbb 100644",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -99999,1 +99999,1 @@",
      "+changed line",
    ].join("\n");
    const map = buildLineMapFromRawDiff(largeDiff);
    const lineSet = map.get("big.ts");
    expect(lineSet!.has(99999)).toBe(true);
  });

  it("should handle hunk with no comma in new file range", () => {
    // @@ -5 +10 @@ means start at line 10 with 1 line implied
    const noCommaDiff = [
      "diff --git a/a.ts b/a.ts",
      "index aaa..bbb 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -5 +10 @@",
      "+added at 10",
    ].join("\n");
    const map = buildLineMapFromRawDiff(noCommaDiff);
    const lineSet = map.get("a.ts");
    expect(lineSet!.has(10)).toBe(true);
  });

  it("should handle multiple hunks in one file", () => {
    const multiHunkDiff = [
      "diff --git a/multi.ts b/multi.ts",
      "index aaa..bbb 100644",
      "--- a/multi.ts",
      "+++ b/multi.ts",
      "@@ -1,3 +1,4 @@",
      " ctx1",
      "+added1",
      " ctx2",
      " ctx3",
      "@@ -10,3 +11,4 @@",
      " ctx10",
      "+added2",
      " ctx11",
      " ctx12",
    ].join("\n");
    const map = buildLineMapFromRawDiff(multiHunkDiff);
    const lineSet = map.get("multi.ts");
    // First hunk: ctx1=1, added1=2, ctx2=3, ctx3=4
    // Second hunk starts at +11: ctx10=11, added2=12, ctx11=13, ctx12=14
    expect(lineSet!.has(1)).toBe(true);
    expect(lineSet!.has(2)).toBe(true);
    expect(lineSet!.has(3)).toBe(true);
    expect(lineSet!.has(4)).toBe(true);
    expect(lineSet!.has(11)).toBe(true);
    expect(lineSet!.has(12)).toBe(true);
    expect(lineSet!.has(13)).toBe(true);
    expect(lineSet!.has(14)).toBe(true);
  });

  it("should handle overlapping hunks (same line number in two hunks)", () => {
    const overlapDiff = [
      "diff --git a/overlap.ts b/overlap.ts",
      "index aaa..bbb 100644",
      "--- a/overlap.ts",
      "+++ b/overlap.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+inserted",
      " line2",
      "@@ -2,2 +3,3 @@",
      " line3",
      "+inserted2",
      " line4",
    ].join("\n");
    const map = buildLineMapFromRawDiff(overlapDiff);
    const lineSet = map.get("overlap.ts");
    // First hunk: line1=1, inserted=2, line2=3
    // Second hunk starts at +3: line3=3, inserted2=4, line4=5
    // Line 3 is added twice to the Set (idempotent)
    expect(lineSet!.has(3)).toBe(true);
  });

  it("should skip lines starting with backslash (no-newline-at-end marker)", () => {
    const noNewlineDiff = [
      "diff --git a/noeol.ts b/noeol.ts",
      "index aaa..bbb 100644",
      "--- a/noeol.ts",
      "+++ b/noeol.ts",
      "@@ -1,2 +1,3 @@",
      " line1",
      "+added line",
      " line2",
      "\\ No newline at end of file",
    ].join("\n");
    const map = buildLineMapFromRawDiff(noNewlineDiff);
    const lineSet = map.get("noeol.ts");
    // Backslash line should be skipped, not counted as context or added
    // line1=1, added=2, line2=3
    expect(lineSet!.size).toBe(3);
    expect(lineSet!.has(1)).toBe(true);
    expect(lineSet!.has(2)).toBe(true);
    expect(lineSet!.has(3)).toBe(true);
  });

  it("should handle diff with malformed diff header (no match)", () => {
    const malformedDiff = [
      "diff --git malformed header",
      "+some line",
    ].join("\n");
    const map = buildLineMapFromRawDiff(malformedDiff);
    // Malformed header doesn't match the regex, so currentFile stays null
    // No file should be registered
    expect(map.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for resolveLine
  // ---------------------------------------------------------------------------

  it("should resolve to nearest valid line when two candidates at different distances", () => {
    const map = new Map<string, Set<number>>();
    map.set("f.ts", new Set([10, 13]));
    // Request line 14: 13 is distance 1, 10 is distance 4
    const result = resolveLine(map, "f.ts", 14);
    expect(result).toBe(13);
  });

  it("should resolve to line at exactly distance 5 (boundary)", () => {
    const map = new Map<string, Set<number>>();
    map.set("f.ts", new Set([10]));
    // Request line 15: distance from 10 is exactly 5
    const result = resolveLine(map, "f.ts", 15);
    expect(result).toBe(10);
  });

  it("should not resolve when nearest line is distance 6", () => {
    const map = new Map<string, Set<number>>();
    map.set("f.ts", new Set([10]));
    // Request line 16: distance from 10 is 6 > 5
    const result = resolveLine(map, "f.ts", 16);
    expect(result).toBeNull();
  });

  it("should resolve to valid line at boundary below (distance 5)", () => {
    const map = new Map<string, Set<number>>();
    map.set("f.ts", new Set([20]));
    // Request line 15: distance from 20 is exactly 5
    const result = resolveLine(map, "f.ts", 15);
    expect(result).toBe(20);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for buildPositionHint
  // ---------------------------------------------------------------------------

  it("should produce multiple range segments for gapped line numbers", () => {
    const files: DiffFile[] = [
      {
        path: "gaps.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 3,
            content: "@@ -1 +1,3 @@",
            changes: [
              { type: "add", line: 1, oldLine: 0, content: "a" },
              { type: "add", line: 2, oldLine: 0, content: "b" },
              { type: "add", line: 5, oldLine: 0, content: "c" },
              { type: "add", line: 8, oldLine: 0, content: "d" },
              { type: "add", line: 9, oldLine: 0, content: "e" },
            ],
          },
        ],
      },
    ];
    const hint = buildPositionHint(files);
    // Lines: 1,2,5,8,9 => ranges: "1-2", "5", "8-9"
    expect(hint).toBe("gaps.ts: lines 1-2, 5, 8-9");
  });

  it("should skip files with only delete changes in hint", () => {
    const files: DiffFile[] = [
      {
        path: "only-del.ts",
        status: "modified",
        additions: 0,
        deletions: 3,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 0,
            newLines: 0,
            content: "@@ -1,3 +0 @@",
            changes: [
              { type: "delete", line: 0, oldLine: 1, content: "d1" },
              { type: "delete", line: 0, oldLine: 2, content: "d2" },
            ],
          },
        ],
      },
    ];
    const hint = buildPositionHint(files);
    expect(hint).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for buildLineMap (fallback)
  // ---------------------------------------------------------------------------

  it("should handle file with multiple hunks in buildLineMap", () => {
    const files: DiffFile[] = [
      {
        path: "multi-hunk.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            content: "@@ -1 +1,2 @@",
            changes: [
              { type: "add", line: 1, oldLine: 0, content: "a" },
              { type: "add", line: 2, oldLine: 0, content: "b" },
            ],
          },
          {
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 2,
            content: "@@ -10 +10,2 @@",
            changes: [
              { type: "normal", line: 10, oldLine: 10, content: "ctx" },
              { type: "add", line: 11, oldLine: 0, content: "c" },
            ],
          },
        ],
      },
    ];
    const map = buildLineMap(files);
    const lineSet = map.get("multi-hunk.ts")!;
    expect(lineSet.has(1)).toBe(true);
    expect(lineSet.has(2)).toBe(true);
    expect(lineSet.has(10)).toBe(true);
    expect(lineSet.has(11)).toBe(true);
    expect(lineSet.size).toBe(4);
  });

  it("should handle negative line numbers in changes (excluded)", () => {
    const files: DiffFile[] = [
      {
        path: "neg.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            content: "@@ -1 +1 @@",
            changes: [
              { type: "add", line: -1, oldLine: 0, content: "bad" },
              { type: "add", line: 5, oldLine: 0, content: "good" },
            ],
          },
        ],
      },
    ];
    const map = buildLineMap(files);
    const lineSet = map.get("neg.ts")!;
    expect(lineSet.has(5)).toBe(true);
    expect(lineSet.has(-1)).toBe(false);
    expect(lineSet.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases for validateFinding
  // ---------------------------------------------------------------------------

  it("should return null for empty LineMap", () => {
    const map = new Map<string, Set<number>>();
    const result = validateFinding(map, "anything.ts", 1);
    expect(result).toBeNull();
  });

  it("should resolve endLine via proximity when it is close but not exact", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([10, 11, 16, 17]));
    const result = validateFinding(map, "src/app.ts", 10, 15);
    // Start: 10 (exact). End: 15 not in set, closest within +5 is 16 (dist 1) or 11 (dist 4)
    // 16 is distance 1, 11 is distance 4. Since 16 > resolved(10), it qualifies
    expect(result!.line).toBe(10);
    expect(result!.endLine).toBe(16);
  });

  it("should omit endLine when resolved endLine equals resolved start line", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([10]));
    const result = validateFinding(map, "src/app.ts", 10, 10);
    // endLine 10 > line 10 is false (equal), so endLine is omitted
    expect(result!.line).toBe(10);
    expect(result!.endLine).toBeUndefined();
  });

  it("should handle endLine resolution when endLine equals start line value", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([10, 11, 12]));
    const result = validateFinding(map, "src/app.ts", 10, 10);
    // endLine is 10, line is 10. endLine > line is false, so no endLine
    expect(result).toEqual({ line: 10 });
  });

  it("should resolve both start and end via proximity for completely off-target finding", () => {
    const map = new Map<string, Set<number>>();
    map.set("src/app.ts", new Set([8, 9, 16, 17]));
    const result = validateFinding(map, "src/app.ts", 10, 15);
    // Start 10: closest valid within +/-5 is 9 (dist 1) or 8 (dist 2)
    // End 15: closest valid within +/-5 is 16 (dist 1) or 17 (dist 2)
    expect(result).not.toBeNull();
    expect([8, 9]).toContain(result!.line);
    expect([16, 17]).toContain(result!.endLine!);
    // endLine must be > resolved start line, so if start=9 and end=16, ok
    expect(result!.endLine!).toBeGreaterThan(result!.line);
  });
});
