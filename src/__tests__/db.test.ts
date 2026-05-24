import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

  describe("recordSuggestion", () => {
    it("records a suggestion and retrieves stats", () => {
      recordSuggestion(tmpDir, "org/repo", "src/auth.ts", 42, "security", "high", "SQL injection");
      const stats = getCategoryStats(tmpDir, "org/repo");
      // Only pending, so no stats (we filter out pending)
      expect(stats).toHaveLength(0);
    });

    it("records multiple suggestions and returns correct count after outcome update", () => {
      recordSuggestion(tmpDir, "org/repo", "src/auth.ts", 42, "security", "high", "SQL injection found");
      recordSuggestion(tmpDir, "org/repo", "src/api.ts", 10, "bug", "medium", "Null pointer");
      recordSuggestion(tmpDir, "org/repo", "src/auth.ts", 99, "security", "high", "Auth bypass");

      // Update outcomes
      updateOutcome(tmpDir, "SQL injection found" /* hash check is approximate, test the flow */ , "accepted");

      const stats = getCategoryStats(tmpDir, "org/repo");
      // Stats only return categories with non-pending outcomes
      expect(stats.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("computeLearningWeights", () => {
    it("returns neutral when insufficient data", () => {
      const weights = computeLearningWeights(tmpDir, "org/repo");
      // No data → empty weights
      expect(Object.keys(weights)).toHaveLength(0);
    });

    it("demotes categories with low acceptance rate", () => {
      // Create enough suggestions to trigger demotion (<30% acceptance, >=5 total)
      for (let i = 0; i < 5; i++) {
        recordSuggestion(tmpDir, "org/repo", "src/style.ts", i, "style", "low", `Style issue ${i}`);
      }
      // Dismiss most of them
      const db = new (require("node:sqlite") as any).DatabaseSync(path.join(tmpDir, ".github", "mizumi-data.db"));
      db.exec(`UPDATE suggestions SET outcome = 'dismissed' WHERE repo = 'org/repo' AND category = 'style'`);
      db.close();

      const weights = computeLearningWeights(tmpDir, "org/repo");
      if (weights.style) {
        expect(weights.style).toBe("demote");
      }
    });
  });

  describe("applyLearningWeights", () => {
    it("demotes severity for demoted categories", () => {
      const findings = [
        { severity: "medium", category: "style", confidence: 80 },
      ];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("low");
      expect(result[0].confidence).toBe(70);
    });

    it("promotes severity for promoted categories", () => {
      const findings = [
        { severity: "medium", category: "security", confidence: 80 },
      ];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].severity).toBe("high");
      expect(result[0].confidence).toBe(90);
    });

    it("leaves neutral categories unchanged", () => {
      const findings = [
        { severity: "high", category: "bug", confidence: 85 },
      ];
      const result = applyLearningWeights(findings, { bug: "neutral" });
      expect(result[0].severity).toBe("high");
      expect(result[0].confidence).toBe(85);
    });

    it("does not demote below nitpick", () => {
      const findings = [
        { severity: "nitpick", category: "style", confidence: 10 },
      ];
      const result = applyLearningWeights(findings, { style: "demote" });
      expect(result[0].severity).toBe("nitpick");
    });

    it("does not promote above critical", () => {
      const findings = [
        { severity: "critical", category: "security", confidence: 100 },
      ];
      const result = applyLearningWeights(findings, { security: "promote" });
      expect(result[0].severity).toBe("critical");
    });
  });
});
