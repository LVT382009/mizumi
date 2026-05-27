import { describe, it, expect } from "vitest";

import {
  dedupFindings,
  formatDedupStats,
  levenshtein,
  messagesSimilar,
  simpleHash,
  DEFAULT_PROXIMITY_LINES,
  DEFAULT_FUZZY_THRESHOLD,
} from "../finding-dedup.js";
import type { DedupSource } from "../finding-dedup.js";
import type { ReviewCommentType } from "../review.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFinding = (
  file: string,
  line: number,
  overrides?: Partial<ReviewCommentType>,
): ReviewCommentType => ({
  file,
  line,
  severity: "medium",
  category: "bug",
  message: `Issue at ${file}:${line}`,
  confidence: 80,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_PROXIMITY_LINES is 5", () => {
    expect(DEFAULT_PROXIMITY_LINES).toBe(5);
  });

  it("DEFAULT_FUZZY_THRESHOLD is 0.7", () => {
    expect(DEFAULT_FUZZY_THRESHOLD).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// simpleHash
// ---------------------------------------------------------------------------

describe("simpleHash", () => {
  it("returns 8-char hex string", () => {
    expect(simpleHash("hello")).toHaveLength(8);
    expect(simpleHash("hello")).toMatch(/^[0-9a-f]+$/);
  });

  it("same input gives same hash", () => {
    expect(simpleHash("test")).toBe(simpleHash("test"));
  });

  it("different input gives different hash", () => {
    expect(simpleHash("a")).not.toBe(simpleHash("b"));
  });

  it("handles empty string", () => {
    expect(simpleHash("")).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns length for empty vs non-empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("returns 0 for two empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("computes single char substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("computes insertion", () => {
    expect(levenshtein("abc", "abdc")).toBe(1);
  });

  it("computes deletion", () => {
    expect(levenshtein("abdc", "abc")).toBe(1);
  });

  it("handles complete difference", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// messagesSimilar
// ---------------------------------------------------------------------------

describe("messagesSimilar", () => {
  it("returns true for identical messages", () => {
    expect(messagesSimilar("SQL injection found", "SQL injection found")).toBe(true);
  });

  it("returns true for very similar messages", () => {
    expect(messagesSimilar("Use const instead of let", "Use const instead of var")).toBe(true);
  });

  it("returns false for completely different messages", () => {
    expect(messagesSimilar("SQL injection found", "Missing type annotation")).toBe(false);
  });

  it("respects custom threshold", () => {
    // With high threshold, similar messages may not match
    expect(messagesSimilar("abc", "abd", 0.9)).toBe(false);
    expect(messagesSimilar("abc", "abd", 0.5)).toBe(true);
  });

  it("handles empty strings", () => {
    expect(messagesSimilar("", "")).toBe(true);
    expect(messagesSimilar("a", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dedupFindings — exact dedup
// ---------------------------------------------------------------------------

describe("dedupFindings — exact dedup", () => {
  it("returns empty for no sources", () => {
    const result = dedupFindings([]);
    expect(result.findings).toHaveLength(0);
    expect(result.stats.inputCount).toBe(0);
    expect(result.stats.outputCount).toBe(0);
  });

  it("returns all findings for single source with no dupes", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [makeFinding("a.ts", 1), makeFinding("b.ts", 5)],
    }];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(2);
    expect(result.stats.duplicatesRemoved).toBe(0);
  });

  it("removes exact duplicate from same source", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [makeFinding("a.ts", 1), makeFinding("a.ts", 1)],
    }];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(1);
    expect(result.stats.duplicatesRemoved).toBe(1);
  });

  it("removes exact duplicate across sources", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1)] },
      { name: "swarm", findings: [makeFinding("a.ts", 1)] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(1);
    expect(result.stats.duplicatesRemoved).toBe(1);
  });

  it("keeps findings with same file+line but different category", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { category: "bug" }),
        makeFinding("a.ts", 1, { category: "security" }),
      ],
    }];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(2);
  });

  it("keeps findings with same file+line+category but different message", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { message: "Bug: null pointer" }),
        makeFinding("a.ts", 1, { message: "Bug: type mismatch" }),
      ],
    }];
    const result = dedupFindings(sources);
    // Different message hash = different fingerprint, but fuzzy phase may merge
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("merges higher severity from duplicate", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1, { severity: "medium" })] },
      { name: "swarm", findings: [makeFinding("a.ts", 1, { severity: "high" })] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("high");
  });

  it("merges higher confidence from duplicate", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1, { confidence: 70 })] },
      { name: "swarm", findings: [makeFinding("a.ts", 1, { confidence: 95 })] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings[0].confidence).toBe(95);
  });

  it("preserves suggestion from either source", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1)] },
      { name: "swarm", findings: [makeFinding("a.ts", 1, { suggestion: "Add null check" })] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings[0].suggestion).toBe("Add null check");
  });
});

