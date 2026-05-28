/**
 * State Machine / Lifecycle Protocol Detector — detect lifecycle protocol
 * violations in PR diffs.
 *
 * No AI code reviewer detects state machine violations at PR review time.
 * State machines are everywhere (order processing, deployment pipelines,
 * auth flows, document workflows), but violations like invalid transitions,
 * missing initial state, and unreachable states are only caught by runtime
 * bugs (order shipped before paid, deploy rolled back before started).
 *
 * XState and similar libraries validate at runtime, but not at PR review.
 * The gap: developers add a new state or transition without updating the
 * transition table, creating phantom states or illegal transitions.
 *
 * Mizumi scans added lines for 4 lifecycle violation categories:
 * 1. Invalid transition: state assignment outside allowed transitions
 * 2. Missing initial state: state machine without initial/default state
 * 3. Unreachable state: state in the machine that no transition targets
 * 4. Missing error state: state machine with no error/failure state
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifecycleProtocolCategory =
  | "invalid-transition"
  | "missing-initial-state"
  | "unreachable-state"
  | "missing-error-state";

export interface LifecycleProtocolIssue {
  /** Category of the issue */
  category: LifecycleProtocolCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = invalid-transition/missing-initial, warning = unreachable/missing-error */
  severity: "critical" | "warning";
}

