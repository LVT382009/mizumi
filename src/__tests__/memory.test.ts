import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readMemory, writeMemory, readRules } from "../memory.js";

describe("readMemory", () => {
  it("returns empty string when memory file does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      expect(readMemory(tmpDir)).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads memory from .github/mizumi-memory.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "## Patterns\n- Always use param queries", "utf-8");
    try {
      expect(readMemory(tmpDir)).toBe("## Patterns\n- Always use param queries");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("writeMemory", () => {
  it("creates .github dir and writes memory file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      writeMemory(tmpDir, "# Memory\n", "- [critical] db.ts:42 — security: sql injection");
      const written = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      expect(written).toContain("# Memory");
      expect(written).toContain("sql injection");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("appends review findings with date header", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      writeMemory(tmpDir, "# Initial\n", "- finding 1");
      const content1 = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      writeMemory(tmpDir, content1, "- finding 2");
      const content2 = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      expect(content2).toContain("finding 1");
      expect(content2).toContain("finding 2");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("skips writing when reviewFindings is empty/whitespace", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      writeMemory(tmpDir, "# Original\n", "   \n  \t  ");
      const written = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      // No date header appended for empty findings
      expect(written).toBe("# Original\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("consolidates when approaching 2KB limit", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      // Build memory that exceeds 80% of 2048 bytes (~1638 bytes)
      let largeMemory = "# Memory\n";
      for (let i = 0; i < 10; i++) {
        largeMemory += `\n## 2026-01-${String(i + 1).padStart(2, "0")}\n`;
        largeMemory += "- finding ".repeat(20) + "\n";
      }

      writeMemory(tmpDir, largeMemory, "- new finding after consolidation");
      const written = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      // After consolidation, sections should be reduced
      expect(Buffer.byteLength(written, "utf-8")).toBeLessThanOrEqual(2048);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("readRules", () => {
  it("returns empty string when no rule files exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    try {
      expect(readRules(tmpDir)).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads REVIEW.md if it exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    fs.writeFileSync(path.join(tmpDir, "REVIEW.md"), "# Rules\n- No console.log", "utf-8");
    try {
      expect(readRules(tmpDir)).toContain("No console.log");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads CLAUDE.md if it exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Context\n- Use strict TypeScript", "utf-8");
    try {
      expect(readRules(tmpDir)).toContain("strict TypeScript");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads .github/REVIEW.md as well", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "REVIEW.md"), "# GH Rules", "utf-8");
    try {
      expect(readRules(tmpDir)).toContain("GH Rules");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("combines multiple rule files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    fs.writeFileSync(path.join(tmpDir, "REVIEW.md"), "Rule A", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "Rule B", "utf-8");
    try {
      const rules = readRules(tmpDir);
      expect(rules).toContain("Rule A");
      expect(rules).toContain("Rule B");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
