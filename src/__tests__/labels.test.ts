import { describe, it, expect, vi } from "vitest";
import { computeLabels, applyLabels } from "../labels.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

function makeOctokit(currentLabels: string[] = []) {
  return {
    rest: {
      issues: {
        getLabel: vi.fn().mockRejectedValue(new Error("not found")),
        createLabel: vi.fn().mockResolvedValue({}),
        listLabelsOnIssue: vi.fn().mockResolvedValue({
          data: currentLabels.map((name) => ({ name })),
        }),
        addLabels: vi.fn().mockResolvedValue({}),
        removeLabel: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

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

  it("returns empty array for empty findings and low risk", () => {
    const labels = computeLabels([], 0);
    expect(labels).toHaveLength(0);
  });

  it("returns only needs-attention for empty findings with high risk", () => {
    const labels = computeLabels([], 5);
    expect(labels).toEqual(["needs-attention"]);
  });

  it("deduplicates when multiple findings map to same category label", () => {
    const labels = computeLabels(
      [
        { severity: "critical", category: "bug" },
        { severity: "high", category: "bug" },
        { severity: "medium", category: "bug" },
      ],
      2
    );
    const bugCount = labels.filter((l) => l === "bug").length;
    expect(bugCount).toBe(1);
  });

  it("applies needs-attention at risk score boundary 4", () => {
    const labels = computeLabels([], 4);
    expect(labels).toContain("needs-attention");
  });

  it("does not apply needs-attention at risk score just below boundary", () => {
    const labels = computeLabels([], 3);
    expect(labels).not.toContain("needs-attention");
  });

  it("applies review-heavy at exactly 10 findings", () => {
    const findings = Array.from({ length: 10 }, () => ({
      severity: "low" as const, category: "style" as const,
    }));
    const labels = computeLabels(findings, 1);
    expect(labels).toContain("review-heavy");
  });

  it("produces correct label set for mixed severity findings", () => {
    const labels = computeLabels(
      [
        { severity: "critical", category: "security" },
        { severity: "high", category: "bug" },
        { severity: "medium", category: "style" },
        { severity: "low", category: "compliance" },
      ],
      5
    );
    expect(labels).toContain("security");
    expect(labels).toContain("bug");
    expect(labels).toContain("style");
    expect(labels).toContain("compliance");
    expect(labels).toContain("needs-attention");
  });
});

describe("applyLabels", () => {
  it("returns empty result when no desired labels", async () => {
    const octokit = makeOctokit();
    const result = await applyLabels(octokit as any, "owner", "repo", 1, [], 1);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("adds desired labels not currently on PR", async () => {
    const octokit = makeOctokit([]);
    const result = await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "high", category: "security" }],
      3
    );
    expect(result.added).toContain("security");
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["security"] })
    );
  });

  it("skips labels already on the PR", async () => {
    const octokit = makeOctokit(["security"]);
    const result = await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "high", category: "security" }],
      3
    );
    expect(result.added).toHaveLength(0);
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("removes Mizumi labels no longer desired", async () => {
    const octokit = makeOctokit(["security", "bug"]);
    const result = await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "high", category: "security" }],
      3
    );
    expect(result.removed).toContain("bug");
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bug" })
    );
  });

  it("does not remove non-Mizumi labels", async () => {
    const octokit = makeOctokit(["security", "enhancement", "good first issue"]);
    const result = await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "high", category: "security" }],
      3
    );
    expect(result.removed).toHaveLength(0);
  });

  it("creates labels that don't exist in repo", async () => {
    const octokit = makeOctokit([]);
    await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "high", category: "security" }],
      3
    );
    expect(octokit.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "security" })
    );
  });

  it("returns both added and removed labels", async () => {
    const octokit = makeOctokit(["bug", "enhancement"]);
    const result = await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "critical", category: "security" }],
      5
    );
    expect(result.added).toContain("security");
    expect(result.added).toContain("needs-attention");
    expect(result.removed).toContain("bug");
  });

  it("handles removeLabel failure gracefully", async () => {
    const octokit = makeOctokit(["security", "bug"]);
    octokit.rest.issues.removeLabel.mockRejectedValueOnce(new Error("already removed"));
    const result = await applyLabels(
      octokit as any, "owner", "repo", 1,
      [{ severity: "high", category: "security" }],
      3
    );
    expect(result.removed).toContain("bug");
  });

  it("returns empty result with no findings and risk below 4", async () => {
    const octokit = makeOctokit();
    const result = await applyLabels(octokit as any, "owner", "repo", 1, [], 1);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it("handles addLabels API failure gracefully", async () => {
    const octokit = makeOctokit([]);
    octokit.rest.issues.addLabels.mockRejectedValueOnce(new Error("add failed"));
    await expect(
      applyLabels(octokit as any, "owner", "repo", 1, [{ severity: "high", category: "security" }], 3)
    ).rejects.toThrow("add failed");
  });

  it("handles listLabelsOnIssue API failure gracefully", async () => {
    const octokit = makeOctokit([]);
    octokit.rest.issues.listLabelsOnIssue.mockRejectedValueOnce(new Error("label list failed"));
    // computeLabels returns ["security"], so applyLabels proceeds past ensureLabel
    await expect(
      applyLabels(octokit as any, "owner", "repo", 1, [{ severity: "high", category: "security" }], 3)
    ).rejects.toThrow("label list failed");
  });
});
