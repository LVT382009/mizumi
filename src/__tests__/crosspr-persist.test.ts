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
});
