import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatCompliance, extractIssueRefs, type ComplianceResult, type ComplianceLevel } from "../compliance.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

// ---------------------------------------------------------------------------
// extractIssueRefs — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("extractIssueRefs", () => {
  it("extracts 'closes #123' reference", () => {
    expect(extractIssueRefs("closes #123")).toEqual([123]);
  });

  it("extracts 'fix #456' reference", () => {
    expect(extractIssueRefs("fix #456")).toEqual([456]);
  });

  it("extracts 'fixed #789' reference", () => {
    expect(extractIssueRefs("fixed #789")).toEqual([789]);
  });

  it("extracts 'fixes #100' reference", () => {
    expect(extractIssueRefs("fixes #100")).toEqual([100]);
  });

  it("extracts 'resolve #200' reference", () => {
    expect(extractIssueRefs("resolve #200")).toEqual([200]);
  });

  it("extracts 'resolves #300' reference", () => {
    expect(extractIssueRefs("resolves #300")).toEqual([300]);
  });

  it("extracts 'resolved #400' reference", () => {
    expect(extractIssueRefs("resolved #400")).toEqual([400]);
  });

  it("extracts 'see #500' reference", () => {
    expect(extractIssueRefs("see #500")).toEqual([500]);
  });

  it("extracts 'reference #600' reference", () => {
    expect(extractIssueRefs("reference #600")).toEqual([600]);
  });

  it("extracts 'part of #700' reference", () => {
    expect(extractIssueRefs("part of #700")).toEqual([700]);
  });

  it("extracts 'related to #800' reference", () => {
    expect(extractIssueRefs("related to #800")).toEqual([800]);
  });

  it("extracts bare # references", () => {
    expect(extractIssueRefs("This addresses #42")).toEqual([42]);
  });

  it("extracts multiple different issue references", () => {
    const refs = extractIssueRefs("closes #1, fixes #2, see #3");
    expect(refs).toContain(1);
    expect(refs).toContain(2);
    expect(refs).toContain(3);
  });

  it("deduplicates same issue number", () => {
    const refs = extractIssueRefs("closes #1 and fixes #1");
    expect(refs).toEqual([1]);
  });

  it("limits to 5 unique references", () => {
    const refs = extractIssueRefs("see #1 #2 #3 #4 #5 #6 #7 #8");
    expect(refs.length).toBeLessThanOrEqual(5);
  });

  it("returns empty array for text with no references", () => {
    expect(extractIssueRefs("Just a regular PR description")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractIssueRefs("")).toEqual([]);
  });

  it("is case-insensitive for keywords", () => {
    expect(extractIssueRefs("Closes #10")).toEqual([10]);
    expect(extractIssueRefs("CLOSES #20")).toEqual([20]);
    expect(extractIssueRefs("Fix #30")).toEqual([30]);
  });

  it("handles PR body with mixed content", () => {
    const body = "## Changes\n\nThis PR adds authentication.\n\nCloses #42\n\nRelated to #99";
    const refs = extractIssueRefs(body);
    expect(refs).toContain(42);
    expect(refs).toContain(99);
  });
});

// ---------------------------------------------------------------------------
// formatCompliance — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("formatCompliance", () => {
  it("returns empty string for no results", () => {
    expect(formatCompliance([])).toBe("");
  });

  it("formats fully compliant result", () => {
    const results: ComplianceResult[] = [
      { issueNumber: 42, issueTitle: "Add auth middleware", compliance: "fully", summary: "All requirements addressed" },
    ];
    const body = formatCompliance(results);
    expect(body).toContain("### Issue Compliance");
    expect(body).toContain("#42");
    expect(body).toContain("Add auth middleware");
    expect(body).toContain("[PASS]");
    expect(body).toContain("All requirements addressed");
    expect(body).toContain("badge/compliance-fully-green");
  });

  it("formats partially compliant result", () => {
    const results: ComplianceResult[] = [
      { issueNumber: 10, issueTitle: "Fix rate limiting", compliance: "partially", summary: "Rate Limiter added but missing config" },
    ];
    const body = formatCompliance(results);
    expect(body).toContain("[WARN]");
    expect(body).toContain("badge/compliance-partially-yellow");
  });

  it("formats non-compliant result", () => {
    const results: ComplianceResult[] = [
      { issueNumber: 5, issueTitle: "Security audit", compliance: "not", summary: "Does not address security requirements" },
    ];
    const body = formatCompliance(results);
    expect(body).toContain("[FAIL]");
    expect(body).toContain("badge/compliance-not-red");
  });

  it("formats none compliance level (no badge)", () => {
    const results: ComplianceResult[] = [
      { issueNumber: 1, issueTitle: "Bug fix", compliance: "none", summary: "No API key for compliance check" },
    ];
    const body = formatCompliance(results);
    expect(body).toContain("#1");
    expect(body).not.toContain("badge/compliance");
  });

  it("formats multiple results", () => {
    const results: ComplianceResult[] = [
      { issueNumber: 1, issueTitle: "Feature A", compliance: "fully", summary: "Done" },
      { issueNumber: 2, issueTitle: "Feature B", compliance: "partially", summary: "Partial" },
      { issueNumber: 3, issueTitle: "Feature C", compliance: "not", summary: "Missing" },
    ];
    const body = formatCompliance(results);
    expect(body).toContain("#1");
    expect(body).toContain("#2");
    expect(body).toContain("#3");
  });
});
