/**
 * Paradigm Clash Detector — detect incompatible programming paradigms
 * mixed in the same scope by AI-generated code.
 *
 * LLMs trained on diverse codebases produce "paradigm soup": they mix
 * React class components with hooks, callbacks with async/await, OOP
 * with functional patterns, and different frameworks in the same module.
 * This creates maintenance nightmares, confused readers, and subtle bugs
 * from paradigm interaction effects.
 *
 * Categories:
 * 1. react-class-and-hooks: class component using hooks or mixing
 *    lifecycle methods with hook-like patterns
 * 2. callback-and-async-await: same function uses callback patterns
 *    (err-first cb, .then/.catch) alongside async/await
 * 3. oop-and-functional-mix: class with pure-function patterns or
 *    file mixing class definitions with functional pipeline style
 * 4. framework-clash: multiple frameworks imported/used in same file
 *    (jQuery + React, Angular + Vue, Express + Koa, etc.)
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParadigmClashCategory =
  | "react-class-and-hooks"
  | "callback-and-async-await"
  | "oop-and-functional-mix"
  | "framework-clash";

export interface ParadigmClashIssue {
  category: ParadigmClashCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface ParadigmClashResult {
  issues: ParadigmClashIssue[];
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

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// --- React class + hooks ---

const REACT_CLASS_PATTERNS = [
  /\bclass\s+\w+\s+extends\s+(?:React\.Component|Component|PureComponent|React\.PureComponent)\b/,
  /\bcomponentDidMount\s*\(/,
  /\bcomponentDidUpdate\s*\(/,
  /\bcomponentWillUnmount\s*\(/,
  /\bshouldComponentUpdate\s*\(/,
  /\bgetSnapshotBeforeUpdate\s*\(/,
  /\bgetDerivedStateFromProps\s*\(/,
  /\bsetState\s*\(/,
  /\bthis\.state\b/,
  /\bthis\.props\b/,
  /\bthis\.setState\b/,
];

const REACT_HOOKS_PATTERNS = [
  /\buse[A-Z]\w*\s*\(/, // useState, useEffect, useRef, useMemo, useCallback, etc.
  /\bReact\.use[A-Z]\w*\s*\(/,
  /\buseContext\s*\(/,
  /\buseReducer\s*\(/,
  /\buseRef\s*\(/,
  /\buseMemo\s*\(/,
  /\buseCallback\s*\(/,
  /\buseEffect\s*\(/,
  /\buseState\s*\(/,
];

// --- Callback + async/await ---

const CALLBACK_PATTERNS = [
  /\b(?:callback|cb|done|next)\s*\)?\s*(?:=>|\(|\{)/,
  /\(err(?:,\s*\w+)*\)\s*=>/,
  /\(error(?:,\s*\w+)*\)\s*=>/,
  /\bfunction\s*\(\s*(?:err|error)\s*(?:,\s*\w+)*\s*\)\s*\{/,
  /\.then\s*\(/,
  /\.catch\s*\(/,
  /\.finally\s*\(/,
  /(?:,\s*(?:callback|cb|done)\s*)\)?\s*(?:=>|\(|\{|\n)/,
  /\bcallback\s*\(/,
];

const ASYNC_AWAIT_PATTERNS = [
  /\basync\s+function\s+\w+\s*\(/,
  /\basync\s+\w+\s*=>/,
  /\basync\s+\(/,
  /\bawait\s+/,
  /\breturn\s+await\s+/,
];

// --- OOP + functional mix ---

const OOP_PATTERNS = [
  /\bclass\s+\w+/,
  /\bextends\s+/,
  /\bimplements\s+/,
  /\bnew\s+\w+\s*\(/,
  /\bthis\.\w+\s*=/,
  /\bsuper\s*\(/,
  /\bprivate\s+\w+/,
  /\bprotected\s+\w+/,
  /\bpublic\s+\w+/,
  /#\w+\s*(?:=|\(|\.)/, // JS private fields
];

const FUNCTIONAL_PATTERNS = [
  /\.map\s*\(\s*(?:\(\w+(?:,\s*\w+)*\)|\w+)\s*=>/,
  /\.filter\s*\(\s*(?:\(\w+(?:,\s*\w+)*\)|\w+)\s*=>/,
  /\.reduce\s*\(\s*(?:\(\w+(?:,\s*\w+)*\)|\w+)\s*=>/,
  /\.flatMap\s*\(\s*(?:\(\w+(?:,\s*\w+)*\)|\w+)\s*=>/,
  /\.pipe\s*\(/,
  /\bcompose\s*\(/,
  /\.compose\s*\(/,
  /\bR\.\w+\s*\(/, // Ramda
  /\bfp\.\w+\s*\(/, // lodash/fp
  /(?:const|let)\s+\w+\s*=\s*(?:\w+\.)?pipe\s*\(/,
];

// --- Framework clash ---

const FRAMEWORK_PAIRS: Array<{ first: RegExp[]; second: RegExp[]; label: string }> = [
  // jQuery + React
  {
    first: [/\$\s*\(/, /\$\s*\.\s*ajax/, /\$\s*\.\s*get/, /\$\s*\.\s*post/, /jQuery/],
    second: [/\bReact\b/, /\bReactDOM\b/, /from\s+['"]react['"]/, /from\s+['"]react-dom['"]/],
    label: "jQuery + React",
  },
  // Angular + Vue
  {
    first: [/@angular/, /@NgModule/, /@Component.*selector/, /\bNgZone\b/, /\bInjectable\b/],
    second: [/\bVue\b/, /Vue\.\s*createApp/, /from\s+['"]vue['"]/, /\bcreateApp\b/, /\bdefineComponent\b/, /\bv-if\b/, /\bv-for\b/],
    label: "Angular + Vue",
  },
  // Angular + React
  {
    first: [/@angular/, /@NgModule/, /@Component.*selector/],
    second: [/\bReact\b/, /from\s+['"]react['"]/, /\buseState\b/, /\buseEffect\b/],
    label: "Angular + React",
  },
  // Express + Koa
  {
    first: [/\bexpress\s*\(\)/, /from\s+['"]express['"]/, /\bapp\.\s*(?:get|post|put|delete|use)\s*\(/, /\bRouter\s*\(/],
    second: [/\bKoa\b/, /from\s+['"]koa['"]/, /\bctx\.\w+/, /\bnext\s*\)?\s*(?:=>|\{)/, /\bapp\.use\s*\(/],
    label: "Express + Koa",
  },
  // React + Vue
  {
    first: [/\bReact\b/, /from\s+['"]react['"]/, /\buseState\b/],
    second: [/\bVue\b/, /Vue\.\s*createApp/, /from\s+['"]vue['"]/, /\bcreateApp\b/, /\bv-if\b/, /\bv-for\b/],
    label: "React + Vue (SFC)",
  },
  // Mocha + Jest
  {
    first: [/from\s+['"]mocha['"]/, /\bdescribe\s*\(/, /\bit\s*\(/, /\bbeforeEach\b/],
    second: [/\bjest\s*\./, /\bexpect\s*\(.*\)\.to(?:Be|Equal|Contain|Match|Throw)/, /\btest\s*\(/],
    label: "Mocha + Jest",
  },
];
// ---------------------------------------------------------------------------
// Detection per file
// ---------------------------------------------------------------------------

interface ParadigmSignals {
  reactClass: { line: number; code: string; match: string }[];
  reactHooks: { line: number; code: string; match: string }[];
  callback: { line: number; code: string; match: string }[];
  asyncAwait: { line: number; code: string; match: string }[];
  oop: { line: number; code: string; match: string }[];
  functional: { line: number; code: string; match: string }[];
  frameworks: Map<string, { line: number; code: string; match: string }[]>;
}

function collectSignals(file: DiffFile): ParadigmSignals {
  const signals: ParadigmSignals = {
    reactClass: [],
    reactHooks: [],
    callback: [],
    asyncAwait: [],
    oop: [],
    functional: [],
    frameworks: new Map(),
  };

  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    for (const re of REACT_CLASS_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.reactClass.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of REACT_HOOKS_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.reactHooks.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of CALLBACK_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.callback.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of ASYNC_AWAIT_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.asyncAwait.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of OOP_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.oop.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of FUNCTIONAL_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.functional.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }

    // Framework detection
    for (const pair of FRAMEWORK_PAIRS) {
      for (const re of pair.first) {
        const m = trimmed.match(re);
        if (m) {
          const key = `${pair.label}:first`;
          if (!signals.frameworks.has(key)) signals.frameworks.set(key, []);
          signals.frameworks.get(key)!.push({ line: change.line, code: trimmed, match: m[0] });
          break;
        }
      }
      for (const re of pair.second) {
        const m = trimmed.match(re);
        if (m) {
          const key = `${pair.label}:second`;
          if (!signals.frameworks.has(key)) signals.frameworks.set(key, []);
          signals.frameworks.get(key)!.push({ line: change.line, code: trimmed, match: m[0] });
          break;
        }
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Issue generation
// ---------------------------------------------------------------------------

function checkReactClash(signals: ParadigmSignals, filePath: string): ParadigmClashIssue[] {
  const issues: ParadigmClashIssue[] = [];
  if (signals.reactClass.length > 0 && signals.reactHooks.length > 0) {
    // Critical: hooks in a class component file
    for (const hook of signals.reactHooks.slice(0, 2)) {
      issues.push({
        category: "react-class-and-hooks",
        file: filePath,
        line: hook.line,
        code: hook.code,
        description: `React hook \`${hook.match}\` detected in a class component file \`${filePath}:${hook.line}\` — LLMs mix class components and hooks, but hooks cannot be used inside class components; convert to a functional component or use a HOC/render prop pattern instead`,
        severity: "critical",
      });
    }
  }
  return issues;
}

function checkCallbackAsyncClash(signals: ParadigmSignals, filePath: string): ParadigmClashIssue[] {
  const issues: ParadigmClashIssue[] = [];
  if (signals.callback.length > 0 && signals.asyncAwait.length > 0) {
    // Warning: mixing callback and async/await patterns in same file
    for (const cb of signals.callback.slice(0, 2)) {
      issues.push({
        category: "callback-and-async-await",
        file: filePath,
        line: cb.line,
        code: cb.code,
        description: `Callback pattern \`${cb.match}\` mixed with async/await in \`${filePath}:${cb.line}\` — LLMs produce "paradigm soup" by mixing error-first callbacks and async/await in the same file; standardize on one asynchronous pattern per module to avoid unhandled rejections and callback-promise interaction bugs`,
        severity: "warning",
      });
    }
    for (const aw of signals.asyncAwait.slice(0, 1)) {
      issues.push({
        category: "callback-and-async-await",
        file: filePath,
        line: aw.line,
        code: aw.code,
        description: `async/await pattern \`${aw.match}\` mixed with callbacks in \`${filePath}:${aw.line}\` — LLMs mix async styles, creating code where promise rejections go unhandled because some code paths use callbacks and others throw; pick one async paradigm per module`,
        severity: "warning",
      });
    }
  }
  return issues;
}

function checkOopFunctionalClash(signals: ParadigmSignals, filePath: string): ParadigmClashIssue[] {
  const issues: ParadigmClashIssue[] = [];
  if (signals.oop.length > 0 && signals.functional.length > 0) {
    // Warning: class definitions with functional pipeline patterns
    for (const oop of signals.oop.slice(0, 2)) {
      issues.push({
        category: "oop-and-functional-mix",
        file: filePath,
        line: oop.line,
        code: oop.code,
        description: `OOP pattern \`${oop.match}\` mixed with functional pipeline style in \`${filePath}:${oop.line}\` — LLMs blend paradigms: class hierarchies with .map/.filter/.reduce pipelines create confusion about where state lives and how data flows; consolidate on one paradigm per module`,
        severity: "warning",
      });
    }
  }
  return issues;
}

function checkFrameworkClash(signals: ParadigmSignals, filePath: string): ParadigmClashIssue[] {
  const issues: ParadigmClashIssue[] = [];

  for (const pair of FRAMEWORK_PAIRS) {
    const firstKey = `${pair.label}:first`;
    const secondKey = `${pair.label}:second`;
    const firstEntries = signals.frameworks.get(firstKey);
    const secondEntries = signals.frameworks.get(secondKey);

    if (firstEntries && firstEntries.length > 0 && secondEntries && secondEntries.length > 0) {
      const entry = firstEntries[0];
      issues.push({
        category: "framework-clash",
        file: filePath,
        line: entry.line,
        code: entry.code,
        description: `Framework clash: ${pair.label} detected in \`${filePath}:${entry.line}\` — LLMs mix frameworks from their training data; using ${pair.label.split(" + ")[0]} and ${pair.label.split(" + ")[1]} in the same file creates conflicting lifecycle management, state models, and rendering pipelines; split into separate modules or choose one framework`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: ParadigmClashIssue[]): ParadigmClashIssue[] {
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

function buildParadigmClashContext(result: ParadigmClashResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Paradigm Clash Detection (${result.issues.length})\n`;
  ctx += "This PR mixes incompatible programming paradigms — LLMs produce \"paradigm soup\":\n\n";

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

function buildParadigmClashBodySummary(result: ParadigmClashResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Paradigm Clash Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLMs trained on diverse codebases produce paradigm soup — mixing React class components with hooks, callbacks with async/await, OOP with functional pipelines, and competing frameworks in the same file. These clashes create maintenance nightmares and subtle bugs from paradigm interaction effects. Standardize on one paradigm per module.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run paradigm clash detection on diff files. Zero LLM cost. */
export function detectParadigmClashes(diffFiles: DiffFile[]): ParadigmClashResult {
  const allIssues: ParadigmClashIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const signals = collectSignals(file);

    allIssues.push(...checkReactClash(signals, file.path));
    allIssues.push(...checkCallbackAsyncClash(signals, file.path));
    allIssues.push(...checkOopFunctionalClash(signals, file.path));
    allIssues.push(...checkFrameworkClash(signals, file.path));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ParadigmClashResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildParadigmClashContext(result);
  result.bodySummary = buildParadigmClashBodySummary(result);

  if (issues.length > 0) {
    core.info(`Paradigm clash detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
