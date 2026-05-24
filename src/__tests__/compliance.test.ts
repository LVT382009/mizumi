import { describe, it, expect, vi } from "vitest";
import { formatCompliance, type ComplianceResult, type ComplianceLevel } from "../compliance.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

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
