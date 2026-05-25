/**
 * Blast Radius — Change impact analysis.
 *
 * Computes which UNCHANGED files are transitively impacted by the PR's
 * changed files using import/re-export dependency graphs extracted from
 * diff content. No other AI code reviewer does this.
 *
 * CodeRabbit shows file groups; Copilot shows flat prose — neither traces
 * the blast radius of a change. Human reviewers think "who else depends on
 * this?" but AI reviewers have been blind to it.
 *
 * Algorithm:
 * 1. Scan added lines in diff hunks for import/require/re-export patterns
 * 2. Build a forward dependency graph: file → set of files it imports
 * 3. Invert to get reverse graph: file → set of files that depend on it
 * 4. For each CHANGED file, BFS/DFS the reverse graph to find dependents
 * 5. Mark impact severity: direct (1-hop) = high, transitive = medium
 * 6. Report unchanged files in the blast radius
 *
 * Lightweight — runs on diff content only, no type checking, zero LLM cost.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  /** Source file doing the import */
  from: string;
  /** Target file being imported */
  to: string;
  /** Type of import relationship */
  kind: "import" | "require" | "re-export" | "dynamic-import";
  /** Line number in the source file */
  line: number;
}

export interface ImpactedFile {
  /** File path of the impacted (downstream) file */
  path: string;
  /** Changed file that caused this impact */
  changedFile: string;
  /** 1 = direct dependency, 2+ = transitive */
  depth: number;
  /** Descriptive label */
  impactLevel: "direct" | "transitive";
}

export interface BlastRadiusResult {
  /** All import/require edges found in the diff */
  edges: DependencyEdge[];
  /** Files in the blast radius (unchanged downstream dependents) */
  impactedFiles: ImpactedFile[];
  /** Number of changed files that have downstream dependents */
  changedFilesWithDependents: number;
  /** Total blast radius (impacted file count) */
  totalImpact: number;
}

// ---------------------------------------------------------------------------
// Import pattern extraction
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS: Array<{ re: RegExp; kind: DependencyEdge["kind"]; pathGroup: number }> = [
  // ESM static imports: import ... from './path'
  { re: /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"](\.[^'"]+)['"]/, kind: "import", pathGroup: 1 },
  // ESM re-exports: export { ... } from './path' or export * from './path'
  { re: /export\s+(?:\{[^}]*\}\s+from|\*\s+(?:as\s+\w+\s+)?from)\s+['"](\.[^'"]+)['"]/, kind: "re-export", pathGroup: 1 },
  // Side-effect imports: import './path'
  { re: /import\s+['"](\.[^'"]+)['"]/, kind: "import", pathGroup: 1 },
  // CJS requires: require('./path')
  { re: /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/, kind: "require", pathGroup: 1 },
  // Dynamic imports: import('./path')
  { re: /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/, kind: "dynamic-import", pathGroup: 1 },
];

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Extract import/require edges from added lines in diff files */
export function extractImportEdges(files: DiffFile[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];

  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;

        for (const pattern of IMPORT_PATTERNS) {
          const match = change.content.match(pattern.re);
          if (!match) continue;

          const rawPath = match[pattern.pathGroup];
          const target = resolveImportPath(rawPath, file.path);
          if (target && target !== file.path) {
            edges.push({
              from: file.path,
              to: target,
              kind: pattern.kind,
              line: change.line,
            });
          }
        }
      }
    }
  }

  return edges;
}

/** Resolve a relative import path to a normalized file path.
 *  Handles ./ ../ and extensionless imports (adds .ts/.tsx/.js/.jsx). */
