import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fingerprintFinding,
  trackFindings,
  buildLifecyclePromptContext,
  formatLifecycleSummary,
} from "../finding-lifecycle.js";
import type { FindingFingerprint, LifecycleResult } from "../finding-lifecycle.js";
import type { ReviewCommentType } from "../review.js";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
  dirname: vi.fn((p: string) => p.split("/").slice(0, -1).join("/")),
}));

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: overrides.file ?? "src/api/health.ts",
    line: overrides.line ?? 10,
    endLine: overrides.endLine,
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "security",
    message: overrides.message ?? "SQL injection vulnerability",
    suggestion: overrides.suggestion,
    confidence: overrides.confidence ?? 90,
  };
}

function setupStore(data: Record<string, unknown> = {}): void {
  (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(data));
}

function getLastWrittenStore(): Record<string, unknown> {
  const calls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls;
  if (calls.length === 0) return {};
  const lastCall = calls[calls.length - 1];
  return JSON.parse(lastCall[1] as string);
}

// ---------------------------------------------------------------------------
// fingerprintFinding
// ---------------------------------------------------------------------------

describe("fingerprintFinding", () => {
  it("generates a stable key from file+line+category+messageHash", () => {
    const f = makeFinding();
    const fp = fingerprintFinding(f);
    expect(fp.key).toContain("src/api/health.ts");
    expect(fp.key).toContain("10");
    expect(fp.key).toContain("security");
    expect(fp.file).toBe("src/api/health.ts");
    expect(fp.line).toBe(10);
    expect(fp.category).toBe("security");
  });

  it("produces different keys for different files", () => {
    const fp1 = fingerprintFinding(makeFinding({ file: "src/a.ts" }));
    const fp2 = fingerprintFinding(makeFinding({ file: "src/b.ts" }));
    expect(fp1.key).not.toBe(fp2.key);
  });

  it("produces different keys for different lines", () => {
    const fp1 = fingerprintFinding(makeFinding({ line: 10 }));
    const fp2 = fingerprintFinding(makeFinding({ line: 20 }));
    expect(fp1.key).not.toBe(fp2.key);
  });

  it("produces different keys for different categories", () => {
    const fp1 = fingerprintFinding(makeFinding({ category: "security" }));
    const fp2 = fingerprintFinding(makeFinding({ category: "bug" }));
    expect(fp1.key).not.toBe(fp2.key);
  });

  it("produces different keys for different messages", () => {
    const fp1 = fingerprintFinding(makeFinding({ message: "SQL injection" }));
    const fp2 = fingerprintFinding(makeFinding({ message: "XSS vulnerability" }));
    expect(fp1.key).not.toBe(fp2.key);
  });

  it("produces same key for identical findings", () => {
    const f = makeFinding();
    const fp1 = fingerprintFinding(f);
    const fp2 = fingerprintFinding(f);
    expect(fp1.key).toBe(fp2.key);
  });

  it("produces same key for same file+line+category+message even with different confidence", () => {
    const fp1 = fingerprintFinding(makeFinding({ confidence: 80 }));
    const fp2 = fingerprintFinding(makeFinding({ confidence: 95 }));
    expect(fp1.key).toBe(fp2.key);
  });

  it("preserves severity in fingerprint", () => {
    const fp = fingerprintFinding(makeFinding({ severity: "critical" }));
    expect(fp.severity).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// trackFindings — first review (iteration 1)
// ---------------------------------------------------------------------------

describe("trackFindings first review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it("returns iteration 1 for first review with no stored snapshot", () => {
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", [
      makeFinding({ file: "src/a.ts", line: 10, category: "security", message: "SQL injection" }),
    ]);
    expect(result.currentIteration).toBe(1);
    expect(result.previousIteration).toBe(0);
    expect(result.newFindings).toHaveLength(1);
    expect(result.persisted).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });

  it("classifies all findings as new on first review", () => {
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", [
      makeFinding({ file: "src/a.ts", line: 10 }),
      makeFinding({ file: "src/b.ts", line: 20 }),
    ]);
    expect(result.newFindings).toHaveLength(2);
  });

  it("writes snapshot to store on first review", () => {
    trackFindings("/ws", "owner", "repo", 42, "sha1", [makeFinding()]);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "utf-8",
    );
    const store = getLastWrittenStore();
    expect(store.snapshots["owner/repo#42"]).toBeDefined();
    expect(store.snapshots["owner/repo#42"].iteration).toBe(1);
  });

  it("returns empty arrays for no findings on first review", () => {
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", []);
    expect(result.newFindings).toHaveLength(0);
    expect(result.persisted).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
  });

  it("includes empty context text for first review with no findings", () => {
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", []);
    expect(result.contextText).toBe("");
  });

  it("includes context text for first review with findings", () => {
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", [makeFinding()]);
    expect(result.contextText).toContain("iteration 1");
  });
});

