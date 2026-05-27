/**
 * Adaptive Chunked Review — split large PRs into logical chunks for higher quality.
 *
 * When a PR touches many files, stuffing everything into one LLM call
 * degrades review quality (context dilution). This module splits the
 * diff into logical chunks by directory + file type, reviews each chunk
 * separately, then merges all findings with dedup.
 *
 * No competitor does this. CodeRabbit/Copilot/Greptile all use a single
 * LLM call regardless of PR size. Mizumi adapts chunk count to PR size.
 *
 * Thresholds:
 * - <=10 files: single-review (no chunking needed)
 * - 11-25 files: 2-3 chunks by directory area
 * - 26+ files: 3-5 chunks by directory + file type
 *
 * Zero LLM cost for planning (chunking is pure heuristic).
 * The actual chunk reviews cost the same total tokens but yield higher quality.
 */
import { DiffFile } from "./diff.js";
import { estimateTokens } from "./router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewChunk {
  id: string;
  label: string;
  files: DiffFile[];
  estimatedTokens: number;
}

export interface ChunkPlan {
  chunks: ReviewChunk[];
  totalFiles: number;
  totalTokens: number;
  strategy: "single" | "by-directory" | "by-area";
  contextText: string;
}

// ---------------------------------------------------------------------------
// Directory area classification
// ---------------------------------------------------------------------------

type Area = "frontend" | "backend" | "infra" | "config" | "test" | "docs" | "other";

const FRONTEND_RE = /\/?(src\/app|src\/components|src\/pages|src\/views|src\/layouts|public\/|assets\/|styles?\/)/i;
const BACKEND_RE = /\/?(src\/api|src\/routes|src\/server|src\/middleware|src\/services|src\/controllers|src\/models|src\/db)/i;
const INFRA_RE = /\/?(infra|terraform|docker|k8s|\.github|deploy|scripts)/i;
const CONFIG_RE = /\/?(config|\.env|tsconfig|eslint|prettier|vite\.config|webpack\.config)/i;
const TEST_RE = /\/?(__tests__|test|tests|spec|\.test\.|\.spec\.)/i;
const DOCS_RE = /\/?(docs?|README|CHANGELOG|CONTRIBUTING)/i;

type AreaPattern = { re: RegExp; area: Area };

const AREA_PATTERNS: AreaPattern[] = [
  { re: FRONTEND_RE, area: "frontend" },
  { re: BACKEND_RE, area: "backend" },
  { re: INFRA_RE, area: "infra" },
  { re: CONFIG_RE, area: "config" },
  { re: TEST_RE, area: "test" },
  { re: DOCS_RE, area: "docs" },
];

