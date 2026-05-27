/**
 * Cross-PR Conflict Detection — detect conflicts between multiple open PRs.
 *
 * When multiple PRs are open simultaneously, they can conflict in ways that
 * only surface at merge time. This module detects 3 conflict types early:
 *
 * 1. File-level conflict: Two PRs modify the same file (merge collision)
 * 2. Export/signature conflict: One PR changes an exported symbol,
 *    another PR still uses the old signature (uses import edge analysis)
 * 3. Delete-use conflict: One PR removes a file/symbol, another PR
 *    still imports or references it
 *
 * No other AI code reviewer analyzes cross-PR interactions. CodeRabbit,
 * Copilot, CodeGuru, and Sourcery all review each PR in isolation.
 * Human reviewers at Google/Bill ping owners — Mizumi detects mechanically.
 *
 * Zero LLM cost. Pure heuristic matching on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";
import { extractImportEdges, type DependencyEdge } from "./blast-radius.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictKind = "file-collision" | "export-change" | "delete-use";

export interface PRConflict {
  /** Type of conflict */
  kind: ConflictKind;
  /** Current PR's affected file */
  currentFile: string;
  /** Other PR number */
  otherPR: number;
  /** Other PR's affected file */
  otherFile: string;
  /** Human-readable description */
  description: string;
  /** Severity heuristic: critical=both change same lines, high=both change same file */
  severity: "critical" | "high" | "medium";
}

