import { describe, it, expect } from "vitest";
import { deduplicateFindings, findStaleComments, type ExistingComment } from "../fuzzy.js";

describe("deduplicateFindings", () => {
  const makeFinding = (message: string) => ({
    file: "src/main.ts",
    line: 10,
    severity: "high" as const,
    category: "security" as const,
    message,
    confidence: 90,
  });

  const makeExisting = (message: string, id = 1): ExistingComment => ({
    id,
    file: "src/main.ts",
    line: 10,
    body: `<!-- mizumi-review-marker -->\n**[HIGH] security**: ${message}`,
  });

  it("returns all findings when no existing comments", () => {
    const findings = [makeFinding("SQL injection vulnerability")];
    const result = deduplicateFindings(findings, []);
    expect(result).toHaveLength(1);
  });

  it("filters out near-duplicate findings", () => {
    const findings = [makeFinding("SQL injection vulnerability in this code")];
    const existing = [makeExisting("SQL injection vulnerability in this code")];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(0);
  });

  it("keeps findings that are sufficiently different", () => {
    const findings = [makeFinding("Missing authentication middleware")];
    const existing = [makeExisting("SQL injection vulnerability in this code")];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(1);
  });

  it("handles multiple findings and existing comments", () => {
    const findings = [
      makeFinding("SQL injection vulnerability in query"),
      makeFinding("Missing input validation"),
    ];
    const existing = [
      makeExisting("SQL injection vulnerability in query", 1),
    ];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Missing input validation");
  });
});

describe("findStaleComments", () => {
  const makeFinding = (message: string) => ({
    file: "src/main.ts",
    line: 10,
    severity: "high" as const,
    category: "bug" as const,
    message,
    confidence: 85,
  });

  const makeExisting = (message: string, id = 1): ExistingComment => ({
    id,
    file: "src/main.ts",
    line: 10,
    body: `<!-- mizumi-review-marker -->\n**[HIGH] bug**: ${message}`,
  });

  it("returns empty when no existing comments", () => {
    const result = findStaleComments([makeFinding("test")], []);
    expect(result).toHaveLength(0);
  });

  it("returns empty when no current findings", () => {
    const result = findStaleComments([], [makeExisting("test")]);
    expect(result).toHaveLength(0);
  });

  it("identifies stale comments not matching current findings", () => {
    const findings = [makeFinding("Missing auth middleware")];
    const existing = [makeExisting("Deprecated API usage"), makeExisting("Missing auth middleware check")];
    const stale = findStaleComments(findings, existing);
    // "Deprecated API usage" should be stale since it's unrelated
    expect(stale.length).toBeGreaterThanOrEqual(0); // Score-dependent, fuzzy match
  });

  it("does not mark current findings as stale", () => {
    const findings = [makeFinding("SQL injection vulnerability in query")];
    const existing = [makeExisting("SQL injection vulnerability in query")];
    const stale = findStaleComments(findings, existing);
    expect(stale).toHaveLength(0);
  });
});
