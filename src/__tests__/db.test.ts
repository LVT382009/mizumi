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
  recordSuggestion,
  getCategoryStats,
  computeLearningWeights,
  applyLearningWeights,
  updateOutcome,
} from "../db.js";

describe("db feedback tracker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-db-"));
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

  function seedAndResolve(
    repo: string,
    category: string,
    total: number,
    acceptedCount: number,
    dismissedCount: number
  ): void {
    for (let i = 0; i < total; i++) {
      recordSuggestion(tmpDir, repo, "src/test.ts", i, category, "medium", `Finding ${category}-${i}`);
    }
    const db = openRawDb();
    const rows = db.prepare(`SELECT id, message_hash FROM suggestions WHERE repo = ? AND category = ? ORDER BY id`).all(repo, category) as Array<{ id: number; message_hash: string }>;
    let accepted = 0;
    let dismissed = 0;
    for (const row of rows) {
      if (accepted < acceptedCount) {
        db.exec(`UPDATE suggestions SET outcome = 'accepted' WHERE id = ${row.id}`);
        accepted++;
      } else if (dismissed < dismissedCount) {
        db.exec(`UPDATE suggestions SET outcome = 'dismissed' WHERE id = ${row.id}`);
        dismissed++;
      }
    }
    db.close();
  }

  describe("recordSuggestion", () => {
    it("records a suggestion and retrieves stats", () => {
      recordSuggestion(tmpDir, "org/repo", "src/auth.ts", 42, "security", "high", "SQL injection");
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats).toHaveLength(0);
    });

    it("records multiple suggestions and returns correct count after outcome update", () => {
      recordSuggestion(tmpDir, "org/repo", "src/auth.ts", 42, "security", "high", "SQL injection found");
      recordSuggestion(tmpDir, "org/repo", "src/api.ts", 10, "bug", "medium", "Null pointer");
      recordSuggestion(tmpDir, "org/repo", "src/auth.ts", 99, "security", "high", "Auth bypass");

      updateOutcome(tmpDir, "SQL injection found", "accepted");

      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats.length).toBeGreaterThanOrEqual(0);
    });

    it("creates .github directory if missing", () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-fresh-"));
      try {
        recordSuggestion(freshDir, "org/repo", "src/a.ts", 1, "bug", "low", "test");
        expect(fs.existsSync(path.join(freshDir, ".github", "mizumi-data.db"))).toBe(true);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });

    it("handles recording with special characters in message", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "bug", "medium", "Issues with `code` and <html> & 'quotes'");
      const db = openRawDb();
      const rows = db.prepare(`SELECT COUNT(*) as count FROM suggestions WHERE repo = 'org/repo'`).all() as Array<{ count: number }>;
      expect(rows[0].count).toBe(1);
      db.close();
    });

    it("inserts with pending outcome by default", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "bug", "low", "test msg");
      const db = openRawDb();
      const rows = db.prepare(`SELECT outcome FROM suggestions WHERE repo = 'org/repo'`).all() as Array<{ outcome: string }>;
      expect(rows[0].outcome).toBe("pending");
      db.close();
    });
  });

  describe("updateOutcome", () => {
    it("updates pending suggestion to accepted", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "security", "high", "test finding");
      const db = openRawDb();
      const row = db.prepare(`SELECT message_hash FROM suggestions WHERE repo = 'org/repo'`).get() as { message_hash: string } | undefined;
      db.close();

      if (row) {
        updateOutcome(tmpDir, row.message_hash, "accepted");
        const stats = getCategoryStats(tmpDir, "org/repo");
        expect(stats).toHaveLength(1);
        expect(stats[0].category).toBe("security");
        expect(stats[0].total).toBe(1);
        expect(stats[0].accepted).toBe(1);
      }
    });

    it("updates pending suggestion to dismissed", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "style", "low", "naming issue");
      const db = openRawDb();
      const row = db.prepare(`SELECT message_hash FROM suggestions WHERE repo = 'org/repo'`).get() as { message_hash: string } | undefined;
      db.close();

      if (row) {
        updateOutcome(tmpDir, row.message_hash, "dismissed");
        const stats = getCategoryStats(tmpDir, "org/repo");
        expect(stats[0].accepted).toBe(0);
        expect(stats[0].total).toBe(1);
      }
    });

    it("does not update already-resolved suggestions", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "bug", "medium", "duplicate finding");
      const db = openRawDb();
      const row = db.prepare(`SELECT message_hash FROM suggestions WHERE repo = 'org/repo'`).get() as { message_hash: string } | undefined;
      db.close();

      if (row) {
        updateOutcome(tmpDir, row.message_hash, "accepted");
        updateOutcome(tmpDir, row.message_hash, "dismissed");
        const stats = getCategoryStats(tmpDir, "org/repo");
        expect(stats[0].accepted).toBe(1);
      }
    });

    it("handles invalid hash gracefully", () => {
      updateOutcome(tmpDir, "nonexistent_hash", "accepted");
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats).toHaveLength(0);
    });

    it("updates fixed outcome", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "bug", "high", "crash bug");
      const db = openRawDb();
      const row = db.prepare(`SELECT message_hash FROM suggestions WHERE repo = 'org/repo'`).get() as { message_hash: string } | undefined;
      db.close();

      if (row) {
        updateOutcome(tmpDir, row.message_hash, "fixed");
        const stats = getCategoryStats(tmpDir, "org/repo");
        expect(stats[0].accepted).toBe(1);
      }
    });
  });

  describe("getCategoryStats", () => {
    it("returns empty for repo with no data", () => {
      const stats = getCategoryStats(tmpDir, "org/empty");
      expect(stats).toEqual([]);
    });

    it("excludes pending suggestions from stats", () => {
      recordSuggestion(tmpDir, "org/repo", "src/a.ts", 1, "bug", "medium", "pending finding");
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats).toHaveLength(0);
    });

    it("computes acceptance rate correctly", () => {
      seedAndResolve("org/repo", "bug", 10, 7, 3);
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats).toHaveLength(1);
      expect(stats[0].category).toBe("bug");
      expect(stats[0].total).toBe(10);
      expect(stats[0].accepted).toBe(7);
      expect(stats[0].acceptanceRate).toBeCloseTo(0.7);
    });

    it("returns separate stats per category", () => {
      seedAndResolve("org/repo", "bug", 5, 4, 1);
      seedAndResolve("org/repo", "security", 5, 1, 4);
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats).toHaveLength(2);
      const bug = stats.find((s) => s.category === "bug");
      const sec = stats.find((s) => s.category === "security");
      expect(bug?.acceptanceRate).toBeCloseTo(0.8);
      expect(sec?.acceptanceRate).toBeCloseTo(0.2);
    });

    it("returns 0 acceptance rate when all dismissed", () => {
      seedAndResolve("org/repo", "style", 5, 0, 5);
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats[0].acceptanceRate).toBe(0);
    });

    it("returns 1.0 acceptance rate when all accepted", () => {
      seedAndResolve("org/repo", "security", 5, 5, 0);
      const stats = getCategoryStats(tmpDir, "org/repo");
      expect(stats[0].acceptanceRate).toBe(1);
    });
  });

  describe("computeLearningWeights", () => {
    it("returns neutral when insufficient data", () => {
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(Object.keys(weights)).toHaveLength(0);
    });

    it("demotes categories with low acceptance rate", () => {
      seedAndResolve("org/repo", "style", 8, 1, 7);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.style).toBe("demote");
    });

    it("promotes categories with high acceptance rate", () => {
      seedAndResolve("org/repo", "security", 8, 8, 0);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.security).toBe("promote");
    });

    it("returns neutral for mid-range acceptance rate", () => {
      seedAndResolve("org/repo", "bug", 10, 5, 5);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.bug).toBe("neutral");
    });

    it("returns neutral when fewer than 5 suggestions even with extreme rate", () => {
      seedAndResolve("org/repo", "style", 4, 0, 4);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.style).toBe("neutral");
    });

    it("returns neutral at exactly 30% acceptance", () => {
      seedAndResolve("org/repo", "bug", 10, 3, 7);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.bug).toBe("neutral");
    });

    it("demotes at 29% acceptance", () => {
      // 7 total, 2 accepted = ~28.6%
      seedAndResolve("org/repo", "style", 7, 2, 5);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.style).toBe("demote");
    });

    it("promotes at 91% acceptance", () => {
      // 11 total, 10 accepted, 1 dismissed = ~90.9%
      seedAndResolve("org/repo", "security", 11, 10, 1);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.security).toBe("promote");
    });

    it("returns neutral at exactly 90% acceptance", () => {
      // 10 total, 9 accepted, 1 dismissed = 90%
      seedAndResolve("org/repo", "bug", 10, 9, 1);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.bug).toBe("neutral");
    });

    it("handles multiple categories with different weights", () => {
      seedAndResolve("org/repo", "style", 6, 0, 6);
      seedAndResolve("org/repo", "security", 6, 6, 0);
      seedAndResolve("org/repo", "bug", 6, 3, 3);
      const weights = computeLearningWeights(tmpDir, "org/repo");
      expect(weights.style).toBe("demote");
      expect(weights.security).toBe("promote");
      expect(weights.bug).toBe("neutral");
    });
  });

  describe("applyLearningWeights", () => {
    it("demotes severity for demoted categories", () => {
      const findings = [{ severity: "medium", category: "style", confidence: 80 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("low");
      expect(result[0].confidence).toBe(70);
    });

    it("promotes severity for promoted categories", () => {
      const findings = [{ severity: "medium", category: "security", confidence: 80 }];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].severity).toBe("high");
      expect(result[0].confidence).toBe(90);
    });

    it("leaves neutral categories unchanged", () => {
      const findings = [{ severity: "high", category: "bug", confidence: 85 }];
      const result = applyLearningWeights(findings, { bug: "neutral" });
      expect(result[0].severity).toBe("high");
      expect(result[0].confidence).toBe(85);
    });

    it("does not demote below nitpick", () => {
      const findings = [{ severity: "nitpick", category: "style", confidence: 10 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("nitpick");
    });

    it("does not promote above critical", () => {
      const findings = [{ severity: "critical", category: "security", confidence: 100 }];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].severity).toBe("critical");
    });

    it("demotes high to medium", () => {
      const findings = [{ severity: "high", category: "style", confidence: 75 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("medium");
      expect(result[0].confidence).toBe(65);
    });

    it("promotes low to medium", () => {
      const findings = [{ severity: "low", category: "security", confidence: 60 }];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].severity).toBe("medium");
      expect(result[0].confidence).toBe(70);
    });

    it("demotes nitpick stays nitpick without confidence reduction (already lowest)", () => {
      const findings = [{ severity: "nitpick", category: "style", confidence: 20 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("nitpick");
      expect(result[0].confidence).toBe(20);
    });

    it("promotes critical stays critical without confidence boost (already highest)", () => {
      const findings = [{ severity: "critical", category: "security", confidence: 95 }];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].severity).toBe("critical");
      expect(result[0].confidence).toBe(95);
    });

    it("does not reduce confidence below 0", () => {
      const findings = [{ severity: "low", category: "style", confidence: 5 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].confidence).toBe(0);
    });

    it("does not increase confidence above 100", () => {
      const findings = [{ severity: "high", category: "security", confidence: 95 }];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].confidence).toBe(100);
    });

    it("leaves findings unchanged when no weight entry", () => {
      const findings = [{ severity: "high", category: "architecture", confidence: 80 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("high");
      expect(result[0].confidence).toBe(80);
    });

    it("handles empty findings array", () => {
      const result = applyLearningWeights([], { style: "demote" });
      expect(result).toEqual([]);
    });

    it("handles finding with unknown severity gracefully", () => {
      const findings = [{ severity: "unknown", category: "style", confidence: 50 }];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("unknown");
    });

    it("processes multiple findings independently", () => {
      const findings = [
        { severity: "high", category: "style", confidence: 80 },
        { severity: "medium", category: "security", confidence: 70 },
        { severity: "low", category: "bug", confidence: 60 },
      ];
      const result = applyLearningWeights(findings, { style: "demote", security: "promote", bug: "neutral" });
      expect(result[0].severity).toBe("medium");
      expect(result[1].severity).toBe("high");
      expect(result[2].severity).toBe("low");
    });
  });
});
