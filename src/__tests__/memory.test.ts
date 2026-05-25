import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readMemory, writeMemory, readRules, autoGenerateSkills, loadSkills, ghostWarnings, buildLearningPrompt } from "../memory.js";

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
      writeMemory(tmpDir, "# Original\n", " \n \t ");
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

  it("creates .github directory if missing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    const githubDir = path.join(tmpDir, ".github");
    // Ensure .github does NOT exist before write
    expect(fs.existsSync(githubDir)).toBe(false);
    try {
      writeMemory(tmpDir, "# Memory\n", "- some finding");
      expect(fs.existsSync(githubDir)).toBe(true);
      const written = fs.readFileSync(path.join(githubDir, "mizumi-memory.md"), "utf-8");
      expect(written).toContain("some finding");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("appends findings with date section header", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      writeMemory(tmpDir, "# Memory\n", "- new finding here");
      const written = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      // Should contain a date section header like ## 2026-05-25
      expect(written).toMatch(/## \d{4}-\d{2}-\d{2}/);
      expect(written).toContain("new finding here");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("hardCap truncates from the top keeping recent entries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-mem-"));
    try {
      // Build a very large memory that exceeds the 2KB hard cap
      let hugeMemory = "# Memory\nline2\nline3\nline4\nline5\n";
      for (let i = 0; i < 30; i++) {
        hugeMemory += `\n## 2026-01-${String(i + 1).padStart(2, "0")}\n`;
        hugeMemory += ("- finding " + "x".repeat(50) + "\n").repeat(3);
      }
      writeMemory(tmpDir, hugeMemory, "- latest finding");
      const written = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-memory.md"), "utf-8");
      // Must be within 2KB hard cap
      expect(Buffer.byteLength(written, "utf-8")).toBeLessThanOrEqual(2048);
      // Should keep the header (first 5 lines)
      expect(written).toContain("# Memory");
      // Should keep the most recent content
      expect(written).toContain("latest finding");
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

  it("reads multiple rules files and joins them with double newline", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    fs.writeFileSync(path.join(tmpDir, "REVIEW.md"), "Rule A content", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "Rule B content", "utf-8");
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "REVIEW.md"), "Rule C content", "utf-8");
    try {
      const rules = readRules(tmpDir);
      expect(rules).toContain("Rule A content");
      expect(rules).toContain("Rule B content");
      expect(rules).toContain("Rule C content");
      // Joined with "\n\n"
      expect(rules).toContain("\n\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads .cursorrules file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "Always use TypeScript strict mode", "utf-8");
    try {
      const rules = readRules(tmpDir);
      expect(rules).toContain("TypeScript strict mode");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads .github/copilot-instructions.md file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "copilot-instructions.md"), "Follow the project's coding standards", "utf-8");
    try {
      const rules = readRules(tmpDir);
      expect(rules).toContain("coding standards");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("skips empty rules files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-rules-"));
    fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "  \n  ", "utf-8");
    try {
      const rules = readRules(tmpDir);
      expect(rules).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("ghostWarnings", () => {
  it("returns empty when no memory content", () => {
    expect(ghostWarnings("", ["src/auth.ts"])).toEqual([]);
  });

  it("returns empty when no changed files", () => {
    expect(ghostWarnings("- [high] src/auth.ts:10 — security: sql injection", [])).toEqual([]);
  });

  it("caps at 5 warnings maximum", () => {
    const memory = [
      "- [high] src/a.ts:1 — security: issue a",
      "- [high] src/b.ts:2 — security: issue b",
      "- [high] src/c.ts:3 — security: issue c",
      "- [high] src/d.ts:4 — security: issue d",
      "- [high] src/e.ts:5 — security: issue e",
      "- [high] src/f.ts:6 — security: issue f",
    ].join("\n");
    const changedFiles = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    const warnings = ghostWarnings(memory, changedFiles);
    expect(warnings.length).toBeLessThanOrEqual(5);
  });

  it("deduplicates identical warnings", () => {
    const memory = [
      "- [high] src/auth.ts:10 — security: sql injection",
      "- [high] src/auth.ts:10 — security: sql injection",
    ].join("\n");
    const warnings = ghostWarnings(memory, ["src/auth.ts"]);
    expect(warnings).toHaveLength(1);
  });

  it("matches by basename as well as full path", () => {
    const memory = "- [high] src/auth.ts:10 — security: sql injection";
    // Use a different path that shares the same basename
    const warnings = ghostWarnings(memory, ["lib/auth.ts"]);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain("auth.ts");
  });

  it("strips leading list marker from warning summary", () => {
    const memory = "- [high] src/auth.ts:10 — security: sql injection";
    const warnings = ghostWarnings(memory, ["src/auth.ts"]);
    expect(warnings[0]).not.toMatch(/^[-*]\s/);
    expect(warnings[0]).toContain("[high]");
  });
});

describe("autoGenerateSkills", () => {
  it("returns empty array for empty memory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    try {
      expect(autoGenerateSkills("", tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("generates skill when file+category appears 3+ times", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const memory = [
      "- [high] src/auth.ts:10 — security: sql injection",
      "- [critical] src/auth.ts:22 — security: missing validation",
      "- [high] src/auth.ts:35 — security: hardcoded secret",
    ].join("\n");
    try {
      const generated = autoGenerateSkills(memory, tmpDir);
      expect(generated).toHaveLength(1);
      const skillContent = fs.readFileSync(generated[0], "utf-8");
      expect(skillContent).toContain("name: security-auth");
      expect(skillContent).toContain('file_pattern: "src/auth.ts"');
      expect(skillContent).toContain("pay attention to security issues");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("skips patterns with fewer than 3 occurrences", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const memory = [
      "- [high] src/db.ts:10 — security: issue1",
      "- [high] src/db.ts:20 — security: issue2",
    ].join("\n");
    try {
      expect(autoGenerateSkills(memory, tmpDir)).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("separates different categories for the same file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const memory = [
      "- [high] src/api.ts:1 — security: issue",
      "- [high] src/api.ts:2 — security: issue",
      "- [high] src/api.ts:3 — security: issue",
      "- [low] src/api.ts:4 — style: lint",
      "- [low] src/api.ts:5 — style: lint",
      "- [low] src/api.ts:6 — style: lint",
    ].join("\n");
    try {
      const generated = autoGenerateSkills(memory, tmpDir);
      expect(generated).toHaveLength(2);
      const names = generated.map((p) => path.basename(p, ".md")).sort();
      expect(names).toEqual(["security-api", "style-api"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("returns empty when memory is empty string", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    try {
      expect(autoGenerateSkills("", tmpDir)).toEqual([]);
      // No skills directory should be created for empty memory
      expect(fs.existsSync(path.join(tmpDir, ".github", "mizumi-skills"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("does not create files for patterns with fewer than 3 occurrences", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const memory = [
      "- [low] src/utils.ts:5 — style: naming",
      "- [low] src/utils.ts:10 — style: whitespace",
    ].join("\n");
    try {
      const generated = autoGenerateSkills(memory, tmpDir);
      expect(generated).toEqual([]);
      // No skills directory should have been created
      expect(fs.existsSync(path.join(tmpDir, ".github", "mizumi-skills"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe("loadSkills", () => {
  it("returns empty when no skills directory exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    try {
      const result = loadSkills(tmpDir, ["src/auth.ts"]);
      expect(result.names).toEqual([]);
      expect(result.loaded).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("returns names and loads matching skills", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const skillsDir = path.join(tmpDir, ".github", "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillContent = "---\nname: security-auth\ndescription: desc\nfile_pattern: \"src/auth.ts\"\n---\nWhen reviewing src/auth.ts, pay attention to security issues.\n";
    fs.writeFileSync(path.join(skillsDir, "security-auth.md"), skillContent, "utf-8");
    try {
      const result = loadSkills(tmpDir, ["src/auth.ts"]);
      expect(result.names).toContain("security-auth");
      expect(result.loaded).toContain("pay attention to security issues");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("skips skills whose file_pattern does not match changed files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const skillsDir = path.join(tmpDir, ".github", "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillContent = "---\nname: security-auth\ndescription: desc\nfile_pattern: \"src/auth.ts\"\n---\nAuth security guidance.\n";
    fs.writeFileSync(path.join(skillsDir, "security-auth.md"), skillContent, "utf-8");
    try {
      const result = loadSkills(tmpDir, ["src/db.ts"]);
      expect(result.names).toContain("security-auth");
      expect(result.loaded).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("caps at 5 skills and 2000 chars", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const skillsDir = path.join(tmpDir, ".github", "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      const content = `---\nname: skill-${i}\ndescription: desc\nfile_pattern: "src/f${i}.ts"\n---\n${"x".repeat(50)}\n`;
      fs.writeFileSync(path.join(skillsDir, `skill-${i}.md`), content, "utf-8");
    }
    try {
      const changedFiles = Array.from({ length: 7 }, (_, i) => `src/f${i}.ts`);
      const result = loadSkills(tmpDir, changedFiles);
      expect(result.names).toHaveLength(7);
      expect(result.loaded.length).toBeLessThanOrEqual(2000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("returns empty loaded when no skill files match changed files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-skill-"));
    const skillsDir = path.join(tmpDir, ".github", "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillContent = "---\nname: security-auth\ndescription: desc\nfile_pattern: \"src/auth.ts\"\n---\nAuth security guidance.\n";
    fs.writeFileSync(path.join(skillsDir, "security-auth.md"), skillContent, "utf-8");
    // Also add a non-matching skill
    const otherSkill = "---\nname: other\ndescription: desc\nfile_pattern: \"src/other.ts\"\n---\nOther guidance.\n";
    fs.writeFileSync(path.join(skillsDir, "other.md"), otherSkill, "utf-8");
    try {
      const result = loadSkills(tmpDir, ["src/unrelated.ts"]);
      expect(result.loaded).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildLearningPrompt
// ---------------------------------------------------------------------------

describe("buildLearningPrompt", () => {
  it("returns empty string when no learning data", () => {
    expect(buildLearningPrompt({}, {})).toBe("");
  });

  it("returns empty when all weights are neutral", () => {
    const weights = { bug: "neutral" as const, security: "neutral" as const };
    expect(buildLearningPrompt(weights, {})).toBe("");
  });

  it("includes demoted categories", () => {
    const weights = { style: "demote" as const, bug: "neutral" as const };
    const prompt = buildLearningPrompt(weights, {});
    expect(prompt).toContain("style");
    expect(prompt).toContain("dismisses");
  });

  it("includes promoted categories", () => {
    const weights = { security: "promote" as const };
    const prompt = buildLearningPrompt(weights, {});
    expect(prompt).toContain("security");
    expect(prompt).toContain("values");
  });

  it("includes both demoted and promoted", () => {
    const weights = { style: "demote" as const, security: "promote" as const };
    const prompt = buildLearningPrompt(weights, {});
    expect(prompt).toContain("dismisses");
    expect(prompt).toContain("values");
  });

  it("includes low-acceptance categories from reaction rates", () => {
    const rates = {
      style: { helpful: 2, unhelpful: 8, rate: 0.2 },
      security: { helpful: 9, unhelpful: 1, rate: 0.9 },
    };
    const prompt = buildLearningPrompt({}, rates);
    expect(prompt).toContain("Low-acceptance");
    expect(prompt).toContain("style");
    expect(prompt).toContain("20% accepted");
  });

  it("skips categories with fewer than 5 responses", () => {
    const rates = {
      style: { helpful: 1, unhelpful: 2, rate: 0.33 },
    };
    const prompt = buildLearningPrompt({}, rates);
    expect(prompt).not.toContain("style");
  });

  it("includes Adaptive Learning header", () => {
    const weights = { style: "demote" as const };
    const prompt = buildLearningPrompt(weights, {});
    expect(prompt).toContain("Adaptive Learning");
  });

  it("handles multiple demoted categories joined with slash", () => {
    const weights = { style: "demote" as const, nitpick: "demote" as const };
    const prompt = buildLearningPrompt(weights, {});
    expect(prompt).toContain("style/nitpick");
  });
});
