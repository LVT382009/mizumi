import { describe, it, expect } from "vitest";
import { ghostWarnings } from "../memory.js";

describe("ghostWarnings", () => {
  it("returns empty for empty memory", () => {
    expect(ghostWarnings("", ["src/auth.ts"])).toEqual([]);
  });

  it("returns empty for empty changed files", () => {
    expect(ghostWarnings("- [high] src/auth.ts:10 — security: missing validation", [])).toEqual([]);
  });

  it("extracts warnings for matching files", () => {
    const memory = "- [high] src/auth.ts:10 — security: missing input validation";
    const result = ghostWarnings(memory, ["src/auth.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("src/auth.ts:10");
    expect(result[0]).toContain("security");
  });

  it("matches by basename when full path doesn't match", () => {
    const memory = "- [critical] login.ts:5 — security: hardcoded secret";
    const result = ghostWarnings(memory, ["src/auth/login.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("login.ts:5");
  });

  it("caps at 5 warnings", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- [high] src/auth.ts:${i} — bug: issue ${i}`);
    const memory = lines.join("\n");
    const result = ghostWarnings(memory, ["src/auth.ts"]);
    expect(result).toHaveLength(5);
  });

  it("deduplicates identical warnings", () => {
    const memory = "- [high] src/auth.ts:10 — security: sql injection\n- [high] src/auth.ts:10 — security: sql injection";
    const result = ghostWarnings(memory, ["src/auth.ts"]);
    expect(result).toHaveLength(1);
  });

  it("strips leading list markers from warnings", () => {
    const memory = "- [high] src/auth.ts:10 — security: missing validation";
    const result = ghostWarnings(memory, ["src/auth.ts"]);
    expect(result[0]).not.toMatch(/^- /);
    expect(result[0]).toContain("[high]");
  });

  it("handles asterisk list markers", () => {
    const memory = "* [critical] db.ts:5 — security: hardcoded secret";
    const result = ghostWarnings(memory, ["db.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("hardcoded secret");
  });

  it("matches multiple files in the same memory", () => {
    const memory = [
      "- [high] src/auth.ts:10 — security: issue1",
      "- [high] src/db.ts:20 — bug: issue2",
    ].join("\n");
    const result = ghostWarnings(memory, ["src/auth.ts", "src/db.ts"]);
    expect(result).toHaveLength(2);
  });

  it("handles memory lines without file references", () => {
    const memory = "# Memory\n\nSome generic note without file refs";
    const result = ghostWarnings(memory, ["src/auth.ts"]);
    expect(result).toHaveLength(0);
  });

  it("handles changed files with subdirectory paths", () => {
    const memory = "- [high] auth.ts:10 — bug: null ref";
    const result = ghostWarnings(memory, ["packages/core/src/auth.ts"]);
    expect(result).toHaveLength(1);
  });

  it("does not match unrelated filenames", () => {
    const memory = "- [high] auth.ts:10 — bug: null ref";
    const result = ghostWarnings(memory, ["src/utils.ts"]);
    expect(result).toHaveLength(0);
  });

  it("preserves severity prefix in warning output", () => {
    const memory = "- [critical] server.ts:1 — security: RCE risk";
    const result = ghostWarnings(memory, ["server.ts"]);
    expect(result[0]).toContain("[critical]");
  });

  it("handles memory with mixed valid and invalid lines", () => {
    const memory = "Title line\n\n- [high] app.ts:5 — bug: crash\nSome other text\n- [medium] app.ts:10 — style: naming";
    const result = ghostWarnings(memory, ["app.ts"]);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  // --- New tests ---

  it("matches medium severity warnings", () => {
    const memory = "- [medium] utils.ts:15 — performance: N+1 query";
    const result = ghostWarnings(memory, ["src/utils.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("[medium]");
  });

  it("matches nitpick severity warnings", () => {
    const memory = "- [nitpick] style.ts:3 — style: formatting";
    const result = ghostWarnings(memory, ["style.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("[nitpick]");
  });

  it("strips asterisk list marker from output", () => {
    const memory = "* [high] config.ts:1 — bug: missing null check";
    const result = ghostWarnings(memory, ["config.ts"]);
    expect(result[0]).not.toMatch(/^\* /);
    expect(result[0]).toContain("[high] config.ts:1");
  });

  it("does not match partial basename (no substring false positive)", () => {
    const memory = "- [high] auth.ts:10 — bug: issue";
    const result = ghostWarnings(memory, ["src/authentication.ts"]);
    // auth.ts is a substring of authentication.ts basename, but
    // basename comparison should still match since "auth.ts" is in the line
    // Actually ghostWarnings checks line.includes(file) OR line.includes(basename)
    // basename of "src/authentication.ts" is "authentication.ts"
    // The memory has "auth.ts" which is NOT "authentication.ts"
    // But the line includes "auth.ts" and the changed file basename is "authentication.ts"
    // basename !== "auth.ts" so no basename match. file !== "src/authentication.ts" so no full match.
    // So this should be empty or 0
    // Wait - the line is "- [high] auth.ts:10 — bug: issue"
    // changedFiles = ["src/authentication.ts"]  -> basename = "authentication.ts"
    // line.includes("src/authentication.ts") = false
    // line.includes("authentication.ts") = false (auth.ts is not a substring match here since it checks for basename exactly)
    // Actually .includes() does substring matching... "auth.ts".includes("authentication.ts") = false
    // "authentication.ts".includes("auth.ts") = false... wait:
    // The code checks: line.includes(file) || line.includes(basename) where basename = "authentication.ts"
    // line = "- [high] auth.ts:10 — bug: issue"
    // line.includes("src/authentication.ts") = false
    // line.includes("authentication.ts") = false (auth.ts is not the same as authentication.ts)
    expect(result).toHaveLength(0);
  });

  it("handles memory with only whitespace", () => {
    const result = ghostWarnings("   \n  \n  ", ["src/auth.ts"]);
    expect(result).toHaveLength(0);
  });

  it("matches file in changed files when multiple files present", () => {
    const memory = "- [critical] db.ts:5 — security: sql injection\n- [low] ui.ts:10 — style: formatting";
    const result = ghostWarnings(memory, ["src/db.ts", "src/ui.ts"]);
    expect(result).toHaveLength(2);
  });

  it("returns only warnings for changed files, not all files", () => {
    const memory = "- [high] auth.ts:10 — security: issue\n- [high] utils.ts:20 — bug: different";
    const result = ghostWarnings(memory, ["auth.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("auth.ts");
  });

  it("handles changed files with Windows-style backslash paths", () => {
    const memory = "- [high] app.ts:5 — bug: crash";
    // The code uses path.basename which works with both separators
    // but the line matching uses string.includes()
    const result = ghostWarnings(memory, ["src\\app.ts"]);
    // basename of "src\\app.ts" is "app.ts", and line contains "app.ts"
    expect(result).toHaveLength(1);
  });

  it("deduplicates warnings that differ only in list marker style", () => {
    const memory = "- [high] auth.ts:10 — security: test\n* [high] auth.ts:10 — security: test";
    const result = ghostWarnings(memory, ["auth.ts"]);
    // After stripping markers, both become "[high] auth.ts:10 — security: test"
    expect(result).toHaveLength(1);
  });
});
