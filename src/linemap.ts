/**
 * Line mapping — THE hard problem.
 * Maps LLM output (file + line number) → GitHub diff position for inline comments.
 *
 * GitHub's PR Review API uses "position" which is the 1-based index into the diff,
 * NOT the file line number. This module builds the mapping between them.
 *
 * Primary: diff0's parseDiffForPositions — walks raw diff text line-by-line.
 * Fallback: parsed DiffFile[] with approximate positions.
 */
import { DiffFile } from "./diff.js";

export interface LineMapping {
  file: string;
  line: number;
  position: number;
  side?: "LEFT" | "RIGHT";
}

/**
 * Build position map from raw unified diff text (diff0 pattern).
 * More accurate than building from parsed hunks because GitHub's "position"
 * counts ALL diff lines including metadata, hunk headers, and context.
 */
export function buildLineMapFromRawDiff(rawDiff: string): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  const lines = rawDiff.split("\n");
  let currentFile: string | null = null;
  let position = 0;
  let newLineNumber = 0;

  for (const line of lines) {
    position++; // Every line in diff increments position

    if (line.startsWith("diff --git")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        currentFile = m[2];
        newLineNumber = 0;
        if (!result.has(currentFile)) {
          result.set(currentFile, new Map());
        }
      }
      continue;
    }

    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        newLineNumber = parseInt(m[1], 10) - 1;
      }
      continue;
    }

    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("Binary")) {
      continue;
    }

    if (!currentFile) continue;
    const fileMap = result.get(currentFile)!;

    if (line.startsWith("+")) {
      newLineNumber++;
      fileMap.set(newLineNumber, position);
    } else if (line.startsWith("-")) {
      // Removed line — no new file line number
    } else if (!line.startsWith("\\")) {
      newLineNumber++;
      fileMap.set(newLineNumber, position);
    }
  }

  return result;
}

/**
 * Build line map from parsed DiffFile[] as fallback.
 * Less accurate — use buildLineMapFromRawDiff when raw diff is available.
 */
export function buildLineMap(files: DiffFile[]): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();

  for (const file of files) {
    const lineToPosition = new Map<number, number>();
    let position = 0;

    for (const hunk of file.hunks) {
      position++; // hunk header
      for (const change of hunk.changes) {
        position++;
        if ((change.type === "add" || change.type === "normal") && change.line > 0) {
          lineToPosition.set(change.line, position);
        }
      }
    }

    result.set(file.path, lineToPosition);
  }

  return result;
}

/**
 * Resolve LLM finding to GitHub diff position.
 * SourceAnt 4-strategy cascade: exact → proximity (±5) → closest.
 */
export function resolvePosition(
  lineMap: Map<string, Map<number, number>>,
  file: string,
  line: number
): number | null {
  const fileMap = lineMap.get(file);
  if (!fileMap) return null;

  if (fileMap.has(line)) return fileMap.get(line)!;

  const positions = [...fileMap.entries()]
    .filter(([ln]) => Math.abs(ln - line) <= 5)
    .sort(([a], [b]) => Math.abs(a - line) - Math.abs(b - line));

  return positions.length > 0 ? positions[0][1] : null;
}

/**
 * Generate hint string for LLM prompt listing valid comment positions.
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
 * Validate that a finding's file+line combination is in the diff.
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