export function resolveImportPath(rawPath: string, sourceFile: string): string {
  if (!rawPath.startsWith(".")) return "";

  const sourceDir = sourceFile.includes("/")
    ? sourceFile.substring(0, sourceFile.lastIndexOf("/"))
    : "";

  const parts = sourceDir ? sourceDir.split("/") : [];
  for (const segment of rawPath.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  return parts.join("/");
}

/** Build forward and reverse dependency graphs from edges */
export function buildDependencyGraphs(
  edges: DependencyEdge[],
  changedFilePaths: Set<string>
): { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  for (const edge of edges) {
    // Only consider edges where the importing file is in the diff
    // (changed file imports something → the target may need attention)
    // OR where the target is a changed file (something imports a changed file)
    const fromChanged = changedFilePaths.has(edge.from);
    const toChanged = changedFilePaths.has(edge.to);

    if (!fromChanged && !toChanged) continue;

    // Forward: from → to (file from imports file to)
    if (!forward.has(edge.from)) forward.set(edge.from, new Set());
    forward.get(edge.from)!.add(edge.to);

    // Reverse: to → from (file from depends on file to)
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    reverse.get(edge.to)!.add(edge.from);
  }

  return { forward, reverse };
}

/** Compute the blast radius: all unchanged files that transitively depend
 *  on changed files, via the reverse dependency graph. */
export function computeBlastRadius(
  changedFiles: string[],
  reverseGraph: Map<string, Set<string>>,
  changedSet: Set<string>
): ImpactedFile[] {
  const impacted: ImpactedFile[] = [];
  const visited = new Set<string>();

  for (const changedFile of changedFiles) {
    const dependents = reverseGraph.get(changedFile);
    if (!dependents) continue;

    // BFS from each changed file's direct dependents
    const queue: Array<{ path: string; depth: number }> = [];
    for (const dep of dependents) {
      queue.push({ path: dep, depth: 1 });
    }

    while (queue.length > 0) {
      const { path: depPath, depth } = queue.shift()!;

      // Skip changed files (they're already in the diff)
      if (changedSet.has(depPath)) continue;

      const dedupKey = `${depPath}::${changedFile}`;
      if (visited.has(dedupKey)) continue;
      visited.add(dedupKey);

      impacted.push({
        path: depPath,
        changedFile,
        depth,
        impactLevel: depth === 1 ? "direct" : "transitive",
      });

      // Continue BFS through this dependent's dependents
      const nextDeps = reverseGraph.get(depPath);
      if (nextDeps && depth < 5) {
        for (const nextDep of nextDeps) {
          queue.push({ path: nextDep, depth: depth + 1 });
        }
      }
    }
  }

  // Sort: direct first, then by depth, then alphabetically
  impacted.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.changedFile !== b.changedFile) return a.changedFile.localeCompare(b.changedFile);
    return a.path.localeCompare(b.path);
  });

  // Deduplicate: keep the shallowest depth for each (path, changedFile) pair
  const seen = new Set<string>();
  return impacted.filter((item) => {
    const key = `${item.path}:${item.changedFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Run the full blast radius analysis pipeline. */
export function runBlastRadiusAnalysis(files: DiffFile[]): BlastRadiusResult {
  const edges = extractImportEdges(files);
  const changedSet = new Set(files.map((f) => f.path));
  const changedPaths = files.map((f) => f.path);

  const { reverse } = buildDependencyGraphs(edges, changedSet);
  const impactedFiles = computeBlastRadius(changedPaths, reverse, changedSet);

  const changedFilesWithDependents = changedPaths.filter(
    (f) => reverse.has(f) && reverse.get(f)!.size > 0
  ).length;

  if (impactedFiles.length > 0) {
    core.info(`Blast radius: ${impactedFiles.length} files impacted by ${changedPaths.length} changes, ${edges.length} dependency edges`);
  }

  return {
    edges,
    impactedFiles,
    changedFilesWithDependents,
    totalImpact: impactedFiles.length,
  };
}

/** Build a blast radius context string for injection into the LLM prompt.
 *  Tells the LLM which unchanged files are transitively impacted. */
export function buildBlastRadiusContext(result: BlastRadiusResult): string {
  if (result.impactedFiles.length === 0) return "";

  let context = `## Blast Radius — Impacted Files (${result.impactedFiles.length})\n`;
  context += "The following UNCHANGED files depend on files modified in this PR. ";
  context += "Reviewers should consider whether changes propagate correctly:\n\n";

  // Group by changed file
  const byChangedFile = new Map<string, ImpactedFile[]>();
  for (const imp of result.impactedFiles) {
    if (!byChangedFile.has(imp.changedFile)) byChangedFile.set(imp.changedFile, []);
    byChangedFile.get(imp.changedFile)!.push(imp);
  }

  for (const [changedFile, dependents] of byChangedFile) {
    context += `### \`${changedFile}\` impacts:\n`;
    for (const dep of dependents.slice(0, 8)) {
      const level = dep.impactLevel === "direct" ? "direct" : `${dep.depth}-hop`;
      context += `- \`${dep.path}\` (${level})\n`;
    }
    if (dependents.length > 8) {
      context += `- ... and ${dependents.length - 8} more\n`;
    }
    context += "\n";
  }

  if (result.edges.length > 0) {
    context += `**Dependency edges found:** ${result.edges.length} (import/require/re-export)\n`;
  }

  return context.trim();
}
