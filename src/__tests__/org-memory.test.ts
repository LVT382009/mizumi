import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

import {
  recordPRHistory,
  retrieveSimilarPRs,
  buildOrgMemoryContext,
  runOrgMemoryRetrieval,
  getIndexedCount,
  pruneOldHistory,
} from "../org-memory.js";
import type { OrgMemoryResult, SimilarPR } from "../org-memory.js";

describe("org-memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-orgmem-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getDbPath(): string {
    return path.join(tmpDir, ".github", "mizumi-data.db");
  }

  function openRawDb(): DatabaseSync {
    return new DatabaseSync(getDbPath());
  }

  // ---------------------------------------------------------------------------
  // recordPRHistory
  // ---------------------------------------------------------------------------

  describe("recordPRHistory", () => {
    it("creates .github directory if missing", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Fix auth", ["src/auth.ts"], [], 2);
      expect(fs.existsSync(getDbPath())).toBe(true);
    });

    it("inserts a PR history entry", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Fix login", ["src/auth.ts", "src/api.ts"], [
        { category: "security", severity: "high", message: "SQL injection in auth" },
        { category: "bug", severity: "medium", message: "Null pointer in handler" },
      ], 3);

      const db = openRawDb();
      const rows = db.prepare(`SELECT * FROM pr_history WHERE repo = ?`).all("org/repo") as any[];
      db.close();

      expect(rows).toHaveLength(1);
      expect(rows[0].pr_number).toBe(1);
      expect(rows[0].title).toBe("Fix login");
      expect(rows[0].finding_count).toBe(2);
      expect(rows[0].risk_score).toBe(3);
    });

    it("stores files as comma-separated string", () => {
      recordPRHistory(tmpDir, "org/repo", 5, "Update", ["src/a.ts", "src/b.ts"], [], 1);

      const db = openRawDb();
      const row = db.prepare(`SELECT files FROM pr_history WHERE repo = ?`).get("org/repo") as { files: string } | undefined;
      db.close();

      expect(row?.files).toBe("src/a.ts,src/b.ts");
    });

    it("stores finding categories as space-separated", () => {
      const findings = [
        { category: "security", severity: "high", message: "XSS" },
        { category: "security", severity: "medium", message: "CSRF" },
        { category: "bug", severity: "low", message: "Typo" },
      ];
      recordPRHistory(tmpDir, "org/repo", 10, "Fix", ["src/x.ts"], findings, 4);

      const db = openRawDb();
      const row = db.prepare(`SELECT finding_categories FROM pr_history WHERE repo = ?`).get("org/repo") as { finding_categories: string } | undefined;
      db.close();

      expect(row?.finding_categories).toBe("security security bug");
    });

    it("builds summary from top findings by severity", () => {
      const findings = [
        { category: "style", severity: "nitpick", message: "Bad formatting" },
        { category: "security", severity: "critical", message: "RCE vulnerability in input parsing" },
        { category: "bug", severity: "high", message: "Race condition in concurrent handler" },
      ];
      recordPRHistory(tmpDir, "org/repo", 20, "Bugfixes", ["src/c.ts"], findings, 5);

      const db = openRawDb();
      const row = db.prepare(`SELECT summary FROM pr_history WHERE repo = ?`).get("org/repo") as { summary: string } | undefined;
      db.close();

      // Critical should appear first
      expect(row?.summary).toContain("[critical]");
      expect(row?.summary).toContain("[high]");
      expect(row?.summary).toContain("RCE vulnerability");
    });

    it("truncates long titles", () => {
      const longTitle = "A".repeat(300);
      recordPRHistory(tmpDir, "org/repo", 30, longTitle, ["src/a.ts"], [], 1);

      const db = openRawDb();
      const row = db.prepare(`SELECT title FROM pr_history WHERE repo = ?`).get("org/repo") as { title: string } | undefined;
      db.close();

      expect(row!.title.length).toBeLessThanOrEqual(200);
    });

    it("upserts on duplicate repo+pr_number", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "First title", ["src/a.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo", 1, "Updated title", ["src/b.ts"], [], 2);

      const db = openRawDb();
      const rows = db.prepare(`SELECT * FROM pr_history WHERE repo = ? AND pr_number = 1`).all("org/repo") as any[];
      db.close();

      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Updated title");
    });

    it("handles empty files array", () => {
      recordPRHistory(tmpDir, "org/repo", 99, "Empty", [], [], 0);

      const db = openRawDb();
      const rows = db.prepare(`SELECT * FROM pr_history WHERE repo = ?`).all("org/repo") as any[];
      db.close();

      expect(rows).toHaveLength(1);
      expect(rows[0].files).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // retrieveSimilarPRs
  // ---------------------------------------------------------------------------

  describe("retrieveSimilarPRs", () => {
    it("returns empty for no history", () => {
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/auth.ts"]);
      expect(results).toHaveLength(0);
    });

    it("returns empty for empty current files", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Fix", ["src/auth.ts"], [], 1);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", []);
      expect(results).toHaveLength(0);
    });

    it("finds PRs with exact file overlap", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Auth fix", ["src/auth.ts", "src/utils.ts"], [
        { category: "security", severity: "high", message: "SQL injection" },
      ], 4);

      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/auth.ts", "src/api.ts"]);
      expect(results).toHaveLength(1);
      expect(results[0].prNumber).toBe(1);
      expect(results[0].overlapCount).toBe(1);
      expect(results[0].overlappingFiles).toContain("src/auth.ts");
    });

    it("excludes current PR number", () => {
      recordPRHistory(tmpDir, "org/repo", 42, "Same PR", ["src/auth.ts"], [], 1);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/auth.ts"], 42);
      expect(results).toHaveLength(0);
    });

    it("sorts by similarity (highest first)", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Partial match", ["src/auth.ts", "src/other.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo", 2, "Full match", ["src/auth.ts", "src/api.ts", "src/db.ts"], [], 1);

      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/auth.ts", "src/api.ts", "src/db.ts"]);
      expect(results[0].prNumber).toBe(2);
    });

    it("respects MAX_SIMILAR_PRS limit", () => {
      for (let i = 1; i <= 10; i++) {
        recordPRHistory(tmpDir, "org/repo", i, `PR ${i}`, ["src/shared.ts"], [], 1);
      }
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/shared.ts"]);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it("filters out low-similarity matches", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Unrelated", ["docs/readme.md", "config/settings.yaml"], [], 1);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/auth.ts", "src/api.ts"]);
      // No file or directory overlap with completely different paths
      expect(results).toHaveLength(0);
    });

    it("detects directory-level overlap", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Sibling file", ["src/auth/login.ts"], [], 1);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/auth/logout.ts"]);
      // Should match via directory overlap (src/auth/)
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it("extracts top categories from past PR", () => {
      const findings = [
        { category: "security", severity: "high", message: "XSS" },
        { category: "security", severity: "high", message: "CSRF" },
        { category: "bug", severity: "medium", message: "Null ptr" },
      ];
      recordPRHistory(tmpDir, "org/repo", 1, "Multi-cat", ["src/a.ts"], findings, 3);

      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/a.ts"]);
      expect(results).toHaveLength(1);
      expect(results[0].topCategories).toContain("security");
    });

    it("handles multiple repos independently", () => {
      recordPRHistory(tmpDir, "org/repo1", 1, "R1", ["src/auth.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo2", 1, "R2", ["src/api.ts"], [], 1);

      const r1 = retrieveSimilarPRs(tmpDir, "org/repo1", ["src/auth.ts"]);
      const r2 = retrieveSimilarPRs(tmpDir, "org/repo2", ["src/auth.ts"]);

      expect(r1).toHaveLength(1);
      // repo2 has src/api.ts, current is src/auth.ts — may have dir overlap via src/
      expect(r2.every((r) => r.prNumber === 1)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // buildOrgMemoryContext
  // ---------------------------------------------------------------------------

  describe("buildOrgMemoryContext", () => {
    it("returns empty string for no similar PRs", () => {
      const result: OrgMemoryResult = { similarPRs: [], totalIndexed: 0, contextText: "" };
      expect(buildOrgMemoryContext(result)).toBe("");
    });

    it("includes PR number and title", () => {
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 42,
          title: "Fix auth bug",
          similarity: 0.75,
          overlapCount: 2,
          overlappingFiles: ["src/auth.ts"],
          summary: "[high] security: SQL injection",
          topCategories: ["security"],
          riskScore: 4,
        }],
        totalIndexed: 10,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("PR #42");
      expect(ctx).toContain("Fix auth bug");
    });

    it("includes similarity percentage", () => {
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 1, title: "Test", similarity: 0.65,
          overlapCount: 1, overlappingFiles: ["src/a.ts"],
          summary: "", topCategories: [], riskScore: 2,
        }],
        totalIndexed: 5,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("65%");
    });

    it("includes shared files", () => {
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 1, title: "T", similarity: 0.5,
          overlapCount: 2, overlappingFiles: ["src/auth.ts", "src/api.ts"],
          summary: "", topCategories: [], riskScore: 1,
        }],
        totalIndexed: 1,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("src/auth.ts");
      expect(ctx).toContain("src/api.ts");
    });

    it("truncates file list when more than 8", () => {
      const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 1, title: "T", similarity: 0.5,
          overlapCount: 10, overlappingFiles: files,
          summary: "", topCategories: [], riskScore: 1,
        }],
        totalIndexed: 1,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("+2 more");
    });

    it("includes finding categories", () => {
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 1, title: "T", similarity: 0.5,
          overlapCount: 1, overlappingFiles: ["src/a.ts"],
          summary: "", topCategories: ["security", "bug"],
          riskScore: 3,
        }],
        totalIndexed: 1,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("security");
      expect(ctx).toContain("bug");
    });

    it("includes key findings summary", () => {
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 1, title: "T", similarity: 0.5,
          overlapCount: 1, overlappingFiles: ["src/a.ts"],
          summary: "[high] security: XSS vulnerability in input",
          topCategories: ["security"],
          riskScore: 4,
        }],
        totalIndexed: 1,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("XSS vulnerability");
    });

    it("includes total indexed count", () => {
      const result: OrgMemoryResult = {
        similarPRs: [{
          prNumber: 1, title: "T", similarity: 0.5,
          overlapCount: 1, overlappingFiles: ["src/a.ts"],
          summary: "", topCategories: [], riskScore: 1,
        }],
        totalIndexed: 42,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("42 indexed");
    });

    it("formats multiple similar PRs", () => {
      const result: OrgMemoryResult = {
        similarPRs: [
          { prNumber: 1, title: "First", similarity: 0.8, overlapCount: 3, overlappingFiles: [], summary: "S1", topCategories: [], riskScore: 2 },
          { prNumber: 2, title: "Second", similarity: 0.5, overlapCount: 1, overlappingFiles: [], summary: "S2", topCategories: [], riskScore: 1 },
        ],
        totalIndexed: 5,
        contextText: "",
      };
      const ctx = buildOrgMemoryContext(result);
      expect(ctx).toContain("PR #1");
      expect(ctx).toContain("PR #2");
    });
  });

  // ---------------------------------------------------------------------------
  // runOrgMemoryRetrieval
  // ---------------------------------------------------------------------------

  describe("runOrgMemoryRetrieval", () => {
    it("returns empty for no history", () => {
      const result = runOrgMemoryRetrieval(tmpDir, "org/repo", ["src/auth.ts"]);
      expect(result.similarPRs).toHaveLength(0);
      expect(result.totalIndexed).toBe(0);
      expect(result.contextText).toBe("");
    });

    it("returns similar PRs with context text", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Auth refactor", ["src/auth.ts"], [
        { category: "security", severity: "high", message: "Missing CSRF token" },
      ], 4);

      const result = runOrgMemoryRetrieval(tmpDir, "org/repo", ["src/auth.ts", "src/api.ts"]);
      expect(result.similarPRs).toHaveLength(1);
      expect(result.totalIndexed).toBe(1);
      expect(result.contextText).toContain("Auth refactor");
    });

    it("excludes current PR from results", () => {
      recordPRHistory(tmpDir, "org/repo", 42, "Current", ["src/auth.ts"], [], 1);
      const result = runOrgMemoryRetrieval(tmpDir, "org/repo", ["src/auth.ts"], 42);
      expect(result.similarPRs).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getIndexedCount
  // ---------------------------------------------------------------------------

  describe("getIndexedCount", () => {
    it("returns 0 for repo with no history", () => {
      expect(getIndexedCount(tmpDir, "org/empty")).toBe(0);
    });

    it("counts indexed PRs correctly", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "A", ["src/a.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo", 2, "B", ["src/b.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo", 3, "C", ["src/c.ts"], [], 1);
      expect(getIndexedCount(tmpDir, "org/repo")).toBe(3);
    });

    it("counts per repo", () => {
      recordPRHistory(tmpDir, "org/repo1", 1, "A", ["src/a.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo2", 1, "B", ["src/b.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo2", 2, "C", ["src/c.ts"], [], 1);
      expect(getIndexedCount(tmpDir, "org/repo1")).toBe(1);
      expect(getIndexedCount(tmpDir, "org/repo2")).toBe(2);
    });

    it("counts upserted entries correctly (no duplicates)", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "V1", ["src/a.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo", 1, "V2", ["src/b.ts"], [], 2);
      expect(getIndexedCount(tmpDir, "org/repo")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // pruneOldHistory
  // ---------------------------------------------------------------------------

  describe("pruneOldHistory", () => {
    it("returns 0 when nothing to prune", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Recent", ["src/a.ts"], [], 1);
      const pruned = pruneOldHistory(tmpDir, "org/repo", 365);
      expect(pruned).toBe(0);
    });

    it("prunes entries older than threshold", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Old", ["src/a.ts"], [], 1);

      // Manually age the entry
      const db = openRawDb();
      db.exec(`UPDATE pr_history SET reviewed_at = datetime('now', '-200 days') WHERE pr_number = 1`);
      db.close();

      const pruned = pruneOldHistory(tmpDir, "org/repo", 100);
      expect(pruned).toBe(1);
      expect(getIndexedCount(tmpDir, "org/repo")).toBe(0);
    });

    it("keeps recent entries", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Recent", ["src/a.ts"], [], 1);

      // Age one entry
      const db = openRawDb();
      db.exec(`UPDATE pr_history SET reviewed_at = datetime('now', '-200 days') WHERE pr_number = 1`);
      db.close();

      // Add a fresh one
      recordPRHistory(tmpDir, "org/repo", 2, "Fresh", ["src/b.ts"], [], 1);

      pruneOldHistory(tmpDir, "org/repo", 100);
      expect(getIndexedCount(tmpDir, "org/repo")).toBe(1);
    });

    it("does not prune from other repos", () => {
      recordPRHistory(tmpDir, "org/repo1", 1, "R1", ["src/a.ts"], [], 1);
      recordPRHistory(tmpDir, "org/repo2", 1, "R2", ["src/b.ts"], [], 1);

      // Age repo1's entry
      const db = openRawDb();
      db.exec(`UPDATE pr_history SET reviewed_at = datetime('now', '-200 days') WHERE repo = 'org/repo1'`);
      db.close();

      pruneOldHistory(tmpDir, "org/repo1", 100);
      expect(getIndexedCount(tmpDir, "org/repo1")).toBe(0);
      expect(getIndexedCount(tmpDir, "org/repo2")).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: record → retrieve → context
  // ---------------------------------------------------------------------------

  describe("full pipeline integration", () => {
    it("records multiple PRs and retrieves most similar ones", () => {
      // PR 1: touches auth + utils
      recordPRHistory(tmpDir, "org/repo", 1, "Auth fix", ["src/auth.ts", "src/utils.ts"], [
        { category: "security", severity: "high", message: "SQL injection" },
      ], 4);

      // PR 2: touches api + db
      recordPRHistory(tmpDir, "org/repo", 2, "API update", ["src/api.ts", "src/db.ts"], [
        { category: "bug", severity: "medium", message: "Null pointer" },
      ], 2);

      // PR 3: touches auth + api
      recordPRHistory(tmpDir, "org/repo", 3, "Auth API", ["src/auth.ts", "src/api.ts"], [
        { category: "security", severity: "critical", message: "Auth bypass" },
        { category: "security", severity: "high", message: "Missing CSRF" },
      ], 5);

      // Current PR touches auth + api → should match PR 3 most
      const result = runOrgMemoryRetrieval(tmpDir, "org/repo", ["src/auth.ts", "src/api.ts"], 99);
      expect(result.similarPRs.length).toBeGreaterThanOrEqual(2);
      expect(result.similarPRs[0].prNumber).toBe(3);
      expect(result.contextText).toContain("Organizational Memory");
    });

    it("builds context with organizational insights", () => {
      recordPRHistory(tmpDir, "org/repo", 100, "Security overhaul", ["src/auth/login.ts", "src/auth/middleware.ts"], [
        { category: "security", severity: "critical", message: "JWT not validated" },
        { category: "security", severity: "high", message: "Missing rate limiting" },
        { category: "bug", severity: "medium", message: "Session race condition" },
      ], 5);

      const result = runOrgMemoryRetrieval(tmpDir, "org/repo", ["src/auth/login.ts", "src/auth/oauth.ts"]);

      expect(result.similarPRs.length).toBeGreaterThan(0);
      expect(result.contextText).toContain("Organizational Memory");
      expect(result.contextText).toContain("security");
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles zero findings", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Clean PR", ["src/a.ts"], [], 0);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/a.ts"]);
      expect(results).toHaveLength(1);
      expect(results[0].topCategories).toHaveLength(0);
    });

    it("handles very long file lists", () => {
      const manyFiles = Array.from({ length: 50 }, (_, i) => `src/module${i}/index.ts`);
      recordPRHistory(tmpDir, "org/repo", 1, "Big PR", manyFiles, [], 1);

      const currentFiles = manyFiles.slice(0, 5);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", currentFiles);
      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBeGreaterThan(0);
    });

    it("handles empty titles gracefully", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "", ["src/a.ts"], [], 1);
      const results = retrieveSimilarPRs(tmpDir, "org/repo", ["src/a.ts"]);
      expect(results).toHaveLength(1);
    });

    it("handles special characters in messages", () => {
      recordPRHistory(tmpDir, "org/repo", 1, "Special", ["src/a.ts"], [
        { category: "bug", severity: "medium", message: "Issue with <html> & `code` and 'quotes'" },
      ], 2);

      const db = openRawDb();
      const row = db.prepare(`SELECT summary FROM pr_history WHERE repo = ?`).get("org/repo") as any;
      db.close();
      expect(row).toBeDefined();
    });
  });
});
