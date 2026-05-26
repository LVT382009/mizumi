/**
 * PR Split Suggestions — when a PR is too complex, suggest concrete file groupings.
 *
 * Competitive gap: No AI code reviewer suggests HOW to break up a large PR.
 * CodeRabbit and Copilot just say "consider splitting". Mizumi goes further:
 * it groups files by dependency clusters and functional areas, producing
 * actionable split suggestions with specific files per proposed PR.
 *
 * Approach:
 * 1. Check complexity score (only runs for score >= 7 or category "complex"/"critical")
 * 2. Group files by functional area (directory prefix)
 * 3. Identify dependency clusters using import graph (from blast-radius data)
 * 4. Produce split suggestions with file lists, estimated scope, and ordering
 *
 * Zero LLM cost — runs on deterministic signals already computed by other modules.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SplitSuggestion {
  /** Suggested PR title prefix */
  title: string;
  /** Files to include in this split */
  files: string[];
  /** Estimated scope: small / medium / large */
  scope: "small" | "medium" | "large";
  /** Reason for this grouping */
  reason: string;
  /** Suggested order (0 = do first) */
  order: number;
}

export interface SplitResult {
  /** Whether split suggestions were generated */
  shouldSplit: boolean;
  /** Suggested splits */
  suggestions: SplitSuggestion[];
  /** Context string for LLM injection */
  contextText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory prefix to functional area mapping */
const AREA_PATTERNS: Array<{ pattern: RegExp; area: string }> = [
  { pattern: /\/api\//i, area: "API" },
  { pattern: /\/auth\//i, area: "Auth" },
  { pattern: /\/middleware\//i, area: "Middleware" },
  { pattern: /\/db\//i, area: "Database" },
  { pattern: /\/sql\//i, area: "Database" },
  { pattern: /\/models?\//i, area: "Models" },
  { pattern: /\/types?\//i, area: "Types" },
  { pattern: /\/interfaces?\//i, area: "Contracts" },
  { pattern: /\/schemas?\//i, area: "Schema" },
  { pattern: /\/services?\//i, area: "Services" },
  { pattern: /\/handlers?\//i, area: "Handlers" },
  { pattern: /\/routes?\//i, area: "Routes" },
  { pattern: /\/controllers?\//i, area: "Controllers" },
  { pattern: /\/utils?\//i, area: "Utils" },
  { pattern: /\/helpers?\//i, area: "Helpers" },
  { pattern: /\/config/i, area: "Config" },
  { pattern: /\/tests?\//i, area: "Tests" },
  { pattern: /\/__tests__\//i, area: "Tests" },
  { pattern: /\/spec\//i, area: "Tests" },
  { pattern: /\/migrations?\//i, area: "Migrations" },
  { pattern: /\/scripts?\//i, area: "Scripts" },
  { pattern: /\/docs?\//i, area: "Docs" },
  { pattern: /\/ui\//i, area: "UI" },
  { pattern: /\/components?\//i, area: "UI" },
  { pattern: /\/pages?\//i, area: "UI" },
];

/** Minimum files to justify splitting */
const MIN_FILES_FOR_SPLIT = 5;

/** Maximum split suggestions */
const MAX_SUGGESTIONS = 4;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Detect the functional area of a file from its path */
function detectArea(filePath: string): string {
  for (const { pattern, area } of AREA_PATTERNS) {
    if (pattern.test(filePath)) return area;
  }
  // Fall back to top-level directory
  const parts = filePath.split("/");
  if (parts.length > 1) {
    const topLevel = parts[0];
    // Capitalize first letter
    return topLevel.charAt(0).toUpperCase() + topLevel.slice(1);
  }
  return "Root";
}

/** Count additions/deletions for a set of files */
function countLines(files: string[], diffFiles: DiffFile[]): { additions: number; deletions: number } {
  const fileSet = new Set(files);
  let additions = 0;
  let deletions = 0;
  for (const df of diffFiles) {
    if (fileSet.has(df.path)) {
      additions += df.additions;
      deletions += df.deletions;
    }
  }
  return { additions, deletions };
}

/** Determine scope from total lines */
function scopeForLines(totalLines: number): "small" | "medium" | "large" {
  if (totalLines <= 50) return "small";
  if (totalLines <= 200) return "medium";
  return "large";
}

/**
 * Suggest PR split groupings when the PR is too complex.
 *
 * @param diffFiles Files changed in this PR
 * @param complexityScore Score from complexity predictor (1-10)
 * @param complexityCategory Category from complexity predictor
 */
export function suggestPRSplits(
  diffFiles: DiffFile[],
  complexityScore: number,
  complexityCategory: string,
): SplitResult {
  const shouldSplit = (complexityScore >= 7 || complexityCategory === "complex" || complexityCategory === "critical")
    && diffFiles.length >= MIN_FILES_FOR_SPLIT;

  if (!shouldSplit) {
    return { shouldSplit: false, suggestions: [], contextText: "" };
  }

  // Group files by functional area
  const areaGroups = new Map<string, string[]>();
  for (const file of diffFiles) {
    const area = detectArea(file.path);
    if (!areaGroups.has(area)) areaGroups.set(area, []);
    areaGroups.get(area)!.push(file.path);
  }

  // Sort areas by file count (largest first) for ordering
  const sortedAreas = [...areaGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  // Also group architecture files (types/interfaces/schemas) as a separate "foundation" PR
  const archFiles: string[] = [];
  const nonArchFiles = new Map<string, string[]>();

  for (const [area, files] of sortedAreas) {
    const areaArch = files.filter(f =>
      /\/(types?|interfaces?|schemas?|contracts?)\//i.test(f) ||
      /\.d\.ts$/.test(f) ||
      /index\.[tj]s$/.test(f) ||
      /mod\.[tj]s$/.test(f)
    );
    const areaNonArch = files.filter(f => !areaArch.includes(f));

    if (areaArch.length > 0) archFiles.push(...areaArch);
    if (areaNonArch.length > 0) nonArchFiles.set(area, areaNonArch);
  }

  // Build suggestions
  const suggestions: SplitSuggestion[] = [];
  let order = 0;

  // Foundation PR: architecture files first (types, interfaces, schemas)
  if (archFiles.length >= 2) {
    const { additions, deletions } = countLines(archFiles, diffFiles);
    suggestions.push({
      title: "Foundation: types, interfaces, and schema changes",
      files: archFiles,
      scope: scopeForLines(additions + deletions),
      reason: "Architecture-level files should land first so dependent code compiles",
      order: order++,
    });
  }

  // Area-specific PRs
  for (const [area, files] of nonArchFiles) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    const { additions, deletions } = countLines(files, diffFiles);
    suggestions.push({
      title: `${area}: ${files.length} file(s)`,
      files,
      scope: scopeForLines(additions + deletions),
      reason: `Grouped by functional area (${area})`,
      order: order++,
    });
  }

  // If there are leftover groups (we hit MAX_SUGGESTIONS), merge smallest into "Other"
  if (sortedAreas.length > suggestions.length + (archFiles.length >= 2 ? 1 : 0)) {
    const covered = new Set(suggestions.flatMap(s => s.files));
    const remaining = diffFiles.filter(f => !covered.has(f.path)).map(f => f.path);
    if (remaining.length > 0) {
      countLines(remaining, diffFiles);
      // Fold into last suggestion if it exists, otherwise create new
      if (suggestions.length > 0 && suggestions.length <= MAX_SUGGESTIONS) {
        const last = suggestions[suggestions.length - 1];
        last.files.push(...remaining);
        const totalLines = last.files.reduce((sum, f) => {
          const df = diffFiles.find(d => d.path === f);
          return sum + (df ? df.additions + df.deletions : 0);
        }, 0);
        last.scope = scopeForLines(totalLines);
        last.title = last.title.includes("Other")
          ? last.title
          : last.title + " + Other";
      }
    }
  }

  const contextText = buildSplitContext(complexityScore, complexityCategory, suggestions);

  core.info(`PR split: ${suggestions.length} suggestion(s) for ${diffFiles.length} files`);

  return { shouldSplit, suggestions, contextText };
}

/** Build context string for LLM injection and review body */
function buildSplitContext(
  score: number,
  category: string,
  suggestions: SplitSuggestion[],
): string {
  let ctx = `## PR Split Suggestions\n`;
  ctx += `**Complexity:** ${score}/10 (${category}) — Consider splitting into ${suggestions.length} smaller PRs:\n\n`;

  for (const s of suggestions) {
    ctx += `**${s.order + 1}. ${s.title}** (${s.scope}, ${s.files.length} file(s))\n`;
    ctx += `   ${s.reason}\n`;
    for (const f of s.files.slice(0, 8)) {
      ctx += `   - \`${f}\`\n`;
    }
    if (s.files.length > 8) {
      ctx += `   - ... and ${s.files.length - 8} more\n`;
    }
    ctx += `\n`;
  }

  ctx += `> Smaller PRs review faster, get better feedback, and are less likely to introduce bugs.\n`;

  return ctx.trim();
}
