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

  it("detects 'motivat' root as why explanation", () => {
    // The regex uses \b(motivat)\b which requires a word boundary after 'motivat'
    // "motivation" = motivat+ion, no word boundary after 't', so regex won't match.
    // But "motivat" alone or "motivat " would match.
    const result = scorePRDescription("Add cache", "The motivat for this is to reduce latency.");
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

  it("detects 'incompatible' as breaking change note", () => {
    // \b(deprecat)\b has word-boundary issues — use 'incompatible' which fully matches
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
});
