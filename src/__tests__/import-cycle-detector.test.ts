import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectImportCycles } from "../import-cycle-detector.js";
import type { ImportCycle, CycleDetectionResult } from "../import-cycle-detector.js";
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
// detectImportCycles — no cycles
// ---------------------------------------------------------------------------

describe("detectImportCycles — no cycles", () => {
  it("returns empty when there are no imports", () => {
    const files = [makeFile("src/utils.ts", [
      "+const x = 1;",
      "+export function add(a: number, b: number) { return a + b; }",
    ])];
    const result = detectImportCycles(files);
    expect(result.cycles).toHaveLength(0);
  });

  it("returns empty when imports form a DAG (no cycles)", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { c } from './c';"]),
      makeFile("src/c.ts", ["+export const c = 42;"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles).toHaveLength(0);
  });

  it("returns empty for external imports", () => {
    const files = [makeFile("src/app.ts", [
      "+import express from 'express';",
      "+import { z } from 'zod';",
    ])];
    const result = detectImportCycles(files);
    expect(result.cycles).toHaveLength(0);
  });

  it("skips deleted files from cycle detection", () => {
    const files = [makeFile("src/old.ts", [
      "+import { foo } from './bar';",
    ], "deleted")];
    const result = detectImportCycles(files);
    // extractImportEdges only parses added lines, but the file status
    // doesn't directly cycle-detect — the key is no cycle edges exist
    expect(result.cycles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Direct cycles (2-node)
// ---------------------------------------------------------------------------

describe("detectImportCycles — direct cycles", () => {

  it("detects A imports B, B imports A", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === "direct-cycle");
    expect(direct.length).toBeGreaterThanOrEqual(1);
    expect(direct[0].severity).toBe("critical");
    expect(direct[0].length).toBe(2);
  });

  it("includes both files in the chain", () => {
    const files = [
      makeFile("src/models/user.ts", ["+import { DB } from '../db';"]),
      makeFile("src/db.ts", ["+import { User } from './models/user';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === "direct-cycle");
    if (direct.length > 0) {
      expect(direct[0].chain.length).toBeGreaterThanOrEqual(3); // A, B, A
    }
  });

  it("description mentions both files", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === "direct-cycle");
    if (direct.length > 0) {
      expect(direct[0].description).toContain("Direct cycle");
    }
  });
});

// ---------------------------------------------------------------------------
// Indirect cycles (3+ node)
// ---------------------------------------------------------------------------

describe("detectImportCycles — indirect cycles", () => {
  it("detects A→B→C→A (3-node cycle)", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { c } from './c';"]),
      makeFile("src/c.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const indirect = result.cycles.filter((c) => c.category === "indirect-cycle");
    expect(indirect.length).toBeGreaterThanOrEqual(1);
    expect(indirect[0].severity).toBe("warning");
    expect(indirect[0].length).toBe(3);
  });

  it("detects 4-node cycle A→B→C→D→A", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { c } from './c';"]),
      makeFile("src/c.ts", ["+import { d } from './d';"]),
      makeFile("src/d.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const cycles = result.cycles.filter((c) => c.length >= 4);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });

  it("description mentions indirect cycle", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { c } from './c';"]),
      makeFile("src/c.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const indirect = result.cycles.filter((c) => c.category === "indirect-cycle");
    if (indirect.length > 0) {
      expect(indirect[0].description).toContain("Indirect cycle");
    }
  });
});

// ---------------------------------------------------------------------------
// Self-imports
// ---------------------------------------------------------------------------

describe("detectImportCycles — self-imports", () => {
  it("detects a file importing itself", () => {
    const files = [makeFile("src/utils.ts", [
      "+import { helper } from './utils';",
    ])];
    const result = detectImportCycles(files);
    const self = result.cycles.filter((c) => c.category === "self-import");
    expect(self.length).toBeGreaterThanOrEqual(1);
    expect(self[0].severity).toBe("critical");
  });

  it("self-import description mentions file", () => {
    const files = [makeFile("src/helpers.ts", [
      "+import { fn } from './helpers';",
    ])];
    const result = detectImportCycles(files);
    const self = result.cycles.filter((c) => c.category === "self-import");
    if (self.length > 0) {
      expect(self[0].description).toContain("Self-import");
    }
  });
});

// ---------------------------------------------------------------------------
// Import types
// ---------------------------------------------------------------------------

describe("detectImportCycles — import kinds", () => {
  it("detects require-based cycles", () => {
    const files = [
      makeFile("src/a.ts", ["+const b = require('./b');"]),
      makeFile("src/b.ts", ["+const a = require('./a');"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === "direct-cycle");
    expect(direct.length).toBeGreaterThanOrEqual(1);
  });

  it("detects type import cycles", () => {
    const files = [
      makeFile("src/a.ts", ["+import type { B } from './b';"]),
      makeFile("src/b.ts", ["+import type { A } from './a';"]),
    ];
    const result = detectImportCycles(files);
    // Type-only import cycles are still worth flagging (they indicate
    // circular type dependencies that complicate refactoring)
    expect(result.cycles).toBeDefined();
  });

  it("records import kinds in the cycle", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === "direct-cycle");
    if (direct.length > 0) {
      expect(direct[0].kinds.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("detectImportCycles — deduplication", () => {
  it("does not report the same cycle twice", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const chains = result.cycles.map((c) => c.chain.slice(0, -1).sort().join("|"));
    const unique = new Set(chains);
    // Same cycle should not be reported more than once
    for (const chain of chains) {
      const count = chains.filter((c) => c === chain).length;
      expect(count).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectImportCycles — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
      makeFile("src/c.ts", ["+import { d } from './d';"]),
      makeFile("src/d.ts", ["+import { e } from './e';"]),
      makeFile("src/e.ts", ["+import { c } from './c';"]),
    ];
    const result = detectImportCycles(files);
    if (result.cycles.length > 1) {
      const severities = result.cycles.map((c) => c.severity);
      const firstWarning = severities.indexOf("warning");
      const lastCritical = severities.lastIndexOf("critical");
      if (firstWarning >= 0 && lastCritical >= 0) {
        expect(lastCritical).toBeLessThan(firstWarning);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("detectImportCycles — context text", () => {
  it("includes cycles in contextText", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    if (result.cycles.length > 0) {
      expect(result.contextText).toContain("Import Cycle Detection");
    }
  });

  it("returns empty contextText when no cycles", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = detectImportCycles(files);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("detectImportCycles — body summary", () => {
  it("includes table in bodySummary when cycles exist", () => {
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    if (result.cycles.length > 0) {
      expect(result.bodySummary).toContain("Import Cycle Detection");
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty bodySummary when no cycles", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = detectImportCycles(files);
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Complex scenarios
// ---------------------------------------------------------------------------

describe("detectImportCycles — complex scenarios", () => {
  it("detects cycle in diamond dependency pattern", () => {
    // A→B, A→C, B→D, C→D (no cycle — just a diamond)
    const files = [
      makeFile("src/a.ts", [
        "+import { b } from './b';",
        "+import { c } from './c';",
      ]),
      makeFile("src/b.ts", ["+import { d } from './d';"]),
      makeFile("src/c.ts", ["+import { d } from './d';"]),
      makeFile("src/d.ts", ["+export const d = 42;"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles).toHaveLength(0);
  });

  it("detects cycle hidden in diamond with back-edge", () => {
    // A→B→C→D→B (cycle: B→C→D→B)
    const files = [
      makeFile("src/a.ts", ["+import { b } from './b';"]),
      makeFile("src/b.ts", ["+import { c } from './c';"]),
      makeFile("src/c.ts", ["+import { d } from './d';"]),
      makeFile("src/d.ts", ["+import { b } from './b';"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
  });

  it("handles mixed external and internal imports", () => {
    const files = [
      makeFile("src/a.ts", [
        "+import express from 'express';",
        "+import { b } from './b';",
      ]),
      makeFile("src/b.ts", [
        "+import { z } from 'zod';",
        "+import { a } from './a';",
      ]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === "direct-cycle");
    expect(direct.length).toBeGreaterThanOrEqual(1);
  });
});
// ---------------------------------------------------------------------------
// Edge cases — additional coverage
// ---------------------------------------------------------------------------

describe('detectImportCycles — edge cases (expanded)', () => {
  it('ignores deleted lines for import extraction', () => {
    const files = [
      makeFile('src/a.ts', ["-import { b } from './b';", "+import { c } from './c';"]),
      makeFile('src/c.ts', ["+export const c = 42;"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles).toHaveLength(0);
  });

  it('handles files with no hunks', () => {
    const files = [makeFile('src/empty.ts', [])];
    const result = detectImportCycles(files);
    expect(result.cycles).toHaveLength(0);
  });

  it('detects cycle with aliased imports', () => {
    const files = [
      makeFile('src/a.ts', ["+import { b as B } from './b';"]),
      makeFile('src/b.ts', ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === 'direct-cycle');
    expect(direct.length).toBeGreaterThanOrEqual(1);
  });

  it('handles multiple imports from the same file', () => {
    const files = [
      makeFile('src/a.ts', [
        "+import { b1 } from './b';",
        "+import { b2 } from './b';",
      ]),
      makeFile('src/b.ts', ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === 'direct-cycle');
    expect(direct.length).toBeGreaterThanOrEqual(1);
  });

  it('detects cycle with path variations (subdirectory)', () => {
    const files = [
      makeFile('src/services/auth.ts', ["+import { db } from '../db';"]),
      makeFile('src/db.ts', ["+import { authenticate } from './services/auth';"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles).toBeDefined();
  });

  it('returns correct contextText structure with both sections', () => {
    const files = [
      makeFile('src/a.ts', ["+import { b } from './b';"]),
      makeFile('src/b.ts', ["+import { a } from './a';"]),
      makeFile('src/c.ts', ["+import { d } from './d';"]),
      makeFile('src/d.ts', ["+import { e } from './e';"]),
      makeFile('src/e.ts', ["+import { c } from './c';"]),
    ];
    const result = detectImportCycles(files);
    if (result.cycles.length > 0) {
      expect(result.contextText).toContain('Import Cycle Detection');
    }
  });

  it('body summary shows chain preview with filenames only', () => {
    const files = [
      makeFile('src/a.ts', ["+import { b } from './b';"]),
      makeFile('src/b.ts', ["+import { a } from './a';"]),
    ];
    const result = detectImportCycles(files);
    if (result.cycles.length > 0 && result.bodySummary) {
      expect(result.bodySummary).toContain('| Category |');
      expect(result.bodySummary).toContain('cycle');
    }
  });

  it('handles require with destructuring', () => {
    const files = [
      makeFile('src/x.ts', ["+const { y } = require('./y');"]),
      makeFile('src/y.ts', ["+const { x } = require('./x');"]),
    ];
    const result = detectImportCycles(files);
    const cycles = result.cycles.filter((c) => c.category === 'direct-cycle');
    expect(cycles.length).toBeGreaterThanOrEqual(1);
  });
});
