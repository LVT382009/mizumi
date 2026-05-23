/**
 * Line mapping — THE hard problem.
 * Maps LLM output (file + line number) → GitHub diff position for inline comments.
 *
 * GitHub's PR Review API uses "position" which is the 1-based index into the diff,
 * NOT the file line number. This module builds the mapping between them.
 *
 * Strategy from SourceAnt's LineMapper + diff0's parseDiffForPositions.
 */
import { DiffFile, DiffHunk, DiffChange } from "./diff.js";

export interface LineMapping {
  file: string;
  line: number;       // The actual file line number the LLM referenced
  position: number;   // The GitHub diff position for createReviewComment
  side?: "LEFT" | "RIGHT";
}

/**
 * Build a complete position lookup from parsed diff data.
 * Returns a map: filePath → Map<fileLineNumber, githubPosition>
 */
export function buildLineMap(files: DiffFile[]): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();

  for (const file of files) {
    const lineToPosition = new Map<number, number>();
    let position = 0;

    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        position++;
        // Only map lines that exist in the new version (RIGHT side)
        // "add" and "normal" lines have valid new-file line numbers
        if (change.type === "add" || change.type === "normal") {
          if (change.line > 0) {
            lineToPosition.set(change.line, position);
          }
        }
      }
    }

    result.set(file.path, lineToPosition);
  }

  return result;
}

/**
 * Resolve an LLM finding to a valid GitHub diff position.
 * If the exact line isn't in the diff, find the nearest valid position.
 */
export function resolvePosition(
  lineMap: Map<string, Map<number, number>>,
  file: string,
  line: number
): number | null {
  const fileMap = lineMap.get(file);
  if (!fileMap) return null;

  // Exact match
  if (fileMap.has(line)) return fileMap.get(line)!;

  // Find nearest valid position (within 5 lines, preferring higher)
  const positions = [...fileMap.entries()]
    .filter(([ln]) => Math.abs(ln - line) <= 5)
    .sort(([a], [b]) => Math.abs(a - line) - Math.abs(b - line));

  return positions.length > 0 ? positions[0][1] : null;
}

/**
 * Generate a hint string for the LLM prompt listing valid comment positions.
 * Format: "src/auth.ts: lines 10-45, 50-89; src/api.ts: lines 5-30"
 */
export function buildPositionHint(files: DiffFile[]): string {
  const parts: string[] = [];

  for (const file of files) {
    const validLines: number[] = [];
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if ((change.type === "add" || change.type === "normal") && change.line > 0) {
          validLines.push(change.line);
        }
      }
    }

    if (validLines.length === 0) continue;

    // Collapse consecutive ranges
    const ranges: string[] = [];
    let rangeStart = validLines[0];
    let rangeEnd = validLines[0];

    for (let i = 1; i < validLines.length; i++) {
      if (validLines[i] === rangeEnd + 1) {
        rangeEnd = validLines[i];
      } else {
        ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);
        rangeStart = validLines[i];
        rangeEnd = validLines[i];
      }
    }
    ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`);

    parts.push(`${file.path}: lines ${ranges.join(", ")}`);
  }

  return parts.join("; ");
}

/**
 * Validate that a finding's file+line combination is actually in the diff.
 * Returns the corrected position or null if impossible.
 */
export function validateFinding(
  lineMap: Map<string, Map<number, number>>,
  file: string,
  line: number,
  endLine?: number
): { position: number; endPosition?: number } | null {
  const position = resolvePosition(lineMap, file, line);
  if (position === null) return null;

  let endPosition: number | undefined;
  if (endLine) {
    const ep = resolvePosition(lineMap, file, endLine);
    if (ep !== null && ep > position) {
      endPosition = ep;
    }
  }

  return { position, endPosition };
}
