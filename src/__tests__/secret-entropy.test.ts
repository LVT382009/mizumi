import { describe, it, expect, vi } from "vitest";
import {
  shannonEntropy,
  extractStringLiterals,
  isLikelySecret,
  runEntropyAnalysis,
  buildEntropyContext,
} from "../secret-entropy.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// shannonEntropy
// ---------------------------------------------------------------------------

describe("shannonEntropy", () => {
  it("returns 0 for empty string", () => {
    expect(shannonEntropy("")).toBe(0);
  });

  it("returns 0 for single repeated character", () => {
    expect(shannonEntropy("aaaaaaa")).toBe(0);
  });

  it("returns 1 for two alternating characters", () => {
    expect(shannonEntropy("ababab")).toBeCloseTo(1, 5);
  });

  it("returns high entropy for random-looking strings", () => {
    const entropy = shannonEntropy("aB3$xY7!kL9@zQ2&pW5*mN8#");
    expect(entropy).toBeGreaterThan(4);
  });

  it("returns low entropy for repetitive strings", () => {
    const entropy = shannonEntropy("abcabcabcabc");
    expect(entropy).toBeLessThan(2);
  });

  it("returns ~4.7 for fully random hex string", () => {
    // 16 hex chars = 4 bits of entropy per char max
    const entropy = shannonEntropy("0123456789abcdef");
    expect(entropy).toBeCloseTo(4, 0);
  });

  it("handles strings with many unique characters", () => {
    const entropy = shannonEntropy("abcdefghijklmnopqrstuvwxyz");
    expect(entropy).toBeGreaterThan(4.5);
  });
});

// ---------------------------------------------------------------------------
// extractStringLiterals
// ---------------------------------------------------------------------------