function classifyArea(file: DiffFile): Area {
  for (const { re, area } of AREA_PATTERNS) {
    if (re.test(file.path)) return area;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Directory grouping
// ---------------------------------------------------------------------------

function topDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts[0] : "root";
}

// ---------------------------------------------------------------------------
// Chunking strategies
// ---------------------------------------------------------------------------

function singleReview(files: DiffFile[], totalTokens: number): ChunkPlan {
  return {
    chunks: [{
      id: "chunk-1",
      label: "Full review",
      files,
      estimatedTokens: totalTokens,
    }],
    totalFiles: files.length,
    totalTokens,
    strategy: "single",
    contextText: "",
  };
}

function chunkByDirectory(files: DiffFile[], totalTokens: number, maxChunks: number = 4): ChunkPlan {
  const groups = new Map<string, DiffFile[]>();
  for (const file of files) {
    const dir = topDir(file.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(file);
  }

  // Sort groups by size (largest first for balanced merging)
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  // Initialize chunks
  const chunks: ReviewChunk[] = sorted.slice(0, maxChunks).map(([dir, chunkFiles], i) => ({
    id: `chunk-${i + 1}`,
    label: dir,
    files: [...chunkFiles],
    estimatedTokens: chunkFiles.reduce((sum, f) => sum + estimateTokens(formatFileForChunk(f)), 0),
  }));

  // Merge small groups into existing chunks
  if (sorted.length > maxChunks) {
    for (let i = maxChunks; i < sorted.length; i++) {
      const smallest = chunks.reduce((min, c) => c.files.length < min.files.length ? c : min);
      smallest.files.push(...sorted[i][1]);
      smallest.label += " + " + sorted[i][0];
      smallest.estimatedTokens = smallest.files.reduce((sum, f) => sum + estimateTokens(formatFileForChunk(f)), 0);
    }
  }

  const strategy = "by-directory";
  const contextText = buildContextText(chunks, "by directory area");

  return {
    chunks,
    totalFiles: files.length,
    totalTokens,
    strategy,
    contextText,
  };
}

function chunkByArea(files: DiffFile[], totalTokens: number): ChunkPlan {
  const groups = new Map<Area, DiffFile[]>();
  for (const file of files) {
    const area = classifyArea(file);
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area)!.push(file);
  }

  const chunks: ReviewChunk[] = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([area, chunkFiles], i) => ({
      id: `chunk-${i + 1}`,
      label: area,
      files: chunkFiles,
      estimatedTokens: chunkFiles.reduce((sum, f) => sum + estimateTokens(formatFileForChunk(f)), 0),
    }));

  // Merge tiny chunks (<3 files) into nearest larger chunk
  const merged: ReviewChunk[] = [];
  let overflow: DiffFile[] = [];
  for (const chunk of chunks) {
    if (chunk.files.length < 3 && merged.length > 0) {
      overflow.push(...chunk.files);
    } else {
      merged.push(chunk);
    }
  }
  if (overflow.length > 0 && merged.length > 0) {
    merged[merged.length - 1].files.push(...overflow);
    merged[merged.length - 1].label += " + misc";
    merged[merged.length - 1].estimatedTokens = merged[merged.length - 1].files.reduce(
      (sum, f) => sum + estimateTokens(formatFileForChunk(f)), 0,
    );
  }

  // Cap at 5 chunks
  while (merged.length > 5) {
    const last = merged.pop()!;
    merged[merged.length - 1].files.push(...last.files);
    merged[merged.length - 1].label += " + " + last.label;
    merged[merged.length - 1].estimatedTokens = merged[merged.length - 1].files.reduce(
      (sum, f) => sum + estimateTokens(formatFileForChunk(f)), 0,
    );
  }

  const contextText = buildContextText(merged, "by functional area");

  return {
    chunks: merged,
    totalFiles: files.length,
    totalTokens,
    strategy: "by-area",
    contextText,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFileForChunk(file: DiffFile): string {
  const changes = file.hunks
    .flatMap(h => h.changes)
    .map(c => c.content)
    .join("\n");
  return `--- ${file.path} ---\n${changes}`;
}

function buildContextText(chunks: ReviewChunk[], method: string): string {
  let text = "## Chunked Review Plan\n\n";
  text += `Large PR detected — review split into ${chunks.length} chunks ${method} for higher quality.\n\n`;
  text += "| Chunk | Area | Files | Est. Tokens |\n";
  text += "|-------|------|-------|-------------|\n";
  for (const chunk of chunks) {
    text += `| ${chunk.id} | ${chunk.label} | ${chunk.files.length} | ~${chunk.estimatedTokens.toLocaleString()} |\n`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan adaptive chunked review for a set of diff files.
 * Returns a chunk plan — does NOT perform the actual review.
 */
export function planChunkedReview(files: DiffFile[]): ChunkPlan {
  if (files.length === 0) return singleReview(files, 0);

  const totalTokens = files.reduce((sum, f) => sum + estimateTokens(formatFileForChunk(f)), 0);

  if (files.length <= 10) {
    return singleReview(files, totalTokens);
  }

  if (files.length <= 25) {
    return chunkByDirectory(files, totalTokens, 3);
  }

  return chunkByArea(files, totalTokens);
}

/**
 * Format a chunk's files into diff text for LLM review.
 */
export function formatChunkDiff(chunk: ReviewChunk): string {
  return chunk.files.map(f => formatFileForChunk(f)).join("\n\n");
}

/**
 * Extract unique file paths from all chunks.
 */
export function getAllChunkFiles(chunks: ReviewChunk[]): string[] {
  const files = new Set<string>();
  for (const chunk of chunks) {
    for (const file of chunk.files) {
      files.add(file.path);
    }
  }
  return [...files].sort();
}
