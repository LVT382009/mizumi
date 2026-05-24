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
});
