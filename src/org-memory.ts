/**
 * Organizational Memory — PR History Semantic Index
 *
 * Competitive gap (rank #2): No AI code reviewer indexes past PRs for
 * cross-review learning. CodeRabbit only has per-session memory; Greptile
 * has repo embedding but no PR-level retrieval.
 *
 * Mizumi already has SQLite (db.ts) for suggestion outcomes. This module
 * extends that infrastructure with:
 * 1. pr_history table — stores PR summaries, file paths, key findings
 * 2. File-path overlap retrieval — find past PRs that touched same files
 * 3. Organizational context injection — tell the LLM what happened before
 *
 * When a new PR touches src/auth.ts, Mizumi can say:
 * "5 previous PRs touched this file. 3 had SQL injection findings (2 dismissed,
 * 1 accepted). Common pattern: missing parameterized queries."
 *
 * This is Jaccard-similarity on file paths, not vector embeddings — zero
 * external deps, runs in GitHub Actions.
 */
import * as core from "@actions/core";
import * as path from "node:path";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PRHistoryEntry {
  id: number;
  repo: string;
  prNumber: number;
  title: string;
  /** Comma-joined file paths touched by this PR */
  files: string;
  /** Space-joined finding categories (e.g. "security bug security") */
  findingCategories: string;
  /** Number of findings posted */
  findingCount: number;
  /** Risk score 1-5 */
  riskScore: number;
  /** Human-readable summary of key findings */
  summary: string;
  /** ISO timestamp */
  reviewedAt: string;
}

export interface SimilarPR {
  prNumber: number;
  title: string;
  /** Jaccard similarity (0-1) based on file path overlap */
  similarity: number;
  /** Number of overlapping files */
  overlapCount: number;
  /** Files in common */
  overlappingFiles: string[];
  /** Key findings from that PR */
  summary: string;
  /** Finding categories with counts */
  topCategories: string[];
  /** Risk score of that PR */
  riskScore: number;
}

export interface OrgMemoryResult {
  /** Similar past PRs, sorted by similarity (highest first) */
  similarPRs: SimilarPR[];
  /** Total PRs in the history index */
  totalIndexed: number;
  /** Context string for LLM injection */
  contextText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_FILENAME = "mizumi-data.db";

/** Maximum similar PRs to return */
const MAX_SIMILAR_PRS = 5;

/** Minimum Jaccard similarity to include (avoid noise) */
const MIN_SIMILARITY = 0.1;

/** Maximum summary length stored in DB */
const MAX_SUMMARY_LEN = 500;

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
    CREATE TABLE IF NOT EXISTS pr_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '',
      finding_categories TEXT NOT NULL DEFAULT '',
      finding_count INTEGER NOT NULL DEFAULT 0,
      risk_score INTEGER NOT NULL DEFAULT 1,
      summary TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_history_repo ON pr_history(repo)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_history_repo_pr ON pr_history(repo, pr_number)`);

  return db;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Record a PR review into the organizational memory index. */
export function recordPRHistory(
  workspace: string,
  repo: string,
  prNumber: number,
  title: string,
  files: string[],
  findings: Array<{ category: string; severity: string; message: string }>,
  riskScore: number
): void {
  const db = openDb(workspace);
  try {
    // Upsert: delete previous entry for same repo+pr, then insert
    const del = db.prepare(`DELETE FROM pr_history WHERE repo = ? AND pr_number = ?`);
    del.run(repo, prNumber);

    const filesStr = files.join(",");
    const categories = findings.map((f) => f.category).join(" ");
    const findingCount = findings.length;

    // Build summary from top-5 findings by severity
    const severityOrder = ["critical", "high", "medium", "low", "nitpick"];
    const sorted = [...findings].sort((a, b) =>
      severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)
    );
    const summary = sorted.slice(0, 5).map((f) =>
      `[${f.severity}] ${f.category}: ${f.message.slice(0, 80)}`
    ).join("; ");

    const insert = db.prepare(
      `INSERT INTO pr_history (repo, pr_number, title, files, finding_categories, finding_count, risk_score, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      repo, prNumber, title.slice(0, 200),
      filesStr, categories, findingCount,
      riskScore, summary.slice(0, MAX_SUMMARY_LEN)
    );

