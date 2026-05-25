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
    // Total: 95 lines
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
  });

  it("returns false for many files but very small changes", () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `file${i}.ts`, status: "modified" as const, additions: 1, deletions: 0, hunks: [],
    }));
    // Total: 10 lines
    expect(shouldRunBehavioralAnalysis(files)).toBe(false);
  });

  it("returns true for exactly 50 lines across 3 files", () => {
    const files = [
      { path: "a.ts", status: "modified" as const, additions: 20, deletions: 10, hunks: [] },
      { path: "b.ts", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "c.ts", status: "modified" as const, additions: 3, deletions: 2, hunks: [] },
    ];
    // Total: 50 lines
    expect(shouldRunBehavioralAnalysis(files)).toBe(true);
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
});
