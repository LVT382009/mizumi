/**
 * Persistent Rule Engine with Auto-Discovery — competitive gap P1-3.
 *
 * Three rule sources (priority order):
 *   1. Built-in deterministic rules (rules.ts) — always run, confidence 100
 *   2. Custom user rules (.github/mizumi-rules.yml) — regex/glob patterns, confidence 90
 *   3. Auto-discovered rules (mined from SQLite suggestion history) — confidence 60-85
 *
 * Rule decay: rules with <30% acceptance over 20+ reviews lose 5 confidence/day.
 * Dead rules (<30 confidence) are automatically pruned.
 *
 * This module does NOT replace rules.ts — it extends the pipeline.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";
import { minimatch } from "minimatch";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuleSource = "custom" | "discovered";
export type RuleType = "regex" | "glob" | "pattern";

export interface PersistedRule {
  id: string;
  name: string;
  description: string;
  source: RuleSource;
  type: RuleType;
  /** Regex rule: matched against added lines. */
  pattern: string;
  /** Glob rule: files matching this path trigger the rule. */
  fileGlob?: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "compliance" | "performance" | "bug" | "style" | "architecture";
  message: string;
  confidence: number;
  /** ISO date when rule was created. */
  createdAt: string;
  /** ISO date when rule was last matched in a review. */
  lastMatchedAt: string | null;
  /** Number of times this rule has matched. */
  matchCount: number;
  /** Whether this rule is currently active. */
  enabled: boolean;
}

export interface RuleEngineResult {
  findings: import("./rules.js").RuleFinding[];
  rulesUsed: number;
  rulesSkipped: number;
  discoveredNew: number;
  decayed: number;
}

export interface CustomRulesConfig {
  rules: PersistedRule[];
}

// ---------------------------------------------------------------------------
// Custom rule loading — .github/mizumi-rules.yml
// ---------------------------------------------------------------------------

const RULES_FILENAME = "mizumi-rules.yml";

