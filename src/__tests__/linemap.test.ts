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
});
