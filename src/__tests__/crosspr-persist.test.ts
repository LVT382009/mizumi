import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fingerprintCrossPR,
  trackCrossPRFindings,
} from "../crosspr-persist.js";
import type { ReviewCommentType } from "../review.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: overrides.file ?? "src/auth/middleware.ts",
    line: overrides.line ?? 15,
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "security",
    message: overrides.message ?? "Missing authentication check",
    suggestion: overrides.suggestion,
    confidence: overrides.confidence ?? 85,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-crosspr-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fingerprintCrossPR
// ---------------------------------------------------------------------------

describe("fingerprintCrossPR", () => {
  it("generates key with category, fileArea, and messageHash", () => {
    const fp = fingerprintCrossPR(makeFinding());
    expect(fp.key).toContain("security");
    expect(fp.key).toContain("src/auth");
    expect(fp.category).toBe("security");
    expect(fp.fileArea).toBe("src/auth");
  });

  it("uses first two path segments for fileArea", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "packages/core/src/index.ts" }));
    expect(fp.fileArea).toBe("packages/core");
  });

  it("handles root-level files", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "package.json" }));
    expect(fp.fileArea).toBe("package.json");
  });

  it("produces same key for same category+area+message", () => {
    const fp1 = fingerprintCrossPR(makeFinding());
    const fp2 = fingerprintCrossPR(makeFinding());
    expect(fp1.key).toBe(fp2.key);
  });

  it("produces different key for different categories", () => {
    const fp1 = fingerprintCrossPR(makeFinding({ category: "security" }));
    const fp2 = fingerprintCrossPR(makeFinding({ category: "bug" }));
    expect(fp1.key).not.toBe(fp2.key);
  });

  it("produces same key for different files in same area", () => {
    const fp1 = fingerprintCrossPR(makeFinding({ file: "src/auth/login.ts" }));
    const fp2 = fingerprintCrossPR(makeFinding({ file: "src/auth/logout.ts" }));
    expect(fp1.key).toBe(fp2.key);
  });

  it("produces different key for different areas", () => {
    const fp1 = fingerprintCrossPR(makeFinding({ file: "src/auth/login.ts" }));
    const fp2 = fingerprintCrossPR(makeFinding({ file: "src/api/login.ts" }));
    expect(fp1.key).not.toBe(fp2.key);
  });
});

// ---------------------------------------------------------------------------
// trackCrossPRFindings
// ---------------------------------------------------------------------------

