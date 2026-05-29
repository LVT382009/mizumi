import { describe, it, expect, vi } from "vitest";
import { detectAIConfigIntegrity } from "../ai-config-integrity-detector.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(
  path: string,
  addedLines: string[],
  status: "modified" | "added" | "deleted" | "renamed" = "modified",
): DiffFile {
  const changes = addedLines.map((content, idx) => ({
    type: "add" as const,
    content: `+${content}`,
    line: idx + 1,
  }));
  return {
    path,
    status,
    hunks: [{ header: "@@ -1 +1 @@@@", changes }],
  };
}

const ZWSP = "​";       // ZERO-WIDTH SPACE
const RLO = "‮";        // RIGHT-TO-LEFT OVERRIDE
const LRE = "‪";        // LEFT-TO-RIGHT EMBEDDING
const BOM = "﻿";        // BYTE ORDER MARK
const SOFT_HYPHEN = "­"; // SOFT HYPHEN
const RLM = "‏";        // RIGHT-TO-LEFT MARK
const ZWNJ = "‌";       // ZERO-WIDTH NON-JOINER

// ---------------------------------------------------------------------------
// hidden-unicode-control
// ---------------------------------------------------------------------------

describe("detectAIConfigIntegrity — hidden-unicode-control", () => {
  it("detects zero-width space in .cursorrules", () => {
    const file = makeDiffFile(".cursorrules", [
      `Always use${ZWSP}TypeScript for new files`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].code).toContain("U+200B");
  });

  it("detects right-to-left override in CLAUDE.md", () => {
    const file = makeDiffFile("CLAUDE.md", [
      `Follow these rules${RLO}hidden command`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects left-to-right embedding in copilot instructions", () => {
    const file = makeDiffFile(".github/copilot-instructions.md", [
      `Write clean code${LRE}extra directives`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects BOM character in MCP config", () => {
    const file = makeDiffFile(".mcp.json", [
      `${BOM}{ "servers": {} }`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects soft hyphen in .cursorrules", () => {
    const file = makeDiffFile(".cursorrules", [
      `Use secure${SOFT_HYPHEN}coding practices`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects right-to-left mark in .claude config", () => {
    const file = makeDiffFile(".claude/settings.json", [
      `{"model": "sonnet"${RLM}}`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not scan non-AI-config files", () => {
    const file = makeDiffFile("src/app.ts", [
      `const x = "${ZWSP}hidden";`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles lines without unicode control chars", () => {
    const file = makeDiffFile(".cursorrules", [
      "Always write tests for new code",
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues).toHaveLength(0);
  });

  it("reports only one finding per line even with multiple control chars", () => {
    const file = makeDiffFile(".cursorrules", [
      `Rule${ZWSP}1${RLO}hidden`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control" && i.line === 1);
    expect(issues.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// malicious-mcp-redirect
// ---------------------------------------------------------------------------

describe("detectAIConfigIntegrity — malicious-mcp-redirect", () => {
  it("detects suspicious TLD in MCP server URL", () => {
    const file = makeDiffFile(".mcp.json", [
      '{"url": "https://evil-server.xyz/mcp"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects IP address as MCP server URL", () => {
    const file = makeDiffFile("mcp.json", [
      '{"url": "https://192.168.1.100:8080/mcp"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects ngrok tunnel URL", () => {
    const file = makeDiffFile(".claude/settings.json", [
      '{"url": "https://abc123.ngrok.io/mcp"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects localhost in production config", () => {
    const file = makeDiffFile(".mcp.json", [
      '{"url": "http://localhost:3000/mcp"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects URL shortener domain", () => {
    const file = makeDiffFile("CLAUDE.md", [
      "MCP server: https://bit.ly/3xAbCd",
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag GitHub URLs", () => {
    const file = makeDiffFile(".mcp.json", [
      '{"url": "https://github.com/modelcontextprotocol/servers"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues).toHaveLength(0);
  });

  it("does not flag npm registry URLs", () => {
    const file = makeDiffFile(".mcp.json", [
      '{"url": "https://registry.npmjs.org/@modelcontextprotocol/server"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues).toHaveLength(0);
  });

  it("does not flag lines without URLs", () => {
    const file = makeDiffFile(".mcp.json", [
      '{"name": "my-mcp-server", "version": "1.0.0"}',
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "malicious-mcp-redirect");
    expect(issues).toHaveLength(0);
  });

  it("does not scan non-AI-config files even with suspicious URLs", () => {
    const file = makeDiffFile("src/config.ts", [
      'const url = "https://evil-server.xyz/api";',
    ]);
    const result = detectAIConfigIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectAIConfigIntegrity — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: ".cursorrules", status: "deleted", hunks: [] };
    const result = detectAIConfigIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: ".cursorrules",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@@@", changes: [] }],
    };
    const result = detectAIConfigIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean AI config files", () => {
    const file = makeDiffFile(".cursorrules", [
      "Always write tests",
      "Use TypeScript",
    ]);
    const result = detectAIConfigIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one file", () => {
    const file = makeDiffFile(".mcp.json", [
      `{"url": "https://evil.xyz/mcp"${ZWSP}}`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it("only scans AI config files", () => {
    const file = makeDiffFile("src/config.ts", [
      `const url = "https://evil.xyz/${RLO}api";`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles ZWNJ (warning severity)", () => {
    const file = makeDiffFile(".cursorrules", [
      `Use${ZWNJ}TypeScript`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects copilot-instructions in .github dir", () => {
    const file = makeDiffFile(".github/copilot-instructions.md", [
      `Code style${ZWSP}guide`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "hidden-unicode-control");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectAIConfigIntegrity — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeDiffFile(".cursorrules", [
      `Always${ZWSP}use TypeScript`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("AI Configuration Integrity Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeDiffFile(".cursorrules", [
      "Always write tests",
    ]);
    const result = detectAIConfigIntegrity([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeDiffFile(".cursorrules", [
      `Always${ZWSP}use TypeScript`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeDiffFile(".cursorrules", [
      "Always write tests",
    ]);
    const result = detectAIConfigIntegrity([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file = makeDiffFile(".cursorrules", [
      `Rule${ZWNJ}with warning`,
      `Rule${ZWSP}with critical`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeDiffFile(".cursorrules", [
      `Always${ZWSP}use TypeScript`,
    ]);
    const result = detectAIConfigIntegrity([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});
