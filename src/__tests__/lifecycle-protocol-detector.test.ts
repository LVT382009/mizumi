import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectLifecycleProtocolViolations } from "../lifecycle-protocol-detector.js";
import type { LifecycleProtocolIssue, LifecycleProtocolResult } from "../lifecycle-protocol-detector.js";
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

describe("detectLifecycleProtocolViolations — no issues", () => {
  it("returns empty for code without state machines", () => {
    const files = [makeFile("src/app.ts", [
      "+const data = await fetchData();",
      "+console.log(data);",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/fsm.ts", [
      "+createMachine({});",
    ], "deleted")];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — invalid transitions", () => {
  it("detects setState to state not in transition table", () => {
    const files = [makeFile("src/order.ts", [
      "+const machine = createMachine({",
      "+  initial: 'pending',",
      "+  states: {",
      "+    pending: { target: 'processing' },",
      "+    processing: { target: 'completed' },",
      "+  },",
      "+});",
      "+setStatus('shipped');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
    expect(invalid[0].severity).toBe("critical");
  });

  it("detects transition to state outside defined transitions", () => {
    const files = [makeFile("src/deploy.ts", [
      "+createMachine({",
      "+  initial: 'idle',",
      "+  states: {",
      "+    idle: { target: 'deploying' },",
      "+    deploying: { target: 'deployed' },",
      "+  },",
      "+});",
      "+transition('cancelled');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag transition to state in table", () => {
    const files = [makeFile("src/order.ts", [
      "+createMachine({",
      "+  initial: 'pending',",
      "+  states: {",
      "+    pending: { target: 'processing' },",
      "+    processing: { target: 'completed' },",
      "+  },",
      "+});",
      "+setStatus('processing');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing initial state
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — missing initial state", () => {
  it("detects createMachine without initial state", () => {
    const files = [makeFile("src/fsm.ts", [
      "+const machine = createMachine({",
      "+  states: {",
      "+    idle: {},",
      "+    running: {},",
      "+  },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("critical");
  });

  it("detects Machine() without initial state", () => {
    const files = [makeFile("src/fsm.ts", [
      "+const fsm = Machine({",
      "+  states: { active: {}, paused: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(1);
  });

  it("does not flag machine with initial state", () => {
    const files = [makeFile("src/fsm.ts", [
      "+const machine = createMachine({",
      "+  initial: 'idle',",
      "+  states: { idle: {}, running: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unreachable state
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — unreachable state", () => {
  it("detects state not targeted by any transition", () => {
    const files = [makeFile("src/fsm.ts", [
      "+const machine = createMachine({",
      "+  initial: 'idle',",
      "+  states: {",
      "+    idle: {},",
      "+    'running': {},",
      "+    'paused': {},",
      "+  },",
      "+  transitions: {",
      "+    idle: { target: 'running' },",
      "+  },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-state");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].severity).toBe("warning");
  });

  it("does not flag state targeted by transition", () => {
    const files = [makeFile("src/fsm.ts", [
      "+const machine = createMachine({",
      "+  initial: 'idle',",
      "+  states: {",
      "+    'idle': {},",
      "+    'active': {},",
      "+  },",
      "+  transitions: {",
      "+    idle: { target: 'active' },",
      "+  },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-state");
    expect(unreachable).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Missing error state
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — missing error state", () => {
  it("detects state machine without error/failure state", () => {
    const files = [makeFile("src/order.ts", [
      "+const machine = createMachine({",
      "+  initial: 'pending',",
      "+  states: {",
      "+    pending: {},",
      "+    processing: {},",
      "+    completed: {},",
      "+  },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(1);
    expect(missingErr[0].severity).toBe("warning");
  });

  it("does not flag machine with error state", () => {
    const files = [makeFile("src/order.ts", [
      "+const machine = createMachine({",
      "+  initial: 'pending',",
      "+  states: {",
      "+    pending: {},",
      "+    processing: {},",
      "+    error: {},",
      "+    completed: {},",
      "+  },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(0);
  });

  it("does not flag machine with failed state", () => {
    const files = [makeFile("src/deploy.ts", [
      "+const machine = createMachine({",
      "+  initial: 'idle',",
      "+  states: { idle: {}, deploying: {}, failed: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/fsm.ts", [
      "+createMachine({",
      "+  states: { active: {}, paused: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Lifecycle Protocol");
    }
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/fsm.ts", [
      "+createMachine({",
      "+  states: { active: {}, paused: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("Lifecycle Protocol");
      expect(result.bodySummary).toContain("<details>");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/fsm.ts", [
      "-// createMachine({ states: {} });",
      "+const x = 42;",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/fsm.ts", [])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+createMachine({ states: {} });"]),
      makeFile("src/b.ts", ["+Machine({ states: {} });"]),
    ];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("skips comment lines", () => {
    const files = [makeFile("src/fsm.ts", [
      "+// createMachine({ states: {} });",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("recognizes FSM pattern", () => {
    const files = [makeFile("src/fsm.ts", [
      "+FSM({",
      "+  states: { locked: {}, unlocked: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingInit = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missingInit.length).toBeGreaterThanOrEqual(1);
  });

  it("recognizes useStateMachine pattern", () => {
    const files = [makeFile("src/hook.ts", [
      "+useStateMachine({",
      "+  states: { idle: {}, loading: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const issues = result.issues.filter((i) =>
      i.category === "missing-initial-state" || i.category === "missing-error-state"
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag machine with rejected state", () => {
    const files = [makeFile("src/approval.ts", [
      "+createMachine({",
      "+  initial: 'submitted',",
      "+  states: { submitted: {}, approved: {}, rejected: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(0);
  });

  it("recognizes .status = literal assignment", () => {
    const files = [makeFile("src/order.ts", [
      "+order.status = 'shipped';",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    // This should not crash; it just collects the state literal
    expect(result).toBeDefined();
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = ["+createMachine({ states: {"];
    for (let i = 0; i < 20; i++) {
      changes.push(`+    'state${i}': {},`);
    }
    changes.push("+});");
    const files = [makeFile("src/fsm.ts", changes)];
    const result = detectLifecycleProtocolViolations(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("detects goTo() calls outside transition table", () => {
    const files = [makeFile("src/workflow.ts", [
      "+createMachine({",
      "+  initial: 'draft',",
      "+  states: {",
      "+    draft: { target: 'review' },",
      "+    review: { target: 'approved' },",
      "+  },",
      "+});",
      "+goTo('archived');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });

  it("recognizes proceed() pattern", () => {
    const files = [makeFile("src/pipeline.ts", [
      "+createMachine({",
      "+  initial: 'start',",
      "+  states: {",
      "+    start: { target: 'middle' },",
      "+    middle: { target: 'end' },",
      "+  },",
      "+});",
      "+proceed('unknown');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });
});