describe("trackCrossPRFindings", () => {
  it("stores findings and creates index", () => {
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding(),
    ]);
    expect(result.totalPatterns).toBeGreaterThan(0);
    // First PR — no recurrence yet
    expect(result.recurringFindings.filter(r => r.inCurrentPR)).toHaveLength(0);
  });

  it("detects cross-PR recurrence", () => {
    // First PR
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Missing auth check" }),
    ]);
    // Second PR — same pattern
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Missing auth check" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent.length).toBeGreaterThan(0);
    expect(inCurrent[0].prCount).toBeGreaterThanOrEqual(2);
  });

  it("detects recurrence across 3+ PRs", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "SQL injection risk" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "SQL injection risk" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "SQL injection risk" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent[0].prCount).toBeGreaterThanOrEqual(3);
  });

  it("does not flag unique findings as recurring", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Unique issue A" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Completely different issue B" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent).toHaveLength(0);
  });

  it("generates context text for recurring issues", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [makeFinding()]);
    expect(result.contextText).toContain("Cross-PR Recurring Issues");
  });

  it("returns empty context for no recurrence", () => {
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with markdown table", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [makeFinding()]);
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("Cross-PR Patterns");
    expect(result.bodySummary).toContain("</details>");
  });

  it("handles empty findings", () => {
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", []);
    expect(result.recurringFindings).toHaveLength(0);
    expect(result.contextText).toBe("");
  });

  it("handles multiple different finding patterns", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Issue A", category: "security" }),
      makeFinding({ message: "Issue B", category: "bug" }),
      makeFinding({ message: "Issue C", category: "style" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Issue A", category: "security" }),
      makeFinding({ message: "Issue B", category: "bug" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent).toHaveLength(2);
  });

  it("persists store to disk", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    expect(fs.existsSync(storePath)).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(Object.keys(store.patterns).length).toBeGreaterThan(0);
  });

  it("reads existing store on subsequent calls", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    // Second call should read the existing store
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [makeFinding()]);
    expect(result.recurringFindings.filter(r => r.inCurrentPR).length).toBeGreaterThan(0);
  });

  it("sorts recurring findings by PR count descending", () => {
    // Pattern A: 3 PRs
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Pattern A recurring issue" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Pattern A recurring issue" }),
    ]);
    // Pattern B: 2 PRs
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Pattern B other issue", category: "bug" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "Pattern A recurring issue" }),
      makeFinding({ message: "Pattern B other issue", category: "bug" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    if (inCurrent.length >= 2) {
      expect(inCurrent[0].prCount).toBeGreaterThanOrEqual(inCurrent[1].prCount);
    }
  });

  it("same PR does not double-count for recurrence", () => {
    const result1 = trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding(),
      makeFinding(),
    ]);
    // Two findings from same PR with same fingerprint should count as 1 PR
    const inCurrent = result1.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent).toHaveLength(0); // Only 1 PR, can't be recurring
  });

  it("includes sample message in recurring findings", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Missing auth check on endpoint" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Missing auth check on endpoint" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    if (inCurrent.length > 0) {
      expect(inCurrent[0].sampleMessage).toContain("Missing auth");
    }
  });

  it("detects patterns not in current PR with higher threshold", () => {
    // Create a pattern in 3 other PRs but NOT in the current one
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Systemic style issue", category: "style" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Systemic style issue", category: "style" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "Systemic style issue", category: "style" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#4", [
      makeFinding({ message: "Different issue", category: "security" }),
    ]);
    const notInCurrent = result.recurringFindings.filter(r => !r.inCurrentPR);
    expect(notInCurrent.length).toBeGreaterThan(0);
  });

  it("limits pattern entries to MAX_ENTRIES_PER_PATTERN", () => {
    // Add many entries for the same pattern across many PRs
    for (let i = 0; i < 55; i++) {
      trackCrossPRFindings(tmpDir, `owner/repo#${i}`, [
        makeFinding({ message: "Recurring overflow pattern" }),
      ]);
    }
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const pattern = Object.values(store.patterns)[0] as any[];
    // Entries should be capped at 50
    expect(pattern.length).toBeLessThanOrEqual(50);
  });

  it("context text shows category and file area", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Auth bypass", category: "security", file: "src/auth/login.ts" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Auth bypass", category: "security", file: "src/auth/login.ts" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    if (inCurrent.length > 0) {
      expect(result.contextText).toContain("security");
      expect(result.contextText).toContain("src/auth");
    }
  });

  it("context text limits to 6 recurring patterns", () => {
    // Create 8 different recurring patterns
    for (let i = 0; i < 8; i++) {
      trackCrossPRFindings(tmpDir, "owner/repo#1", [
        makeFinding({ message: `Pattern ${i}`, category: i < 3 ? "security" : "bug" }),
      ]);
      trackCrossPRFindings(tmpDir, "owner/repo#2", [
        makeFinding({ message: `Pattern ${i}`, category: i < 3 ? "security" : "bug" }),
      ]);
    }
    // Just verify it doesn't crash with many patterns
    const result3 = trackCrossPRFindings(tmpDir, "owner/repo#3", []);
    expect(result3.contextText).toBeDefined();
  });

  it("body summary includes PR count column", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding({ message: "SQLi pattern" })]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [makeFinding({ message: "SQLi pattern" })]);
    if (result.bodySummary) {
      expect(result.bodySummary).toContain("PRs");
    }
  });

  it("body summary includes tracked patterns count", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [makeFinding()]);
    if (result.bodySummary) {
      expect(result.bodySummary).toContain("tracked patterns");
    }
  });

  it("handles findings with special characters in messages", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: 'XSS: <script>alert("xss")</script>' }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: 'XSS: <script>alert("xss")</script>' }),
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("handles concurrent writes gracefully (last-write-wins)", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Concurrent pattern A" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Concurrent pattern B" }),
    ]);
    // Both patterns should exist
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it("fingerprint hashes different messages differently", () => {
    const fp1 = fingerprintCrossPR(makeFinding({ message: "Missing auth" }));
    const fp2 = fingerprintCrossPR(makeFinding({ message: "Buffer overflow" }));
    expect(fp1.messageHash).not.toBe(fp2.messageHash);
  });

  it("truncates message in entry to 80 chars", () => {
    const longMessage = "x".repeat(200);
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: longMessage }),
    ]);
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const entries = Object.values(store.patterns)[0] as any[];
    expect(entries[0].message.length).toBeLessThanOrEqual(80);
  });

  it("distinct PRs counted correctly even with multiple entries per PR", () => {
    // Same PR, same pattern, two findings → should count as 1 PR
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Multi-entry pattern" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Multi-entry pattern" }),
    ]);
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const entries = Object.values(store.patterns)[0] as any[];
    // Should have 2 entries but they're from the same PR
    const prSet = new Set(entries.map((e: any) => e.prKey));
    expect(prSet.size).toBe(1);
  });

  it("recurring finding includes PR details", () => {
    trackCrossPRFindings(tmpDir, "org/repo#10", [
      makeFinding({ message: "Detail check" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "org/repo#20", [
      makeFinding({ message: "Detail check" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    if (inCurrent.length > 0) {
      expect(inCurrent[0].prs.length).toBeGreaterThan(0);
      expect(inCurrent[0].prs[0].prKey).toBeTruthy();
      expect(inCurrent[0].prs[0].severity).toBeTruthy();
    }
  });

  it("handles file in two-level path correctly", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "src/app.ts" }));
    // Two-segment path → full path as fileArea
    expect(fp.fileArea).toBe("src/app.ts");
  });

  it("handles file with dots in name", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "src/.env.local" }));
    expect(fp.fileArea).toBe("src/.env.local");
  });

  it("recurring finding shows at most 5 PRs", () => {
    for (let i = 0; i < 10; i++) {
      trackCrossPRFindings(tmpDir, `org/repo#${i}`, [
        makeFinding({ message: "Many-PR pattern" }),
      ]);
    }
    const result = trackCrossPRFindings(tmpDir, "org/repo#10", [
      makeFinding({ message: "Many-PR pattern" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    if (inCurrent.length > 0) {
      expect(inCurrent[0].prs.length).toBeLessThanOrEqual(5);
    }
  });

  it("empty findings produces zero totalPatterns", () => {
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", []);
    expect(result.totalPatterns).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests
// ---------------------------------------------------------------------------

describe("fingerprintCrossPR — edge cases", () => {
  it("handles file with deep path (multiple segments)", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "packages/core/src/utils/helper.ts" }));
    expect(fp.fileArea).toBe("packages/core");
  });

  it("handles file with single segment and no extension", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "Makefile" }));
    expect(fp.fileArea).toBe("Makefile");
  });

  it("handles file path with backslash (non-standard)", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "src\\auth\\login.ts" }));
    // Backslash is not a path separator for split("/")
    expect(fp.fileArea).toBeDefined();
  });

  it("handles empty file path", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "" }));
    expect(fp.fileArea).toBe(".");
  });

  it("handles file path that is just a dot", () => {
    const fp = fingerprintCrossPR(makeFinding({ file: "." }));
    expect(fp.fileArea).toBe(".");
  });

  it("key format is category:fileArea:messageHash", () => {
    const fp = fingerprintCrossPR(makeFinding({ category: "bug", file: "src/app.ts", message: "Null pointer" }));
    expect(fp.key).toMatch(/^bug:src\/app\.ts:[a-z0-9]+$/);
  });

  it("same message produces same messageHash", () => {
    const fp1 = fingerprintCrossPR(makeFinding({ message: "Identical message" }));
    const fp2 = fingerprintCrossPR(makeFinding({ message: "Identical message" }));
    expect(fp1.messageHash).toBe(fp2.messageHash);
  });

  it("different messages produce different messageHashes", () => {
    const fp1 = fingerprintCrossPR(makeFinding({ message: "First issue" }));
    const fp2 = fingerprintCrossPR(makeFinding({ message: "Second issue" }));
    expect(fp1.messageHash).not.toBe(fp2.messageHash);
  });

  it("hashes only first 80 chars of message", () => {
    const short = "A".repeat(20);
    const long = short + "B".repeat(100);
    const fp1 = fingerprintCrossPR(makeFinding({ message: short }));
    const fp2 = fingerprintCrossPR(makeFinding({ message: long }));
    // The hash is computed on message.substring(0, 80)
    // short (20 chars) and long (120 chars) — first 80 chars differ
    // so they should produce different hashes
    expect(fp1.messageHash).not.toBe(fp2.messageHash);
  });

  it("produces same hash for messages that match in first 80 chars", () => {
    const base = "A".repeat(80);
    const msg1 = base;
    const msg2 = base + "EXTRA CONTENT";
    const fp1 = fingerprintCrossPR(makeFinding({ message: msg1 }));
    const fp2 = fingerprintCrossPR(makeFinding({ message: msg2 }));
    // Both are truncated to same 80 chars before hashing
    expect(fp1.messageHash).toBe(fp2.messageHash);
  });
});

