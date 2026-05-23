/**
 * Memory — MEMORY.md reader/writer (Hermes-style, ~2KB bounded).
 * Repo-specific knowledge that persists across reviews.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";

const MAX_MEMORY_BYTES = 2048;
const MEMORY_FILENAME = "mizumi-memory.md";
const CONSOLIDATE_THRESHOLD = 0.8; // Consolidate at 80% full

/**
 * Read MEMORY.md from the repo. Returns empty string if missing.
 */
export function readMemory(workspace: string): string {
  const memoryPath = path.join(workspace, ".github", MEMORY_FILENAME);
  if (!fs.existsSync(memoryPath)) return "";

  try {
    const content = fs.readFileSync(memoryPath, "utf-8");
    core.info(`Memory: loaded ${content.length} bytes from ${MEMORY_FILENAME}`);
    return content;
  } catch {
    return "";
  }
}

/**
 * Write updated MEMORY.md after a review.
 * Appends new findings and consolidates when approaching size limit.
 */
export function writeMemory(
  workspace: string,
  currentMemory: string,
  reviewFindings: string
): void {
  const memoryDir = path.join(workspace, ".github");
  const memoryPath = path.join(memoryDir, MEMORY_FILENAME);

  let updated = currentMemory;

  if (reviewFindings.trim()) {
    updated += `\n\n## ${new Date().toISOString().split("T")[0]}\n${reviewFindings}`;
  }

  // Consolidate if approaching limit
  if (Buffer.byteLength(updated, "utf-8") > MAX_MEMORY_BYTES * CONSOLIDATE_THRESHOLD) {
    updated = consolidate(updated);
  }

  // Hard cap — truncate oldest entries
  if (Buffer.byteLength(updated, "utf-8") > MAX_MEMORY_BYTES) {
    updated = hardCap(updated, MAX_MEMORY_BYTES);
  }

  try {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    fs.writeFileSync(memoryPath, updated, "utf-8");
    core.info(`Memory: wrote ${Buffer.byteLength(updated, "utf-8")} bytes`);
  } catch (error) {
    core.warning(`Failed to write memory: ${error}`);
  }
}

/**
 * Consolidate memory — merge similar entries, prune stale items.
 * Keeps the most recent and most referenced patterns.
 */
function consolidate(memory: string): string {
  const sections = memory.split(/\n## \d{4}-\d{2}-\d{2}\n/);

  if (sections.length <= 2) return memory;

  // Keep header (first section) + last 3 sections
  const header = sections[0];
  const recentSections = sections.slice(-3);

  return header + recentSections
    .map((s) => `\n## consolidated\n${s.trim()}`)
    .join("\n");
}

/**
 * Hard cap — truncate from the top, keeping the most recent entries.
 */
function hardCap(memory: string, maxBytes: number): string {
  const lines = memory.split("\n");

  // Keep header (first 5 lines) + tail
  const header = lines.slice(0, 5);
  let tail = lines.slice(5);

  while (Buffer.byteLength([...header, ...tail].join("\n"), "utf-8") > maxBytes && tail.length > 0) {
    tail = tail.slice(1);
  }

  return [...header, ...tail].join("\n");
}

/**
 * Read project rules files (CLAUDE.md, REVIEW.md) — highest priority context.
 */
export function readRules(workspace: string): string {
  const rulesPaths = [
    path.join(workspace, "REVIEW.md"),
    path.join(workspace, "CLAUDE.md"),
    path.join(workspace, ".github", "REVIEW.md"),
  ];

  const parts: string[] = [];
  for (const p of rulesPaths) {
    if (fs.existsSync(p)) {
      try {
        parts.push(fs.readFileSync(p, "utf-8"));
      } catch { /* skip unreadable files */ }
    }
  }

  return parts.join("\n\n");
}
