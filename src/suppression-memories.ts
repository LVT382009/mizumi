/**
 * Suppression Memories — AI Memorized Triage (competitive gap #1).
 *
 * When a human dismisses a finding with a reason, Mizumi stores a
 * "suppression memory": a structured record that auto-silences the
 * same pattern in future reviews. Unlike statistical dismissal rates
 * (feedback.ts), suppression memories capture the *reasoning* behind
 * a dismissal and match on file+category+pattern context.
 *
 * Example: "Dismissed SQL injection in src/api/health.ts because
 * the endpoint is auth-free by design" → auto-suppresses future
 * SQL findings in health endpoints.
 *
 * Zero LLM cost — runs on SQLite + regex pattern matching.
 * Extends the existing mizumi-data.db shared with db.ts and org-memory.ts.
 */
import * as core from "@actions/core";
import * as path from "node:path";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuppressionMemory {
  id: number;
  repo: string;
  /** File path or glob pattern (e.g. "src/api/health*.ts") */
  filePattern: string;
  /** Finding category this suppresses */
  category: string;
  /** Partial message text to match (empty = match any message in category) */
  messagePattern: string;
  /** Human-provided reason for the suppression */
  reason: string;
  /** How many times this memory auto-suppressed a finding */
  hitCount: number;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last hit */
  lastHitAt: string;
}

export interface SuppressionResult {
  /** Memories that matched findings in this review */
  matchedMemories: SuppressionMemory[];
  /** Findings that were suppressed */
  suppressedCount: number;
  /** Context string for LLM injection */
  contextText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_FILENAME = "mizumi-data.db";

/** Maximum suppression memories per repo */
const MAX_MEMORIES = 100;

/** Minimum message pattern length to require (avoid overly broad matches) */
const MIN_PATTERN_LEN = 5;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function getDbPath(workspace: string): string {
  return path.join(workspace, ".github", DB_FILENAME);
}

function openDb(workspace: string): DatabaseSync {
  const dbPath = getDbPath(workspace);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS suppression_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      file_pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      message_pattern TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_hit_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_suppression_repo ON suppression_memories(repo)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_suppression_repo_cat ON suppression_memories(repo, category)`);

  return db;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Convert a file path to a glob pattern for broader matching.
 * "src/api/health.ts" → "src/api/health*"
 * Preserves directory structure but widens the filename match.
 */
function toGlobPattern(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath);
  // Match the same base name + any suffix (e.g. health.ts, health.controller.ts)
  return dir === "." ? `${base}*${ext}` : `${dir}/${base}*${ext}`;
}

/**
 * Check if a file path matches a glob pattern.
 * Supports only the * wildcard (matches any characters except /).
 */
function globMatch(pattern: string, filePath: string): boolean {
  if (pattern === filePath) return true;
  if (!pattern.includes("*")) return false;
  // Convert glob to regex: * → [^/]*
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}

/**
 * Record a suppression memory when a finding is dismissed with a reason.
 */
export function recordSuppressionMemory(
  workspace: string,
  repo: string,
  file: string,
  category: string,
  message: string,
  reason: string
): void {
  if (!reason.trim()) return;

  const db = openDb(workspace);
  try {
    // Dedup: check if an identical memory already exists
    const existing = db.prepare(
      `SELECT id FROM suppression_memories
       WHERE repo = ? AND category = ? AND message_pattern = ? AND reason = ?`
    ).get(repo, category, message, reason.trim());

    if (existing) {
      core.info(`Suppression memory: duplicate skipped for ${category} in ${file}`);
      return;
    }

    // Enforce max memories per repo
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM suppression_memories WHERE repo = ?`).get(repo) as { cnt: number } | undefined;
    if ((count?.cnt ?? 0) >= MAX_MEMORIES) {
      // Delete oldest, least-hit memory
      db.prepare(
        `DELETE FROM suppression_memories WHERE repo = ? ORDER BY hit_count ASC, created_at ASC LIMIT 1`
      ).run(repo);
    }

    const insert = db.prepare(
      `INSERT INTO suppression_memories (repo, file_pattern, category, message_pattern, reason)
       VALUES (?, ?, ?, ?, ?)`
    );
    insert.run(repo, toGlobPattern(file), category, message, reason.trim());

    core.info(`Suppression memory: recorded for ${category} in ${file} — "${reason.trim().slice(0, 60)}"`);
  } catch (e) {
    core.warning(`Failed to record suppression memory: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db.close();
  }
}

/**
 * Check if a finding should be suppressed based on stored memories.
 * Matches on file glob pattern + category + optional message pattern.
 */
export function shouldSuppress(
  workspace: string,
  repo: string,
  file: string,
  category: string,
  message: string
): SuppressionMemory | null {
  const db = openDb(workspace);
  try {
    const rows = db.prepare(
      `SELECT id, repo, file_pattern, category, message_pattern, reason, hit_count, created_at, last_hit_at
       FROM suppression_memories WHERE repo = ? AND category = ?`
    ).all(repo, category) as Array<{
      id: number;
      repo: string;
      file_pattern: string;
      category: string;
      message_pattern: string;
      reason: string;
      hit_count: number;
      created_at: string;
      last_hit_at: string;
    }>;

    for (const row of rows) {
      const fileMatch = globMatch(row.file_pattern, file);
      if (!fileMatch) continue;

      // If message_pattern is set, check if it matches
      if (row.message_pattern) {
        if (row.message_pattern.length >= MIN_PATTERN_LEN && message.includes(row.message_pattern)) {
          return rowToMemory(row);
        }
        if (row.message_pattern.length < MIN_PATTERN_LEN) {
          // Pattern too short for reliable matching — just match on file+category
          return rowToMemory(row);
        }
        continue; // message doesn't match
      }

      // No message pattern — match on file+category alone
      return rowToMemory(row);
    }

    return null;
  } catch (e) {
    core.warning(`Suppression memory lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    db.close();
  }
}