export interface LifecycleProtocolResult {
  /** All detected lifecycle protocol issues */
  issues: LifecycleProtocolIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// State machine patterns
const STATE_MACHINE_RE = /(?:createMachine|Machine|StateMachine|fsm|FSM|useStateMachine|useMachine|createStateMachine)\s*\(/;
const STATE_ASSIGN_RE = /(?:\.status|\.state|\.phase|\.stage)\s*=\s*['"](\w+)['"]/;
const TRANSITION_RE = /(?:target|next|to|transition)\s*:\s*['"](\w+)['"]/;
const INITIAL_STATE_RE = /(?:initial|start|default)\s*:\s*['"](\w+)['"]/;
const ERROR_STATE_RE = /['\"]?(?:error|failed|failure|rejected|invalid|cancelled|aborted|denied|timeout|dead)['\"]?\s*:/;

// Common state machine keywords in code
const SET_STATUS_RE = /(?:setState|setStatus|setPhase|setStage|transition|goTo|changeState|advance|proceed)\s*\(\s*['"](\w+)['"]/;
const STATE_LITERAL_RE = /(?:status|state|phase|stage)\s*(?:===|!==|==|=)\s*['"](\w+)['"]/;

// Lines to skip
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectInvalidTransitions(file: DiffFile): LifecycleProtocolIssue[] {
  const issues: LifecycleProtocolIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Look for state machine definitions and transition patterns
  let hasStateMachine = false;
  const transitions = new Set<string>();
  const states = new Set<string>();

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    if (STATE_MACHINE_RE.test(change.content)) {
      hasStateMachine = true;
    }

    // Collect transition targets
    const transMatch = change.content.match(TRANSITION_RE);
    if (transMatch) {
      transitions.add(transMatch[1]);
    }

    // Collect state assignments
    const stateMatch = change.content.match(STATE_ASSIGN_RE);
    if (stateMatch) {
      states.add(stateMatch[1]);
    }

    // Collect setState/setStatus calls
    const setStatusMatch = change.content.match(SET_STATUS_RE);
    if (setStatusMatch) {
      states.add(setStatusMatch[1]);
    }

    // Collect state literal comparisons
    const stateLitMatch = change.content.match(STATE_LITERAL_RE);
    if (stateLitMatch) {
      states.add(stateLitMatch[1]);
    }
  }

  // Flag setState/setStatus calls that don't appear in any transition table
  if (hasStateMachine || transitions.size > 0) {
    for (const change of addedChanges) {
      if (SKIP_LINE_RE.test(change.content)) continue;

      const setStatusMatch = change.content.match(SET_STATUS_RE);
      if (setStatusMatch) {
        const targetState = setStatusMatch[1];
        if (transitions.size > 0 && !transitions.has(targetState) && targetState !== "error" && targetState !== "failed") {
          const trimmed = change.content.replace(/^\+/, "").trim();
          issues.push({
            category: "invalid-transition",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Possible invalid transition to '${targetState}' in \`${file.path}:${change.line}\` — state '${targetState}' not found in transition table; verify this transition is valid`,
            severity: "critical",
          });
        }
      }
    }
  }

  return issues;
}

function detectMissingInitialState(file: DiffFile): LifecycleProtocolIssue[] {
  const issues: LifecycleProtocolIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Find state machine creation without initial state
  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (SKIP_LINE_RE.test(change.content)) continue;

    if (!STATE_MACHINE_RE.test(change.content)) continue;

    // Look ahead for initial state definition (up to 20 lines)
    let hasInitialState = false;
    for (let j = i + 1; j < Math.min(i + 20, addedChanges.length); j++) {
      const next = addedChanges[j];
      if (INITIAL_STATE_RE.test(next.content)) {
        hasInitialState = true;
        break;
      }
      // Stop at end of machine definition
      if (/^\+\s*\}\s*[;,]\s*$/.test(next.content)) break;
    }

    if (!hasInitialState) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "missing-initial-state",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `State machine without initial state in \`${file.path}:${change.line}\` — every state machine needs an initial/default state to be deterministic`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectUnreachableState(file: DiffFile): LifecycleProtocolIssue[] {
  const issues: LifecycleProtocolIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Collect all states defined and all states targeted by transitions
  const definedStates = new Map<string, number>(); // state → line
  const targetedStates = new Set<string>();

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // States defined (left side of transition or state declaration)
    const stateDefMatch = change.content.match(/^\+\s*['"](\w+)['"]\s*:/);
    if (stateDefMatch) {
      definedStates.set(stateDefMatch[1], change.line);
    }

    // States targeted by transitions
    const transMatch = change.content.match(TRANSITION_RE);
    if (transMatch) {
      targetedStates.add(transMatch[1]);
    }

    // Initial state counts as targeted
    const initMatch = change.content.match(INITIAL_STATE_RE);
    if (initMatch) {
      targetedStates.add(initMatch[1]);
    }
  }

  // Find defined states that are never targeted
  for (const [state, line] of definedStates) {
    if (!targetedStates.has(state) && state !== "error" && state !== "failed" && state !== "success" && state !== "done") {
      issues.push({
        category: "unreachable-state",
        file: file.path,
        line,
        code: `state '${state}'`,
        description: `Unreachable state '${state}' in \`${file.path}:${line}\` — no transition targets this state; it may be dead code or a missing transition should be added`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectMissingErrorState(file: DiffFile): LifecycleProtocolIssue[] {
  const issues: LifecycleProtocolIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Find state machine definitions and check for error state
  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (SKIP_LINE_RE.test(change.content)) continue;

    if (!STATE_MACHINE_RE.test(change.content)) continue;

    // Collect all state names in this machine definition (look ahead up to 30 lines)
    let hasErrorState = false;
    for (let j = i + 1; j < Math.min(i + 30, addedChanges.length); j++) {
      const next = addedChanges[j];
      if (ERROR_STATE_RE.test(next.content)) {
        hasErrorState = true;
        break;
      }
      // Stop at end of machine definition
      if (/^\+\s*\}\s*[;,]\s*$/.test(next.content)) break;
    }

    if (!hasErrorState) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "missing-error-state",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `State machine without error/failure state in \`${file.path}:${change.line}\` — add an error, failed, or rejected state to handle failures gracefully`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: LifecycleProtocolIssue[]): LifecycleProtocolIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildLifecycleProtocolContext(result: LifecycleProtocolResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## State Machine / Lifecycle Protocol Violations (${result.issues.length})\n`;
  ctx += "This PR may introduce state machine violations:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const i of warnings.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }

  return ctx.trim();
}

function buildLifecycleProtocolBodySummary(result: LifecycleProtocolResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>State Machine / Lifecycle Protocol Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*State machine violations cause non-deterministic bugs — orders shipped before payment, deploys rolled back before starting.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run state machine / lifecycle protocol detection on diff files.
 * Zero LLM cost.
 */
export function detectLifecycleProtocolViolations(diffFiles: DiffFile[]): LifecycleProtocolResult {
  const allIssues: LifecycleProtocolIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectInvalidTransitions(file));
    allIssues.push(...detectMissingInitialState(file));
    allIssues.push(...detectUnreachableState(file));
    allIssues.push(...detectMissingErrorState(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: LifecycleProtocolResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildLifecycleProtocolContext(result);
  result.bodySummary = buildLifecycleProtocolBodySummary(result);

  if (issues.length > 0) {
    core.info(`Lifecycle protocol detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
