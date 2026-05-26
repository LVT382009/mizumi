import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  loadCustomRules,
  discoverRules,
  runRuleEngine,
  applyRuleDecay,
  updateRuleMatchStats,
  executeRuleEngine,
  parseRulesYaml,
  type PersistedRule,
} from "../rule-engine.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rule-test-"));
  const githubDir = path.join(dir, ".github");
  fs.mkdirSync(githubDir, { recursive: true });
  return dir;
}

function addFile(
  filePath: string,
  addLines: string[],
  startLine = 1
): DiffFile {
  return {
    path: filePath,
    status: "added",
    additions: addLines.length,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: startLine,
        newLines: addLines.length,
        content: "",
        changes: addLines.map((content, i) => ({
          type: "add" as const,
          line: startLine + i,
          oldLine: 0,
          content,
        })),
      },
    ],
  };
}

function makeCustomRule(overrides: Partial<PersistedRule> = {}): PersistedRule {
  return {
    id: "test-rule-1",
    name: "test-rule",
    description: "Test rule",
    source: "custom",
    type: "regex",
    pattern: "console\\.log",
    severity: "low",
    category: "style",
    message: "Avoid console.log",
    confidence: 90,
    createdAt: new Date().toISOString(),
    lastMatchedAt: null,
    matchCount: 0,
    enabled: true,
    ...overrides,
  };
}

function seedSuggestions(db: DatabaseSync, repo: string, entries: Array<{ file: string; category: string; severity: string; outcome: string }>) {
  const insert = db.prepare(
    "INSERT INTO suggestions (repo, file, line, category, severity, message_hash, outcome) VALUES (?, ?, 1, ?, ?, ?, ?)"
  );
  for (const e of entries) {
    insert.run(repo, e.file, e.category, e.severity, "hash-" + e.file + "-" + e.category, e.outcome);
  }
}

function writeRulesYaml(dir: string, content: string) {
  fs.writeFileSync(path.join(dir, ".github", "mizumi-rules.yml"), content);
}

// ---------------------------------------------------------------------------
// parseRulesYaml
// ---------------------------------------------------------------------------

describe("parseRulesYaml", () => {
  it("parses simple rules list", () => {
    const yaml = [
      "rules:",
      "  - name: no-console",
      "    pattern: console",
      "    severity: low",
      "    category: style",
      "    message: No console",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
    expect(result.rules![0].name).toBe("no-console");
    expect(result.rules![0].severity).toBe("low");
  });

  it("parses multiple rules", () => {
    const yaml = [
      "rules:",
      "  - name: rule1",
      "    pattern: a",
      "    severity: high",
      "  - name: rule2",
      "    pattern: b",
      "    severity: low",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(2);
  });

  it("parses boolean values", () => {
    const yaml = [
      "rules:",
      "  - name: disabled-rule",
      "    pattern: x",
      "    enabled: false",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules![0].enabled).toBe(false);
  });

  it("parses numeric values", () => {
    const yaml = [
      "rules:",
      "  - name: with-confidence",
      "    pattern: y",
      "    confidence: 75",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules![0].confidence).toBe(75);
  });

  it("handles empty YAML", () => {
    const result = parseRulesYaml("");
    expect(result.rules).toBeUndefined();
  });

  it("skips comments", () => {
    const yaml = [
      "# This is a comment",
      "rules:",
      "  - name: test",
      "    pattern: z",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
  });

  it("parses file_glob field", () => {
    const yaml = [
      "rules:",
      "  - name: src-only",
      "    pattern: eval",
      "    file_glob: src/**/*.ts",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules![0].file_glob).toBe("src/**/*.ts");
  });

  it("handles dash with inline key-value", () => {
    const yaml = [
      "rules:",
      "  - name: inline-rule",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
    expect(result.rules![0].name).toBe("inline-rule");
  });

  it("handles quoted values", () => {
    const yaml = [
      "rules:",
      '  - name: "quoted-name"',
      '    pattern: "quoted-pattern"',
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules![0].name).toBe("quoted-name");
  });

  it("exits array on dedent", () => {
    const yaml = [
      "rules:",
      "  - name: rule1",
      "    pattern: a",
      "other_key: value",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadCustomRules
// ---------------------------------------------------------------------------

describe("loadCustomRules", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns empty array when no rules file exists", () => {
    expect(loadCustomRules(tmpDir)).toEqual([]);
  });

  it("loads custom rules from .github/mizumi-rules.yml", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: no-console",
      "    pattern: console",
      "    severity: low",
      "    category: style",
      "    message: Avoid console",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("no-console");
    expect(rules[0].source).toBe("custom");
    expect(rules[0].type).toBe("regex");
    expect(rules[0].category).toBe("style");
  });

  it("defaults severity to medium when not specified", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: test",
      "    pattern: x",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules[0].severity).toBe("medium");
  });

  it("defaults category to bug when not specified", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: test",
      "    pattern: x",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules[0].category).toBe("bug");
  });

  it("defaults confidence to 90 when not specified", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: test",
      "    pattern: x",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules[0].confidence).toBe(90);
  });

  it("skips rules without name", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - pattern: x",
      "    severity: low",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it("skips rules without pattern", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: empty-rule",
      "    severity: low",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules).toHaveLength(0);
  });

  it("handles corrupted YAML gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, ".github", "mizumi-rules.yml"), "{{invalid yaml");
    const rules = loadCustomRules(tmpDir);
    expect(Array.isArray(rules)).toBe(true);
  });

  it("sets custom confidence from YAML", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: confident-rule",
      "    pattern: x",
      "    confidence: 60",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules[0].confidence).toBe(60);
  });

  it("handles glob type rules", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: json-check",
      "    pattern: \"\"",
      "    type: glob",
      "    file_glob: src/**/*.json",
    ].join("\n"));
    const rules = loadCustomRules(tmpDir);
    expect(rules[0].type).toBe("glob");
    expect(rules[0].fileGlob).toBe("src/**/*.json");
  });
});

