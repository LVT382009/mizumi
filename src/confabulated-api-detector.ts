/**
 * Confabulated API Surface Detector — detect LLM-hallucinated API calls.
 *
 * When LLMs generate code, they invent API methods from training data
 * rather than reading actual library docs: calling methods that don't
 * exist on the type, using wrong arity, optional chaining on non-nullable
 * types, and importing symbols not exported by the module.
 *
 * Categories:
 * 1. non-existent-method: calling methods common in other languages/libraries
 * 2. wrong-arity: calling with clearly wrong argument counts
 * 3. fantasy-optional-chain: ?. on a type that can't be null/undefined
 * 4. confabulated-import: importing from modules unlikely to have that export
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfabulatedAPICategory =
  | "non-existent-method"
  | "wrong-arity"
  | "fantasy-optional-chain"
  | "confabulated-import";

export interface ConfabulatedAPIIssue {
  category: ConfabulatedAPICategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface ConfabulatedAPIResult {
  issues: ConfabulatedAPIIssue[];
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

// Methods that LLMs frequently confabulate — these either don't exist on
// the object type in standard JS/TS, or are from different libraries
const CONFABULATED_METHODS: { pattern: RegExp; language: string; correctAlternative: string }[] = [
  // String methods that don't exist in standard JS
  { pattern: /\.contains\s*\(/, language: "Java/Rust", correctAlternative: "includes()" },
  { pattern: /\.startsWith\s*\(/, language: "standard", correctAlternative: "valid but check type" },
  { pattern: /\.isEmpty\s*\(/, language: "Java", correctAlternative: ".length === 0" },
  { pattern: /\.isBlank\s*\(/, language: "Java", correctAlternative: ".trim().length === 0" },
  { pattern: /\.size\s*\(\s*\)/, language: "Java/C++", correctAlternative: ".length or .size (without parens for Map/Set)" },
  { pattern: /\.trimLeft\s*\(/, language: "deprecated", correctAlternative: "trimStart()" },
  { pattern: /\.trimRight\s*\(/, language: "deprecated", correctAlternative: "trimEnd()" },

  // Array methods that don't exist or are commonly misused
  { pattern: /\.add\s*\(/, language: "Java List", correctAlternative: "push()" },
  { pattern: /\.remove\s*\(\s*\d+\s*\)/, language: "Java List", correctAlternative: "splice()" },
  { pattern: /\.get\s*\(\s*\d+\s*\)/, language: "Java List", correctAlternative: "bracket notation [index]" },
  { pattern: /\.first\s*\(\s*\)/, language: "Rails/Lodash", correctAlternative: "[0]" },
  { pattern: /\.last\s*\(\s*\)/, language: "Rails/Lodash", correctAlternative: ".at(-1) or [arr.length-1]" },
  { pattern: /\.flatten\s*\(\s*\)/, language: "Ruby/Lodash", correctAlternative: ".flat()" },
  { pattern: /\.collect\s*\(/, language: "Ruby", correctAlternative: ".map()" },
  { pattern: /\.select\s*\(/, language: "Ruby", correctAlternative: ".filter()" },
  { pattern: /\.reject\s*\(/, language: "Ruby", correctAlternative: ".filter() with negation" },

  // Map/Object methods that don't exist
  { pattern: /\.hasKey\s*\(/, language: "Java Map", correctAlternative: ".has() (Map) or 'key' in obj" },
  { pattern: /\.has_value\s*\(/, language: "Ruby Hash", correctAlternative: ".has() (Map) or Object.values().includes()" },
  { pattern: /\.keys\s*\(\s*\)/, language: "Java Map", correctAlternative: "Object.keys() or Map.keys() (without parens for iterator)" },

  // Promise/async methods
  { pattern: /\.await\s*\(/, language: "C#", correctAlternative: "await (keyword, not method)" },
  { pattern: /\.thenApply\s*\(/, language: "Java CompletableFuture", correctAlternative: ".then()" },
  { pattern: /\.exceptionally\s*\(/, language: "Java", correctAlternative: ".catch()" },

  // Number methods
  { pattern: /\.toInt\s*\(\s*\)/, language: "Kotlin/Scala", correctAlternative: "parseInt() or Number()" },
  { pattern: /\.toString\s*\(\s*\d+\s*\)/, language: "Java (radix)", correctAlternative: ".toString(radix) is valid JS but check intent" },
  { pattern: /\.abs\s*\(\s*\)/, language: "method on number", correctAlternative: "Math.abs()" },
  { pattern: /\.ceil\s*\(\s*\)/, language: "method on number", correctAlternative: "Math.ceil()" },
  { pattern: /\.floor\s*\(\s*\)/, language: "method on number", correctAlternative: "Math.floor()" },
  { pattern: /\.round\s*\(\s*\)/, language: "method on number", correctAlternative: "Math.round()" },
];

// Wrong arity patterns — functions called with wrong number of args
const ARITY_KNOWN: Map<string, { min: number; max: number; display: string }> = new Map([
  ["parseInt", { min: 1, max: 2, display: "parseInt(string, radix?)" }],
  ["parseFloat", { min: 1, max: 1, display: "parseFloat(string)" }],
  ["isNaN", { min: 1, max: 1, display: "isNaN(value)" }],
  ["isFinite", { min: 1, max: 1, display: "isFinite(value)" }],
  ["encodeURI", { min: 1, max: 1, display: "encodeURI(string)" }],
  ["decodeURI", { min: 1, max: 1, display: "decodeURI(string)" }],
  ["encodeURIComponent", { min: 1, max: 1, display: "encodeURIComponent(string)" }],
  ["decodeURIComponent", { min: 1, max: 1, display: "decodeURIComponent(string)" }],
  ["Object.keys", { min: 1, max: 1, display: "Object.keys(obj)" }],
  ["Object.values", { min: 1, max: 1, display: "Object.values(obj)" }],
  ["Object.entries", { min: 1, max: 1, display: "Object.entries(obj)" }],
  ["Object.assign", { min: 2, max: Infinity, display: "Object.assign(target, ...sources)" }],
  ["Array.isArray", { min: 1, max: 1, display: "Array.isArray(value)" }],
  ["Array.from", { min: 1, max: 3, display: "Array.from(iterable, mapFn?, thisArg?)" }],
  ["JSON.parse", { min: 1, max: 2, display: "JSON.parse(text, reviver?)" }],
  ["JSON.stringify", { min: 1, max: 3, display: "JSON.stringify(value, replacer?, space?)" }],
  ["Promise.all", { min: 1, max: 1, display: "Promise.all(iterable)" }],
  ["Promise.race", { min: 1, max: 1, display: "Promise.race(iterable)" }],
  ["Math.max", { min: 0, max: Infinity, display: "Math.max(...values)" }],
  ["Math.min", { min: 0, max: Infinity, display: "Math.min(...values)" }],
  ["Math.abs", { min: 1, max: 1, display: "Math.abs(x)" }],
  ["Math.ceil", { min: 1, max: 1, display: "Math.ceil(x)" }],
  ["Math.floor", { min: 1, max: 1, display: "Math.floor(x)" }],
  ["Math.round", { min: 1, max: 1, display: "Math.round(x)" }],
  ["Math.sqrt", { min: 1, max: 1, display: "Math.sqrt(x)" }],
  ["Math.pow", { min: 2, max: 2, display: "Math.pow(base, exp)" }],
  ["Math.log", { min: 1, max: 1, display: "Math.log(x)" }],
  ["console.log", { min: 0, max: Infinity, display: "console.log(...data)" }],
]);

// Common types where optional chaining is always wrong (primitive literals)
const PRIMITIVE_LITERAL_RE = /(?:\d+\.?\d*|true|false|null|undefined|['"][^'"]*['"])\s*\?\./;

// Confabulated import patterns — importing from well-known modules
// with symbols they don't actually export
const CONFABULATED_IMPORTS: { modulePattern: RegExp; wrongExports: string[]; correctModule: string }[] = [
  { modulePattern: /^node:fs$/, wrongExports: ["fetch", "Request", "Response"], correctModule: "node:http / undici" },
  { modulePattern: /^node:path$/, wrongExports: ["join", "resolve", "dirname"], correctModule: "these ARE valid — skip" },
  { modulePattern: /^node:http$/, wrongExports: ["readFile", "writeFile", "createReadStream"], correctModule: "node:fs" },
  { modulePattern: /^node:crypto$/, wrongExports: ["hash", "encrypt", "decrypt"], correctModule: "node:crypto (check method names)" },
  { modulePattern: /^fs$/, wrongExports: ["fetch", "Request"], correctModule: "node:http" },
  { modulePattern: /^path$/, wrongExports: ["fetch"], correctModule: "node:http" },
  { modulePattern: /^react$/, wrongExports: ["useState", "useEffect", "useCallback", "useMemo", "useRef"], correctModule: "react (these are valid — skip)" },
  { modulePattern: /^axios$/, wrongExports: ["get", "post", "put", "delete", "patch"], correctModule: "axios (these are valid — skip)" },
  { modulePattern: /^lodash$/, wrongExports: ["chain"], correctModule: "lodash (chain is valid in full lodash)" },
  { modulePattern: /^express$/, wrongExports: ["Router"], correctModule: "express (Router is valid — skip)" },
];

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// ---------------------------------------------------------------------------
// Detection: non-existent-method
// ---------------------------------------------------------------------------

function detectNonExistentMethod(file: DiffFile): ConfabulatedAPIIssue[] {
  const issues: ConfabulatedAPIIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Skip if this is a method definition (not a call)
      if (/^\s*(?:public|private|protected|static|async|export)?\s*\w+\s*\(/.test(trimmed) &&
          !/^\s*(?:if|for|while|switch|catch|return|throw|const|let|var)\b/.test(trimmed)) continue;
    // Skip if this is inside a class/object definition
    if (/^\s*(?:class|interface|type|enum)\b/.test(trimmed)) continue;

    for (const { pattern, language, correctAlternative } of CONFABULATED_METHODS) {
      if (pattern.test(trimmed)) {
        // Extract the method name from the pattern
        const methodMatch = trimmed.match(/\.(\w+)\s*\(/);
        const methodName = methodMatch?.[1] || "unknown";

        issues.push({
          category: "non-existent-method",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Method \`.${methodName}()\` in \`${file.path}:${change.line}\` may not exist — LLMs confabulate methods from ${language} training data; use \`${correctAlternative}\` instead`,
          severity: "warning",
        });
        break; // One issue per line
      }
    }
  }

  return issues.slice(0, 5); // Cap to avoid noise
}

// ---------------------------------------------------------------------------
// Detection: wrong-arity
// ---------------------------------------------------------------------------

function detectWrongArity(file: DiffFile): ConfabulatedAPIIssue[] {
  const issues: ConfabulatedAPIIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Match known function calls — simple approach: check Math.*, Object.*, etc.
    for (const [funcName, arity] of ARITY_KNOWN) {
      // Match: Math.abs(...), Object.keys(...), parseInt(...), etc.
      const escaped = funcName.replace(".", "\\.");
      const callRe = new RegExp(`\\b${escaped}\\s*\\(([^)]*)\\)`);
      const callMatch = trimmed.match(callRe);
      if (callMatch) {
        const argsStr = callMatch[1].trim();
        const argCount = argsStr.length === 0 ? 0 : argsStr.split(",").length;

        if (argCount < arity.min || argCount > arity.max) {
          issues.push({
            category: "wrong-arity",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `\`${funcName}()\` called with ${argCount} argument(s) in \`${file.path}:${change.line}\` — expected ${arity.display}; LLMs generate calls with wrong argument counts from training data; check the function signature`,
            severity: "warning",
          });
        }
      }
    }
  }

  return issues.slice(0, 5); // Cap to avoid noise
}

// ---------------------------------------------------------------------------
// Detection: fantasy-optional-chain
// ---------------------------------------------------------------------------

function detectFantasyOptionalChain(file: DiffFile): ConfabulatedAPIIssue[] {
  const issues: ConfabulatedAPIIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Detect optional chaining on primitive literals — always wrong
    if (PRIMITIVE_LITERAL_RE.test(trimmed)) {
      const chainMatch = trimmed.match(/([\d]+|true|false|null|undefined|['"][^'"]*['"])\s*\?\.\s*(\w+)/);
      if (chainMatch) {
        issues.push({
          category: "fantasy-optional-chain",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Optional chaining \`${chainMatch[1]}?.${chainMatch[2]}\` on primitive in \`${file.path}:${change.line}\` — LLMs add \`?.\` defensively on primitives that cannot be null/undefined; remove the \`?\` since the base value is never nullable`,
          severity: "warning",
        });
      }
    }
  }

  return issues.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Detection: confabulated-import
// ---------------------------------------------------------------------------

function detectConfabulatedImport(file: DiffFile): ConfabulatedAPIIssue[] {
  const issues: ConfabulatedAPIIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const importMatch = trimmed.match(/import\s+(?:{([^}]+)}\s+from\s+)?['"]([^'"]+)['"]/);
    if (!importMatch) continue;

    const symbols = importMatch[1]
      ? importMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      : [];
    const modulePath = importMatch[2];

    for (const { modulePattern, wrongExports, correctModule } of CONFABULATED_IMPORTS) {
      if (modulePattern.test(modulePath)) {
        // Skip entries where we marked "skip" in correctModule
        if (correctModule.includes("skip")) continue;

        for (const symbol of symbols) {
          if (wrongExports.includes(symbol)) {
            issues.push({
              category: "confabulated-import",
              file: file.path,
              line: change.line,
              code: trimmed,
              description: `Symbol \`${symbol}\` imported from \`${modulePath}\` in \`${file.path}:${change.line}\` — this symbol is not exported by \`${modulePath}\`; LLMs confabulate import paths from training data; use \`${correctModule}\` instead`,
              severity: "critical",
            });
          }
        }
      }
    }
  }

  return issues.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: ConfabulatedAPIIssue[]): ConfabulatedAPIIssue[] {
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

function buildConfabulatedAPIContext(result: ConfabulatedAPIResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Confabulated API Detection (${result.issues.length})\n`;
  ctx += "This PR may contain API calls that don't exist — a common LLM hallucination pattern:\n\n";

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

function buildConfabulatedAPIBodySummary(result: ConfabulatedAPIResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Confabulated API Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*When LLMs generate code, they invent API methods from training data rather than reading actual library docs. Detected patterns: methods that don't exist on JS types, wrong argument counts, optional chaining on non-nullable values, and imports of symbols not exported by the module.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run confabulated API surface detection on diff files. Zero LLM cost. */
export function detectConfabulatedAPI(diffFiles: DiffFile[]): ConfabulatedAPIResult {
  const allIssues: ConfabulatedAPIIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectNonExistentMethod(file));
    allIssues.push(...detectWrongArity(file));
    allIssues.push(...detectFantasyOptionalChain(file));
    allIssues.push(...detectConfabulatedImport(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ConfabulatedAPIResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildConfabulatedAPIContext(result);
  result.bodySummary = buildConfabulatedAPIBodySummary(result);

  if (issues.length > 0) {
    core.info(`Confabulated API detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
