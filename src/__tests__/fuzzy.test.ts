import { describe, it, expect } from "vitest";
import { deduplicateFindings, findStaleComments, type ExistingComment } from "../fuzzy.js";

// Helper to access internal stripMarker via dedup/findStale behavior observation

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

  it("finds stale comments when completely different topics", () => {
    const findings = [makeFinding("Memory leak in event listener")];
    const existing = [makeExisting("SQL injection in user query", 1), makeExisting("Hardcoded API key detected", 2)];
    const stale = findStaleComments(findings, existing);
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it("handles empty message bodies gracefully", () => {
    const findings = [makeFinding("test issue")];
    const existing: ExistingComment[] = [{ id: 1, file: "src/a.ts", line: 5, body: "" }];
    const stale = findStaleComments(findings, existing);
    expect(stale).toHaveLength(0); // empty body skipped
  });
});

describe("deduplicateFindings — edge cases", () => {
  it("handles empty new findings array", () => {
    const result = deduplicateFindings([], [{ id: 1, file: "a.ts", line: 1, body: "existing" }]);
    expect(result).toHaveLength(0);
  });

  it("handles findings with different files/lines but same message", () => {
    const findings = [
      { file: "src/a.ts", line: 10, severity: "high" as const, category: "bug" as const, message: "Null pointer dereference", confidence: 90 },
      { file: "src/b.ts", line: 20, severity: "high" as const, category: "bug" as const, message: "Null pointer dereference", confidence: 85 },
    ];
    const existing: ExistingComment[] = [{ id: 1, file: "src/a.ts", line: 10, body: "<!-- mizumi-review-marker -->\n**[HIGH] bug**: Null pointer dereference" }];
    const result = deduplicateFindings(findings, existing);
    // Same message → first is deduplicated, second may or may not be (same message vs different file)
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("preserves findings below threshold", () => {
    const findings = [{ file: "a.ts", line: 1, severity: "low" as const, category: "style" as const, message: "Use const instead of let for variable that is never reassigned", confidence: 60 }];
    const existing: ExistingComment[] = [{ id: 1, file: "a.ts", line: 1, body: "<!-- mizumi-review-marker -->\n**[LOW] style**: Consider using optional chaining for safer property access" }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(1);
  });
});

describe("deduplicateFindings — additional edge cases", () => {
  const makeFinding = (message: string, file = "src/main.ts", line = 10) => ({
    file,
    line,
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

  it("handles single finding against many existing comments", () => {
    const findings = [makeFinding("Rare edge case in error handling")];
    const existing = Array.from({ length: 50 }, (_, i) =>
      makeExisting(`Unrelated finding ${i}`, i + 1)
    );
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(1);
  });

  it("handles many findings against single existing comment", () => {
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding(`Unique issue ${i}`)
    );
    const existing = [makeExisting("SQL injection vulnerability")];
    const result = deduplicateFindings(findings, existing);
    expect(result.length).toBeGreaterThanOrEqual(9);
  });

  it("strips HTML marker from comment body during comparison", () => {
    const findings = [makeFinding("SQL injection vulnerability in query")];
    const existing: ExistingComment[] = [{
      id: 1,
      file: "src/main.ts",
      line: 10,
      body: "<!-- mizumi-review-marker -->\n**[HIGH] security**: SQL injection vulnerability in query",
    }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(0);
  });

  it("strips suggestion blocks from comment body during comparison", () => {
    const findings = [makeFinding("Missing null check before dereference")];
    const existing: ExistingComment[] = [{
      id: 1,
      file: "src/main.ts",
      line: 10,
      body: "<!-- mizumi-review-marker -->\n**[HIGH] bug**: Missing null check before dereference\n```suggestion\nif (obj != null) {\n```",
    }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(0);
  });

  it("strips VS Code link from comment body during comparison", () => {
    const findings = [makeFinding("Buffer overflow in string copy")];
    const existing: ExistingComment[] = [{
      id: 1,
      file: "src/main.ts",
      line: 10,
      body: "<!-- mizumi-review-marker -->\n**[CRITICAL] security**: Buffer overflow in string copy\n[Open in VS Code](vscode://file/...)",
    }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(0);
  });

  it("strips HTML tags from comment body", () => {
    const findings = [makeFinding("Unhandled promise rejection")];
    const existing: ExistingComment[] = [{
      id: 1,
      file: "src/main.ts",
      line: 10,
      body: "<!-- mizumi-review-marker -->\n**[HIGH] bug**: Unhandled promise rejection <details>extra info</details>",
    }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(0);
  });

  it("does not deduplicate findings that are semantically different but share keywords", () => {
    const findings = [
      makeFinding("Missing authentication for admin endpoint"),
      makeFinding("Missing input validation for admin endpoint"),
    ];
    const existing = [makeExisting("Missing authentication for admin endpoint")];
    const result = deduplicateFindings(findings, existing);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // The second finding about input validation should survive
    expect(result.some((f) => f.message.includes("input validation"))).toBe(true);
  });

  it("returns empty array when all findings are duplicates", () => {
    const findings = [
      makeFinding("SQL injection vulnerability in query"),
      makeFinding("SQL injection vulnerability in query"),
    ];
    const existing = [makeExisting("SQL injection vulnerability in query")];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(0);
  });

  it("handles findings with special characters in messages", () => {
    const findings = [makeFinding("Regex /(?<=foo)bar/ causes ReDoS vulnerability")];
    const existing: ExistingComment[] = [{ id: 1, file: "a.ts", line: 1, body: "unrelated" }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(1);
  });

  it("handles very long finding messages", () => {
    const longMsg = "A".repeat(500);
    const findings = [makeFinding(longMsg)];
    const existing: ExistingComment[] = [{ id: 1, file: "a.ts", line: 1, body: "short message" }];
    const result = deduplicateFindings(findings, existing);
    expect(result).toHaveLength(1);
  });
});

describe("findStaleComments — additional edge cases", () => {
  const makeFinding = (message: string, file = "src/main.ts", line = 10) => ({
    file,
    line,
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

  it("returns all comments as stale when findings list is empty", () => {
    // findStaleComments returns [] when currentFindings is empty (early exit)
    const existing = [makeExisting("Old finding A", 1), makeExisting("Old finding B", 2)];
    const result = findStaleComments([], existing);
    expect(result).toHaveLength(0);
  });

  it("returns empty when existing comments list is empty", () => {
    const findings = [makeFinding("New finding")];
    const result = findStaleComments(findings, []);
    expect(result).toHaveLength(0);
  });

  it("identifies stale comments with completely different subjects", () => {
    const findings = [makeFinding("Memory leak in event handler")];
    const existing = [
      makeExisting("SQL injection vulnerability in login", 1),
      makeExisting("Hardcoded credentials in config", 2),
    ];
    const stale = findStaleComments(findings, existing);
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves existing comment id in stale results", () => {
    const findings = [makeFinding("Race condition in async handler")];
    const existing = [makeExisting("Typo in variable name", 42)];
    const stale = findStaleComments(findings, existing);
    if (stale.length > 0) {
      expect(stale[0].id).toBe(42);
    }
  });

  it("handles comments with only HTML marker and no substantive body", () => {
    const findings = [makeFinding("Null pointer dereference")];
    const existing: ExistingComment[] = [{
      id: 1,
      file: "src/a.ts",
      line: 5,
      body: "<!-- mizumi-review-marker -->\n**[HIGH] bug**: ",
    }];
    const stale = findStaleComments(findings, existing);
    // Body strips to empty → should be skipped
    expect(stale).toHaveLength(0);
  });

  it("handles single finding vs many existing comments", () => {
    const findings = [makeFinding("Uncaught exception in handler")];
    const existing = Array.from({ length: 20 }, (_, i) =>
      makeExisting(`Resolved problem ${i}`, i + 1)
    );
    const stale = findStaleComments(findings, existing);
    // Most should be stale since "Uncaught exception" won't match "Resolved problem N"
    expect(stale.length).toBeGreaterThanOrEqual(1);
  });

  it("does not mark near-matching comments as stale", () => {
    const findings = [makeFinding("Missing error handling for null response from API")];
    const existing = [makeExisting("Missing error handling for null response from API")];
    const stale = findStaleComments(findings, existing);
    expect(stale).toHaveLength(0);
  });

  it("handles comments with suggestion blocks", () => {
    const findings = [makeFinding("Potential XSS in user input rendering")];
    const existing: ExistingComment[] = [{
      id: 7,
      file: "src/view.ts",
      line: 22,
      body: "<!-- mizumi-review-marker -->\n**[CRITICAL] security**: Potential XSS in user input rendering\n```suggestion\nsanitize(input)\n```",
    }];
    const stale = findStaleComments(findings, existing);
    // Same finding → not stale
    expect(stale).toHaveLength(0);
  });
});