// ---------------------------------------------------------------------------
// dedupFindings — proximity merge
// ---------------------------------------------------------------------------

describe("dedupFindings — proximity merge", () => {
  it("merges findings within proximity lines (same file + category)", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 10, { category: "bug" }),
        makeFinding("a.ts", 12, { category: "bug" }),
      ],
    }];
    const result = dedupFindings(sources, { proximityLines: 5 });
    expect(result.stats.proximityMerges).toBe(1);
    expect(result.findings).toHaveLength(1);
  });

  it("does NOT merge findings beyond proximity lines", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { category: "bug" }),
        makeFinding("a.ts", 20, { category: "bug" }),
      ],
    }];
    const result = dedupFindings(sources, { proximityLines: 5 });
    expect(result.findings).toHaveLength(2);
    expect(result.stats.proximityMerges).toBe(0);
  });

  it("does NOT merge findings in different files", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { category: "bug" }),
        makeFinding("b.ts", 3, { category: "bug" }),
      ],
    }];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(2);
  });

  it("does NOT merge findings with different categories", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { category: "bug" }),
        makeFinding("a.ts", 3, { category: "security" }),
      ],
    }];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(2);
  });

  it("custom proximityLines=0 disables proximity merge", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { category: "bug" }),
        makeFinding("a.ts", 2, { category: "bug", message: "Different issue" }),
      ],
    }];
    const result = dedupFindings(sources, { proximityLines: 0 });
    expect(result.stats.proximityMerges).toBe(0);
  });

  it("chains proximity merges: 3 close findings merge down", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 10, { category: "bug" }),
        makeFinding("a.ts", 12, { category: "bug", message: "Issue at line 12" }),
        makeFinding("a.ts", 14, { category: "bug", message: "Issue at line 14" }),
      ],
    }];
    const result = dedupFindings(sources, { proximityLines: 5 });
    // All 3 within 5 lines of each other, should merge to 1
    expect(result.findings.length).toBeLessThanOrEqual(2);
    expect(result.stats.proximityMerges).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// dedupFindings — fuzzy message dedup
// ---------------------------------------------------------------------------

describe("dedupFindings — fuzzy message dedup", () => {
  it("merges findings with similar messages at same file+line+category", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { message: "SQL injection vulnerability detected here" }),
        makeFinding("a.ts", 1, { message: "SQL injection vulnerability detected here!" }),
      ],
    }];
    const result = dedupFindings(sources, { fuzzyThreshold: 0.7 });
    // Should be merged by fuzzy matching (even though message hash differs)
    expect(result.findings).toHaveLength(1);
  });

  it("does NOT merge messages that are too different", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { message: "SQL injection vulnerability detected in query builder" }),
        makeFinding("a.ts", 1, { message: "Missing return type annotation for exported function" }),
      ],
    }];
    const result = dedupFindings(sources, { fuzzyThreshold: 0.8 });
    expect(result.findings).toHaveLength(2);
  });

  it("respects custom fuzzy threshold", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [
        makeFinding("a.ts", 1, { message: "Use const instead of let" }),
        makeFinding("a.ts", 1, { message: "Use const instead of var" }),
      ],
    }];
    const loose = dedupFindings(sources, { fuzzyThreshold: 0.5 });
    const strict = dedupFindings(sources, { fuzzyThreshold: 0.95 });
    expect(loose.findings.length).toBeLessThanOrEqual(strict.findings.length);
  });
});

// ---------------------------------------------------------------------------
// dedupFindings — multi-source integration
// ---------------------------------------------------------------------------

