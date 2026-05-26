import { describe, it, expect, vi } from "vitest";
import { computeSafetyScore } from "../safety-score.js";
import type { AttributionResult } from "../attribution.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// computeSafetyScore
// ---------------------------------------------------------------------------

describe("computeSafetyScore", () => {
  it("returns 100 for no findings", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(100);
  });

  it("deducts for critical findings", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "critical", category: "security" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(75);
    expect(result.factors.findingPenalty).toBe(25);
  });

  it("deducts for high findings", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "high", category: "bug" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(90);
    expect(result.factors.findingPenalty).toBe(10);
  });

  it("deducts for medium findings", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "medium", category: "style" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(95);
  });

  it("deducts for low findings", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "low", category: "style" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(98);
  });

  it("deducts for nitpick findings", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "nitpick", category: "style" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(99);
  });

  it("accumulates penalties from multiple findings", () => {
    const result = computeSafetyScore({
      findings: [
        { severity: "critical", category: "security" },
        { severity: "high", category: "bug" },
        { severity: "medium", category: "style" },
      ],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(60); // 100 - 25 - 10 - 5
  });

  it("deducts for blast radius >5 files", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 7,
      attribution: null,
    });
    expect(result.score).toBe(95);
    expect(result.factors.blastRadiusPenalty).toBe(5);
  });

  it("deducts more for blast radius >10 files", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 15,
      attribution: null,
    });
    expect(result.score).toBe(90);
    expect(result.factors.blastRadiusPenalty).toBe(10);
  });

  it("no blast radius penalty for ≤5 files", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 5,
      attribution: null,
    });
    expect(result.factors.blastRadiusPenalty).toBe(0);
  });

  it("adjusts for high dismissal attribution", () => {
    const attribution: AttributionResult = {
      categories: [{
        category: "style", total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    };
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution,
    });
    expect(result.factors.attributionAdjustment).toBeGreaterThan(0);
    expect(result.factors.attributionAdjustment).toBe(2); // 1 reliable high-dismissal category → +2
  });

  it("no attribution bonus without reliable categories", () => {
    const attribution: AttributionResult = {
      categories: [{
        category: "style", total: 3, helpful: 0, dismissed: 3,
        dismissalRate: 1.0, confidencePenalty: 75, isReliable: false,
      }],
      reliableCategories: 0,
      entriesAnalyzed: 3,
    };
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution,
    });
    expect(result.factors.attributionAdjustment).toBe(0);
  });

  it("deducts for high risk score (4+)", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 4,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.factors.riskAdjustment).toBe(-10);
    expect(result.score).toBe(90);
  });

  it("deducts for medium risk score (3)", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 3,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.factors.riskAdjustment).toBe(-5);
    expect(result.score).toBe(95);
  });

  it("no risk adjustment for low risk (1-2)", () => {
    const result = computeSafetyScore({
      findings: [],
      riskScore: 2,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.factors.riskAdjustment).toBe(0);
    expect(result.score).toBe(100);
  });

  it("clamps score at 0 minimum", () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({
      severity: "critical", category: "security",
    }));
    const result = computeSafetyScore({
      findings,
      riskScore: 5,
      blastRadiusFiles: 20,
      attribution: null,
    });
    expect(result.score).toBe(0);
  });

  it("clamps score at 100 maximum", () => {
    const attribution: AttributionResult = {
      categories: Array.from({ length: 5 }, (_, i) => ({
        category: `cat${i}`, total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      })),
      reliableCategories: 5,
      entriesAnalyzed: 75,
    };
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution,
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("caps attribution bonus at 10", () => {
    const attribution: AttributionResult = {
      categories: Array.from({ length: 10 }, (_, i) => ({
        category: `cat${i}`, total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      })),
      reliableCategories: 10,
      entriesAnalyzed: 150,
    };
    const result = computeSafetyScore({
      findings: [],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution,
    });
    expect(result.factors.attributionAdjustment).toBeLessThanOrEqual(10);
  });

  it("deducts 1 point per unknown severity finding", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "unknown", category: "other" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(99);
  });

  it("accumulates unknown severity penalties", () => {
    const result = computeSafetyScore({
      findings: [
        { severity: "unknown", category: "other" },
        { severity: "unknown", category: "other" },
        { severity: "unknown", category: "other" },
      ],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(97);
    expect(result.factors.findingPenalty).toBe(3);
  });

  it("combines all penalty types", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "high", category: "bug" }],
      riskScore: 4,
      blastRadiusFiles: 15,
      attribution: null,
    });
    expect(result.score).toBe(70); // 100 - 10 (high) - 10 (blast) - 10 (risk) = 70
    expect(result.factors.findingPenalty).toBe(10);
    expect(result.factors.blastRadiusPenalty).toBe(10);
    expect(result.factors.riskAdjustment).toBe(-10);
  });

  it("combines findings and attribution bonus", () => {
    const attribution: AttributionResult = {
      categories: [{
        category: "style", total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    };
    const result = computeSafetyScore({
      findings: [{ severity: "medium", category: "bug" }],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution,
    });
    expect(result.score).toBe(97); // 100 - 5 (medium) + 2 (attribution) = 97
  });

  it("risk score 5 gives same penalty as 4", () => {
    const r4 = computeSafetyScore({ findings: [], riskScore: 4, blastRadiusFiles: 0, attribution: null });
    const r5 = computeSafetyScore({ findings: [], riskScore: 5, blastRadiusFiles: 0, attribution: null });
    expect(r5.factors.riskAdjustment).toBe(-10);
    expect(r5.score).toBe(r4.score);
  });

  it("blast radius exactly 6 gets penalty", () => {
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 6, attribution: null });
    expect(result.factors.blastRadiusPenalty).toBe(5);
  });

  it("attribution with 0.61 dismissal rate is high-dismissal", () => {
    const attribution: AttributionResult = {
      categories: [{
        category: "style", total: 15, helpful: 6, dismissed: 9,
        dismissalRate: 0.61, confidencePenalty: 45, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    };
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 0, attribution });
    expect(result.factors.attributionAdjustment).toBe(2);
  });

  it("attribution with <0.6 dismissal rate is not high-dismissal", () => {
    const attribution: AttributionResult = {
      categories: [{
        category: "style", total: 15, helpful: 7, dismissed: 8,
        dismissalRate: 0.53, confidencePenalty: 0, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 15,
    };
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 0, attribution });
    expect(result.factors.attributionAdjustment).toBe(0);
  });

  it("multiple findings with all severity levels", () => {
    const result = computeSafetyScore({
      findings: [
        { severity: "critical", category: "security" },
        { severity: "high", category: "bug" },
        { severity: "medium", category: "style" },
        { severity: "low", category: "style" },
        { severity: "nitpick", category: "style" },
      ],
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(57); // 100 - 25 - 10 - 5 - 2 - 1
    expect(result.factors.findingPenalty).toBe(43);
  });

  it("score exactly 70 is success state boundary", () => {
    const result = computeSafetyScore({
      findings: Array.from({ length: 3 }, () => ({ severity: "high", category: "bug" })),
      riskScore: 1,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(70);
  });

  it("score drops below 40 with enough penalties", () => {
    const result = computeSafetyScore({
      findings: [
        { severity: "critical", category: "security" },
        { severity: "critical", category: "security" },
      ],
      riskScore: 3,
      blastRadiusFiles: 0,
      attribution: null,
    });
    expect(result.score).toBe(45); // 100 - 25*2 - 5(risk) = 45
  });

  it("blast radius exactly 5 gets no penalty", () => {
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 5, attribution: null });
    expect(result.factors.blastRadiusPenalty).toBe(0);
    expect(result.score).toBe(100);
  });

  it("blast radius exactly 11 gets >10 penalty", () => {
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 11, attribution: null });
    expect(result.factors.blastRadiusPenalty).toBe(10);
  });

  it("attribution with 3 reliable high-dismissal categories gives +6", () => {
    const attribution: AttributionResult = {
      categories: [
        { category: "style", total: 15, helpful: 2, dismissed: 13, dismissalRate: 0.87, confidencePenalty: 65, isReliable: true },
        { category: "nitpick", total: 12, helpful: 1, dismissed: 11, dismissalRate: 0.92, confidencePenalty: 69, isReliable: true },
        { category: "docs", total: 20, helpful: 3, dismissed: 17, dismissalRate: 0.85, confidencePenalty: 63, isReliable: true },
      ],
      reliableCategories: 3,
      entriesAnalyzed: 47,
    };
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 0, attribution });
    expect(result.factors.attributionAdjustment).toBe(6);
  });

  it("attribution with reliable but low-dismissal category gives no bonus", () => {
    const attribution: AttributionResult = {
      categories: [{
        category: "bug", total: 20, helpful: 15, dismissed: 5,
        dismissalRate: 0.25, confidencePenalty: 0, isReliable: true,
      }],
      reliableCategories: 1,
      entriesAnalyzed: 20,
    };
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 0, attribution });
    expect(result.factors.attributionAdjustment).toBe(0);
  });

  it("all combined penalties with attribution bonus", () => {
    const attribution: AttributionResult = {
      categories: Array.from({ length: 5 }, (_, i) => ({
        category: `cat${i}`, total: 15, helpful: 2, dismissed: 13,
        dismissalRate: 0.87, confidencePenalty: 65, isReliable: true,
      })),
      reliableCategories: 5,
      entriesAnalyzed: 75,
    };
    const result = computeSafetyScore({
      findings: [{ severity: "high", category: "bug" }],
      riskScore: 4,
      blastRadiusFiles: 7,
      attribution,
    });
    // 100 - 10(finding) - 5(blast) + 10(attribution capped) - 10(risk) = 85
    expect(result.score).toBe(85);
    expect(result.factors.attributionAdjustment).toBe(10);
  });

  it("zero findings with risk 2 gives no risk adjustment", () => {
    const result = computeSafetyScore({ findings: [], riskScore: 2, blastRadiusFiles: 0, attribution: null });
    expect(result.factors.riskAdjustment).toBe(0);
    expect(result.score).toBe(100);
  });

  it("large number of critical findings clamped at 0", () => {
    const findings = Array.from({ length: 10 }, () => ({ severity: "critical", category: "security" }));
    const result = computeSafetyScore({ findings, riskScore: 5, blastRadiusFiles: 20, attribution: null });
    expect(result.score).toBe(0);
    expect(result.factors.findingPenalty).toBe(250);
  });

  it("attribution with mix of reliable and unreliable categories", () => {
    const attribution: AttributionResult = {
      categories: [
        { category: "style", total: 15, helpful: 2, dismissed: 13, dismissalRate: 0.87, confidencePenalty: 65, isReliable: true },
        { category: "perf", total: 3, helpful: 0, dismissed: 3, dismissalRate: 1.0, confidencePenalty: 75, isReliable: false },
      ],
      reliableCategories: 1,
      entriesAnalyzed: 18,
    };
    const result = computeSafetyScore({ findings: [], riskScore: 1, blastRadiusFiles: 0, attribution });
    expect(result.factors.attributionAdjustment).toBe(2);
  });

  it("returns correct factors object structure", () => {
    const result = computeSafetyScore({
      findings: [{ severity: "medium", category: "bug" }],
      riskScore: 3,
      blastRadiusFiles: 6,
      attribution: null,
    });
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("factors");
    expect(result.factors).toHaveProperty("findingPenalty");
    expect(result.factors).toHaveProperty("blastRadiusPenalty");
    expect(result.factors).toHaveProperty("attributionAdjustment");
    expect(result.factors).toHaveProperty("riskAdjustment");
    expect(typeof result.factors.findingPenalty).toBe("number");
    expect(typeof result.factors.blastRadiusPenalty).toBe("number");
    expect(typeof result.factors.attributionAdjustment).toBe("number");
    expect(typeof result.factors.riskAdjustment).toBe("number");
  });

  it("risk score exactly 3 gives medium penalty", () => {
    const result = computeSafetyScore({ findings: [], riskScore: 3, blastRadiusFiles: 0, attribution: null });
    expect(result.factors.riskAdjustment).toBe(-5);
  });

  it("risk score exactly 4 gives high penalty", () => {
    const result = computeSafetyScore({ findings: [], riskScore: 4, blastRadiusFiles: 0, attribution: null });
    expect(result.factors.riskAdjustment).toBe(-10);
  });
});