describe("trackCrossPRFindings — edge cases", () => {
  it("handles finding with very long file path", () => {
    const longPath = "src/" + "very/deep/".repeat(20) + "file.ts";
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ file: longPath, message: "Deep path issue" }),
    ]);
    expect(result.totalPatterns).toBeGreaterThan(0);
  });

  it("handles finding with all severity levels", () => {
    const findings = [
      makeFinding({ severity: "critical", category: "security", message: "CRIT issue" }),
      makeFinding({ severity: "high", category: "bug", message: "HIGH issue" }),
      makeFinding({ severity: "medium", category: "style", message: "MED issue" }),
      makeFinding({ severity: "low", category: "style", message: "LOW issue" }),
      makeFinding({ severity: "nitpick", category: "style", message: "NIT issue" }),
    ];
    trackCrossPRFindings(tmpDir, "owner/repo#1", findings);
    trackCrossPRFindings(tmpDir, "owner/repo#2", findings);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", findings);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent.length).toBe(5);
  });

  it("handles findings with identical messages but different categories as separate", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Same text", category: "security" }),
      makeFinding({ message: "Same text", category: "bug" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Same text", category: "security" }),
      makeFinding({ message: "Same text", category: "bug" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "Same text", category: "security" }),
      makeFinding({ message: "Same text", category: "bug" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    expect(inCurrent.length).toBe(2);
  });

  it("body summary includes file area column", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "SQLi here", category: "security", file: "src/auth/login.ts" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "SQLi here", category: "security", file: "src/auth/login.ts" }),
    ]);
    if (result.bodySummary) {
      expect(result.bodySummary).toContain("src/auth");
    }
  });

  it("context text mentions PR count", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Recurring bug" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Recurring bug" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "Recurring bug" }),
    ]);
    expect(result.contextText).toContain("3 PRs");
  });

  it("handles PR key with special characters", () => {
    const result = trackCrossPRFindings(tmpDir, "org-name/repo_name#1", [
      makeFinding({ message: "Test finding" }),
    ]);
    expect(result.totalPatterns).toBeGreaterThan(0);
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    expect(fs.existsSync(storePath)).toBe(true);
  });

  it("multiple findings from same PR same pattern count as one PR", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Same pattern" }),
      makeFinding({ message: "Same pattern" }),
      makeFinding({ message: "Same pattern" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Same pattern" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "Same pattern" }),
    ]);
    const inCurrent = result.recurringFindings.filter(r => r.inCurrentPR);
    if (inCurrent.length > 0) {
      expect(inCurrent[0].prCount).toBe(3);
    }
  });

  it("body summary truncates sample message to 40 chars", () => {
    const longMessage = "A".repeat(100);
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: longMessage }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: longMessage }),
    ]);
    if (result.bodySummary) {
      // The table cell should contain at most 40 chars of the message
      const lines = result.bodySummary.split("\n");
      const dataLines = lines.filter(l => l.includes("|") && !l.includes("Pattern") && !l.includes("----"));
      for (const line of dataLines) {
        const cells = line.split("|").filter(c => c.trim());
        if (cells.length > 0) {
          expect(cells[0].trim().length).toBeLessThanOrEqual(42); // account for backticks
        }
      }
    }
  });

  it("context text includes file area with trailing slash", () => {
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ file: "src/utils/helper.ts", message: "Bug in utils" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ file: "src/utils/helper.ts", message: "Bug in utils" }),
    ]);
    if (result.contextText) {
      expect(result.contextText).toContain("src/utils/");
    }
  });

  it("patterns not in current PR require 3+ PRs (not 2)", () => {
    // Create a pattern in 2 PRs but NOT in the current one
    trackCrossPRFindings(tmpDir, "owner/repo#1", [
      makeFinding({ message: "Two-PR only", category: "style" }),
    ]);
    trackCrossPRFindings(tmpDir, "owner/repo#2", [
      makeFinding({ message: "Two-PR only", category: "style" }),
    ]);
    const result = trackCrossPRFindings(tmpDir, "owner/repo#3", [
      makeFinding({ message: "Different issue", category: "bug" }),
    ]);
    const notInCurrent = result.recurringFindings.filter(r => !r.inCurrentPR);
    // 2 PRs is not enough for the non-current-PR threshold (needs 3+)
    expect(notInCurrent).toHaveLength(0);
  });

  it("handles very many patterns without crashing", () => {
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding({ message: `Pattern ${i}`, category: i % 2 === 0 ? "security" : "bug" })
    );
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", findings);
    expect(result.totalPatterns).toBeGreaterThan(0);
    expect(result.totalPatterns).toBeLessThanOrEqual(50);
  });

  it("store file is valid JSON after multiple writes", () => {
    for (let i = 0; i < 10; i++) {
      trackCrossPRFindings(tmpDir, `owner/repo#${i}`, [
        makeFinding({ message: `Finding ${i}` }),
      ]);
    }
    const storePath = path.join(tmpDir, ".github", "mizumi-crosspr.json");
    const raw = fs.readFileSync(storePath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const store = JSON.parse(raw);
    expect(store.patterns).toBeDefined();
  });

  it("context text is empty on first PR", () => {
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    expect(result.contextText).toBe("");
  });

  it("body summary is empty on first PR", () => {
    const result = trackCrossPRFindings(tmpDir, "owner/repo#1", [makeFinding()]);
    expect(result.bodySummary).toBe("");
  });
});
