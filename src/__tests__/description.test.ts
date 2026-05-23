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
});

describe("formatDescriptionFeedback", () => {
  it("returns empty string for score >= 3", () => {
    const result = formatDescriptionFeedback({ score: 3, missing: [] });
    expect(result).toBe("");
  });

  it("returns feedback for low scores", () => {
    const result = formatDescriptionFeedback({ score: 1, missing: ["test plan"] });
    expect(result).toContain("PR Description Quality");
    expect(result).toContain("test plan");
  });
});