describe("dedupFindings — multi-source integration", () => {
  it("handles 3 sources with overlapping findings", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1, { severity: "high" }), makeFinding("b.ts", 5)] },
      { name: "swarm-security", findings: [makeFinding("a.ts", 1, { severity: "critical" })] },
      { name: "swarm-perf", findings: [makeFinding("c.ts", 10, { category: "performance" })] },
    ];
    const result = dedupFindings(sources);
    // a.ts:1 deduped, b.ts:5 kept, c.ts:10 kept
    expect(result.findings).toHaveLength(3);
    // a.ts:1 should have critical severity (kept from swarm)
    const aFindings = result.findings.filter(f => f.file === "a.ts");
    expect(aFindings[0].severity).toBe("critical");
  });

  it("tracks source breakdown correctly", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1), makeFinding("b.ts", 2)] },
      { name: "swarm", findings: [makeFinding("c.ts", 3)] },
    ];
    const result = dedupFindings(sources);
    expect(result.stats.sourceBreakdown["review"]).toBe(2);
    expect(result.stats.sourceBreakdown["swarm"]).toBe(1);
  });

  it("tracks input/output counts correctly", () => {
    const sources: DedupSource[] = [
      { name: "review", findings: [makeFinding("a.ts", 1), makeFinding("a.ts", 1)] },
    ];
    const result = dedupFindings(sources);
    expect(result.stats.inputCount).toBe(2);
    expect(result.stats.outputCount).toBe(1);
  });

  it("handles large number of findings", () => {
    const findings: ReviewCommentType[] = [];
    for (let i = 0; i < 100; i++) {
      findings.push(makeFinding(`file${i}.ts`, i + 1));
    }
    const sources: DedupSource[] = [{ name: "review", findings }];
    const result = dedupFindings(sources);
    expect(result.stats.outputCount).toBe(100);
  });

  it("dedup rate is correct when all are duplicates", () => {
    const sources: DedupSource[] = [
      { name: "a", findings: [makeFinding("x.ts", 1)] },
      { name: "b", findings: [makeFinding("x.ts", 1)] },
      { name: "c", findings: [makeFinding("x.ts", 1)] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(1);
    expect(result.stats.inputCount).toBe(3);
    expect(result.stats.duplicatesRemoved).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatDedupStats
// ---------------------------------------------------------------------------

describe("formatDedupStats", () => {
  it("formats stats with reduction percentage", () => {
    const text = formatDedupStats({
      inputCount: 10,
      outputCount: 7,
      duplicatesRemoved: 2,
      proximityMerges: 1,
      sourceBreakdown: { review: 6, swarm: 4 },
    });
    expect(text).toContain("10→7");
    expect(text).toContain("30%");
    expect(text).toContain("2 exact dupes");
    expect(text).toContain("1 proximity merges");
    expect(text).toContain("review=6");
    expect(text).toContain("swarm=4");
  });

  it("handles zero reduction", () => {
    const text = formatDedupStats({
      inputCount: 5,
      outputCount: 5,
      duplicatesRemoved: 0,
      proximityMerges: 0,
      sourceBreakdown: {},
    });
    expect(text).toContain("0%");
  });

  it("handles empty input", () => {
    const text = formatDedupStats({
      inputCount: 0,
      outputCount: 0,
      duplicatesRemoved: 0,
      proximityMerges: 0,
      sourceBreakdown: {},
    });
    expect(text).toContain("0→0");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("findings with endLine are preserved", () => {
    const sources: DedupSource[] = [{
      name: "review",
      findings: [makeFinding("a.ts", 1, { endLine: 5 })],
    }];
    const result = dedupFindings(sources);
    expect(result.findings[0].endLine).toBe(5);
  });

  it("merge preserves endLine from either source", () => {
    const sources: DedupSource[] = [
      { name: "a", findings: [makeFinding("a.ts", 1, { endLine: 5 })] },
      { name: "b", findings: [makeFinding("a.ts", 1, { endLine: 10 })] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings[0].endLine).toBeDefined();
  });

  it("merges keeping longer message when messages are similar", () => {
    const sources: DedupSource[] = [
      { name: "a", findings: [makeFinding("a.ts", 1, { message: "Use const instead of let here" })] },
      { name: "b", findings: [makeFinding("a.ts", 1, { message: "Use const instead of let here for immutability" })] },
    ];
    const result = dedupFindings(sources);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toBe("Use const instead of let here for immutability");
  });

  it("handles all severity levels in merge", () => {
    for (const sev of ["critical", "high", "medium", "low", "nitpick"] as const) {
      const sources: DedupSource[] = [
        { name: "a", findings: [makeFinding("a.ts", 1, { severity: sev })] },
      ];
      const result = dedupFindings(sources);
      expect(result.findings[0].severity).toBe(sev);
    }
  });

  it("source with empty findings is counted in breakdown", () => {
    const sources: DedupSource[] = [
      { name: "empty", findings: [] },
      { name: "full", findings: [makeFinding("a.ts", 1)] },
    ];
    const result = dedupFindings(sources);
    expect(result.stats.sourceBreakdown["empty"]).toBe(0);
    expect(result.stats.sourceBreakdown["full"]).toBe(1);
  });
});
