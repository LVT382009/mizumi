import { describe, it, expect } from "vitest";
import {
  buildLineMapFromRawDiff,
  resolvePosition,
  buildPositionHint,
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

  it("correctly maps added lines to positions", () => {
    const map = buildLineMapFromRawDiff(SAMPLE_DIFF);
    const fileMap = map.get("src/foo.ts");
    expect(fileMap).toBeDefined();

    // "import { z }" is at the 7th diff line => position 7
    // It's the 2nd new-file line after the @@ header starts at newLineNumber=1
    // After header: line 1 is context("import { x }") => newLine=1, pos=6
    //   Wait — let me trace precisely:
    //   Line 1: "diff --git..." => position++ => pos=1, skip
    //   Line 2: "index ..."     => position++ => pos=2, skip
    //   Line 3: "--- ..."       => position++ => pos=3, skip
    //   Line 4: "+++ ..."       => position++ => pos=4, skip
    //   Line 5: "@@ ..."        => position++ => pos=5, set newLineNumber=0
    //   Line 6: " import { x }" => position++ => pos=6, context=>newLine=1, set(1,6)
    //   Line 7: "+import { z }" => position++ => pos=7, add=>newLine=2, set(2,7)
    //   Line 8: "+import { a }" => position++ => pos=8, add=>newLine=3, set(3,8)
    //   Line 9: " "             => position++ => pos=9, context=>newLine=4, set(4,9)
    //   Line 10:"-const old..."  => position++ => pos=10, delete=>no new FileLine
    //   Line 11:"+const new..."  => position++ => pos=11, add=>newLine=5, set(5,11)
    //   Line 12:" // end"        => position++ => pos=12, context=>newLine=6, set(6,12)

    expect(fileMap!.get(2)).toBe(7); // first added line
    expect(fileMap!.get(3)).toBe(8); // second added line
    expect(fileMap!.get(5)).toBe(11); // added "const new" line
  });

  it("counts position across ALL diff lines including metadata and hunk headers", () => {
    const map = buildLineMapFromRawDiff(SAMPLE_DIFF);
    const fileMap = map.get("src/foo.ts");

    // Context line at newLineNumber=1 should have position 6
    // (positions 1-4 were metadata, 5 was hunk header)
    expect(fileMap!.get(1)).toBe(6);
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
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-old2",
      "+new2",
    ].join("\n");

    const map = buildLineMapFromRawDiff(multiDiff);
    expect(map.has("a.ts")).toBe(true);
    expect(map.has("b.ts")).toBe(true);
    expect(map.get("a.ts")!.get(1)).toBe(7); // "+new" is line 7 in the diff
    expect(map.get("b.ts")!.get(1)).toBe(14); // "+new2" is line 14 in the diff
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
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -5,2 +5,3 @@",
      " context5",
      "+added later",
      " context6",
    ].join("\n");

    const map = buildLineMapFromRawDiff(multiFileDiff);

    // first.txt: line 2 ("+added early") maps correctly
    const firstMap = map.get("first.txt");
    expect(firstMap!.get(2)).toBeDefined();

    // second.txt: the @@ header says +5 so newLineNumber should start from 4 (5-1)
    // context5 => newLine=5, "+added later" => newLine=6
    const secondMap = map.get("second.txt");
    expect(secondMap!.get(6)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePosition
// ---------------------------------------------------------------------------

describe("resolvePosition", () => {
  function makeMap(
    entries: Array<[string, Array<[number, number]>]>
  ): Map<string, Map<number, number>> {
    const map = new Map<string, Map<number, number>>();
    for (const [file, lines] of entries) {
      const inner = new Map<number, number>();
      for (const [line, pos] of lines) {
        inner.set(line, pos);
      }
      map.set(file, inner);
    }
    return map;
  }

  it("returns exact match when line exists", () => {
    const map = makeMap([["src/app.ts", [[10, 42], [20, 55]]]]);
    expect(resolvePosition(map, "src/app.ts", 10)).toBe(42);
    expect(resolvePosition(map, "src/app.ts", 20)).toBe(55);
  });

  it("falls back to nearest line within plus/minus 5 when exact line is missing", () => {
    const map = makeMap([["src/app.ts", [[10, 42], [16, 58]]]]);
    // Line 12 is not in the map, but 10 is within 5 lines
    const result = resolvePosition(map, "src/app.ts", 12);
    expect(result).toBe(42); // closest to 12 is line 10 (distance 2)
  });

  it("picks the closer line when two candidates are equidistant", () => {
    // Line 12 requested; line 10 (dist 2) and line 14 (dist 2) both within 5
    // When tied, sort is stable-by-order; the filter preserves insertion order
    const map = makeMap([["src/app.ts", [[10, 42], [14, 99]]]]);
    const result = resolvePosition(map, "src/app.ts", 12);
    // Either 42 or 99 is acceptable; must be one of them
    expect([42, 99]).toContain(result);
  });

  it("returns null when no file match exists", () => {
    const map = makeMap([["src/app.ts", [[10, 42]]]]);
    expect(resolvePosition(map, "src/other.ts", 10)).toBeNull();
  });

  it("returns null when the nearest line is more than 5 lines away", () => {
    const map = makeMap([["src/app.ts", [[10, 42]]]]);
    expect(resolvePosition(map, "src/app.ts", 20)).toBeNull(); // distance 10 > 5
  });

  it("returns null when the file map is empty", () => {
    const map = makeMap([["src/app.ts", []]]);
    expect(resolvePosition(map, "src/app.ts", 1)).toBeNull();
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