// ---------------------------------------------------------------------------
// trackFindings — subsequent review (iteration 2+)
// ---------------------------------------------------------------------------

describe("trackFindings subsequent review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects persisted findings", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "old-sha",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10, category: "security", message: "SQL injection" }))],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "new-sha", [
      makeFinding({ file: "src/a.ts", line: 10, category: "security", message: "SQL injection" }),
    ]);
    expect(result.currentIteration).toBe(2);
    expect(result.persisted).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.newFindings).toHaveLength(0);
  });

  it("detects resolved findings", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "old-sha",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 }))],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "new-sha", []);
    expect(result.resolved).toHaveLength(1);
    expect(result.persisted).toHaveLength(0);
    expect(result.newFindings).toHaveLength(0);
  });

  it("detects new findings", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "old-sha",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 }))],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "new-sha", [
      makeFinding({ file: "src/a.ts", line: 10 }),
      makeFinding({ file: "src/new.ts", line: 5, category: "bug", message: "Null deref" }),
    ]);
    expect(result.persisted).toHaveLength(1);
    expect(result.newFindings).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
  });

  it("handles mixed persisted, resolved, and new", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "old-sha",
          iteration: 1,
          timestamp: 1000,
          findings: [
            fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 })),
            fingerprintFinding(makeFinding({ file: "src/b.ts", line: 20 })),
            fingerprintFinding(makeFinding({ file: "src/c.ts", line: 30 })),
          ],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "new-sha", [
      makeFinding({ file: "src/a.ts", line: 10 }), // persisted
      makeFinding({ file: "src/d.ts", line: 40, category: "bug", message: "New bug" }), // new
    ]);
    expect(result.persisted).toHaveLength(1); // a.ts persists
    expect(result.resolved).toHaveLength(2); // b.ts and c.ts resolved
    expect(result.newFindings).toHaveLength(1); // d.ts is new
  });

  it("increments iteration counter", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 2,
          timestamp: 2000,
          findings: [],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "sha3", []);
    expect(result.currentIteration).toBe(3);
    expect(result.previousIteration).toBe(2);
  });

  it("overwrites previous snapshot for same PR", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "old-sha",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 }))],
        },
      },
    });
    trackFindings("/ws", "owner", "repo", 42, "new-sha", []);
    const store = getLastWrittenStore();
    expect(store.snapshots["owner/repo#42"].sha).toBe("new-sha");
    expect(store.snapshots["owner/repo#42"].iteration).toBe(2);
  });

  it("preserves other PR snapshots", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 1,
          timestamp: 1000,
          findings: [],
        },
        "other/repo#10": {
          prKey: "other/repo#10",
          sha: "sha-x",
          iteration: 3,
          timestamp: 3000,
          findings: [],
        },
      },
    });
    trackFindings("/ws", "owner", "repo", 42, "sha2", []);
    const store = getLastWrittenStore();
    expect(store.snapshots["other/repo#10"]).toBeDefined();
    expect(store.snapshots["other/repo#10"].iteration).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Store I/O edge cases
// ---------------------------------------------------------------------------