    core.info(`Org memory: recorded PR #${prNumber} (${files.length} files, ${findingCount} findings)`);
  } catch (e) {
    core.warning(`Failed to record PR history: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    db.close();
  }
}

/**
 * Retrieve similar past PRs based on file path overlap (Jaccard similarity).
 * Files are tokenized by path segments for better matching:
 * "src/auth/login.ts" matches "src/auth/logout.ts" (2/4 segments overlap).
 */
export function retrieveSimilarPRs(
  workspace: string,
  repo: string,
  currentFiles: string[],
  excludePrNumber?: number
): SimilarPR[] {
  if (currentFiles.length === 0) return [];

  const db = openDb(workspace);
  try {
    const query = db.prepare(
      `SELECT pr_number, title, files, finding_categories, finding_count, risk_score, summary
       FROM pr_history
       WHERE repo = ?`
    );
    const rows = query.all(repo) as Array<{
      pr_number: number;
      title: string;
      files: string;
      finding_categories: string;
      finding_count: number;
      risk_score: number;
      summary: string;
    }>;

    const currentSet = new Set(currentFiles);
    // Also build segment-level sets for partial path matching
    const currentSegments = new Set<string>();
    for (const f of currentFiles) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) {
        currentSegments.add(parts.slice(0, i).join("/"));
      }
    }

    const results: SimilarPR[] = [];

    for (const row of rows) {
      if (excludePrNumber && row.pr_number === excludePrNumber) continue;

      const pastFiles = row.files ? row.files.split(",").filter(Boolean) : [];
      if (pastFiles.length === 0) continue;

      // Exact file overlap
      const overlappingFiles = pastFiles.filter((f) => currentSet.has(f));
      // Directory-level overlap (shared path prefixes)
      let dirOverlap = 0;
      for (const f of pastFiles) {
        if (currentSet.has(f)) continue; // Already counted
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++) {
          if (currentSegments.has(parts.slice(0, i).join("/"))) {
            dirOverlap++;
            break;
          }
        }
      }

      // Jaccard: exact overlap gets full weight, dir overlap gets 0.3 weight
      const union = new Set([...currentFiles, ...pastFiles]).size;
      if (union === 0) continue;

      const weightedOverlap = overlappingFiles.length + dirOverlap * 0.3;
      const similarity = weightedOverlap / union;

      if (similarity < MIN_SIMILARITY) continue;

      // Extract top categories
      const catStr = row.finding_categories || "";
      const catCounts = new Map<string, number>();
      for (const c of catStr.split(" ").filter(Boolean)) {
        catCounts.set(c, (catCounts.get(c) || 0) + 1);
      }
      const topCategories = [...catCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cat]) => cat);

      results.push({
        prNumber: row.pr_number,
        title: row.title,
        similarity: Math.round(similarity * 100) / 100,
        overlapCount: overlappingFiles.length,
        overlappingFiles,
        summary: row.summary,
        topCategories,
        riskScore: row.risk_score,
      });
    }

    // Sort by similarity (highest first), then by overlap count
    results.sort((a, b) => b.similarity - a.similarity || b.overlapCount - a.overlapCount);

    return results.slice(0, MAX_SIMILAR_PRS);
  } catch (e) {
    core.warning(`Failed to retrieve similar PRs: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Build organizational memory context for LLM injection.
 * Tells the reviewer what happened in similar past PRs.
 */
export function buildOrgMemoryContext(result: OrgMemoryResult): string {
  if (result.similarPRs.length === 0) return "";

  let ctx = `## Organizational Memory (${result.similarPRs.length} similar past PR(s), ${result.totalIndexed} indexed)\n`;
  ctx += "Previous PRs that touched the same files had these patterns. Use this context to avoid repeating dismissed findings and to emphasize patterns that were accepted:\n\n";

  for (const pr of result.similarPRs) {
    ctx += `### PR #${pr.prNumber}: ${pr.title || "(no title)"}\n`;
    ctx += `- **Similarity**: ${Math.round(pr.similarity * 100)}% (${pr.overlapCount} file(s) in common)\n`;
    if (pr.overlappingFiles.length > 0) {
      const filesList = pr.overlappingFiles.slice(0, 8).join(", ");
      ctx += `- **Shared files**: ${filesList}${pr.overlappingFiles.length > 8 ? ` +${pr.overlappingFiles.length - 8} more` : ""}\n`;
    }
    if (pr.topCategories.length > 0) {
      ctx += `- **Finding categories**: ${pr.topCategories.join(", ")}\n`;
    }
    if (pr.summary) {
      ctx += `- **Key findings**: ${pr.summary}\n`;
    }
    ctx += `- **Risk score**: ${pr.riskScore}/5\n\n`;
  }

  return ctx.trim();
}

/**
 * Run the full organizational memory pipeline.
 * Retrieve similar PRs and format for context injection.
 */
export function runOrgMemoryRetrieval(
  workspace: string,
  repo: string,
  currentFiles: string[],
  currentPrNumber?: number
): OrgMemoryResult {
  const similarPRs = retrieveSimilarPRs(workspace, repo, currentFiles, currentPrNumber);

  // Count total indexed PRs
  let totalIndexed = 0;
  const db = openDb(workspace);
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM pr_history WHERE repo = ?`).get(repo) as { cnt: number } | undefined;
    totalIndexed = row?.cnt ?? 0;
  } catch {
    // Non-critical
  } finally {
    db.close();
  }

  const contextText = buildOrgMemoryContext({ similarPRs, totalIndexed, contextText: "" });

  if (similarPRs.length > 0) {
    core.info(`Org memory: ${similarPRs.length} similar PR(s) found (top: PR #${similarPRs[0].prNumber}, similarity=${similarPRs[0].similarity})`);
  }

  return { similarPRs, totalIndexed, contextText };
}

/** Get the count of indexed PRs for a repo. */
export function getIndexedCount(workspace: string, repo: string): number {
  const db = openDb(workspace);
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM pr_history WHERE repo = ?`).get(repo) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** Prune PR history entries older than N days. */
export function pruneOldHistory(workspace: string, repo: string, maxAgeDays: number): number {
  const db = openDb(workspace);
  try {
    const result = db.prepare(
      `DELETE FROM pr_history WHERE repo = ? AND reviewed_at < datetime('now', ? || ' days')`
    ).run(repo, `-${maxAgeDays}`);
    if (result.changes > 0) {
      core.info(`Org memory: pruned ${result.changes} entries older than ${maxAgeDays} days`);
    }
    return Number(result.changes);
  } catch (e) {
    core.warning(`Failed to prune PR history: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  } finally {
    db.close();
  }
}