function rowToMemory(row: Record<string, unknown>): SuppressionMemory {
  return {
    id: row.id as number,
    repo: row.repo as string,
    filePattern: row.file_pattern as string,
    category: row.category as string,
    messagePattern: row.message_pattern as string,
    reason: row.reason as string,
    hitCount: row.hit_count as number,
    createdAt: row.created_at as string,
    lastHitAt: row.last_hit_at as string,
  };
}

/**
 * Apply suppression memories to review findings.
 * Returns findings with suppression-matched ones filtered out,
 * plus context about what was suppressed and why.
 */
export function applySuppressionMemories<T extends { file: string; category: string; message: string; confidence: number }>(
  workspace: string,
  repo: string,
  findings: T[]
): { filtered: T[]; suppressedCount: number; matchedMemories: SuppressionMemory[] } {
  const matchedMemories: SuppressionMemory[] = [];
  let suppressedCount = 0;

  if (findings.length === 0) return { filtered: findings, suppressedCount: 0, matchedMemories: [] };

  const filtered = findings.filter((f) => {
    const memory = shouldSuppress(workspace, repo, f.file, f.category, f.message);
    if (memory) {
      matchedMemories.push(memory);
      suppressedCount++;
      core.info(`Suppression memory: auto-suppressed ${f.category} in ${f.file} (reason: "${memory.reason.slice(0, 60)}")`);
      return false;
    }
    return true;
  });

  // Increment hit counts for matched memories
  if (matchedMemories.length > 0) {
    incrementHitCounts(workspace, matchedMemories.map((m) => m.id));
  }

  return { filtered, suppressedCount, matchedMemories };
}

/** Increment hit counts for matched suppression memories. */
function incrementHitCounts(workspace: string, memoryIds: number[]): void {
  const db = openDb(workspace);
  try {
    const update = db.prepare(
      `UPDATE suppression_memories SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE id = ?`
    );
    for (const id of memoryIds) {
      update.run(id);
    }
  } catch {
    // Non-critical
  } finally {
    db.close();
  }
}

/**
 * Build context string for LLM injection about active suppression memories.
 * Tells the reviewer which patterns are auto-suppressed and why.
 */
export function buildSuppressionContext(result: SuppressionResult): string {
  if (result.matchedMemories.length === 0 && result.suppressedCount === 0) return "";

  let ctx = `## Suppression Memories (${result.suppressedCount} finding(s) auto-suppressed)\n`;
  ctx += "The following patterns were automatically suppressed based on human-reviewed dismissal reasons. ";
  ctx += "Do NOT re-raise these findings unless the code context has materially changed:\n\n";

  for (const memory of result.matchedMemories) {
    ctx += `- **${memory.category}** in \`${memory.filePattern}\`: ${memory.reason} (hit ${memory.hitCount}x)\n`;
  }

  return ctx.trim();
}

/**
 * Run the full suppression memory pipeline.
 * Checks findings against stored memories, returns filtered findings + context.
 */
export function runSuppressionMemories<T extends { file: string; category: string; message: string; confidence: number }>(
  workspace: string,
  repo: string,
  findings: T[]
): { filtered: T[]; result: SuppressionResult } {
  const { filtered, suppressedCount, matchedMemories } = applySuppressionMemories(workspace, repo, findings);

  const result: SuppressionResult = {
    matchedMemories,
    suppressedCount,
    contextText: "",
  };

  result.contextText = buildSuppressionContext(result);

  if (suppressedCount > 0) {
    core.info(`Suppression memories: ${suppressedCount} finding(s) auto-suppressed (${matchedMemories.length} memory match(es))`);
  }

  return { filtered, result };
}

/** Get all suppression memories for a repo (for admin/debug purposes). */
export function getSuppressionMemories(workspace: string, repo: string): SuppressionMemory[] {
  const db = openDb(workspace);
  try {
    const rows = db.prepare(
      `SELECT id, repo, file_pattern, category, message_pattern, reason, hit_count, created_at, last_hit_at
       FROM suppression_memories WHERE repo = ? ORDER BY hit_count DESC`
    ).all(repo) as Array<Record<string, unknown>>;

    return rows.map(rowToMemory);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Delete a specific suppression memory by ID. */
export function deleteSuppressionMemory(workspace: string, id: number): boolean {
  const db = openDb(workspace);
  try {
    const result = db.prepare(`DELETE FROM suppression_memories WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Prune suppression memories with zero hits older than N days. */
export function pruneUnusedMemories(workspace: string, repo: string, maxAgeDays: number): number {
  const db = openDb(workspace);
  try {
    const result = db.prepare(
      `DELETE FROM suppression_memories
       WHERE repo = ? AND hit_count = 0 AND created_at < datetime('now', ? || ' days')`
    ).run(repo, `-${maxAgeDays}`);
    if (Number(result.changes) > 0) {
      core.info(`Suppression memories: pruned ${Number(result.changes)} unused entries older than ${maxAgeDays} days`);
    }
    return Number(result.changes);
  } catch (e) {
    core.warning(`Failed to prune suppression memories: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  } finally {
    db.close();
  }
}