describe("lifecycle store edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles corrupted store file gracefully", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("not json");
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", [makeFinding()]);
    expect(result.currentIteration).toBe(1); // treat as first review
  });

  it("handles empty store file", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("");
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", [makeFinding()]);
    expect(result.currentIteration).toBe(1);
  });

  it("creates store directory on first write", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    trackFindings("/ws", "owner", "repo", 42, "sha1", []);
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(".github"),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("evicts oldest snapshots when over limit", () => {
    const snapshots: Record<string, unknown> = {};
    for (let i = 0; i < 501; i++) {
      snapshots[`org/repo#${i}`] = {
        prKey: `org/repo#${i}`,
        sha: `sha${i}`,
        iteration: 1,
        timestamp: i,
        findings: [],
      };
    }
    setupStore({ snapshots });
    trackFindings("/ws", "owner", "repo", 9999, "newsha", []);
    const store = getLastWrittenStore();
    expect(Object.keys(store.snapshots).length).toBeLessThanOrEqual(500);
    // Newest should be present
    expect(store.snapshots["owner/repo#9999"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildLifecyclePromptContext
// ---------------------------------------------------------------------------

describe("buildLifecyclePromptContext", () => {
  it("returns empty string for first iteration", () => {
    const result: LifecycleResult = {
      persisted: [],
      resolved: [],
      newFindings: [],
      previousIteration: 0,
      currentIteration: 1,
      contextText: "",
    };
    expect(buildLifecyclePromptContext(result)).toBe("");
  });

  it("returns empty string when no persisted findings", () => {
    const result: LifecycleResult = {
      persisted: [],
      resolved: [fingerprintFinding(makeFinding())],
      newFindings: [fingerprintFinding(makeFinding({ file: "src/new.ts" }))],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    expect(buildLifecyclePromptContext(result)).toBe("");
  });

  it("includes persisted findings in prompt context", () => {
    const persisted = [fingerprintFinding(makeFinding({ file: "src/api.ts", line: 42 }))];
    const result: LifecycleResult = {
      persisted,
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const ctx = buildLifecyclePromptContext(result);
    expect(ctx).toContain("Persisted Findings");
    expect(ctx).toContain("src/api.ts:42");
    expect(ctx).toContain("Do NOT re-raise");
  });

  it("limits to 6 persisted findings in prompt", () => {
    const persisted = Array.from({ length: 10 }, (_, i) =>
      fingerprintFinding(makeFinding({ file: `src/file${i}.ts`, line: i + 1 }))
    );
    const result: LifecycleResult = {
      persisted,
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const ctx = buildLifecyclePromptContext(result);
    expect(ctx).toContain("src/file0.ts");
    expect(ctx).toContain("src/file5.ts");
    expect(ctx).toContain("4 more persisted");
  });

  it("mentions previous iteration number", () => {
    const persisted = [fingerprintFinding(makeFinding())];
    const result: LifecycleResult = {
      persisted,
      resolved: [],
      newFindings: [],
      previousIteration: 3,
      currentIteration: 4,
      contextText: "",
    };
    const ctx = buildLifecyclePromptContext(result);
    expect(ctx).toContain("iteration 3");
  });

  it("includes guidance on how to handle persisted findings", () => {
    const persisted = [fingerprintFinding(makeFinding())];
    const result: LifecycleResult = {
      persisted,
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const ctx = buildLifecyclePromptContext(result);
    expect(ctx).toContain("partially addressed");
    expect(ctx).toContain("brief reminder");
  });
});

// ---------------------------------------------------------------------------
// formatLifecycleSummary
// ---------------------------------------------------------------------------

describe("formatLifecycleSummary", () => {
  it("returns empty string for first iteration", () => {
    const result: LifecycleResult = {
      persisted: [],
      resolved: [],
      newFindings: [],
      previousIteration: 0,
      currentIteration: 1,
      contextText: "",
    };
    expect(formatLifecycleSummary(result)).toBe("");
  });

  it("returns empty string when all zero counts", () => {
    const result: LifecycleResult = {
      persisted: [],
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    expect(formatLifecycleSummary(result)).toBe("");
  });

  it("includes markdown table with counts", () => {
    const result: LifecycleResult = {
      persisted: [fingerprintFinding(makeFinding())],
      resolved: [fingerprintFinding(makeFinding({ file: "src/old.ts" }))],
      newFindings: [fingerprintFinding(makeFinding({ file: "src/new.ts" }))],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const summary = formatLifecycleSummary(result);
    expect(summary).toContain("<details>");
    expect(summary).toContain("Finding Lifecycle");
    expect(summary).toContain("iteration 2");
    expect(summary).toContain("| Persisted | 1 |");
    expect(summary).toContain("| Resolved | 1 |");
    expect(summary).toContain("| New | 1 |");
  });

  it("lists persisted findings with file:line", () => {
    const persisted = [fingerprintFinding(makeFinding({ file: "src/auth.ts", line: 42 }))];
    const result: LifecycleResult = {
      persisted,
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const summary = formatLifecycleSummary(result);
    expect(summary).toContain("src/auth.ts:42");
    expect(summary).toContain("still unresolved");
  });

  it("shows resolved message when findings resolved", () => {
    const resolved = [fingerprintFinding(makeFinding({ file: "src/fixed.ts" }))];
    const result: LifecycleResult = {
      persisted: [],
      resolved,
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const summary = formatLifecycleSummary(result);
    expect(summary).toContain("1 finding(s) resolved");
    expect(summary).toContain("Great work");
  });

  it("truncates persisted findings at 5", () => {
    const persisted = Array.from({ length: 8 }, (_, i) =>
      fingerprintFinding(makeFinding({ file: `src/f${i}.ts`, line: i }))
    );
    const result: LifecycleResult = {
      persisted,
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const summary = formatLifecycleSummary(result);
    expect(summary).toContain("3 more");
  });

  it("includes closing details tag", () => {
    const result: LifecycleResult = {
      persisted: [fingerprintFinding(makeFinding())],
      resolved: [],
      newFindings: [],
      previousIteration: 1,
      currentIteration: 2,
      contextText: "",
    };
    const summary = formatLifecycleSummary(result);
    expect(summary).toContain("</details>");
  });
});

// ---------------------------------------------------------------------------
// contextText generation (within trackFindings)
// ---------------------------------------------------------------------------

describe("contextText in trackFindings result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first review with findings includes iteration 1", () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = trackFindings("/ws", "owner", "repo", 42, "sha1", [makeFinding()]);
    expect(result.contextText).toContain("iteration 1");
    expect(result.contextText).toContain("1 finding(s)");
  });

  it("second review shows persisted findings in context", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 }))],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "sha2", [
      makeFinding({ file: "src/a.ts", line: 10 }),
    ]);
    expect(result.contextText).toContain("iteration 2");
    expect(result.contextText).toContain("1 finding(s) persisted");
  });

  it("second review shows resolved findings", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 }))],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "sha2", []);
    expect(result.contextText).toContain("1 finding(s) resolved");
  });

  it("context with all three categories", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 1,
          timestamp: 1000,
          findings: [
            fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 })),
            fingerprintFinding(makeFinding({ file: "src/b.ts", line: 20 })),
          ],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "sha2", [
      makeFinding({ file: "src/a.ts", line: 10 }), // persisted
      makeFinding({ file: "src/c.ts", line: 30, category: "bug", message: "New bug" }), // new
    ]);
    expect(result.contextText).toContain("persisted");
    expect(result.contextText).toContain("resolved");
    expect(result.contextText).toContain("new");
  });

  it("includes focus reminder when findings persisted", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding())],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "sha2", [makeFinding()]);
    expect(result.contextText).toContain("still unresolved");
    expect(result.contextText).toContain("Focus on these");
  });
});

