import { describe, it, expect } from "vitest";
import { shouldRunBehavioralAnalysis, formatBehavioralSummary } from "../behavioral.js";
import type { BehavioralSummaryType } from "../behavioral.js";

// ---------------------------------------------------------------------------
// shouldRunBehavioralAnalysis
// ---------------------------------------------------------------------------

describe("shouldRunBehavioralAnalysis", () => {
  it("returns false for less than 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 50, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 30, deletions: 5, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns false for 3 files but < 50 total lines", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 8, deletions: 2, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 5, deletions: 1, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns true for 3+ files with 50+ total lines", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 30, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 25, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 20, deletions: 5, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for many files but very small changes", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`, status: "modified" as const, additions: 1, deletions: 0, hunks: [],
    }));
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns true for exactly 50 lines across 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 20, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 3, deletions: 2, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for exactly 49 lines across 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 20, deletions: 9, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 3, deletions: 2, hunks: [] },
    ];
    // Total: 49 lines — just below threshold
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("counts additions and deletions separately", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 25, deletions: 0, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 0, deletions: 25, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 1, deletions: 0, hunks: [] },
    ];
    // Total: 51 lines (25+0+0+25+1+0)
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for empty files array", () => {
    expect(shouldRunBehavioralAnalysis([])).toBe(false);
  });

  it("returns false for single file with many lines", () => {
    const files = [
      { path: "big.ts", status: "modified" as const, additions: 500, deletions: 200, hunks: [] },
    ];
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatBehavioralSummary
// ---------------------------------------------------------------------------

describe("formatBehavioralSummary", () => {
  const sampleSummary: BehavioralSummaryType = {
    headline: "Adds OAuth2 PKCE flow and replaces session auth with token auth",
    changes: [
      {
        type: "replaced",
        area: "authentication",
        description: "Session-based authentication replaced with JWT token-based authentication",
        impact: "high",
        files: ["src/auth/session.ts", "src/auth/token.ts", "src/middleware.ts"],
      },
      {
        type: "added",
        area: "security",
        description: "OAuth2 PKCE flow added for public clients",
        impact: "medium",
        files: ["src/auth/pkce.ts", "src/auth/oauth.ts"],
      },
      {
        type: "removed",
        area: "error handling",
        description: "Legacy cookie-based error redirect removed",
        impact: "low",
        files: ["src/errors/redirect.ts"],
      },
    ],
    riskAreas: ["Session management", "Token refresh flow", "Cookie fallback"],
    testingFocus: "Verify JWT tokens are properly issued and refreshed, and that PKCE challenge/verifier pairs work for OAuth flows",
  };

  it("includes the headline in the summary tag", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain(sampleSummary.headline);
  });

  it("includes all change types with correct emoji", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("🟡");
    expect(result).toContain("🟢");
    expect(result).toContain("🔴");
  });

  it("includes impact badges", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("⚠️");
    expect(result).toContain("📋");
    expect(result).toContain("✏️");
  });

  it("includes file references", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("`src/auth/session.ts`");
    expect(result).toContain("`src/auth/token.ts`");
  });

  it("includes risk areas", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("Session management");
    expect(result).toContain("Token refresh flow");
  });

  it("includes testing focus", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("JWT tokens");
  });

  it("wraps content in details/summary block", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("<details>");
    expect(result).toContain("</details>");
    expect(result).toContain("<summary>");
  });

  it("formats replaced changes correctly", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Replaced**");
  });

  it("formats added changes correctly", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Added**");
  });

  it("formats removed changes correctly", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Removed**");
  });

  it("handles summary with no risk areas", () => {
    const noRisk: BehavioralSummaryType = {
      ...sampleSummary,
      riskAreas: [],
    };
    const result = formatBehavioralSummary(noRisk);
    expect(result).not.toContain("**Risk Areas:**");
  });

  it("handles modified and refactored change types", () => {
    const summary: BehavioralSummaryType = {
      headline: "Refactors data layer",
      changes: [
        { type: "modified", area: "data access", description: "Query timeout increased from 5s to 30s", impact: "medium", files: ["src/db/queries.ts"] },
        { type: "refactored", area: "caching", description: "Cache layer moved from Redis to in-memory LRU", impact: "low", files: ["src/cache/redis.ts", "src/cache/lru.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Check query performance under load",
    };
    const result = formatBehavioralSummary(summary);
    expect(result).toContain("**Modified**");
    expect(result).toContain("**Refactored**");
    expect(result).toContain("⚪");
  });

  it("handles summary with single change", () => {
    const single: BehavioralSummaryType = {
      headline: "Adds rate limiting",
      changes: [
        { type: "added", area: "API", description: "Rate limiting middleware added", impact: "high", files: ["src/middleware/rate-limit.ts"] },
      ],
      riskAreas: ["Performance"],
      testingFocus: "Load test with concurrent requests",
    };
    const result = formatBehavioralSummary(single);
    expect(result).toContain("**Added**");
    expect(result).toContain("Rate limiting middleware added");
    expect(result).toContain("**Risk Areas:** Performance");
  });

  it("capitalizes change type labels", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("**Replaced**");
    expect(result).toContain("**Added**");
    expect(result).toContain("**Removed**");
    // Should NOT contain lowercase versions as bold labels
    expect(result).not.toContain("**replaced**");
    expect(result).not.toContain("**added**");
  });

  it("formats change descriptions as blockquotes", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("> Session-based authentication replaced");
  });

  it("formats file references in sup tags", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("<sup>");
    expect(result).toContain("</sup>");
  });

  it("formats each file with backticks", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("`src/auth/pkce.ts`");
    expect(result).toContain("`src/auth/oauth.ts`");
  });

  it("handles high impact badge for high-impact changes", () => {
    const high: BehavioralSummaryType = {
      headline: "Test",
      changes: [
        { type: "added", area: "core", description: "Big change", impact: "high", files: ["a.ts"] },
      ],
      riskAreas: [],
      testingFocus: "Test everything",
    };
    const result = formatBehavioralSummary(high);
    expect(result).toContain("⚠️");
  });

  it("handles summary with 5 changes", () => {
    const many: BehavioralSummaryType = {
      headline: "Major refactor",
      changes: [
        { type: "added", area: "a", description: "Add a", impact: "high", files: ["a.ts"] },
        { type: "removed", area: "b", description: "Remove b", impact: "high", files: ["b.ts"] },
        { type: "replaced", area: "c", description: "Replace c", impact: "medium", files: ["c.ts"] },
        { type: "modified", area: "d", description: "Modify d", impact: "medium", files: ["d.ts"] },
        { type: "refactored", area: "e", description: "Refactor e", impact: "low", files: ["e.ts"] },
      ],
      riskAreas: ["a", "b", "c"],
      testingFocus: "Everything",
    };
    const result = formatBehavioralSummary(many);
    expect(result).toContain("**Added**");
    expect(result).toContain("**Removed**");
    expect(result).toContain("**Replaced**");
    expect(result).toContain("**Modified**");
    expect(result).toContain("**Refactored**");
  });

  it("includes multiple risk areas in comma-separated list", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("Session management, Token refresh flow, Cookie fallback");
  });

  it("handles empty changes array", () => {
    const empty: BehavioralSummaryType = {
      headline: "Empty PR",
      changes: [],
      riskAreas: [],
      testingFocus: "Nothing to test",
    };
    const result = formatBehavioralSummary(empty);
    expect(result).toContain("Empty PR");
  });

  it("wraps content in details block for collapsible display", () => {
    const result = formatBehavioralSummary(sampleSummary);
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>");
    expect(result).toContain("Behavioral");
  });

  it("handles very long headline", () => {
    const long: BehavioralSummaryType = {
      headline: "This is a very long headline that describes a complex refactoring of the entire authentication and authorization system including OAuth2, SAML, and custom token-based approaches across multiple microservices",
      changes: [
        { type: "added", area: "auth", description: "Complex auth", impact: "high", files: ["a.ts"] },
      ],
      riskAreas: ["Auth"],
      testingFocus: "Test auth flows",
    };
    const result = formatBehavioralSummary(long);
    expect(result).toContain("OAuth2");
  });

  it("handles change with many files", () => {
    const manyFiles: BehavioralSummaryType = {
      headline: "Renames package",
      changes: [
        {
          type: "refactored",
          area: "package",
          description: "Package renamed",
          impact: "medium",
          files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        },
      ],
      riskAreas: [],
      testingFocus: "Re-import check",
    };
    const result = formatBehavioralSummary(manyFiles);
    expect(result).toContain("`src/a.ts`");
    expect(result).toContain("`src/e.ts`");
  });
});
