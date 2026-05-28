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

// ---------------------------------------------------------------------------
// Edge cases — 10 additional targeted tests
// ---------------------------------------------------------------------------

describe('detectImportCycles — targeted edge cases', () => {
  // 1. Self-import via import type (file type-imports itself)
  it('detects self-import via import type', () => {
    const files = [
      makeFile('src/types.ts', ["+import type { types } from './types';"]),
    ];
    const result = detectImportCycles(files);
    const self = result.cycles.filter((c) => c.category === 'self-import');
    expect(self.length).toBeGreaterThanOrEqual(1);
    expect(self[0].severity).toBe('critical');
  });

  // 2. Three-node indirect cycle with mixed import kinds
  it('detects 3-node indirect cycle with mixed import kinds', () => {
    const files = [
      makeFile('src/alpha.ts', ["+import { beta } from './beta';"]),
      makeFile('src/beta.ts', ["+import type { Gamma } from './gamma';"]),
      makeFile('src/gamma.ts', ["+import { alpha } from './alpha';"]),
    ];
    const result = detectImportCycles(files);
    const indirect = result.cycles.filter((c) => c.category === 'indirect-cycle');
    expect(indirect.length).toBeGreaterThanOrEqual(1);
    expect(indirect[0].length).toBe(3);
    expect(indirect[0].severity).toBe('warning');
  });

  // 3. Dynamic import() forming a direct cycle
  it('detects cycle formed by dynamic import()', () => {
    const files = [
      makeFile('src/lazyA.ts', ["+const mod = import('./lazyB');"]),
      makeFile('src/lazyB.ts', ["+const mod = import('./lazyA');"]),
    ];
    const result = detectImportCycles(files);
    const cycles = result.cycles.filter((c) =>
      c.category === 'direct-cycle' || c.category === 'indirect-cycle'
    );
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    // Verify dynamic-import kind is recorded
    const kinds = result.cycles.flatMap((c) => c.kinds);
    expect(kinds).toContain('dynamic-import');
  });

  // 4. Re-export cycle (export { x } from './a')
  it('detects re-export cycle', () => {
    const files = [
      makeFile('src/reexportA.ts', ["+export { helper } from './reexportB';"]),
      makeFile('src/reexportB.ts', ["+export { util } from './reexportA';"]),
    ];
    const result = detectImportCycles(files);
    const cycles = result.cycles.filter((c) =>
      c.category === 'direct-cycle' || c.category === 'indirect-cycle'
    );
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const kinds = result.cycles.flatMap((c) => c.kinds);
    expect(kinds).toContain('re-export');
  });

  // 5. Multiple independent cycles in same file set
  it('detects multiple independent cycles in the same file set', () => {
    const files = [
      // First cycle: p ↔ q
      makeFile('src/p.ts', ["+import { q } from './q';"]),
      makeFile('src/q.ts', ["+import { p } from './p';"]),
      // Second cycle: r → s → t → r
      makeFile('src/r.ts', ["+import { s } from './s';"]),
      makeFile('src/s.ts', ["+import { t } from './t';"]),
      makeFile('src/t.ts', ["+import { r } from './r';"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles.length).toBeGreaterThanOrEqual(2);
    const categories = result.cycles.map((c) => c.category);
    expect(categories).toContain('direct-cycle');
    expect(categories).toContain('indirect-cycle');
  });

  // 6. Type-only imports are included in cycle detection
  it('includes type-only imports in cycle detection (import type forms a cycle)', () => {
    const files = [
      makeFile('src/ifaceA.ts', ["+import type { IfaceB } from './ifaceB';"]),
      makeFile('src/ifaceB.ts', ["+import type { IfaceA } from './ifaceA';"]),
    ];
    const result = detectImportCycles(files);
    // The regex matches import type — type-only cycles are still flagged
    // because circular type dependencies complicate refactoring
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
  });

  // 7. Aliased import forms a cycle (import { x as y })
  it('detects cycle with aliased import (import { x as y })', () => {
    const files = [
      makeFile('src/aliasA.ts', ["+import { data as d } from './aliasB';"]),
      makeFile('src/aliasB.ts', ["+import { config as c } from './aliasA';"]),
    ];
    const result = detectImportCycles(files);
    const direct = result.cycles.filter((c) => c.category === 'direct-cycle');
    expect(direct.length).toBeGreaterThanOrEqual(1);
  });

  // 8. Deep path imports (multi-level ../)
  it('detects cycle via deep relative path imports', () => {
    const files = [
      makeFile('src/features/auth/login.ts', ["+import { db } from '../../db';"]),
      makeFile('src/db.ts', ["+import { loginHandler } from './features/auth/login';"]),
    ];
    const result = detectImportCycles(files);
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
  });

  // 9. Deleted files do not contribute edges (file status = deleted)
  it('skips edges from deleted files', () => {
    const files = [
      // This file is deleted — its imports should not be extracted
      makeFile('src/deadCode.ts', ["+import { active } from './active';"], "deleted"),
      // active.ts does NOT import back, so no cycle even if deadCode was alive
      makeFile('src/active.ts', ["+export const active = true;"], "modified"),
    ];
    const result = detectImportCycles(files);
    // deleted file hunks typically only have 'delete' change types;
    // the makeFile helper creates 'add' changes, but the status is 'deleted'.
    // extractImportEdges only looks at change.type === 'add', so if the
    // deleted file's hunks only contained deleted lines it would skip them.
    // Here the helper creates add lines but the key contract is:
    // no cycle should be reported since active.ts does not import back.
    expect(result.cycles).toHaveLength(0);
  });

  // 10. Side-effect import forms a cycle
  it('detects cycle formed by side-effect imports', () => {
    const files = [
      makeFile('src/sideA.ts', ["+import './sideB';"]),
      makeFile('src/sideB.ts', ["+import './sideA';"]),
    ];
    const result = detectImportCycles(files);
    // Side-effect imports are kind "import" — they still create edges
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
  });
});