// ---------------------------------------------------------------------------
// discoverRules
// ---------------------------------------------------------------------------

describe("discoverRules", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns empty when no DB exists", () => {
    expect(discoverRules(tmpDir, "test/repo")).toEqual([]);
  });

  it("discovers rules from suggestion history", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    seedSuggestions(db, "test/repo", [
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
    ]);
    db.close();

    const rules = discoverRules(tmpDir, "test/repo");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].source).toBe("discovered");
    expect(rules[0].type).toBe("pattern");
    expect(rules[0].category).toBe("security");
  });

  it("does not discover rules with too few occurrences", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // Only 2 occurrences, below threshold of 3
    seedSuggestions(db, "test/repo", [
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
    ]);
    db.close();

    const rules = discoverRules(tmpDir, "test/repo");
    expect(rules.every((r) => r.source !== "discovered" || r.matchCount >= 3)).toBe(true);
  });

  it("does not discover rules with low acceptance rate", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    seedSuggestions(db, "test/repo", [
      { file: "src/style.ts", category: "style", severity: "low", outcome: "dismissed" },
      { file: "src/style.ts", category: "style", severity: "low", outcome: "dismissed" },
      { file: "src/style.ts", category: "style", severity: "low", outcome: "dismissed" },
      { file: "src/style.ts", category: "style", severity: "low", outcome: "dismissed" },
      { file: "src/style.ts", category: "style", severity: "low", outcome: "accepted" },
    ]);
    db.close();

    // 1/5 = 20% acceptance, below 40% threshold
    const rules = discoverRules(tmpDir, "test/repo");
    expect(rules.some((r) => r.fileGlob?.includes("style"))).toBe(false);
  });

  it("computes confidence based on acceptance rate", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // 4 accepted, 1 dismissed = 80% acceptance => confidence = 60 + 0.8*25 = 80
    seedSuggestions(db, "test/repo", [
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "dismissed" },
    ]);
    db.close();

    const rules = discoverRules(tmpDir, "test/repo");
    const discoveredRule = rules.find((r) => r.source === "discovered");
    expect(discoveredRule).toBeDefined();
    expect(discoveredRule!.confidence).toBe(80);
  });

  it("persists discovered rules to DB", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    seedSuggestions(db, "test/repo", [
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
      { file: "src/auth.ts", category: "security", severity: "high", outcome: "accepted" },
    ]);
    db.close();

    discoverRules(tmpDir, "test/repo");

    // Verify the rule was persisted
    const db2 = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    const rows = db2.prepare("SELECT * FROM discovered_rules").all();
    db2.close();
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runRuleEngine
// ---------------------------------------------------------------------------

describe("runRuleEngine", () => {
  it("finds regex pattern matches in added lines", () => {
    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const rules = [makeCustomRule({ pattern: "console\\.log", name: "no-console" })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-console");
    expect(findings[0].file).toBe("src/app.ts");
  });

  it("does not match deleted lines", () => {
    const file: DiffFile = {
      path: "src/app.ts", status: "modified", additions: 0, deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, content: "",
        changes: [{ type: "delete", line: 0, oldLine: 1, content: "console.log('removed')" }],
      }],
    };
    const rules = [makeCustomRule({ pattern: "console\\.log" })];
    const findings = runRuleEngine([file], rules, []);
    expect(findings).toHaveLength(0);
  });

  it("respects file_glob filter", () => {
    const files = [addFile("test/app.ts", ["console.log('debug')"])];
    const rules = [makeCustomRule({ pattern: "console\\.log", fileGlob: "src/**/*.ts" })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(0);
  });

  it("matches files that pass file_glob filter", () => {
    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const rules = [makeCustomRule({ pattern: "console\\.log", fileGlob: "src/**/*.ts" })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(1);
  });

  it("runs pattern type rules on matching file globs", () => {
    const files = [addFile("src/auth/login.ts", ["export function login() {}"])];
    const discoveredRules: PersistedRule[] = [{
      id: "discovered-test", name: "security-pattern-auth",
      description: "Security issues common in auth files",
      source: "discovered", type: "pattern", pattern: "",
      fileGlob: "src/auth/**", severity: "medium", category: "security",
      message: "Security pattern: auth file modified",
      confidence: 70, createdAt: new Date().toISOString(),
      lastMatchedAt: null, matchCount: 5, enabled: true,
    }];
    const findings = runRuleEngine(files, [], discoveredRules);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("security-pattern-auth");
  });

  it("skips disabled rules", () => {
    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const rules = [makeCustomRule({ pattern: "console\\.log", enabled: false })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(0);
  });

  it("skips rules with confidence below 30", () => {
    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const rules = [makeCustomRule({ pattern: "console\\.log", confidence: 25 })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(0);
  });

  it("deduplicates findings by file:line:rule", () => {
    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const rules = [
      makeCustomRule({ pattern: "console\\.log", name: "no-console-1" }),
      makeCustomRule({ pattern: "console\\.log", name: "no-console-2" }),
    ];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(2); // Different rule names
  });

  it("finds multiple lines from same rule", () => {
    const files = [addFile("src/app.ts", ["console.log('a')", "console.log('b')"])];
    const rules = [makeCustomRule({ pattern: "console\\.log" })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(2);
  });

  it("handles invalid regex gracefully", () => {
    const files = [addFile("src/app.ts", ["some code"])];
    const rules = [makeCustomRule({ pattern: "[invalid", name: "bad-regex" })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(0);
  });

  it("returns empty for empty files", () => {
    const rules = [makeCustomRule()];
    const findings = runRuleEngine([], rules, []);
    expect(findings).toHaveLength(0);
  });

  it("handles glob type rules", () => {
    const files = [addFile("src/config.json", ["{}"])];
    const rules: PersistedRule[] = [makeCustomRule({
      type: "glob", pattern: "", fileGlob: "src/**/*.json", name: "json-config",
    })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings).toHaveLength(1);
  });

  it("sets correct severity and category from rule", () => {
    const files = [addFile("src/app.ts", ["eval('code')"])];
    const rules = [makeCustomRule({ pattern: "eval\\(", name: "no-eval", severity: "critical", category: "security" })];
    const findings = runRuleEngine(files, rules, []);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("security");
  });

  it("combines custom and discovered rules", () => {
    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const custom = [makeCustomRule({ pattern: "console\\.log", name: "custom-console" })];
    const discovered: PersistedRule[] = [{
      id: "disc-1", name: "disc-console", description: "Discovered: console pattern",
      source: "discovered", type: "regex", pattern: "console\\.log",
      severity: "low", category: "style", message: "Console pattern",
      confidence: 70, createdAt: new Date().toISOString(),
      lastMatchedAt: null, matchCount: 3, enabled: true,
    }];
    const findings = runRuleEngine(files, custom, discovered);
    expect(findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// applyRuleDecay
// ---------------------------------------------------------------------------

describe("applyRuleDecay", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("does not decay custom rules", () => {
    const rules = [makeCustomRule({ confidence: 90, source: "custom" })];
    const result = applyRuleDecay(rules, tmpDir, "test/repo");
    expect(result.decayed).toBe(0);
    expect(result.rules[0].confidence).toBe(90);
  });

  it("does not decay when no DB exists", () => {
    const rules = [makeCustomRule({ source: "discovered", confidence: 80 })];
    const result = applyRuleDecay(rules, tmpDir, "test/repo");
    expect(result.decayed).toBe(0);
  });

  it("does not decay when category has high acceptance", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // 15 accepted, 5 dismissed = 75% acceptance (above 30% threshold)
    for (let i = 0; i < 15; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/auth.ts", category: "style", severity: "low", outcome: "accepted" }]);
    }
    for (let i = 0; i < 5; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/auth.ts", category: "style", severity: "low", outcome: "dismissed" }]);
    }
    db.close();

    const rules = [makeCustomRule({ source: "discovered", confidence: 80, category: "style" })];
    const result = applyRuleDecay(rules, tmpDir, "test/repo");
    expect(result.decayed).toBe(0);
  });

  it("does not decay when fewer than 20 reviews for category", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    // Only 10 reviews = below threshold of 20
    for (let i = 0; i < 2; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/auth.ts", category: "style", severity: "low", outcome: "accepted" }]);
    }
    for (let i = 0; i < 8; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/auth.ts", category: "style", severity: "low", outcome: "dismissed" }]);
    }
    db.close();

    const rules = [makeCustomRule({ source: "discovered", confidence: 80, category: "style" })];
    const result = applyRuleDecay(rules, tmpDir, "test/repo");
    expect(result.decayed).toBe(0);
  });

  it("decays discovered rules with low acceptance and 20+ reviews", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS discovered_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'discovered', type TEXT NOT NULL DEFAULT 'pattern', pattern TEXT NOT NULL, file_glob TEXT, severity TEXT NOT NULL DEFAULT 'medium', category TEXT NOT NULL DEFAULT 'bug', message TEXT NOT NULL, confidence INTEGER NOT NULL DEFAULT 70, created_at TEXT NOT NULL, last_matched_at TEXT, match_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1)");
    // 25 reviews with 15% acceptance (4 accepted, 21 dismissed)
    for (let i = 0; i < 4; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/style.ts", category: "style", severity: "low", outcome: "accepted" }]);
    }
    for (let i = 0; i < 21; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/style.ts", category: "style", severity: "low", outcome: "dismissed" }]);
    }
    db.close();

    // Rule created 10 days ago with confidence 60
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const rules = [makeCustomRule({
      id: "discovered-old-rule",
      source: "discovered", confidence: 60, category: "style",
      createdAt: tenDaysAgo, lastMatchedAt: tenDaysAgo,
    })];
    const result = applyRuleDecay(rules, tmpDir, "test/repo");
    // 10 days * 5 = 50 decay, capped at 50. 60 - 50 = 10 < 30 => auto-disabled
    expect(result.decayed).toBeGreaterThan(0);
    expect(result.rules[0].enabled).toBe(false);
  });

  it("does not decay recently matched rules as much", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS discovered_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'discovered', type TEXT NOT NULL DEFAULT 'pattern', pattern TEXT NOT NULL, file_glob TEXT, severity TEXT NOT NULL DEFAULT 'medium', category TEXT NOT NULL DEFAULT 'bug', message TEXT NOT NULL, confidence INTEGER NOT NULL DEFAULT 70, created_at TEXT NOT NULL, last_matched_at TEXT, match_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1)");
    for (let i = 0; i < 4; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/style.ts", category: "style", severity: "low", outcome: "accepted" }]);
    }
    for (let i = 0; i < 21; i++) {
      seedSuggestions(db, "test/repo", [{ file: "src/style.ts", category: "style", severity: "low", outcome: "dismissed" }]);
    }
    db.close();

    // Rule last matched 1 day ago
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const rules = [makeCustomRule({
      id: "discovered-recent-rule",
      source: "discovered", confidence: 80, category: "style",
      createdAt: oneDayAgo, lastMatchedAt: oneDayAgo,
    })];
    const result = applyRuleDecay(rules, tmpDir, "test/repo");
    // 1 day * 5 = 5 decay. 80 - 5 = 75, above 30 => still enabled
    expect(result.rules[0].enabled).toBe(true);
    expect(result.rules[0].confidence).toBe(75);
  });
});

// ---------------------------------------------------------------------------
// updateRuleMatchStats
// ---------------------------------------------------------------------------

describe("updateRuleMatchStats", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("does nothing when no DB exists", () => {
    const findings = [{ file: "src/a.ts", line: 1, severity: "medium" as const, category: "bug" as const, message: "test", rule: "test-rule" }];
    updateRuleMatchStats(tmpDir, findings, [makeCustomRule()], []);
  });

  it("updates match stats for discovered rules", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS discovered_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'discovered', type TEXT NOT NULL DEFAULT 'pattern', pattern TEXT NOT NULL, file_glob TEXT, severity TEXT NOT NULL DEFAULT 'medium', category TEXT NOT NULL DEFAULT 'bug', message TEXT NOT NULL, confidence INTEGER NOT NULL DEFAULT 70, created_at TEXT NOT NULL, last_matched_at TEXT, match_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1)");
    db.prepare("INSERT INTO discovered_rules (id, name, description, source, type, pattern, severity, category, message, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("disc-1", "test-disc", "desc", "discovered", "pattern", "", "medium", "bug", "msg", 70, new Date().toISOString());
    db.close();

    const discoveredRule: PersistedRule = {
      id: "disc-1", name: "test-disc", description: "desc", source: "discovered",
      type: "pattern", pattern: "", severity: "medium", category: "bug",
      message: "msg", confidence: 70, createdAt: new Date().toISOString(),
      lastMatchedAt: null, matchCount: 0, enabled: true,
    };
    const findings = [{ file: "src/a.ts", line: 1, severity: "medium" as const, category: "bug" as const, message: "test", rule: "test-disc" }];
    updateRuleMatchStats(tmpDir, findings, [], [discoveredRule]);

    const db2 = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    const row = db2.prepare("SELECT match_count, last_matched_at FROM discovered_rules WHERE id = ?").get("disc-1") as Record<string, unknown>;
    db2.close();
    expect(row.match_count).toBe(1);
    expect(row.last_matched_at).toBeTruthy();
  });

  it("does not update custom rules", () => {
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE IF NOT EXISTS discovered_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'discovered', type TEXT NOT NULL DEFAULT 'pattern', pattern TEXT NOT NULL, file_glob TEXT, severity TEXT NOT NULL DEFAULT 'medium', category TEXT NOT NULL DEFAULT 'bug', message TEXT NOT NULL, confidence INTEGER NOT NULL DEFAULT 70, created_at TEXT NOT NULL, last_matched_at TEXT, match_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1)");
    db.close();

    const customRule = makeCustomRule({ name: "custom-match" });
    const findings = [{ file: "src/a.ts", line: 1, severity: "low" as const, category: "style" as const, message: "test", rule: "custom-match" }];
    updateRuleMatchStats(tmpDir, findings, [customRule], []);
    // No error, and discovered_rules table stays unchanged
  });
});

// ---------------------------------------------------------------------------
// executeRuleEngine (integration)
// ---------------------------------------------------------------------------

describe("executeRuleEngine", () => {
  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns empty findings when no rules configured", () => {
    const files = [addFile("src/app.ts", ["console.log('test')"])];
    const result = executeRuleEngine(files, tmpDir, "test/repo");
    expect(result.findings).toHaveLength(0);
    expect(result.rulesUsed).toBe(0);
  });

  it("runs custom rules from mizumi-rules.yml", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: no-console-log",
      "    pattern: console",
      "    severity: low",
      "    category: style",
      "    message: No console.log in production",
    ].join("\n"));

    // Create a minimal suggestions DB so discoverRules doesn't fail
    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.close();

    const files = [addFile("src/app.ts", ["console.log('debug')"])];
    const result = executeRuleEngine(files, tmpDir, "test/repo");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].rule).toBe("no-console-log");
  });

  it("reports rulesSkipped for disabled rules", () => {
    writeRulesYaml(tmpDir, [
      "rules:",
      "  - name: disabled-rule",
      "    pattern: x",
      "    severity: low",
      "    enabled: false",
    ].join("\n"));

    const db = new DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, message_hash TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.close();

    const files = [addFile("src/app.ts", ["some code"])];
    const result = executeRuleEngine(files, tmpDir, "test/repo");
    expect(result.rulesSkipped).toBeGreaterThanOrEqual(1);
  });

  it("handles no files gracefully", () => {
    const result = executeRuleEngine([], tmpDir, "test/repo");
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Additional parseRulesYaml edge cases
// ---------------------------------------------------------------------------

describe("parseRulesYaml additional edge cases", () => {
  it("handles quoted string values", () => {
    const yaml = [
      "rules:",
      " - name: test",
      "   pattern: \"console\\.log\"",
      "   message: \"Avoid console.log\"",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
    expect(result.rules![0].pattern).toContain("console");
  });

  it("handles rules with glob type", () => {
    const yaml = [
      "rules:",
      " - name: config-check",
      "   type: glob",
      "   file_glob: '**/*.yaml'",
      "   severity: medium",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
  });

  it("parses multiple properties per rule", () => {
    const yaml = [
      "rules:",
      " - name: full-rule",
      "   pattern: todo",
      "   severity: low",
      "   category: style",
      "   message: TODO found",
      "   confidence: 80",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
    expect(result.rules![0].severity).toBe("low");
    expect(result.rules![0].category).toBe("style");
    expect(result.rules![0].confidence).toBe(80);
  });

  it("stops parsing rules at dedent", () => {
    const yaml = [
      "rules:",
      " - name: rule1",
      "   pattern: x",
      "other_key: value",
    ].join("\n");
    const result = parseRulesYaml(yaml);
    expect(result.rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Additional runRuleEngine edge cases
// ---------------------------------------------------------------------------

describe("runRuleEngine additional edge cases", () => {
  it("handles invalid regex gracefully", () => {
    const badRule = makeCustomRule({ pattern: "[invalid", type: "regex" });
    const files = [addFile("test.ts", ["some code"])];
    const findings = runRuleEngine(files, [badRule], []);
    expect(findings).toHaveLength(0);
  });

  it("handles glob rule matching multiple files", () => {
    const globRule = makeCustomRule({
      type: "glob",
      fileGlob: "src/**/*.ts",
      pattern: "",
    });
    const files = [
      addFile("src/a.ts", ["code"]),
      addFile("src/b.ts", ["code"]),
      addFile("docs/readme.md", ["text"]),
    ];
    const findings = runRuleEngine(files, [globRule], []);
    expect(findings).toHaveLength(2);
  });

  it("handles empty diff files", () => {
    const findings = runRuleEngine([], [makeCustomRule()], []);
    expect(findings).toHaveLength(0);
  });

  it("deduplicates findings from same rule on same line", () => {
    const rule = makeCustomRule({ pattern: "console" });
    const files = [addFile("app.ts", ["console.log('a')", "console.log('b')"])];
    const findings = runRuleEngine(files, [rule], []);
    expect(findings.length).toBeLessThanOrEqual(2);
  });
});

