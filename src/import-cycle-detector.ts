/**
 * Import Cycle Detector — detect circular dependency chains in PR diffs.
 *
 * No AI code reviewer detects import cycles. CodeRabbit, Copilot, CodeGuru,
 * and Sourcery all ignore dependency graph topology. Circular imports cause
 * undefined-at-runtime errors (hoisted declarations), tree-shaking failures,
 * and bundle bloat. They're hard to debug because symptoms appear in
 * unrelated files.
 *
 * Mizumi analyzes import edges from the diff to detect:
 * 1. Direct cycles: A imports B, B imports A (2-node cycle)
 * 2. Indirect cycles: A→B→C→A (3+ node cycle)
 * 3. Self-imports: A imports A (pathological)
 * 4. Cycle severity: measures cycle length and dependency kind
 *
 * Zero LLM cost — pure graph analysis on import edges.
 */
import * as core from "@actions/core";
import { extractImportEdges, type DependencyEdge } from "./blast-radius.js";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CycleCategory =
  | "direct-cycle"
  | "indirect-cycle"
  | "self-import";

export interface ImportCycle {
  /** Category of the cycle */
  category: CycleCategory;
  /** Files in the cycle (in order) */
  chain: string[];
  /** Length of the cycle (number of edges) */
  length: number;
  /** Import kinds involved */
  kinds: string[];
  /** Human-readable description */
  description: string;
  /** Severity: critical = self-import/direct, warning = indirect */
  severity: "critical" | "warning";
}

export interface CycleDetectionResult {
  /** All detected import cycles */
  cycles: ImportCycle[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Cycle detection — iterative with path tracking
// ---------------------------------------------------------------------------

function stripExtension(p: string): string {
  const dot = p.lastIndexOf(".");
  const slash = p.lastIndexOf("/");
  if (dot > slash && dot > 0) return p.slice(0, dot);
  return p;
}

function detectCycles(edges: DependencyEdge[]): ImportCycle[] {
  // Build adjacency list — normalize 'from' to match 'to' (extensionless)
  const adj = new Map<string, Array<{ to: string; kind: string }>>();
  for (const edge of edges) {
    const fromNorm = stripExtension(edge.from);
    if (!adj.has(fromNorm)) adj.set(fromNorm, []);
    adj.get(fromNorm)!.push({ to: edge.to, kind: edge.kind });
  }

  const allCycles: ImportCycle[] = [];
  const seenCycles = new Set<string>();

  const nodes = [...adj.keys()];

  for (const startNode of nodes) {
    // DFS from startNode, only report cycles that go back to startNode
    // This avoids reporting the same cycle from every node in it
    const stack: Array<{ node: string; path: string[]; kinds: string[] }> = [
      { node: startNode, path: [startNode], kinds: [] },
    ];
    const globalVisited = new Set<string>();

    while (stack.length > 0) {
      const { node, path, kinds } = stack.pop()!;

      const neighbors = adj.get(node);
      if (!neighbors) continue;

      for (const { to, kind } of neighbors) {
        if (to === startNode && path.length >= 2) {
          // Found a cycle back to start
          const chain = [...path, startNode];
          const cycleKey = path.slice().sort().join("→");
          if (!seenCycles.has(cycleKey)) {
            seenCycles.add(cycleKey);
            allCycles.push(classifyCycle(chain, [...kinds, kind]));
          }
        } else if (!path.includes(to) && !globalVisited.has(to)) {
          stack.push({
            node: to,
            path: [...path, to],
            kinds: [...kinds, kind],
          });
        }
      }
    }
  }

  // Also detect self-imports
  for (const edge of edges) {
    if (stripExtension(edge.from) === edge.to) {
      const cycleKey = `self:${edge.from}`;
      if (!seenCycles.has(cycleKey)) {
        seenCycles.add(cycleKey);
        allCycles.push({
          category: "self-import",
          chain: [edge.from, edge.from],
          length: 1,
          kinds: [edge.kind],
          description: `Self-import in \`${edge.from}\` — file imports itself`,
          severity: "critical",
        });
      }
    }
  }

  return allCycles;
}

function classifyCycle(chain: string[], kinds: string[]): ImportCycle {
  const length = chain.length - 1; // edges = nodes in cycle

  if (length === 2) {
    return {
      category: "direct-cycle",
      chain,
      length,
      kinds,
      description: `Direct cycle: \`${chain[0]}\` ↔ \`${chain[1]}\` — both files import each other, causing initialization-order bugs`,
      severity: "critical",
    };
  }

  return {
    category: "indirect-cycle",
    chain,
    length,
    kinds,
    description: `Indirect cycle (${length}-node): ${chain.map((c) => `\`${c}\``).join(" → ")} — circular dependency chain may cause undefined-at-runtime errors`,
    severity: "warning",
  };
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildCycleContext(result: CycleDetectionResult): string {
  if (result.cycles.length === 0) return "";

  const critical = result.cycles.filter((c) => c.severity === "critical");
  const warnings = result.cycles.filter((c) => c.severity === "warning");

  let ctx = `## Import Cycle Detection (${result.cycles.length})\n`;
  ctx += "This PR may introduce circular dependencies:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const c of critical.slice(0, 10)) {
      ctx += `- ${c.description}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const c of warnings.slice(0, 10)) {
      ctx += `- ${c.description}\n`;
    }
  }

  return ctx.trim();
}

function buildCycleBodySummary(result: CycleDetectionResult): string {
  if (result.cycles.length === 0) return "";

  let body = `<details><summary><strong>Import Cycle Detection</strong> — ${result.cycles.length} cycle(s)</summary>\n\n`;
  body += "| Category | Chain | Length | Severity |\n";
  body += "|----------|-------|--------|----------|\n";

  for (const c of result.cycles.slice(0, 15)) {
    const catLabel = c.category.replace(/-/g, " ");
    const chainPreview = c.chain.slice(0, -1).map((f) => f.split("/").pop()).join(" → ");
    body += `| ${catLabel} | ${chainPreview} | ${c.length} | ${c.severity} |\n`;
  }

  if (result.cycles.length > 15) {
    body += `| ... | | | ${result.cycles.length - 15} more |\n`;
  }

  body += `\n*Circular dependencies cause initialization-order bugs and tree-shaking failures.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run import cycle detection on diff files.
 * Zero LLM cost.
 */
export function detectImportCycles(diffFiles: DiffFile[]): CycleDetectionResult {
  const edges = extractImportEdges(diffFiles);
  const cycles = detectCycles(edges);

  // Sort: critical first, then by cycle length
  cycles.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.length - b.length;
  });

  const result: CycleDetectionResult = {
    cycles,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildCycleContext(result);
  result.bodySummary = buildCycleBodySummary(result);

  if (cycles.length > 0) {
    core.info(`Import cycle detection: ${cycles.length} cycle(s) detected (${cycles.filter((c) => c.severity === "critical").length} critical)`);
  }

  return result;
}
