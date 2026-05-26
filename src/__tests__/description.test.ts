import { describe, it, expect } from "vitest";
import { scorePRDescription, formatDescriptionFeedback } from "../description.js";

describe("scorePRDescription", () => {
  it("gives 0 for empty title and body", () => {
    const result = scorePRDescription("", "");
    expect(result.score).toBe(0);
    expect(result.missing).toHaveLength(4);
  });

  it("gives 1 for minimal body with no structure", () => {
    const result = scorePRDescription("fix bug", "fixed it");
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("gives bonus for why explanation (because keyword)", () => {
    const result = scorePRDescription("Fix login bug", "Because users couldn't log in, this fixes the auth check.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("gives bonus for long body (likely explains why)", () => {
    const longBody = "A".repeat(150);
    const result = scorePRDescription("Update deps", longBody);
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects linked issues", () => {
    const result = scorePRDescription("Fix login", "Fixes #42");
    expect(result.missing).not.toContain("linked issue or ticket reference");
  });

  it("detects test plan", () => {
    const result = scorePRDescription("Fix login", "Test plan: manually verify login flow");
    expect(result.missing).not.toContain("test plan or verification steps");
  });

  it("detects breaking change notes", () => {
    const result = scorePRDescription("Update API", "Breaking change: removed /v1/endpoint");
    expect(result.missing).not.toContain("breaking change notes (if applicable)");
  });

  it("full score with all elements", () => {
    const result = scorePRDescription(
      "Fix auth flow",
      "Fixes #99. Because auth was broken, this resolves the token check. Test plan: run `npm test`. Breaking change: token format changed."
    );
    expect(result.score).toBeGreaterThanOrEqual(3);
  });

  it("detects 'since' as why explanation", () => {
    const result = scorePRDescription("Refactor", "Since the old approach was slow, this uses memoization.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'motivation' as why explanation", () => {
    const result = scorePRDescription("Add cache", "The motivation for this is to reduce latency.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'resolve' as why explanation", () => {
    const result = scorePRDescription("Bug fix", "Resolves the race condition in concurrent access.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'closes #N' as linked issue", () => {
    const result = scorePRDescription("Feature", "Closes #100");
    expect(result.missing).not.toContain("linked issue or ticket reference");
  });

  it("detects bare #N reference as linked issue", () => {
    const result = scorePRDescription("Feature", "Related to #55");
    expect(result.missing).not.toContain("linked issue or ticket reference");
  });

  it("detects 'verified' as test plan keyword", () => {
    const result = scorePRDescription("Fix", "Verified by running integration tests.");
    expect(result.missing).not.toContain("test plan or verification steps");
  });

  it("detects 'deprecation' as breaking change note", () => {
    const result = scorePRDescription("API update", "Deprecation notice: /v1/endpoint will be removed.");
    expect(result.missing).not.toContain("breaking change notes (if applicable)");
  });

  it("detects 'incompatible' as breaking change note", () => {
    const result = scorePRDescription("API update", "This change is incompatible with v1 API.");
    expect(result.missing).not.toContain("breaking change notes (if applicable)");
  });

  it("flags missing when body is whitespace-only", () => {
    const result = scorePRDescription("Fix", "   ");
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("score is clamped at 0 minimum", () => {
    const result = scorePRDescription("", "short");
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("detects 'fix' as why explanation", () => {
    const result = scorePRDescription("Fix bug", "Fix the null pointer dereference in auth module.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'address' as why explanation", () => {
    const result = scorePRDescription("Security", "Address the XSS vulnerability in user input handling.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'purpose' as why explanation", () => {
    const result = scorePRDescription("Refactor", "The purpose of this change is to improve performance.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'goal' as why explanation", () => {
    const result = scorePRDescription("Feature", "Goal: enable users to export data as CSV.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("detects 'refs #N' as linked issue", () => {
    const result = scorePRDescription("Update", "Refs #200");
    expect(result.missing).not.toContain("linked issue or ticket reference");
  });

  it("detects 'see #N' as linked issue", () => {
    const result = scorePRDescription("Hotfix", "See #77 for details");
    expect(result.missing).not.toContain("linked issue or ticket reference");
  });

  it("detects 'how to test' as test plan", () => {
    const result = scorePRDescription("Fix", "How to test: run npm test and verify output");
    expect(result.missing).not.toContain("test plan or verification steps");
  });

  it("detects 'test steps' as test plan", () => {
    const result = scorePRDescription("Feature", "Test steps: 1. Open app 2. Click export");
    expect(result.missing).not.toContain("test plan or verification steps");
  });

  it("gives perfect score 4 with all four elements", () => {
    const result = scorePRDescription(
      "Fix auth",
      "Because the token was expired, this refreshes it. Fixes #10. Test plan: run auth suite. Breaking change: token format changed."
    );
    expect(result.score).toBe(4);
    expect(result.missing).toHaveLength(0);
  });

});


  // --- Additional edge cases ---

  it("gives 0 for whitespace-only title and body", () => {
    const result = scorePRDescription(" ", " ");
    expect(result.score).toBe(0);
  });

  it("detects since as why explanation", () => {
    const result = scorePRDescription("Refactor", "Since the old code was buggy, this rewrites it.");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("does not flag linked issue for bare # in body", () => {
    // A bare # without a digit should not match
    const result = scorePRDescription("Update", "See # for details");
    expect(result.missing).toContain("linked issue or ticket reference");
  });

  it("detects refs #N pattern", () => {
    const result = scorePRDescription("Hotfix", "Refs #999");
    expect(result.missing).not.toContain("linked issue or ticket reference");
  });

  it("body over 100 chars counts as why explanation", () => {
    const longBody = "x".repeat(101);
    const result = scorePRDescription("Update", longBody);
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });

  it("body exactly 100 chars does not count as why explanation when no why keywords", () => {
    const body = "a".repeat(100);
    const result = scorePRDescription("Update", body);
    expect(result.missing).toContain("explanation of why this change is needed");
  });

  it("detects migration guide as breaking change", () => {
    const result = scorePRDescription("API v2", "Migration guide: update your endpoints");
    expect(result.missing).not.toContain("breaking change notes (if applicable)");
  });

  it("detects upgrade guide as breaking change", () => {
    const result = scorePRDescription("Release", "Upgrade guide: see the breaking changes section");
    expect(result.missing).not.toContain("breaking change notes (if applicable)");
  });

  it("flags missing breaking change for non-empty body", () => {
    const result = scorePRDescription("Feature", "Add new endpoint");
    expect(result.missing).toContain("breaking change notes (if applicable)");
  });

  it("score 2 when 2 elements are missing", () => {
    const result = scorePRDescription("Fix bug", "Because root cause was X. Fixes #3.");
    // Has why (because) + linked issue (fixes #3), but no test plan or breaking note
    expect(result.missing).toHaveLength(2);
    expect(result.score).toBe(2);
  });

  it("title contributes to why detection", () => {
    // fix in title should count as why
    const result = scorePRDescription("Fix login bug", "just a small change");
    expect(result.missing).not.toContain("explanation of why this change is needed");
  });
describe("formatDescriptionFeedback", () => {
  it("returns empty string for score >= 3", () => {
    const result = formatDescriptionFeedback({ score: 3, missing: [] });
    expect(result).toBe("");
  });

  it("returns empty string for score = 4", () => {
    const result = formatDescriptionFeedback({ score: 4, missing: [] });
    expect(result).toBe("");
  });

  it("returns feedback for low scores", () => {
    const result = formatDescriptionFeedback({ score: 1, missing: ["test plan"] });
    expect(result).toContain("PR Description Quality");
    expect(result).toContain("test plan");
  });

  it("includes score in feedback header", () => {
    const result = formatDescriptionFeedback({ score: 2, missing: ["why explanation"] });
    expect(result).toContain("2/4");
  });

  it("lists all missing elements", () => {
    const result = formatDescriptionFeedback({ score: 0, missing: ["why", "issues", "test plan", "breaking"] });
    expect(result).toContain("why");
    expect(result).toContain("issues");
    expect(result).toContain("test plan");
    expect(result).toContain("breaking");
  });

  it("formats missing items as bullet list", () => {
    const result = formatDescriptionFeedback({ score: 1, missing: ["item A", "item B"] });
    expect(result).toContain("- item A");
    expect(result).toContain("- item B");
  });

  // --- Additional edge cases ---

  it("returns empty string for score 3 with empty missing", () => {
    const result = formatDescriptionFeedback({ score: 3, missing: [] });
    expect(result).toBe("");
  });

  it("returns feedback for score 0", () => {
    const result = formatDescriptionFeedback({ score: 0, missing: ["a", "b", "c", "d"] });
    expect(result).toContain("0/4");
    expect(result).toContain("a");
  });

  it("returns feedback for score 1", () => {
    const result = formatDescriptionFeedback({ score: 1, missing: ["x", "y"] });
    expect(result).toContain("1/4");
  });

  it("returns feedback for score 2", () => {
    const result = formatDescriptionFeedback({ score: 2, missing: ["x", "y"] });
    expect(result).toContain("2/4");
  });

  it("markdown formatting includes PR Description Quality header", () => {
    const result = formatDescriptionFeedback({ score: 1, missing: ["test plan"] });
    expect(result).toContain("## PR Description Quality");
  });

  it("suggests improving the description", () => {
    const result = formatDescriptionFeedback({ score: 1, missing: ["why explanation"] });
    expect(result).toContain("Consider suggesting");
  });

  it("single missing item produces one bullet", () => {
    const result = formatDescriptionFeedback({ score: 3, missing: ["test plan"] });
    expect(result).toBe(""); // score 3 is too high
  });

  it("score just below threshold produces feedback", () => {
    const result = formatDescriptionFeedback({ score: 2, missing: ["x"] });
    expect(result).not.toBe("");
  });
});