// ---------------------------------------------------------------------------
// Multi-iteration scenarios
// ---------------------------------------------------------------------------

describe("multi-iteration scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("iteration 3 knows about iteration 2", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha2",
          iteration: 2,
          timestamp: 2000,
          findings: [
            fingerprintFinding(makeFinding({ file: "src/a.ts", line: 10 })),
            fingerprintFinding(makeFinding({ file: "src/new.ts", line: 5 })),
          ],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 42, "sha3", [
      makeFinding({ file: "src/a.ts", line: 10 }), // persisted from iter 2
    ]);
    expect(result.currentIteration).toBe(3);
    expect(result.previousIteration).toBe(2);
    expect(result.persisted).toHaveLength(1);
    expect(result.resolved).toHaveLength(1); // src/new.ts from iter 2 resolved
  });

  it("finding resolved then re-introduced is new", () => {
    // Iter 1: has a.ts:10 bug
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha2",
          iteration: 2,
          timestamp: 2000,
          findings: [
            fingerprintFinding(makeFinding({ file: "src/b.ts", line: 20 })),
          ],
        },
      },
    });
    // Iter 3: a.ts:10 bug comes back (was resolved in iter 2)
    const result = trackFindings("/ws", "owner", "repo", 42, "sha3", [
      makeFinding({ file: "src/a.ts", line: 10 }),
      makeFinding({ file: "src/b.ts", line: 20 }),
    ]);
    expect(result.persisted).toHaveLength(1); // b.ts persisted
    expect(result.newFindings).toHaveLength(1); // a.ts is new (not in iter 2 snapshot)
  });

  it("isolates different PRs", () => {
    setupStore({
      snapshots: {
        "owner/repo#42": {
          prKey: "owner/repo#42",
          sha: "sha1",
          iteration: 1,
          timestamp: 1000,
          findings: [fingerprintFinding(makeFinding())],
        },
      },
    });
    const result = trackFindings("/ws", "owner", "repo", 99, "sha2", [makeFinding()]);
    // PR 99 has no previous snapshot — first review
    expect(result.currentIteration).toBe(1);
  });
});