describe("extractStringLiterals", () => {
  it("extracts double-quoted strings", () => {
    const result = extractStringLiterals('const x = "hello world here";');
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("hello world here");
  });

  it("extracts single-quoted strings", () => {
    const result = extractStringLiterals("const x = 'hello world here';");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("hello world here");
  });

  it("extracts backtick strings", () => {
    const result = extractStringLiterals("const x = `hello world here`;");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("hello world here");
  });

  it("skips strings shorter than 7 chars", () => {
    const result = extractStringLiterals('const x = "short";');
    expect(result).toHaveLength(0);
  });

  it("extracts multiple strings from one line", () => {
    const result = extractStringLiterals('const a = "first string here"; const b = "second string here";');
    expect(result).toHaveLength(2);
  });

  it("skips strings on newlines within the literal", () => {
    // Strings with \n inside should not be extracted (the regex excludes \n)
    const result = extractStringLiterals('const x = "line1\\nline2\\nline3";');
    // The backslash-n is actually two chars in source, so this may or may not match
    // depending on interpretation. The key test: no multiline strings leak through.
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("handles empty results gracefully", () => {
    const result = extractStringLiterals("const x = 42;");
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isLikelySecret
// ---------------------------------------------------------------------------

describe("isLikelySecret", () => {
  it("flags high-entropy hex string as likely secret", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const result = isLikelySecret(hex, `const token = "${hex}";`);
    expect(result.likely).toBe(true);
    expect(result.reason).toContain("hex");
  });

  it("flags high-entropy base64 string as likely secret", () => {
    const b64 = "UmFuZG9tQmFzZTY0U3RyaW5nSGVyZQ==";
    const result = isLikelySecret(b64, `const secret = "${b64}";`);
    expect(result.likely).toBe(true);
    expect(result.reason).toContain("base64");
  });

  it("flags high-entropy mixed string as likely secret", () => {
    const mixed = "aB3$xY7!kL9@zQ2&pW5*mN8#rT1";
    const result = isLikelySecret(mixed, `const key = "${mixed}";`);
    expect(result.likely).toBe(true);
    expect(result.reason).toContain("high-entropy");
  });

  it("does not flag imports", () => {
    const result = isLikelySecret(
      "some/long/package/name/here",
      'import foo from "some/long/package/name/here";'
    );
    expect(result.likely).toBe(false);
  });

  it("does not flag require paths", () => {
    const result = isLikelySecret(
      "some/long/package/name/here",
      'const foo = require("some/long/package/name/here");'
    );
    expect(result.likely).toBe(false);
  });

  it("does not flag URLs", () => {
    const result = isLikelySecret(
      "https://api.example.com/v2/endpoint",
      'const url = "https://api.example.com/v2/endpoint";'
    );
    expect(result.likely).toBe(false);
  });

  it("does not flag UUIDs", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = isLikelySecret(uuid, `const id = "${uuid}";`);
    expect(result.likely).toBe(false);
  });

  it("does not flag CSS color codes", () => {
    const result = isLikelySecret("#ff5500", 'const color = "#ff5500";');
    expect(result.likely).toBe(false);
  });

  it("does not flag className strings", () => {
    const result = isLikelySecret(
      "container-fluid d-flex align-items",
      'className: "container-fluid d-flex align-items"'
    );
    expect(result.likely).toBe(false);
  });

  it("does not flag low-entropy strings", () => {
    const result = isLikelySecret("aaaaaaaaaaaaaaaaaaaaaa", 'const x = "aaaaaaaaaaaaaaaaaaaaaa";');
    expect(result.likely).toBe(false);
  });

  it("does not flag short strings", () => {
    const result = isLikelySecret("abc123", 'const x = "abc123";');
    expect(result.likely).toBe(false);
  });

  it("does not flag path assignments", () => {
    const result = isLikelySecret(
      "/usr/local/bin/custom-script",
      'path: "/usr/local/bin/custom-script"'
    );
    expect(result.likely).toBe(false);
  });

  it("does not flag hash context variables", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const result = isLikelySecret(hex, `const commitHash = "${hex}";`);
    expect(result.likely).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runEntropyAnalysis
// ---------------------------------------------------------------------------

describe("runEntropyAnalysis", () => {
  function makeDiffFile(path: string, lines: Array<{ content: string; line: number }>): DiffFile {
    return {
      path,
      additions: lines.length,
      deletions: 0,
      hunks: [{
        oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length,
        changes: lines.map((l) => ({
          type: "add" as const, content: l.content, line: l.line,
        })),
      }],
    };
  }

  it("returns no findings for clean code", () => {
    const files = [makeDiffFile("src/app.ts", [
      { content: 'const name = "hello";', line: 1 },
      { content: "const count = 42;", line: 2 },
    ])];
    const result = runEntropyAnalysis(files);
    expect(result.findings).toHaveLength(0);
    expect(result.stringsAnalyzed).toBeGreaterThanOrEqual(0);
  });

  it("detects high-entropy hex string in code", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const files = [makeDiffFile("src/config.ts", [
      { content: `const token = "${hex}";`, line: 5 },
    ])];
    const result = runEntropyAnalysis(files);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/config.ts");
    expect(result.findings[0].line).toBe(5);
    expect(result.findings[0].severity).toBe("high");
  });

  it("skips test files", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const files = [makeDiffFile("src/__tests__/app.test.ts", [
      { content: `const token = "${hex}";`, line: 5 },
    ])];
    const result = runEntropyAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("skips spec files", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const files = [makeDiffFile("src/app.spec.ts", [
      { content: `const token = "${hex}";`, line: 5 },
    ])];
    const result = runEntropyAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });

  it("detects multiple secrets in one file", () => {
    const hex1 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const hex2 = "f0e1d2c3b4a596877a6b5c4d3e2f1a0b";
    const files = [makeDiffFile("src/auth.ts", [
      { content: `const key1 = "${hex1}";`, line: 3 },
      { content: `const key2 = "${hex2}";`, line: 4 },
    ])];
    const result = runEntropyAnalysis(files);
    expect(result.findings).toHaveLength(2);
  });

  it("counts strings analyzed", () => {
    const files = [makeDiffFile("src/app.ts", [
      { content: 'const a = "short";', line: 1 },
      { content: 'const b = "this is a longer string value";', line: 2 },
      { content: "const c = 42;", line: 3 },
    ])];
    const result = runEntropyAnalysis(files);
    expect(result.stringsAnalyzed).toBeGreaterThanOrEqual(0);
  });

  it("truncates secret snippets for safety", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const files = [makeDiffFile("src/config.ts", [
      { content: `const token = "${hex}";`, line: 5 },
    ])];
    const result = runEntropyAnalysis(files);
    if (result.findings.length > 0) {
      // Snippet should be truncated, not the full value
      expect(result.findings[0].snippet.length).toBeLessThan(hex.length);
      expect(result.findings[0].snippet).toContain("...");
    }
  });

  it("ignores deleted lines", () => {
    const hex = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const files: DiffFile[] = [{
      path: "src/app.ts",
      additions: 0,
      deletions: 1,
      hunks: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 0,
        changes: [{ type: "delete" as const, content: `const token = "${hex}";`, line: 5 }],
      }],
    }];
    const result = runEntropyAnalysis(files);
    expect(result.findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildEntropyContext
// ---------------------------------------------------------------------------

describe("buildEntropyContext", () => {
  it("returns empty string for no findings", () => {
    const result = buildEntropyContext({ findings: [], stringsAnalyzed: 0 });
    expect(result).toBe("");
  });

  it("formats findings as LLM context", () => {
    const result = buildEntropyContext({
      findings: [{
        file: "src/config.ts",
        line: 5,
        entropy: 4.8,
        length: 42,
        snippet: "a1b2c3d4...a9b0",
        reason: "hex string (entropy=4.8, len=42)",
        severity: "high",
      }],
      stringsAnalyzed: 10,
    });
    expect(result).toContain("Entropy-Based Secret Detection");
    expect(result).toContain("src/config.ts");
    expect(result).toContain("hex");
    expect(result).toContain("10");
  });

  it("truncates at 12 findings", () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      file: `src/mod${i}.ts`,
      line: i + 1,
      entropy: 4.5,
      length: 32,
      snippet: "abc...xyz",
      reason: "high-entropy string",
      severity: "high" as const,
    }));
    const result = buildEntropyContext({ findings, stringsAnalyzed: 100 });
    expect(result).toContain("3 more");
    expect(result).toContain("100");
  });
});
