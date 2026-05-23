/**
 * Line mapping — validates LLM output lines against the diff.
 *
 * GitHub deprecated the `position` param for review comments in favor of
 * `line`/`start_line`/`side`/`start_side`. Since the LLM already outputs
 * file line numbers, we validate them against the diff rather than computing
 * diff positions.
 *
 * Primary: walk raw diff to extract valid new-file line numbers.
 * Fallback: build from parsed DiffFile[].
 */

// LineMap: file path → set of valid new-file line numbers in the diff
export type LineMap = Map<string, Set<number>>;

/**
 * Build line map from raw unified diff text (diff0 pattern).
 * Walks the raw diff line-by-line to extract exactly which new-file
 * line numbers exist in the diff — these are valid comment targets.
 */
export function buildLineMapFromRawDiff(rawDiff: string): LineMap {
  const result: LineMap = new Map();
  const lines = rawDiff.split("\n");
  let currentFile: string | null = null;
  let newLineNumber = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        currentFile = m[2];
        newLineNumber = 0;
        if (!result.has(currentFile)) {
          result.set(currentFile, new Set());
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
    const lineSet = result.get(currentFile)!;

    if (line.startsWith("+")) {
      newLineNumber++;
      lineSet.add(newLineNumber);
    } else if (line.startsWith("-")) {
      // Removed line — no new file line number
    } else if (!line.startsWith("\\")) {
      // Context line — still a valid comment target (exists in new file)
      newLineNumber++;
      lineSet.add(newLineNumber);
    }
  }

  return result;
}

/**
 * Build line map from parsed DiffFile[] as fallback.
 * Less accurate — use buildLineMapFromRawDiff when raw diff is available.
 */
export function buildLineMap(files: import("./diff.js").DiffFile[]): LineMap {
  const result: LineMap = new Map();

  for (const file of files) {
    const validLines = new Set<number>();

    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if ((change.type === "add" || change.type === "normal") && change.line > 0) {
          validLines.add(change.line);
        }
      }
    }

    result.set(file.path, validLines);
  }

  return result;
}

/**
 * Check if a file+line combination is valid for posting a review comment.
 * Falls back to nearest valid line within ±5 (SourceAnt proximity strategy).
 */
export function isValidLine(lineMap: LineMap, file: string, line: number): boolean {
  const lineSet = lineMap.get(file);
  if (!lineSet) return false;
  return lineSet.has(line);
}

/**
 * Resolve LLM finding to a valid file line number.
 * SourceAnt cascade: exact → proximity ±5 → null.
 * Returns the valid line number to use, or null if no valid line found.
 */
export function resolveLine(
  lineMap: LineMap,
  file: string,
  line: number
): number | null {
  const lineSet = lineMap.get(file);
  if (!lineSet) return null;

  if (lineSet.has(line)) return line;

  // Proximity: find nearest valid line within ±5
  let best: number | null = null;
  let bestDist = Infinity;

  for (const validLine of lineSet) {
    const dist = Math.abs(validLine - line);
    if (dist <= 5 && dist < bestDist) {
      best = validLine;
      bestDist = dist;
    }
  }

  return best;
}

/**
 * Generate hint string for LLM prompt listing valid comment positions.
 */
export function buildPositionHint(files: import("./diff.js").DiffFile[]): string {
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
 * Returns resolved line numbers or null if invalid.
 */
export function validateFinding(
  lineMap: LineMap,
  file: string,
  line: number,
  endLine?: number
): { line: number; endLine?: number } | null {
  const resolved = resolveLine(lineMap, file, line);
  if (resolved === null) return null;

  let resolvedEnd: number | undefined;
  if (endLine && endLine > line) {
    const re = resolveLine(lineMap, file, endLine);
    if (re !== null && re > resolved) {
      resolvedEnd = re;
    }
  }

  return { line: resolved, endLine: resolvedEnd };
}
