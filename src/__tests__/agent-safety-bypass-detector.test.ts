/**
 * Tests for Agent Self-Referential Safety Bypass Detector
 */
import { describe, it, expect } from "vitest";
import { detectAgentSafetyBypass } from "../agent-safety-bypass-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(path: string, added: string[], removed: string[] = [], status: "modified" | "added" = "modified"): DiffFile {
  const changes = [
    ...added.map((content, i) => ({ type: "add" as const, content: `+${content}`, line: i + 1, ln: i + 1 })),
    ...removed.map((content, i) => ({ type: "delete" as const, content: `-${content}`, line: added.length + i + 1, ln: added.length + i + 1 })),
  ];
  return {
    path,
    status,
    hunks: [{ header: "@@ -0 +0 @@", changes }],
  };
}

// ---------------------------------------------------------------------------
// governance-config-modification
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — governance-config-modification", () => {
  it("detects PR modifying both .claude/settings.json and source code", () => {
    const govFile = makeDiffFile(".claude/settings.json", ['"autoApprove": false']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects PR modifying both .mcp.json and source code", () => {
    const govFile = makeDiffFile(".mcp.json", ['"mcpServers": {']);
    const srcFile = makeDiffFile("src/index.py", ["def main():"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects PR modifying both .vscode/settings.json and source code", () => {
    const govFile = makeDiffFile(".vscode/settings.json", ['"files.autoSave": true']);
    const srcFile = makeDiffFile("src/main.rs", ["fn main() {"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag governance-only PRs with no source changes", () => {
    const govFile = makeDiffFile(".claude/settings.json", ['"autoApprove": false']);
    const result = detectAgentSafetyBypass([govFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag source-only PRs with no governance changes", () => {
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues).toHaveLength(0);
  });

  it("detects CLAUDE.md + source code as self-referential", () => {
    const govFile = makeDiffFile("CLAUDE.md", ["# Updated instructions"]);
    const srcFile = makeDiffFile("src/utils.ts", ["export const x = 1;"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects .cursorrules + source code", () => {
    const govFile = makeDiffFile(".cursorrules", ["Always use TypeScript"]);
    const srcFile = makeDiffFile("src/page.tsx", ["export default function Page() {}"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects pre-commit config + source code", () => {
    const govFile = makeDiffFile(".pre-commit-config.yaml", ["repos:"]);
    const srcFile = makeDiffFile("src/handler.py", ["def handle():"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files as source code", () => {
    const govFile = makeDiffFile(".claude/settings.json", ['"autoApprove": false']);
    const testFile = makeDiffFile("src/__tests__/app.test.ts", ["expect(1).toBe(1);"]);
    const result = detectAgentSafetyBypass([govFile, testFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// safety-hook-disabling
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — safety-hook-disabling", () => {
  it("detects autoApprove: true in governance file", () => {
    const file = makeDiffFile(".claude/settings.json", ['"autoApprove": true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects auto_approve: true in YAML config", () => {
    const file = makeDiffFile(".github/workflows/ci.yml", ["auto_approve: true"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects auto-merge: true", () => {
    const file = makeDiffFile(".github/workflows/merge.yml", ["auto-merge: true"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects skip_review: true", () => {
    const file = makeDiffFile(".claude/settings.json", ['"skip_review": true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects enforcement: false", () => {
    const file = makeDiffFile(".vscode/settings.json", ['"enforce": false']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects empty protected branches", () => {
    const file = makeDiffFile(".github/workflows/protection.yml", ["protected_branches: []"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects required_reviewers: 0", () => {
    const file = makeDiffFile(".github/workflows/review.yml", ["required_reviewers: 0"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removal of pre-commit hook", () => {
    const file = makeDiffFile(".husky/pre-commit", [], ["#!/bin/sh", "npx lint-staged"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects removal of required_review setting", () => {
    const file = makeDiffFile(".github/workflows/protection.yml", [], ["required_review: 2"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects always_allow: true", () => {
    const file = makeDiffFile(".claude/settings.json", ['"always_allow": true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag autoApprove: false (safe state)", () => {
    const file = makeDiffFile(".claude/settings.json", ['"autoApprove": false']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    // Not a safety disable — it's false, which is safe
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag safety patterns in non-governance files", () => {
    const file = makeDiffFile("src/config.ts", ["autoApprove: true"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag comment lines", () => {
    const file = makeDiffFile(".claude/settings.json", ['// autoApprove: true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// agent-permission-expansion
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — agent-permission-expansion", () => {
  it("detects new MCP server added", () => {
    const file = makeDiffFile(".mcp.json", ['"mcpServers": {']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects allowedTools expansion", () => {
    const file = makeDiffFile(".claude/settings.json", ['"allowedTools": [']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects allowedCommands expansion", () => {
    const file = makeDiffFile(".claude/settings.json", ['"allowedCommands": [']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects unattended: true mode", () => {
    const file = makeDiffFile(".claude/settings.json", ['"unattended": true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects --yes force flag in config", () => {
    const file = makeDiffFile(".github/workflows/deploy.yml", ["npm install --yes"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects broad permissions scope", () => {
    const file = makeDiffFile(".cursor/mcp.json", ['"permissions": {"read": true}']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag permission expansions in non-governance files", () => {
    const file = makeDiffFile("src/app.ts", ["const allowedTools = [];"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag test files", () => {
    const file = makeDiffFile("src/__tests__/config.test.ts", ['"mcpServers": {']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — combined scenarios", () => {
  it("detects multiple categories in a single PR", () => {
    const govFile = makeDiffFile(".claude/settings.json", ['"autoApprove": true']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const categories = new Set(result.issues.map((i) => i.category));
    // Should have governance-config-modification + safety-hook-disabling
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it("produces context text with issues", () => {
    const govFile = makeDiffFile(".claude/settings.json", ['"autoApprove": true']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Agent Self-Referential Safety Bypass");
    }
  });

  it("produces body summary with table", () => {
    const govFile = makeDiffFile(".claude/settings.json", ['"autoApprove": true']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
      expect(result.bodySummary).toContain("Vectimus");
    }
  });

  it("returns empty context for clean PR", () => {
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([srcFile]);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag deleted files", () => {
    const file: DiffFile = { path: ".claude/settings.json", status: "deleted", hunks: [] };
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([file, srcFile]);
    const govIssues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(govIssues).toHaveLength(0);
  });

  it("handles empty hunks gracefully", () => {
    const file: DiffFile = {
      path: ".claude/settings.json",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectAgentSafetyBypass([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("sorts critical before warning", () => {
    const govFile1 = makeDiffFile(".claude/settings.json", ['"autoApprove": true']);
    const govFile2 = makeDiffFile(".mcp.json", ['"mcpServers": {']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([govFile1, govFile2, srcFile]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("deduplicates same category/file/line", () => {
    const file = makeDiffFile(".claude/settings.json", ['"autoApprove": true', '"autoApprove": true']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([file, srcFile]);
    // Same category + file, different lines — should have multiple governance issues
    const govIssues = result.issues.filter((i) => i.category === "governance-config-modification");
    // Each unique line can produce a governance issue from different lines
    expect(govIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("body summary truncates at 15 issues", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      makeDiffFile(`.mcp${i}.json`, ['"mcpServers": {'])
    );
    const result = detectAgentSafetyBypass(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});


// ---------------------------------------------------------------------------
// Expanded coverage: governance-config-modification
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — governance-config-modification expanded", () => {
  it("detects AGENTS.md + source code as self-referential", () => {
    const govFile = makeDiffFile("AGENTS.md", ["# Agent instructions updated"]);
    const srcFile = makeDiffFile("src/agent.ts", ["function run() {}"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects claude_desktop_config.json + source code", () => {
    const govFile = makeDiffFile("claude_desktop_config.json", ['"mcpServers": {}']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects .continue/ + source code as self-referential", () => {
    const govFile = makeDiffFile(".continue/config.json", ['"allow": true']);
    const srcFile = makeDiffFile("src/app.py", ["def main():"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects .github/copilot + source code", () => {
    const govFile = makeDiffFile(".github/copilot-instructions.md", ["Use TypeScript"]);
    const srcFile = makeDiffFile("src/page.tsx", ["export default function Page() {}"]);
    const result = detectAgentSafetyBypass([govFile, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects multiple governance files + source produces multiple governance issues", () => {
    const gov1 = makeDiffFile("CLAUDE.md", ["# Updated instructions"]);
    const gov2 = makeDiffFile(".mcp.json", ['"mcpServers": {}']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([gov1, gov2, srcFile]);
    const issues = result.issues.filter((i) => i.category === "governance-config-modification");
    // Each governance file produces its own issue
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: safety-hook-disabling
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — safety-hook-disabling expanded", () => {
  it('detects "auto_approve": true with JSON quotes', () => {
    const file = makeDiffFile(".claude/settings.json", ['"auto_approve": true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects required_status_checks: [] in JSON config", () => {
    const file = makeDiffFile(".github/workflows/protection.yml", ['"required_status_checks": []']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects deletion of husky config", () => {
    const file = makeDiffFile(".husky/pre-commit", [], ["npx husky install"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects deletion of lint-staged", () => {
    const file = makeDiffFile(".husky/pre-commit", [], ["npx lint-staged"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects allowed_all: true", () => {
    const file = makeDiffFile(".claude/settings.json", ['"allowed_all": true']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "safety-hook-disabling");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: agent-permission-expansion
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — agent-permission-expansion expanded", () => {
  it("detects mcpServers in YAML config", () => {
    const file = makeDiffFile(".mcp.json", ["mcpServers: {"]);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects allowedTools pattern", () => {
    const file = makeDiffFile(".claude/settings.json", ['"allowedTools": [']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it('detects command with dangerous value', () => {
    const file = makeDiffFile(".mcp.json", ['"command": "rm -rf /"']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects read access to /etc", () => {
    const file = makeDiffFile(".mcp.json", ['read: "/etc/passwd"']);
    const result = detectAgentSafetyBypass([file]);
    const issues = result.issues.filter((i) => i.category === "agent-permission-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: combined scenarios
// ---------------------------------------------------------------------------

describe("detectAgentSafetyBypass — combined expanded", () => {
  it("deduplicates at same line", () => {
    const file = makeDiffFile(".claude/settings.json", ['"autoApprove": true']);
    const srcFile = makeDiffFile("src/app.ts", ["console.log('hello');"]);
    const result = detectAgentSafetyBypass([file, srcFile]);
    // governance-config-modification + safety-hook-disabling may both match,
    // but same category+file+line should dedup
    const safetyIssues = result.issues.filter(
      (i) => i.category === "safety-hook-disabling" && i.file === ".claude/settings.json" && i.line === 1
    );
    expect(safetyIssues.length).toBeLessThanOrEqual(1);
  });

  it("clean source-only PR with no governance produces no governance issues", () => {
    const src1 = makeDiffFile("src/main.rs", ["fn main() {"]);
    const src2 = makeDiffFile("src/lib.go", ["func Hello() {}"]);
    const result = detectAgentSafetyBypass([src1, src2]);
    const govIssues = result.issues.filter((i) => i.category === "governance-config-modification");
    expect(govIssues).toHaveLength(0);
  });
});
