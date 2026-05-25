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
});
