/**
 * SQLite feedback tracker — stores suggestion outcomes and drives learning weights.
 * Uses Node.js 24 built-in node:sqlite (no native dependency).
 *
 * Phase 2.6: suggestions table for persistent feedback history
 * Phase 2.7: learning weights — auto-lower severity for <30% acceptance, auto-raise for >90%
 */
import * as core from "@actions/core";
import * as path from "node:path";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DB_FILENAME = "mizumi-data.db";

export interface SuggestionRecord {
  id: number;
  repo: string;
  file: string;
  line: number;
  category: string;
  severity: string;
  messageHash: string;
  outcome: "pending" | "accepted" | "dismissed" | "fixed";
  createdAt: string;
}

export interface CategoryStats {
  category: string;
  total: number;
  accepted: number;
  acceptanceRate: number;
}

function getDbPath(workspace: string): string {
  return path.join(workspace, ".github", DB_FILENAME);
}

function openDb(workspace: string): DatabaseSync {
  const dbPath = getDbPath(workspace);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      message_hash TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_repo_cat ON suggestions(repo, category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_suggestions_hash ON suggestions(message_hash)`);

  return db;
}

/** Record a new suggestion from a review. */
export function recordSuggestion(
  workspace: string,
  repo: string,
  file: string,
  line: number,
  category: string,
  severity: string,
  message: string
): void {
  const db = openDb(workspace);
  try {
    const messageHash = hashMessage(message);
    const insert = db.prepare(
      `INSERT INTO suggestions (repo, file, line, category, severity, message_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insert.run(repo, file, line, category, severity, messageHash);
    core.info(`Feedback: recorded suggestion for ${file}:${line} [${category}]`);
  } catch (e) {
    core.warning(`Failed to record suggestion: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db.close();
  }
}

/** Update suggestion outcome (accepted, dismissed, fixed). */
export function updateOutcome(
  workspace: string,
  messageHash: string,
  outcome: "accepted" | "dismissed" | "fixed"
): void {
  const db = openDb(workspace);
  try {
    const update = db.prepare(
      `UPDATE suggestions SET outcome = ? WHERE message_hash = ? AND outcome = 'pending'`
    );
    const result = update.run(outcome, messageHash);
    if (result.changes > 0) {
      core.info(`Feedback: updated ${result.changes} suggestion(s) to ${outcome}`);
    }
  } catch (e) {
    core.warning(`Failed to update outcome: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db.close();
  }
}

/** Get acceptance rate stats per category for a repo. */
export function getCategoryStats(workspace: string, repo: string): CategoryStats[] {
  const db = openDb(workspace);
  try {
    const query = db.prepare(`
      SELECT category,
             COUNT(*) as total,
             SUM(CASE WHEN outcome IN ('accepted', 'fixed') THEN 1 ELSE 0 END) as accepted
      FROM suggestions
      WHERE repo = ? AND outcome != 'pending'
      GROUP BY category
    `);
    const rows = query.all(repo) as Array<{ category: string; total: number; accepted: number }>;
    return rows.map((r) => ({
      category: r.category,
      total: r.total,
      accepted: r.accepted,
      acceptanceRate: r.total > 0 ? r.accepted / r.total : 0,
    }));
  } catch (e) {
    core.warning(`Failed to get category stats: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Compute learning weights — adjusts severity based on acceptance rates.
 * <30% acceptance → auto-lower severity (demote category findings)
 * >90% acceptance → auto-raise severity (promote category findings)
 * Returns a map of category → "demote" | "promote" | "neutral"
 */
export function computeLearningWeights(
  workspace: string,
  repo: string
): Record<string, "demote" | "promote" | "neutral"> {
  const stats = getCategoryStats(workspace, repo);
  const weights: Record<string, "demote" | "promote" | "neutral"> = {};

  for (const s of stats) {
    if (s.total < 5) {
      weights[s.category] = "neutral"; // Not enough data
    } else if (s.acceptanceRate < 0.3) {
      weights[s.category] = "demote";
    } else if (s.acceptanceRate > 0.9) {
      weights[s.category] = "promote";
    } else {
      weights[s.category] = "neutral";
    }
  }

  return weights;
}

/** Apply learning weights to adjust finding severities. */
export function applyLearningWeights(
  findings: Array<{ severity: string; category: string; confidence: number }>,
  weights: Record<string, "demote" | "promote" | "neutral">
): Array<{ severity: string; category: string; confidence: number }> {
  const severityOrder = ["nitpick", "low", "medium", "high", "critical"] as const;

  return findings.map((f) => {
    const action = weights[f.category];
    if (!action || action === "neutral") return f;

    if (action === "demote") {
      const idx = severityOrder.indexOf(f.severity as any);
      if (idx > 0) {
        return { ...f, severity: severityOrder[idx - 1], confidence: Math.max(f.confidence - 10, 0) };
      }
    }

    if (action === "promote") {
      const idx = severityOrder.indexOf(f.severity as any);
      if (idx < severityOrder.length - 1) {
        return { ...f, severity: severityOrder[idx + 1], confidence: Math.min(f.confidence + 10, 100) };
      }
    }

    return f;
  });
}

/** Simple hash for message dedup — fast, non-cryptographic. */
function hashMessage(message: string): string {
  let hash = 0;
  for (let i = 0; i < message.length; i++) {
    const chr = message.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit int
  }
  return Math.abs(hash).toString(36);
}
