/**
 * Tests for Gitignore Gap Detector
 */
import { describe, it, expect } from "vitest";
import { detectGitignoreGaps } from "../gitignore-gap-detector.js";
import type { DiffFile } from "../diff.js";

function makeDiffFile(path: string, status: "modified" | "added" = "added"): DiffFile {
  const changes = [{ type: "add" as const, content: `+content`, line: 1, ln: 1 }];
  return {
    path,
    status,
    hunks: [{ header: "@@ -0 +0 @@", changes }],
  };
}

// ---------------------------------------------------------------------------
// sensitive-file-added
// ---------------------------------------------------------------------------

describe("detectGitignoreGaps — sensitive-file-added", () => {
  it("flags .env file added", () => {
    const file = makeDiffFile(".env");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("flags .env.production file added", () => {
    const file = makeDiffFile(".env.production");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags credentials.json added", () => {
    const file = makeDiffFile("credentials.json");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags secrets.yaml added", () => {
    const file = makeDiffFile("secrets.yaml");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags .pem private key file", () => {
    const file = makeDiffFile("server.key.pem");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags .npmrc with potential tokens", () => {
    const file = makeDiffFile(".npmrc");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags .env even when modified (not just added)", () => {
    const file = makeDiffFile(".env", "modified");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag src/env.ts source code", () => {
    const file = makeDiffFile("src/env.ts");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "sensitive-file-added");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// build-artifact-added
// ---------------------------------------------------------------------------

describe("detectGitignoreGaps — build-artifact-added", () => {
  it("flags dist/ directory added", () => {
    const file = makeDiffFile("dist/index.js");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "build-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags build/ directory added", () => {
    const file = makeDiffFile("build/output.js");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "build-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags node_modules/ added", () => {
    const file = makeDiffFile("node_modules/react/index.js");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "build-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags .next/ directory added", () => {
    const file = makeDiffFile(".next/server/pages/index.js");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "build-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag dist.ts source file", () => {
    const file = makeDiffFile("src/dist-helper.ts");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "build-artifact-added");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag build artifacts in modified files", () => {
    const file = makeDiffFile("dist/index.js", "modified");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "build-artifact-added");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// os-ide-artifact-added
// ---------------------------------------------------------------------------

describe("detectGitignoreGaps — os-ide-artifact-added", () => {
  it("flags .DS_Store added", () => {
    const file = makeDiffFile(".DS_Store");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "os-ide-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags Thumbs.db added", () => {
    const file = makeDiffFile("Thumbs.db");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "os-ide-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags .idea/ directory added", () => {
    const file = makeDiffFile(".idea/workspace.xml");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "os-ide-artifact-added");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag .vscode/settings.json (shared settings)", () => {
    const file = makeDiffFile(".vscode/settings.json");
    const result = detectGitignoreGaps([file]);
    const issues = result.issues.filter((i) => i.category === "os-ide-artifact-added" && i.file === ".vscode/settings.json");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined / edge cases
// ---------------------------------------------------------------------------

describe("detectGitignoreGaps — combined", () => {
  it("detects multiple categories", () => {
    const files = [
      makeDiffFile(".env"),
      makeDiffFile("dist/index.js"),
      makeDiffFile(".DS_Store"),
    ];
    const result = detectGitignoreGaps(files);
    const cats = new Set(result.issues.map((i) => i.category));
    expect(cats.size).toBeGreaterThanOrEqual(2);
  });

  it("sorts critical before warning", () => {
    const files = [
      makeDiffFile("dist/index.js"),
      makeDiffFile(".env"),
    ];
    const result = detectGitignoreGaps(files);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("handles deleted files", () => {
    const file: DiffFile = { path: ".env", status: "deleted", hunks: [] };
    const result = detectGitignoreGaps([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for clean source files", () => {
    const file = makeDiffFile("src/app.ts");
    const result = detectGitignoreGaps([file]);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("produces context text", () => {
    const file = makeDiffFile(".env");
    const result = detectGitignoreGaps([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Gitignore Gap");
    }
  });

  it("produces body summary with table", () => {
    const file = makeDiffFile(".env");
    const result = detectGitignoreGaps([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});
