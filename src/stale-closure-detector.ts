/**
 * Stale Closure Detector — detect closures capturing stale/mutable variables.
 *
 * LLMs frequently create closures that capture variable values at closure
 * creation time, not at invocation time. When the captured variable later
 * changes (loop iteration, event reuse, async resolution), the closure
 * operates on a stale value. This is uniquely LLM because:
 *
 * 1. LLMs write `for (var i = 0; ...)` with closures inside (classic var hoisting)
 * 2. LLMs capture `let` loop variables in async closures assuming block-scope
 *    semantics prevent staleness — but async timing still causes races
 * 3. LLMs register event handlers that capture mutable state without rebinding
 * 4. LLMs use setTimeout/setInterval callbacks that reference variables that
 *    change before the timer fires
 *
 * No AI code reviewer detects stale closure patterns. ESLint has limited
 * `no-loop-func` but it's opt-in, has many false positives, only covers
 * loop-scoped functions, and misses async timing and setTimeout patterns.
 *
 * Categories:
 * 1. loop-var-closure: function/arrow inside loop capturing mutable loop variable
 * 2. stale-event-handler: event handler capturing mutable state
 * 3. async-closure-race: variable captured in async closure that may mutate before resolution
 * 4. settimeout-stale-capture: setTimeout/setInterval callback capturing mutable variable
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StaleClosureCategory =
  | "loop-var-closure"
  | "stale-event-handler"
  | "async-closure-race"
  | "settimeout-stale-capture";

export interface StaleClosureIssue {
  category: StaleClosureCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface StaleClosureResult {
  issues: StaleClosureIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^\+/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

function makeVarRef(varName: string): RegExp {
  return new RegExp(`\\b${varName}\\b`);
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const VAR_LOOP_RE = /\bfor\s*\(\s*var\s+(\w+)\s+/;
const FOR_LOOP_RE = /\bfor\s*\(\s*(?:var|let|const)\s+(\w+)\s+/;
const FOR_IN_RE = /\bfor\s*\(\s*(?:var|let|const)\s+(\w+)\s+in\s+/;
const FOR_OF_RE = /\bfor\s*\(\s*(?:var|let|const)\s+(\w+)\s+of\s+/;

const FOREACH_ASYNC_RE = /\.\s*forEach\s*\(\s*async\b/;

const CLOSURE_RE = /(?:function\s*\(|=>\s*\{|=>\s*\(|=>\s*\w|\.then\s*\(|\.catch\s*\()/;

const EVENT_HANDLER_RE = /\.\s*(?:on|addEventListener|once|prependOnceListener)\s*\(\s*['"]/;

const TIMER_RE = /\b(?:setTimeout|setInterval|nextTick|setImmediate)\s*\(/;

const AWAIT_IN_LOOP_RE = /\bawait\s+/;

const MUTATION_RE = /^\+\s*(?:let|var)\s+\w+\s*=/;

const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|\/test\/|\/tests\/|\.e2e\.)/;

// ---------------------------------------------------------------------------
// Detection: loop-var-closure
// ---------------------------------------------------------------------------

function detectLoopVarClosure(file: DiffFile): StaleClosureIssue[] {
  const issues: StaleClosureIssue[] = [];
  const added = getAddedChanges(file);

  for (let i = 0; i < added.length; i++) {
    const change = added[i];
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Case 1: for (var i = ...) with closure referencing i
    const varMatch = trimmed.match(VAR_LOOP_RE);
    if (varMatch) {
      const loopVar = varMatch[1];
      const ref = makeVarRef(loopVar);
      let foundClosure = false;
      let foundRef = false;
      for (let j = i + 1; j < Math.min(i + 20, added.length); j++) {
        const next = stripPrefix(added[j].content);
        if (next === "}") break;
        if (CLOSURE_RE.test(next)) foundClosure = true;
        if (foundClosure && ref.test(next)) { foundRef = true; break; }
        // Also match if closure and reference are on the same line
        if (CLOSURE_RE.test(next) && ref.test(next)) { foundRef = true; break; }
      }
      if (foundRef) {
        issues.push({
          category: "loop-var-closure",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Loop variable \`${loopVar}\` captured in closure inside \`var\` loop in \`${file.path}:${change.line}\` — LLMs use \`var\` in loops with closures, causing all iterations to share the same variable; use \`let\` instead of \`var\` to get per-iteration binding`,
          severity: "critical",
        });
      }
    }

    // Case 2: for (let/const x of/in ...) with closure + await = async race
    const letMatch = trimmed.match(FOR_OF_RE) || trimmed.match(FOR_IN_RE) || trimmed.match(FOR_LOOP_RE);
    if (letMatch && !VAR_LOOP_RE.test(trimmed)) {
      const loopVar = letMatch[1];
      let hasClosure = false;
      let hasAwait = false;
      for (let j = i + 1; j < Math.min(i + 20, added.length); j++) {
        const next = stripPrefix(added[j].content);
        if (next === "}") break;
        if (CLOSURE_RE.test(next)) hasClosure = true;
        if (AWAIT_IN_LOOP_RE.test(next)) hasAwait = true;
      }
      if (hasClosure && hasAwait) {
        issues.push({
          category: "loop-var-closure",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Loop variable \`${loopVar}\` captured in async closure in \`${file.path}:${change.line}\` — even with \`let\`, async closures inside loops can race; the closure may reference \`${loopVar}\` after the loop has moved to the next iteration; use \`for...of\` with sequential \`await\` or collect promises and \`Promise.all()\` after the loop`,
          severity: "warning",
        });
      }
    }

    // Case 3: array.forEach(async ...) — always a bug
    if (FOREACH_ASYNC_RE.test(trimmed)) {
      issues.push({
        category: "loop-var-closure",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `\`forEach\` with \`async\` callback in \`${file.path}:${change.line}\` — LLMs write \`array.forEach(async ...)\` but forEach does not await the callback; promises fire in parallel and errors are swallowed; use \`for...of\` with \`await\` or \`Promise.all(array.map(async ...))\` instead`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: stale-event-handler
// ---------------------------------------------------------------------------

function detectStaleEventHandler(file: DiffFile): StaleClosureIssue[] {
  const issues: StaleClosureIssue[] = [];
  const added = getAddedChanges(file);

  const mutableVars: Set<string> = new Set();
  for (const change of added) {
    const trimmed = stripPrefix(change.content);
    const letMatch = trimmed.match(/^(?:let|var)\s+(\w+)\s*=/);
    if (letMatch) mutableVars.add(letMatch[1]);
  }

  for (let i = 0; i < added.length; i++) {
    const change = added[i];
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    if (EVENT_HANDLER_RE.test(trimmed)) {
      for (const varName of mutableVars) {
        const ref = makeVarRef(varName);
        // Check current line and next few lines of handler body
        let found = ref.test(trimmed);
        if (!found) {
          for (let j = i + 1; j < Math.min(i + 6, added.length); j++) {
            const next = stripPrefix(added[j].content);
            if (next === "}" || next === "});" || next === "})") break;
            if (ref.test(next)) { found = true; break; }
          }
        }
        if (found) {
          issues.push({
            category: "stale-event-handler",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Event handler capturing mutable variable \`${varName}\` in \`${file.path}:${change.line}\` — LLMs register event handlers that capture mutable state; the handler uses the value at bind time, not event time; use \`const\` for captured values or re-read inside the handler`,
            severity: "warning",
          });
          break;
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: async-closure-race
// ---------------------------------------------------------------------------

function detectAsyncClosureRace(file: DiffFile): StaleClosureIssue[] {
  const issues: StaleClosureIssue[] = [];
  const added = getAddedChanges(file);

  for (let i = 0; i < added.length; i++) {
    const change = added[i];
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // let x = await ...; then x is reassigned later
    const letAssign = trimmed.match(/^(?:let)\s+(\w+)\s*=\s*await\s+/);
    if (letAssign) {
      const varName = letAssign[1];
      const reassignRE = new RegExp(`\\b${varName}\\s*=\\s*(?!await)`);
      for (let j = i + 1; j < Math.min(i + 15, added.length); j++) {
        const next = stripPrefix(added[j].content);
        if (reassignRE.test(next) && !next.includes("const")) {
          issues.push({
            category: "async-closure-race",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Async variable \`${varName}\` reassigned after await in \`${file.path}:${change.line}\` — LLMs reassign \`let\` variables after \`await\`, creating race conditions where concurrent code paths see different values; use \`const\` for each assignment or separate variable names`,
            severity: "warning",
          });
          break;
        }
      }
    }

    // Promise.all with mutable state nearby
    if (trimmed.includes("Promise.all")) {
      let hasNearbyMutation = false;
      for (let j = Math.max(0, i - 5); j < Math.min(i + 15, added.length); j++) {
        if (MUTATION_RE.test(added[j].content)) {
          hasNearbyMutation = true;
          break;
        }
      }
      if (hasNearbyMutation) {
        issues.push({
          category: "async-closure-race",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `\`Promise.all\` with mutable state in \`${file.path}:${change.line}\` — LLMs use \`let\` variables inside Promise.all callbacks, causing race conditions when multiple promises mutate the same variable concurrently; use immutable patterns or separate accumulators per promise`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: settimeout-stale-capture
// ---------------------------------------------------------------------------

function detectSettimeoutStaleCapture(file: DiffFile): StaleClosureIssue[] {
  const issues: StaleClosureIssue[] = [];
  const added = getAddedChanges(file);

  const mutableVars: Set<string> = new Set();
  for (const change of added) {
    const trimmed = stripPrefix(change.content);
    const letMatch = trimmed.match(/^(?:let|var)\s+(\w+)\s*=/);
    if (letMatch) mutableVars.add(letMatch[1]);
  }

  for (let i = 0; i < added.length; i++) {
    const change = added[i];
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    if (TIMER_RE.test(trimmed)) {
      for (const varName of mutableVars) {
        const ref = makeVarRef(varName);
        let found = ref.test(trimmed);
        if (!found) {
          for (let j = i + 1; j < Math.min(i + 8, added.length); j++) {
            const next = stripPrefix(added[j].content);
            if (next === "}" || next === "});" || next === "})") break;
            if (ref.test(next)) { found = true; break; }
          }
        }
        if (found) {
          const severity: "critical" | "warning" = TEST_FILE_RE.test(file.path) ? "warning" : "critical";
          issues.push({
            category: "settimeout-stale-capture",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `\`setTimeout\`/\`setInterval\` callback capturing mutable variable \`${varName}\` in \`${file.path}:${change.line}\` — LLMs capture mutable variables in timer callbacks; the variable may have changed by the time the timer fires; capture the current value with a \`const\` before the timer, or use \`const $\{varName} = current${varName.charAt(0).toUpperCase() + varName.slice(1)}\` pattern`,
            severity,
          });
          break;
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: StaleClosureIssue[]): StaleClosureIssue[] {
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

function buildStaleClosureContext(result: StaleClosureResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Stale Closure Detection (${result.issues.length})\n`;
  ctx += "This PR may contain closures capturing stale/mutable variables — a pattern LLMs frequently produce:\n\n";

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

function buildStaleClosureBodySummary(result: StaleClosureResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Stale Closure Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Stale closures capture variable values at creation time, not invocation time. LLMs write loops with closures, event handlers with mutable state, and timer callbacks that reference variables that change before the callback fires.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run stale closure detection on diff files. Zero LLM cost. */
export function detectStaleClosures(diffFiles: DiffFile[]): StaleClosureResult {
  const allIssues: StaleClosureIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectLoopVarClosure(file));
    allIssues.push(...detectStaleEventHandler(file));
    allIssues.push(...detectAsyncClosureRace(file));
    allIssues.push(...detectSettimeoutStaleCapture(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: StaleClosureResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildStaleClosureContext(result);
  result.bodySummary = buildStaleClosureBodySummary(result);

  if (issues.length > 0) {
    core.info(`Stale closure detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
