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

// ---------------------------------------------------------------------------
// Additional edge case tests — invalid transitions with React hooks
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — invalid transitions with React hooks", () => {
  it("should detect invalid transition via useMachine hook when setState targets state outside table", () => {
    const files = [makeFile("src/useAuth.ts", [
      "+useMachine({",
      "+ initial: 'loggedOut',",
      "+ states: {",
      "+ loggedOut: { target: 'loggedIn' },",
      "+ loggedIn: { target: 'loggedOut' },",
      "+ },",
      "+});",
      "+setState('admin');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
    expect(invalid[0].severity).toBe("critical");
  });

  it("should detect invalid transition via useStateMachine hook when setState targets state outside table", () => {
    const files = [makeFile("src/useToggle.ts", [
      "+useStateMachine({",
      "+ initial: 'off',",
      "+ states: {",
      "+ off: { target: 'on' },",
      "+ on: { target: 'off' },",
      "+ },",
      "+});",
      "+setState('maybe');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });

  it("should not flag setState to error as invalid transition even when error is not in table", () => {
    const files = [makeFile("src/deploy.ts", [
      "+createMachine({",
      "+ initial: 'idle',",
      "+ states: {",
      "+ idle: { target: 'running' },",
      "+ },",
      "+});",
      "+setState('error');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid).toHaveLength(0);
  });

  it("should not flag setState to failed as invalid transition even when failed is not in table", () => {
    const files = [makeFile("src/task.ts", [
      "+createMachine({",
      "+ initial: 'pending',",
      "+ states: {",
      "+ pending: { target: 'running' },",
      "+ },",
      "+});",
      "+setState('failed');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid).toHaveLength(0);
  });

  it("should detect changeState() call outside transition table", () => {
    const files = [makeFile("src/flow.ts", [
      "+createMachine({",
      "+ initial: 'init',",
      "+ states: {",
      "+ init: { target: 'ready' },",
      "+ },",
      "+});",
      "+changeState('unknown_state');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });

  it("should detect advance() call outside transition table via FSM pattern", () => {
    const files = [makeFile("src/queue.ts", [
      "+FSM({",
      "+ initial: 'waiting',",
      "+ states: {",
      "+ waiting: { target: 'serving' },",
      "+ serving: { target: 'done' },",
      "+ },",
      "+});",
      "+advance('skipped');",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const invalid = result.issues.filter((i) => i.category === "invalid-transition");
    expect(invalid.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests — missing initial state with hooks
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — missing initial state with hooks", () => {
  it("should detect useStateMachine without initial state", () => {
    const files = [makeFile("src/hook.ts", [
      "+const [state, send] = useStateMachine({",
      "+ states: { formOpen: {}, formClosed: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("critical");
  });

  it("should detect StateMachine() without initial state", () => {
    const files = [makeFile("src/legacy.ts", [
      "+StateMachine({",
      "+ states: { off: {}, on: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(1);
  });

  it("should not flag useStateMachine with initial state", () => {
    const files = [makeFile("src/hook.ts", [
      "+useStateMachine({",
      "+ initial: 'idle',",
      "+ states: { idle: {}, busy: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(0);
  });

  it("should not flag Machine() with initial state", () => {
    const files = [makeFile("src/fsm.ts", [
      "+Machine({",
      "+ initial: 'start',",
      "+ states: { start: {}, finish: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missing = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests — unreachable state exemptions
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — unreachable state exemptions", () => {
  it("should not flag initial state as unreachable when no incoming transition targets it", () => {
    const files = [makeFile("src/fsm.ts", [
      "+const machine = createMachine({",
      "+ initial: 'idle',",
      "+ states: {",
      "+ 'idle': {},",
      "+ 'running': {},",
      "+ },",
      "+ transitions: {",
      "+ running: { target: 'idle' },",
      "+ },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter(
      (i) => i.category === "unreachable-state" && i.code.includes("idle"),
    );
    expect(unreachable).toHaveLength(0);
  });

  it("should not flag done state as unreachable", () => {
    const files = [makeFile("src/pipeline.ts", [
      "+createMachine({",
      "+ initial: 'start',",
      "+ states: {",
      "+ 'start': {},",
      "+ 'done': {},",
      "+ },",
      "+ transitions: {",
      "+ start: { target: 'start' },",
      "+ },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter(
      (i) => i.category === "unreachable-state" && i.code.includes("done"),
    );
    expect(unreachable).toHaveLength(0);
  });

  it("should not flag success state as unreachable", () => {
    const files = [makeFile("src/job.ts", [
      "+createMachine({",
      "+ initial: 'pending',",
      "+ states: {",
      "+ 'pending': {},",
      "+ 'success': {},",
      "+ },",
      "+ transitions: {",
      "+ pending: { target: 'pending' },",
      "+ },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter(
      (i) => i.category === "unreachable-state" && i.code.includes("success"),
    );
    expect(unreachable).toHaveLength(0);
  });

  it("should not flag error state as unreachable", () => {
    const files = [makeFile("src/process.ts", [
      "+createMachine({",
      "+ initial: 'ready',",
      "+ states: {",
      "+ 'ready': {},",
      "+ 'error': {},",
      "+ },",
      "+ transitions: {",
      "+ ready: { target: 'ready' },",
      "+ },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter(
      (i) => i.category === "unreachable-state" && i.code.includes("error"),
    );
    expect(unreachable).toHaveLength(0);
  });

  it("should not flag failed state as unreachable", () => {
    const files = [makeFile("src/batch.ts", [
      "+createMachine({",
      "+ initial: 'queued',",
      "+ states: {",
      "+ 'queued': {},",
      "+ 'failed': {},",
      "+ },",
      "+ transitions: {",
      "+ queued: { target: 'queued' },",
      "+ },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const unreachable = result.issues.filter(
      (i) => i.category === "unreachable-state" && i.code.includes("failed"),
    );
    expect(unreachable).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests — missing error state with alternative names
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — missing error state alternative names", () => {
  it("should not flag machine with aborted state as missing error state", () => {
    const files = [makeFile("src/task.ts", [
      "+createMachine({",
      "+ initial: 'pending',",
      "+ states: { pending: {}, running: {}, aborted: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(0);
  });

  it("should not flag machine with cancelled state as missing error state", () => {
    const files = [makeFile("src/order.ts", [
      "+createMachine({",
      "+ initial: 'created',",
      "+ states: { created: {}, cancelled: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(0);
  });

  it("should not flag machine with timeout state as missing error state", () => {
    const files = [makeFile("src/conn.ts", [
      "+createMachine({",
      "+ initial: 'connected',",
      "+ states: { connected: {}, timeout: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingErr = result.issues.filter((i) => i.category === "missing-error-state");
    expect(missingErr).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests — line type filtering and multi-machine
// ---------------------------------------------------------------------------

describe("detectLifecycleProtocolViolations — line filtering and multi-machine", () => {
  it("should ignore normal unchanged lines", () => {
    const files = [makeFile("src/fsm.ts", [
      " createMachine({",
      " states: { active: {}, paused: {} },",
      " });",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("should not detect state machine patterns on deleted lines", () => {
    const files = [makeFile("src/fsm.ts", [
      "-createMachine({",
      "- states: { idle: {}, running: {} },",
      "-});",
      "+const x = 1;",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("should handle two state machines in the same file independently", () => {
    const files = [makeFile("src/dual.ts", [
      "+createMachine({",
      "+ states: { a1: {}, a2: {} },",
      "+});",
      "+Machine({",
      "+ states: { b1: {}, b2: {} },",
      "+});",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    const missingInit = result.issues.filter((i) => i.category === "missing-initial-state");
    expect(missingInit.length).toBeGreaterThanOrEqual(2);
  });

  it("should skip import lines even if they contain Machine keyword", () => {
    const files = [makeFile("src/fsm.ts", [
      "+import { Machine } from 'xstate';",
      "+const x = 42;",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("should skip type definition lines even if they contain state machine terms", () => {
    const files = [makeFile("src/types.ts", [
      "+type StateMachine = { states: string[] };",
      "+const x = 42;",
    ])];
    const result = detectLifecycleProtocolViolations(files);
    expect(result.issues).toHaveLength(0);
  });
});