export interface CrossPRConflictResult {
  /** All detected conflicts */
  conflicts: PRConflict[];
  /** Current PR file paths */
  currentFiles: string[];
  /** Other PRs analyzed */
  otherPRs: OpenPRSummary[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

export interface OpenPRSummary {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** Files changed in this PR (paths only) */
  files: string[];
  /** Import edges from this PR's diff */
  edges: DependencyEdge[];
  /** Files deleted in this PR */
  deletedFiles: string[];
}

// ---------------------------------------------------------------------------
// File-level conflict detection
// ---------------------------------------------------------------------------

function detectFileCollisions(
  currentFiles: Set<string>,
  otherPR: OpenPRSummary,
): PRConflict[] {
  const conflicts: PRConflict[] = [];
  for (const file of otherPR.files) {
    if (currentFiles.has(file)) {
      conflicts.push({
        kind: "file-collision",
        currentFile: file,
        otherPR: otherPR.number,
        otherFile: file,
        description: `Both this PR and PR #${otherPR.number} modify \`${file}\` — likely merge conflict`,
        severity: "high",
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Export/signature conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect when the current PR imports from a file that another PR also changes.
 * If PR A changes `src/utils.ts` (which exports helpers) and PR B imports from
 * `src/utils.ts`, there's a risk that PR A's changes break PR B's assumptions.
 */
/** Strip file extension for module-level path comparison. */
function stripExtension(p: string): string {
  const dot = p.lastIndexOf(".");
  const slash = p.lastIndexOf("/");
  if (dot > slash && dot > 0) return p.slice(0, dot);
  return p;
}

function detectExportConflicts(
  currentEdges: DependencyEdge[],
  currentFiles: Set<string>,
  otherPR: OpenPRSummary,
): PRConflict[] {
  const conflicts: PRConflict[] = [];
  const otherFilesNoExt = new Set(otherPR.files.map(stripExtension));
  const currentFilesNoExt = new Set([...currentFiles].map(stripExtension));

  // Current PR imports from a file that another PR also changes
  for (const edge of currentEdges) {
    const edgeTarget = stripExtension(edge.to);
    if (otherFilesNoExt.has(edgeTarget) && !currentFilesNoExt.has(edgeTarget)) {
      // Current PR imports X, other PR changes X
      conflicts.push({
        kind: "export-change",
        currentFile: edge.from,
        otherPR: otherPR.number,
        otherFile: edge.to,
        description: `This PR imports from \`${edge.to}\` (${edge.kind}) which PR #${otherPR.number} also modifies — signature may change`,
        severity: "medium",
      });
    }
  }

  // Other PR imports from a file that current PR changes
  for (const edge of otherPR.edges) {
    const edgeTarget = stripExtension(edge.to);
    if (currentFilesNoExt.has(edgeTarget) && !otherFilesNoExt.has(edgeTarget)) {
      conflicts.push({
        kind: "export-change",
        currentFile: edge.to,
        otherPR: otherPR.number,
        otherFile: edge.from,
        description: `PR #${otherPR.number} imports from \`${edge.to}\` which this PR modifies — their code may break`,
        severity: "medium",
      });
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Delete-use conflict detection
// ---------------------------------------------------------------------------

/**
 * Detect when one PR deletes a file and another PR imports from it.
 */
function detectDeleteUseConflicts(
  currentEdges: DependencyEdge[],
  _currentFiles: Set<string>,
  currentDeleted: string[],
  otherPR: OpenPRSummary,
): PRConflict[] {
  const conflicts: PRConflict[] = [];
  const otherDeletedNoExt = new Set(otherPR.deletedFiles.map(stripExtension));

  // Current PR imports from a file that another PR deletes
  for (const edge of currentEdges) {
    const edgeTarget = stripExtension(edge.to);
    if (otherDeletedNoExt.has(edgeTarget)) {
      const deletedFile = otherPR.deletedFiles.find(d => stripExtension(d) === edgeTarget) || edgeTarget;
        conflicts.push({
          kind: "delete-use",
          currentFile: edge.from,
          otherPR: otherPR.number,
          otherFile: deletedFile,
          description: `This PR imports \`${deletedFile}\` but PR #${otherPR.number} deletes it`,
          severity: "critical",
        });
      }
    }

  // Current PR deletes a file that another PR imports
  for (const deletedFile of currentDeleted) {
    const deletedNoExt = stripExtension(deletedFile);
    for (const edge of otherPR.edges) {
      const edgeTarget = stripExtension(edge.to);
      if (edgeTarget === deletedNoExt) {
        conflicts.push({
          kind: "delete-use",
          currentFile: deletedFile,
          otherPR: otherPR.number,
          otherFile: edge.from,
          description: `This PR deletes \`${deletedFile}\` but PR #${otherPR.number} still imports it`,
          severity: "critical",
        });
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupConflicts(conflicts: PRConflict[]): PRConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((c) => {
    const key = `${c.kind}:${c.currentFile}:${c.otherPR}:${c.otherFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildConflictContext(result: CrossPRConflictResult): string {
  const critical = result.conflicts.filter((c) => c.severity === "critical");
  const high = result.conflicts.filter((c) => c.severity === "high");
  const medium = result.conflicts.filter((c) => c.severity === "medium");

  if (critical.length === 0 && high.length === 0 && medium.length === 0) return "";

  let ctx = `## Cross-PR Conflicts (${result.conflicts.length})\n`;
  ctx += "This PR may conflict with other open PRs. Coordinate with authors before merging:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const c of critical.slice(0, 5)) {
      ctx += `- ${c.description}\n`;
    }
  }
  if (high.length > 0) {
    ctx += "### High\n";
    for (const c of high.slice(0, 5)) {
      ctx += `- ${c.description}\n`;
    }
  }
  if (medium.length > 0) {
    ctx += "### Medium\n";
    for (const c of medium.slice(0, 5)) {
      ctx += `- ${c.description}\n`;
    }
  }

  return ctx.trim();
}

function buildConflictBodySummary(result: CrossPRConflictResult): string {
  if (result.conflicts.length === 0) return "";

  let body = `<details><summary><strong>Cross-PR Conflicts</strong> — ${result.conflicts.length} detected</summary>\n\n`;

  body += "| Type | File | Other PR | Severity |\n";
  body += "|------|------|----------|----------|\n";

  for (const c of result.conflicts.slice(0, 15)) {
    const typeLabel = c.kind === "file-collision" ? "collision" : c.kind === "export-change" ? "export" : "delete-use";
    body += `| ${typeLabel} | \`${c.currentFile}\` | #${c.otherPR} | ${c.severity} |\n`;
  }

  if (result.conflicts.length > 15) {
    body += `| ... | | | ${result.conflicts.length - 15} more |\n`;
  }

  body += `\n*Analyzed against ${result.otherPRs.length} other open PRs.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run cross-PR conflict detection.
 * Compares the current PR's diff against other open PR diffs.
 * Zero LLM cost.
 */
export function detectCrossPRConflicts(
  currentFiles: DiffFile[],
  otherPRs: OpenPRSummary[],
): CrossPRConflictResult {
  const currentFilePaths = new Set(currentFiles.map((f) => f.path));
  const currentEdges = extractImportEdges(currentFiles);
  const currentDeleted = currentFiles
    .filter((f) => f.status === "deleted")
    .map((f) => f.path);

  const allConflicts: PRConflict[] = [];

  for (const otherPR of otherPRs) {
    const fileCollisions = detectFileCollisions(currentFilePaths, otherPR);
    const exportConflicts = detectExportConflicts(currentEdges, currentFilePaths, otherPR);
    const deleteUseConflicts = detectDeleteUseConflicts(currentEdges, currentFilePaths, currentDeleted, otherPR);

    allConflicts.push(...fileCollisions, ...exportConflicts, ...deleteUseConflicts);
  }

  const conflicts = dedupConflicts(allConflicts);

  // Sort: critical first, then high, then medium; within severity by kind
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2 };
  conflicts.sort((a, b) => {
    const sv = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sv !== 0) return sv;
    return a.currentFile.localeCompare(b.currentFile);
  });

  const result: CrossPRConflictResult = {
    conflicts,
    currentFiles: [...currentFilePaths].sort(),
    otherPRs,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildConflictContext(result);
  result.bodySummary = buildConflictBodySummary(result);

  if (conflicts.length > 0) {
    core.info(`Cross-PR conflicts: ${conflicts.length} detected against ${otherPRs.length} open PRs`);
  }

  return result;
}

/**
 * Build an OpenPRSummary from a PR's diff files (for use after fetching
 * other PR diffs via the platform client).
 */
export function buildOpenPRSummary(
  prNumber: number,
  title: string,
  files: DiffFile[],
): OpenPRSummary {
  const edges = extractImportEdges(files);
  const deletedFiles = files
    .filter((f) => f.status === "deleted")
    .map((f) => f.path);

  return {
    number: prNumber,
    title,
    files: files.map((f) => f.path),
    edges,
    deletedFiles,
  };
}
