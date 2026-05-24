import { describe, it, expect, vi } from "vitest";
import { computeLabels } from "../labels.js";

describe("computeLabels", () => {
  it("applies security label for security findings", () => {
    const labels = computeLabels(
      [{ severity: "high", category: "security" }],
      3
    );
    expect(labels).toContain("security");
    expect(labels).not.toContain("bug");
  });

  it("applies bug label for bug findings", () => {
    const labels = computeLabels(
      [{ severity: "medium", category: "bug" }],
      2
    );
    expect(labels).toContain("bug");
  });

  it("applies style label for style findings", () => {
    const labels = computeLabels(
      [{ severity: "low", category: "style" }],
      1
    );
    expect(labels).toContain("style");
  });

  it("applies needs-attention for risk >= 4", () => {
    const labels = computeLabels(
      [{ severity: "high", category: "security" }],
      4
    );
    expect(labels).toContain("needs-attention");
  });

  it("does not apply needs-attention for risk < 4", () => {
    const labels = computeLabels(
      [{ severity: "medium", category: "bug" }],
      3
    );
    expect(labels).not.toContain("needs-attention");
  });

  it("applies review-heavy for 10+ findings", () => {
    const findings = Array.from({ length: 12 }, () => ({
      severity: "low" as const, category: "style" as const,
    }));
    const labels = computeLabels(findings, 2);
    expect(labels).toContain("review-heavy");
  });

  it("does not apply review-heavy for < 10 findings", () => {
    const labels = computeLabels(
      [{ severity: "low", category: "style" }],
      1
    );
    expect(labels).not.toContain("review-heavy");
  });

  it("applies compliance label for compliance category", () => {
    const labels = computeLabels(
      [{ severity: "medium", category: "compliance" }],
      2
    );
    expect(labels).toContain("compliance");
  });

  it("applies multiple labels for mixed findings", () => {
    const labels = computeLabels(
      [
        { severity: "critical", category: "security" },
        { severity: "high", category: "bug" },
      ],
      5
    );
    expect(labels).toContain("security");
    expect(labels).toContain("bug");
    expect(labels).toContain("needs-attention");
  });

  it("returns empty for no findings and low risk", () => {
    const labels = computeLabels([], 1);
    expect(labels).toHaveLength(0);
  });

  it("deduplicates labels", () => {
    const labels = computeLabels(
      [
        { severity: "high", category: "security" },
        { severity: "medium", category: "security" },
        { severity: "low", category: "security" },
      ],
      2
    );
    const securityCount = labels.filter((l) => l === "security").length;
    expect(securityCount).toBe(1);
  });
});
