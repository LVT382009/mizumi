/**
 * Context Amplification Detector — detect parallel implementations from context resets.
 *
 * When LLM context windows fill or reset, the model forgets existing
 * implementations and creates duplicate or parallel implementations with
 * different naming. This creates subtle drift: two versions of "send
 * notification" exist, one gets updated, the other doesn't.
 *
 * Categories:
 * 1. duplicate-implementation: same behavior implemented in multiple added functions
 * 2. naming-inconsistency: different names for same domain concept across files
 * 3. divergent-utility: same data transformation with slightly different logic
 * 4. import-divergence: equivalent imports from different module paths
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextAmplificationCategory =
  | "duplicate-implementation"
  | "naming-inconsistency"
  | "divergent-utility"
  | "import-divergence";

export interface ContextAmplificationIssue {
  category: ContextAmplificationCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface ContextAmplificationResult {
  issues: ContextAmplificationIssue[];
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

// Normalize synonymous verbs to a canonical form
const VERB_SYNONYMS: Map<string, string> = new Map([
  ["dispatch", "send"], ["push", "send"], ["emit", "send"], ["publish", "send"], ["notify", "send"], ["alert", "send"],
  ["build", "create"], ["make", "create"], ["generate", "create"], ["init", "create"], ["spawn", "create"],
  ["fetch", "get"], ["retrieve", "get"], ["load", "get"], ["read", "get"], ["find", "get"], ["query", "get"],
  ["store", "save"], ["persist", "save"], ["write", "save"],
  ["remove", "delete"], ["destroy", "delete"], ["cleanup", "delete"], ["purge", "delete"],
  ["check", "validate"], ["verify", "validate"], ["ensure", "validate"], ["assert", "validate"],
  ["serialize", "format"], ["encode", "format"], ["convert", "format"], ["transform", "format"],
  ["decode", "parse"], ["deserialize", "parse"], ["extract", "parse"],
]);

function normalizeVerb(verb: string): string {
  return VERB_SYNONYMS.get(verb) || verb;
}

// Normalize synonymous nouns to a canonical form
const NOUN_SYNONYMS: Map<string, string> = new Map([
  ["message", "notification"], ["alert", "notification"], ["event", "notification"], ["dispatch", "notification"],
  ["settings", "config"], ["options", "config"], ["preferences", "config"], ["env", "config"],
  ["store", "repository"], ["dao", "repository"], ["persistence", "repository"], ["db", "repository"],
  ["controller", "handler"], ["service", "handler"], ["manager", "handler"], ["processor", "handler"],
  ["adapter", "client"], ["connector", "client"], ["wrapper", "client"], ["proxy", "client"],
  ["telemetry", "logger"], ["metrics", "logger"], ["analytics", "logger"], ["monitor", "logger"],
  ["account", "user"], ["profile", "user"], ["member", "user"],
]);

function normalizeNoun(noun: string): string {
  return NOUN_SYNONYMS.get(noun) || noun;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Function/method declarations
const FUNCTION_DECL_RE = /\b(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\))\s*=>)/;

// Common verb prefixes that suggest same behavior
const VERB_PREFIXES = ["send", "dispatch", "push", "emit", "publish", "notify", "alert",
  "create", "build", "make", "generate", "init", "spawn",
  "get", "fetch", "retrieve", "load", "read", "find", "query",
  "save", "store", "persist", "write", "update",
  "delete", "remove", "destroy", "cleanup", "purge",
  "validate", "check", "verify", "ensure", "assert",
  "format", "serialize", "encode", "convert", "transform",
  "parse", "decode", "deserialize", "extract"];

// Import statements (used inline)

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s|interface\s|type\s|enum\s)/;

// Common naming inconsistencies — same concept, different words
const NAMING_INCONSISTENCY_GROUPS: string[][] = [
  ["notification", "alert", "message", "dispatch", "event"],
  ["config", "settings", "options", "preferences", "env"],
  ["repository", "store", "dao", "persistence", "db"],
  ["handler", "controller", "service", "manager", "processor"],
  ["client", "adapter", "connector", "wrapper", "proxy"],
  ["logger", "telemetry", "metrics", "analytics", "monitor"],
];

// ---------------------------------------------------------------------------
// Detection: duplicate-implementation
// ---------------------------------------------------------------------------

function detectDuplicateImplementation(diffFiles: DiffFile[]): ContextAmplificationIssue[] {
  const issues: ContextAmplificationIssue[] = [];

  // Collect all function/method declarations across files
  const declarations: { name: string; verb: string; noun: string; file: string; line: number; code: string }[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      // Function declaration
      const funcMatch = trimmed.match(FUNCTION_DECL_RE);
      if (funcMatch) {
        const name = funcMatch[1] || funcMatch[2] || funcMatch[3] || "";
        if (name) {
          const lowerName = name.toLowerCase();
          for (const verb of VERB_PREFIXES) {
            if (lowerName.startsWith(verb)) {
              const noun = normalizeNoun(lowerName.substring(verb.length));
 const normalizedVerb = normalizeVerb(verb);
              declarations.push({ name, verb: normalizedVerb, noun, file: file.path, line: change.line, code: trimmed });
              break;
            }
          }
        }
      }
    }
  }

  // Find pairs with same verb+noun but different names (in different files)
  for (let i = 0; i < declarations.length; i++) {
    for (let j = i + 1; j < declarations.length; j++) {
      const a = declarations[i];
      const b = declarations[j];

      if (a.verb === b.verb && a.noun === b.noun && a.name !== b.name && a.file !== b.file) {
        issues.push({
          category: "duplicate-implementation",
          file: a.file,
          line: a.line,
          code: a.code,
          description: `Potential duplicate implementation: \`${a.name}\` in \`${a.file}:${a.line}\` and \`${b.name}\` in \`${b.file}:${b.line}\` — both implement \`${a.verb}${a.noun}\`; LLMs create parallel implementations when context resets; consolidate into a single implementation`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: naming-inconsistency
// ---------------------------------------------------------------------------

function detectNamingInconsistency(diffFiles: DiffFile[]): ContextAmplificationIssue[] {
  const issues: ContextAmplificationIssue[] = [];

  // Track which naming group words appear in which files
  const groupUsage: Map<string, Map<string, { file: string; line: number; code: string }[]>> = new Map();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      // Check for domain nouns in function/class/variable names
      for (const group of NAMING_INCONSISTENCY_GROUPS) {
        for (const word of group) {
          if (trimmed.toLowerCase().includes(word)) {
            let groupMap = groupUsage.get(group.join(","));
            if (!groupMap) {
              groupMap = new Map();
              groupUsage.set(group.join(","), groupMap);
            }
            let entries = groupMap.get(word);
            if (!entries) {
              entries = [];
              groupMap.set(word, entries);
            }
            entries.push({ file: file.path, line: change.line, code: trimmed });
          }
        }
      }
    }
  }

  // Flag groups where multiple synonyms are used across different files
  for (const [, groupMap] of groupUsage) {
    const usedWords = [...groupMap.keys()].filter((w) => groupMap.get(w)!.length > 0);

    // If 2+ different synonyms appear in different files
    if (usedWords.length >= 2) {
      const filesByWord = new Map<string, Set<string>>();
      for (const word of usedWords) {
        const files = new Set(groupMap.get(word)!.map((e) => e.file));
        filesByWord.set(word, files);
      }

      // Check if they appear in different files
      const allFiles = new Set([...filesByWord.values()].flatMap((s) => [...s]));
      if (allFiles.size >= 2) {
        // Find a representative example
        const firstWord = usedWords[0];
        const firstEntry = groupMap.get(firstWord)![0];
        const description = usedWords.map((w) => `\`${w}\``).join(", ");

        issues.push({
          category: "naming-inconsistency",
          file: firstEntry.file,
          line: firstEntry.line,
          code: firstEntry.code,
          description: `Naming inconsistency: ${description} used for same concept across multiple files — LLMs use different names for the same domain concept when context resets; standardize on one name to prevent drift`,
          severity: "warning",
        });
      }
    }
  }

  return issues.slice(0, 5); // Cap to avoid noise
}

// ---------------------------------------------------------------------------
// Detection: divergent-utility
// ---------------------------------------------------------------------------

function detectDivergentUtility(diffFiles: DiffFile[]): ContextAmplificationIssue[] {
  const issues: ContextAmplificationIssue[] = [];

  // Track utility function patterns — same transformation, slightly different code
  const utilPatterns: Map<string, { displayName: string; file: string; line: number; code: string }[]> = new Map();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      // Common utility patterns: format*, parse*, convert*, validate*
      const utilMatch = trimmed.match(/\b(?:(?:export\s+)?(?:async\s+)?function\s+|(?:export\s+)?const\s+)(format|parse|convert|transform|validate|normalize|sanitize|serialize|encode|decode|extract)(\w+)?\s*[\(=]/i);
      if (utilMatch) {
        const baseVerb = utilMatch[1]; // preserve casing for display
        const suffix = utilMatch[2] || "";
        const key = `${baseVerb.toLowerCase()}${suffix.toLowerCase()}`;

        let entries = utilPatterns.get(key);
        if (!entries) {
          entries = [];
          utilPatterns.set(key, entries);
        }
 entries.push({ displayName: `${baseVerb}${suffix}`, file: file.path, line: change.line, code: trimmed });
      }
    }
  }

  // Flag utilities with same base name in different files
  for (const [, entries] of utilPatterns) {
    if (entries.length >= 2) {
      const files = new Set(entries.map((e) => e.file));
      if (files.size >= 2) {
        issues.push({
          category: "divergent-utility",
          file: entries[0].file,
          line: entries[0].line,
          code: entries[0].code,
      description: `Utility \`${entries[0].displayName}\` defined in multiple files: ${[...files].map((f) => `\`${f}\``).join(", ")} — LLMs create divergent copies of utility functions; consolidate into a shared module to prevent subtle logic differences from accumulating`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: import-divergence
// ---------------------------------------------------------------------------

function detectImportDivergence(diffFiles: DiffFile[]): ContextAmplificationIssue[] {
  const issues: ContextAmplificationIssue[] = [];

  // Track which import paths are used for similar things
  const importBySymbol: Map<string, { path: string; file: string; line: number; code: string }[]> = new Map();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      const importMatch = trimmed.match(/import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const symbols = importMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        const importPath = importMatch[2];

        for (const symbol of symbols) {
          if (!symbol || symbol.length < 2) continue;
          let entries = importBySymbol.get(symbol);
          if (!entries) {
            entries = [];
            importBySymbol.set(symbol, entries);
          }
          entries.push({ path: importPath, file: file.path, line: change.line, code: trimmed });
        }
      }
    }
  }

  // Flag symbols imported from different paths across files
  for (const [symbol, entries] of importBySymbol) {
    if (entries.length >= 2) {
      const paths = new Set(entries.map((e) => e.path));
      if (paths.size >= 2) {
        issues.push({
          category: "import-divergence",
          file: entries[0].file,
          line: entries[0].line,
          code: entries[0].code,
          description: `Symbol \`${symbol}\` imported from different paths: ${[...paths].map((p) => `\`${p}\``).join(", ")} — LLMs import from divergent module paths for equivalent functionality; standardize import paths to prevent drift`,
          severity: "warning",
        });
      }
    }
  }

  return issues.slice(0, 5); // Cap to avoid noise
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: ContextAmplificationIssue[]): ContextAmplificationIssue[] {
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

function buildContextAmplificationContext(result: ContextAmplificationResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Context Amplification Detection (${result.issues.length})\n`;
  ctx += "This PR may contain parallel implementations from LLM context resets:\n\n";

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

function buildContextAmplificationBodySummary(result: ContextAmplificationResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Context Amplification Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*When LLM context windows reset, the model forgets existing implementations and creates parallel versions. Both copies may be actively called but only one gets updated, causing subtle drift.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run context amplification detection on diff files. Zero LLM cost. */
export function detectContextAmplification(diffFiles: DiffFile[]): ContextAmplificationResult {
  const allIssues: ContextAmplificationIssue[] = [];

  allIssues.push(...detectDuplicateImplementation(diffFiles));
  allIssues.push(...detectNamingInconsistency(diffFiles));
  allIssues.push(...detectDivergentUtility(diffFiles));
  allIssues.push(...detectImportDivergence(diffFiles));

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ContextAmplificationResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildContextAmplificationContext(result);
  result.bodySummary = buildContextAmplificationBodySummary(result);

  if (issues.length > 0) {
    core.info(`Context amplification detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
