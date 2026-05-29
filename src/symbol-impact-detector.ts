/**
 * Symbol-Level Impact Detector — map changed exported symbols to their
 * downstream callers across the entire PR.
 *
 * Traditional blast radius works at the file level. This detector works at
 * the symbol level: "function getUser() changed → 3 callers in 2 files
 * need retesting." This is the granularity reviewers actually need.
 *
 * No AI code reviewer does this. CodeRabbit shows file groups; Copilot
 * shows flat prose; DeepSource flags issues but doesn't trace impact.
 *
 * Algorithm:
 * 1. Extract exported symbols from changed files (functions, classes, types)
 * 2. Find which symbols are actually modified in the diff
 * 3. Trace which other files import those symbols
 * 4. Classify impact: API handler > caller > test-file > type-only
 * 5. Compute symbol-impact score (0-10) from consumer count × weight
 *
 * Lightweight — regex-based extraction on diff content, zero LLM cost.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymbolKind = "function" | "class" | "type" | "constant" | "interface";
export type ImpactConsumerKind = "api-handler" | "caller" | "test-file" | "type-import";

export interface ExportedSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
}

export interface SymbolConsumer {
  symbol: string;
  sourceFile: string;
  consumerFile: string;
  consumerLine: number;
  kind: ImpactConsumerKind;
}

export interface SymbolImpactIssue {
  symbol: string;
  kind: SymbolKind;
  sourceFile: string;
  sourceLine: number;
  consumers: SymbolConsumer[];
  score: number;
  severity: "critical" | "warning";
  description: string;
}

export interface SymbolImpactResult {
  issues: SymbolImpactIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Symbol extraction patterns
// ---------------------------------------------------------------------------

const EXPORT_PATTERNS: Array<{ re: RegExp; kind: SymbolKind; nameGroup: number }> = [
  // export function name(
  { re: /^export\s+(?:async\s+)?function\s+(\w+)/m, kind: "function", nameGroup: 1 },
  // export class Name
  { re: /^export\s+class\s+(\w+)/m, kind: "class", nameGroup: 1 },
  // export interface Name
  { re: /^export\s+interface\s+(\w+)/m, kind: "interface", nameGroup: 1 },
  // export type Name
  { re: /^export\s+type\s+(\w+)/m, kind: "type", nameGroup: 1 },
  // export const/let name =
  { re: /^export\s+(?:const|let)\s+(\w+)/m, kind: "constant", nameGroup: 1 },
  // export default function name(
  { re: /^export\s+default\s+(?:async\s+)?function\s+(\w+)/m, kind: "function", nameGroup: 1 },
];

// API handler indicators
const API_HANDLER_RE = /(?:router|app|server|fastify|express|koa|hono|route|handler|endpoint|controller)\s*\./i;
const TEST_FILE_RE = /(?:__tests__|\.test\.|\.spec\.|_test\.|_spec\.|tests?\/)/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^[-+]/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Extract exported symbols from changed files
// ---------------------------------------------------------------------------

function extractChangedSymbols(file: DiffFile): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];
  if (file.status === "deleted") return symbols;

  const added = getAddedChanges(file);
  const allAddedLines = added.map((c) => stripPrefix(c.content)).join("\n");

  for (const pattern of EXPORT_PATTERNS) {
    let match: RegExpExecArray | null;
    const re = new RegExp(pattern.re.source, "gm");
    while ((match = re.exec(allAddedLines)) !== null) {
      const name = match[pattern.nameGroup];
      // Find the line number
      let line = 0;
      for (const change of added) {
        if (stripPrefix(change.content).includes(name)) {
          line = change.line;
          break;
        }
      }
      symbols.push({
        name,
        kind: pattern.kind,
        file: file.path,
        line: line || 1,
      });
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Extract symbol consumers from all files
// ---------------------------------------------------------------------------

function extractSymbolConsumers(
  files: DiffFile[],
  changedSymbols: ExportedSymbol[]
): SymbolConsumer[] {
  const consumers: SymbolConsumer[] = [];
  const symbolMap = new Map<string, ExportedSymbol>();

  for (const sym of changedSymbols) {
    symbolMap.set(sym.name, sym);
  }

  // Phase 1: Build per-file import map — which symbols each file imports from relative paths
  // Map<filePath, Set<symbolName>> — symbols imported via relative paths
  const fileImports = new Map<string, Set<string>>();

  for (const file of files) {
    if (file.status === "deleted") continue;
    const imported = new Set<string>();
    const added = getAddedChanges(file);

    for (const change of added) {
      const trimmed = stripPrefix(change.content);

      // Named import from relative path
      const namedMatch = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/);
      if (namedMatch) {
        const specs = namedMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const spec of specs) imported.add(spec);
      }

      // Default import from relative path
      const defaultMatch = trimmed.match(/^import\s+(\w+)\s+from\s+['"](\.[^'"]+)['"]/);
      if (defaultMatch && !trimmed.includes("{")) {
        imported.add(defaultMatch[1]);
      }

      // Namespace import from relative path
      const nsMatch = trimmed.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.[^'"]+)['"]/);
      if (nsMatch) {
        const nsName = nsMatch[1];
        // Mark all changed symbols that match X.symName usage as imported
        for (const sym of changedSymbols) {
          const usageRe = new RegExp(`\\b${nsName}\\.${sym.name}\\b`);
          for (const otherChange of added) {
            if (usageRe.test(stripPrefix(otherChange.content))) {
              imported.add(sym.name);
            }
          }
        }
      }
    }

    if (imported.size > 0) {
      fileImports.set(file.path, imported);
    }
  }

  // Phase 2: Find consumers — only files that import the symbol from a relative path
  for (const file of files) {
    if (file.status === "deleted") continue;
    const imported = fileImports.get(file.path);
    if (!imported) continue;

    const added = getAddedChanges(file);
    for (const change of added) {
      const trimmed = stripPrefix(change.content);
      if (trimmed.startsWith("import ")) continue;

      for (const sym of changedSymbols) {
        if (sym.file === file.path) continue; // skip own file
        if (!imported.has(sym.name)) continue; // only symbols actually imported

        const usageRe = new RegExp(`\\b${sym.name}\\b`);
        if (usageRe.test(trimmed)) {
          const exists = consumers.some(
            (c) => c.symbol === sym.name && c.consumerFile === file.path && c.consumerLine === change.line
          );
          if (!exists) {
            consumers.push({
              symbol: sym.name,
              sourceFile: sym.file,
              consumerFile: file.path,
              consumerLine: change.line,
              kind: classifyConsumer(file.path, trimmed),
            });
          }
        }
      }
    }
  }

  return consumers;
}

function classifyConsumer(filePath: string, lineContent: string): ImpactConsumerKind {
  if (TEST_FILE_RE.test(filePath)) return "test-file";
  if (API_HANDLER_RE.test(lineContent) || API_HANDLER_RE.test(filePath)) return "api-handler";
  if (lineContent.includes("import type ") || lineContent.includes("import { type ")) return "type-import";
  return "caller";
}

// ---------------------------------------------------------------------------
// Compute issues
// ---------------------------------------------------------------------------

const CONSUMER_WEIGHTS: Record<ImpactConsumerKind, number> = {
  "api-handler": 4,
  "caller": 2,
  "test-file": 1,
  "type-import": 1,
};

function computeIssues(
  symbols: ExportedSymbol[],
  consumers: SymbolConsumer[]
): SymbolImpactIssue[] {
  const issues: SymbolImpactIssue[] = [];

  for (const sym of symbols) {
    const symConsumers = consumers.filter(
      (c) => c.symbol === sym.name && c.sourceFile === sym.file
    );
    if (symConsumers.length === 0) continue;

    const score = symConsumers.reduce((sum, c) => sum + CONSUMER_WEIGHTS[c.kind], 0);
    const consumerFiles = new Set(symConsumers.map((c) => c.consumerFile));

    const severity: "critical" | "warning" = score >= 7 ? "critical" : "warning";

    const consumerDesc = symConsumers
      .slice(0, 5)
      .map((c) => `${c.consumerFile}:${c.consumerLine} (${c.kind})`)
      .join(", ");

    issues.push({
      symbol: sym.name,
      kind: sym.kind,
      sourceFile: sym.file,
      sourceLine: sym.line,
      consumers: symConsumers,
      score,
      severity,
      description: `Symbol \`${sym.name}\` (${sym.kind}) changed in \`${sym.file}:${sym.line}\` — ${symConsumers.length} consumer(s) across ${consumerFiles.size} file(s) need retesting: ${consumerDesc}${symConsumers.length > 5 ? ` ... +${symConsumers.length - 5} more` : ""}`,
    });
  }

  issues.sort((a, b) => b.score - a.score);
  return issues;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildContext(result: SymbolImpactResult): string {
  if (result.issues.length === 0) return "";

  let ctx = `## Symbol-Level Impact Analysis (${result.issues.length})\n`;
  ctx += "Changed exported symbols and their downstream consumers:\n\n";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (critical.length > 0) {
    ctx += "### High Impact (score ≥ 7)\n";
    for (const issue of critical.slice(0, 10)) {
      ctx += `- \`${issue.symbol}\` (${issue.kind}) in \`${issue.sourceFile}\`: ${issue.consumers.length} consumer(s), score ${issue.score}\n`;
    }
  }

  if (warnings.length > 0) {
    ctx += "### Moderate Impact\n";
    for (const issue of warnings.slice(0, 10)) {
      ctx += `- \`${issue.symbol}\` (${issue.kind}) in \`${issue.sourceFile}\`: ${issue.consumers.length} consumer(s), score ${issue.score}\n`;
    }
  }

  return ctx.trim();
}

function buildBodySummary(result: SymbolImpactResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Symbol-Level Impact Analysis</strong> — ${result.issues.length} symbol(s) with downstream consumers</summary>\n\n`;
  body += "| Symbol | Kind | Source | Consumers | Score | Severity |\n";
  body += "|--------|------|--------|-----------|-------|----------|\n";

  for (const issue of result.issues.slice(0, 20)) {
    body += `| \`${issue.symbol}\` | ${issue.kind} | \`${issue.sourceFile}:${issue.sourceLine}\` | ${issue.consumers.length} | ${issue.score} | ${issue.severity} |\n`;
  }

  if (result.issues.length > 20) {
    body += `| ... | | | | ${result.issues.length - 20} more | |\n`;
  }

  body += `\n*Symbol-level impact: no AI code reviewer traces which exported symbols changed and which callers need retesting. Reviewers should verify that consumer code still matches the updated API contracts.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: SymbolImpactIssue[]): SymbolImpactIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.symbol}:${issue.sourceFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run symbol-level impact detection on diff files. Zero LLM cost. */
export function detectSymbolImpact(diffFiles: DiffFile[]): SymbolImpactResult {
  // Step 1: Extract changed exported symbols
  const allSymbols: ExportedSymbol[] = [];
  for (const file of diffFiles) {
    allSymbols.push(...extractChangedSymbols(file));
  }

  // Step 2: Find consumers of those symbols
  const consumers = extractSymbolConsumers(diffFiles, allSymbols);

  // Step 3: Compute impact issues
  const issues = dedupIssues(computeIssues(allSymbols, consumers));

  const result: SymbolImpactResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildContext(result);
  result.bodySummary = buildBodySummary(result);

  if (issues.length > 0) {
    core.info(
      `Symbol impact: ${issues.length} symbol(s) with consumers, ${issues.filter((i) => i.severity === "critical").length} critical`
    );
  }

  return result;
}