/** Parse user-defined custom rules from .github/mizumi-rules.yml. */
export function loadCustomRules(workspace: string): PersistedRule[] {
  const rulesPath = path.join(workspace, ".github", RULES_FILENAME);
  if (!fs.existsSync(rulesPath)) return [];

  try {
    const raw = fs.readFileSync(rulesPath, "utf-8");
    const parsed = parseRulesYaml(raw);
    if (!Array.isArray(parsed.rules)) return [];

    return parsed.rules
      .filter((r: Record<string, unknown>) => r.name && (r.pattern || r.file_glob))
      .map((r: Record<string, unknown>, i: number) => ({
        id: `custom-${i}`,
        name: String(r.name),
        description: String(r.description || r.name),
        source: "custom" as const,
        type: (r.type === "glob" ? "glob" : "regex") as RuleType,
        pattern: String(r.pattern),
        fileGlob: r.file_glob ? String(r.file_glob) : undefined,
        severity: validateSeverity(String(r.severity || "medium")),
        category: validateCategory(String(r.category || "bug")),
        message: String(r.message || `Custom rule: ${r.name}`),
        confidence: r.confidence ? Number(r.confidence) : 90,
        createdAt: new Date().toISOString(),
        lastMatchedAt: null,
        matchCount: 0,
        enabled: r.enabled !== false,
      }));
  } catch (e) {
    core.warning(`Failed to load custom rules: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auto-discovery — mine patterns from SQLite suggestion history
// ---------------------------------------------------------------------------

const DB_FILENAME = "mizumi-data.db";
const DISCOVERY_MIN_OCCURRENCES = 3;
const DISCOVERY_MIN_ACCEPTANCE = 0.4;

/**
 * Mine auto-discovered rules from the SQLite suggestions table.
 * A pattern becomes a discovered rule when:
 * - Same file+category appears 3+ times
 * - Acceptance rate is >= 40% (avoids learning from bad patterns)
 */
export function discoverRules(workspace: string, repo: string): PersistedRule[] {
  const dbPath = path.join(workspace, ".github", DB_FILENAME);
  if (!fs.existsSync(dbPath)) return [];

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS discovered_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'discovered',
      type TEXT NOT NULL DEFAULT 'pattern',
      pattern TEXT NOT NULL,
      file_glob TEXT,
      severity TEXT NOT NULL DEFAULT 'medium',
      category TEXT NOT NULL DEFAULT 'bug',
      message TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 70,
      created_at TEXT NOT NULL,
      last_matched_at TEXT,
      match_count INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1
    )`);

    const existing = loadDiscoveredRulesFromDb(db);
    const newRules = minePatternsFromDb(db, repo);
    const merged = mergeDiscoveredRules(existing, newRules, db);

    return merged.filter((r) => r.enabled && r.confidence >= 30);
  } catch (e) {
    core.warning(`Rule discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  } finally {
    db?.close();
  }
}

function loadDiscoveredRulesFromDb(db: DatabaseSync): PersistedRule[] {
  const query = db.prepare(`SELECT * FROM discovered_rules WHERE enabled = 1`);
  const rows = query.all() as Array<Record<string, unknown>>;
  return rows.map(rowToPersistedRule);
}

function minePatternsFromDb(db: DatabaseSync, repo: string): PersistedRule[] {
  const query = db.prepare(`
    SELECT file, category, severity,
      COUNT(*) as total,
      SUM(CASE WHEN outcome IN ('accepted', 'fixed') THEN 1 ELSE 0 END) as accepted
    FROM suggestions
    WHERE repo = ? AND outcome != 'pending'
    GROUP BY file, category
    HAVING COUNT(*) >= ? AND SUM(CASE WHEN outcome IN ('accepted', 'fixed') THEN 1 ELSE 0 END) * 1.0 / COUNT(*) >= ?
    ORDER BY total DESC
    LIMIT 20
  `);
  const rows = query.all(repo, DISCOVERY_MIN_OCCURRENCES, DISCOVERY_MIN_ACCEPTANCE) as Array<{
    file: string; category: string; severity: string;
    total: number; accepted: number;
  }>;

  return rows.map((r) => {
    const acceptanceRate = r.accepted / r.total;
    const confidence = Math.round(60 + acceptanceRate * 25);
    const dir = path.dirname(r.file);
    const ext = path.extname(r.file);
    const fileGlob = `${dir}/**${ext}`;
    const ruleId = `discovered-${r.file.replace(/[^a-z0-9]/gi, "-")}-${r.category}`;
    const basename = path.basename(r.file, ext);

    return {
      id: ruleId,
      name: `${r.category}-pattern-${basename}`,
      description: `Auto-discovered: ${r.category} issues frequently found in ${r.file} (${r.total} occurrences, ${Math.round(acceptanceRate * 100)}% accepted)`,
      source: "discovered" as const,
      type: "pattern" as RuleType,
      pattern: "",
      fileGlob,
      severity: validateSeverity(r.severity),
      category: validateCategory(r.category),
      message: `Historical pattern: ${r.category} issues are common in this file (${r.total} past findings)`,
      confidence,
      createdAt: new Date().toISOString(),
      lastMatchedAt: null,
      matchCount: r.total,
      enabled: true,
    } satisfies PersistedRule;
  });
}

function mergeDiscoveredRules(
  existing: PersistedRule[],
  mined: PersistedRule[],
  db: DatabaseSync
): PersistedRule[] {
  const existingMap = new Map(existing.map((r) => [r.id, r]));

  for (const rule of mined) {
    if (existingMap.has(rule.id)) {
      const existing_rule = existingMap.get(rule.id)!;
      existing_rule.confidence = rule.confidence;
      existing_rule.matchCount = rule.matchCount;
      existing_rule.description = rule.description;
      existing_rule.message = rule.message;

      const update = db.prepare(`
        UPDATE discovered_rules
        SET confidence = ?, match_count = ?, description = ?, message = ?
        WHERE id = ?
      `);
      update.run(rule.confidence, rule.matchCount, rule.description, rule.message, rule.id);
    } else {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO discovered_rules
        (id, name, description, source, type, pattern, file_glob, severity, category,
         message, confidence, created_at, last_matched_at, match_count, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      insert.run(
        rule.id, rule.name, rule.description, rule.source, rule.type,
        rule.pattern, rule.fileGlob || null, rule.severity, rule.category,
        rule.message, rule.confidence, rule.createdAt, null, rule.matchCount
      );
      existingMap.set(rule.id, rule);
    }
  }

  return [...existingMap.values()];
}

// ---------------------------------------------------------------------------
// Rule decay — reduce confidence of rules with low acceptance
// ---------------------------------------------------------------------------

const DECAY_MIN_REVIEWS = 20;
const DECAY_LOW_ACCEPTANCE = 0.3;
const DECAY_RATE = 5;

/**
 * Apply decay to rules whose category has low acceptance rate.
 * Rules lose 5 confidence/day when their category has <30% acceptance
 * over 20+ resolved suggestions. Decayed rules below 30 confidence
 * are auto-disabled.
 */
export function applyRuleDecay(
  rules: PersistedRule[],
  workspace: string,
  repo: string
): { rules: PersistedRule[]; decayed: number } {
  let decayed = 0;
  const dbPath = path.join(workspace, ".github", DB_FILENAME);
  if (!fs.existsSync(dbPath)) return { rules, decayed };

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    const categoryStats = getCategoryDecayStats(db, repo);
    const now = Date.now();

    const updated = rules.map((rule) => {
      if (rule.source !== "discovered") return rule;

      const stats = categoryStats[rule.category];
      if (!stats || stats.total < DECAY_MIN_REVIEWS || stats.rate >= DECAY_LOW_ACCEPTANCE) {
        return rule;
      }

      const lastMatch = rule.lastMatchedAt
        ? new Date(rule.lastMatchedAt).getTime()
        : new Date(rule.createdAt).getTime();
      const daysSinceMatch = Math.floor((now - lastMatch) / (1000 * 60 * 60 * 24));

      const decayAmount = Math.min(daysSinceMatch * DECAY_RATE, 50);
      const newConfidence = Math.max(rule.confidence - decayAmount, 0);

      if (newConfidence < 30) {
        decayed++;
        const upd = db!.prepare(`UPDATE discovered_rules SET enabled = 0, confidence = ? WHERE id = ?`);
        upd.run(newConfidence, rule.id);
        return { ...rule, confidence: newConfidence, enabled: false };
      }

      if (decayAmount > 0) {
        decayed++;
        const upd = db!.prepare(`UPDATE discovered_rules SET confidence = ? WHERE id = ?`);
        upd.run(newConfidence, rule.id);
        return { ...rule, confidence: newConfidence };
      }

      return rule;
    });

    return { rules: updated, decayed };
  } catch (e) {
    core.warning(`Rule decay failed: ${e instanceof Error ? e.message : String(e)}`);
    return { rules, decayed };
  } finally {
    db?.close();
  }
}

function getCategoryDecayStats(
  db: DatabaseSync,
  repo: string
): Record<string, { total: number; rate: number }> {
  const query = db.prepare(`
    SELECT category,
      COUNT(*) as total,
      SUM(CASE WHEN outcome IN ('accepted', 'fixed') THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as rate
    FROM suggestions
    WHERE repo = ? AND outcome != 'pending'
    GROUP BY category
  `);
  const rows = query.all(repo) as Array<{ category: string; total: number; rate: number }>;
  const result: Record<string, { total: number; rate: number }> = {};
  for (const r of rows) {
    result[r.category] = { total: r.total, rate: r.rate };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Run engine — execute custom + discovered rules on diff
// ---------------------------------------------------------------------------

/**
 * Run the persistent rule engine on diff files.
 * Returns findings from custom and discovered rules.
 * Does NOT replace rules.ts — this is an additional pipeline stage.
 */
export function runRuleEngine(
  files: DiffFile[],
  customRules: PersistedRule[],
  discoveredRules: PersistedRule[]
): import("./rules.js").RuleFinding[] {
  const findings: import("./rules.js").RuleFinding[] = [];
  const allRules = [...customRules, ...discoveredRules].filter((r) => r.enabled && r.confidence >= 30);

  for (const rule of allRules) {
    for (const file of files) {
      if (rule.fileGlob && !minimatch(file.path, rule.fileGlob)) continue;

      if (rule.type === "regex" && rule.pattern) {
        let regex: RegExp;
        try {
          regex = new RegExp(rule.pattern, "i");
        } catch {
          continue;
        }

        for (const hunk of file.hunks) {
          for (const change of hunk.changes) {
            if (change.type === "add" && regex.test(change.content)) {
              findings.push({
                file: file.path,
                line: change.line,
                severity: rule.severity,
                category: rule.category,
                message: rule.message,
                rule: rule.name,
              });
            }
          }
        }
      }

      if ((rule.type === "pattern" || rule.type === "glob") && rule.fileGlob) {
        if (minimatch(file.path, rule.fileGlob)) {
          const firstAdd = file.hunks[0]?.changes.find((c) => c.type === "add");
          findings.push({
            file: file.path,
            line: firstAdd?.line ?? 1,
            severity: rule.severity,
            category: rule.category,
            message: rule.message,
            rule: rule.name,
          });
        }
      }
    }
  }

  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Update rule match stats after review
// ---------------------------------------------------------------------------

/** Update lastMatchedAt and matchCount for rules that produced findings. */
export function updateRuleMatchStats(
  workspace: string,
  findings: import("./rules.js").RuleFinding[],
  customRules: PersistedRule[],
  discoveredRules: PersistedRule[]
): void {
  const allRules = [...customRules, ...discoveredRules];
  const matchedRuleNames = new Set(findings.map((f) => f.rule));

  const dbPath = path.join(workspace, ".github", DB_FILENAME);
  if (!fs.existsSync(dbPath)) return;

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    for (const rule of allRules) {
      if (!matchedRuleNames.has(rule.name) || rule.source !== "discovered") continue;
      const upd = db.prepare(`
        UPDATE discovered_rules
        SET last_matched_at = datetime('now'), match_count = match_count + 1
        WHERE id = ?
      `);
      upd.run(rule.id);
    }
  } catch {
    // Non-critical
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// Full engine pipeline
// ---------------------------------------------------------------------------

/** Full rule engine pipeline: load custom, discover, decay, run, update. */
export function executeRuleEngine(
  files: DiffFile[],
  workspace: string,
  repo: string
): RuleEngineResult {
  // 1. Load custom rules
  const customRules = loadCustomRules(workspace);
  core.info(`Rule engine: ${customRules.length} custom rule(s) loaded`);

  // 2. Discover rules from history
  const discoveredRules = discoverRules(workspace, repo);
  const newDiscovered = discoveredRules.filter(
    (r) => r.source === "discovered" && r.enabled
  ).length;
  core.info(`Rule engine: ${newDiscovered} discovered rule(s) active`);

  // 3. Apply decay
  const { rules: decayedRules, decayed } = applyRuleDecay(
    discoveredRules, workspace, repo
  );
  if (decayed > 0) {
    core.info(`Rule engine: ${decayed} rule(s) decayed`);
  }

  // 4. Run engine
  const activeDiscovered = decayedRules.filter((r) => r.enabled);
  const findings = runRuleEngine(files, customRules, activeDiscovered);

  const rulesUsed = customRules.length + activeDiscovered.length;
  const rulesSkipped = customRules.filter((r) => !r.enabled).length
    + decayedRules.filter((r) => !r.enabled).length;

  // 5. Update match stats
  updateRuleMatchStats(workspace, findings, customRules, activeDiscovered);

  return {
    findings,
    rulesUsed,
    rulesSkipped,
    discoveredNew: newDiscovered,
    decayed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = ["critical", "high", "medium", "low"] as const;
const VALID_CATEGORIES = ["security", "compliance", "performance", "bug", "style", "architecture"] as const;

function validateSeverity(s: string): PersistedRule["severity"] {
  return (VALID_SEVERITIES as readonly string[]).includes(s)
    ? (s as PersistedRule["severity"]) : "medium";
}

function validateCategory(s: string): PersistedRule["category"] {
  return (VALID_CATEGORIES as readonly string[]).includes(s)
    ? (s as PersistedRule["category"]) : "bug";
}

function rowToPersistedRule(row: Record<string, unknown>): PersistedRule {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    source: String(row.source) as RuleSource,
    type: String(row.type) as RuleType,
    pattern: String(row.pattern),
    fileGlob: row.file_glob ? String(row.file_glob) : undefined,
    severity: validateSeverity(String(row.severity)),
    category: validateCategory(String(row.category)),
    message: String(row.message),
    confidence: Number(row.confidence),
    createdAt: String(row.created_at),
    lastMatchedAt: row.last_matched_at ? String(row.last_matched_at) : null,
    matchCount: Number(row.match_count),
    enabled: Boolean(row.enabled),
  };
}

/** Minimal YAML parser for mizumi-rules.yml (list-of-objects structure). */
export function parseRulesYaml(text: string): { rules?: Record<string, unknown>[] } {
  const result: { rules?: Record<string, unknown>[] } = {};
  const lines = text.split("\n");
  let currentRule: Record<string, unknown> | null = null;
  let inRulesArray = false;
  let rulesKey = -1;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed === "rules:" || trimmed.startsWith("rules:")) {
      inRulesArray = true;
      rulesKey = indent;
      result.rules = [];
      continue;
    }

    if (!inRulesArray) continue;

    if (trimmed.startsWith("- ")) {
      currentRule = {};
      result.rules!.push(currentRule);
      const rest = trimmed.slice(2).trim();
      const colonIdx = rest.indexOf(":");
      if (colonIdx > 0) {
        const key = rest.slice(0, colonIdx).trim();
        const value = rest.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (currentRule) currentRule[key] = parseValue(value);
      }
      continue;
    }

    if (indent <= rulesKey) {
      inRulesArray = false;
      currentRule = null;
      continue;
    }

    if (currentRule) {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
        currentRule[key] = parseValue(value);
      }
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (!isNaN(Number(value)) && value !== "") return Number(value);
  return value;
}
