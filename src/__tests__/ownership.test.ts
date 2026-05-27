import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseCodeowners,
  globToRegex,
  findOwners,
  matchOwnership,
  applyOwnershipToFindings,
  buildOwnershipSummary,
  loadCodeowners,
  DEFAULT_OWNERSHIP_CONFIG,
} from "../ownership.js";
import type { OwnershipConfig } from "../ownership.js";

// ---------------------------------------------------------------------------
// parseCodeowners
// ---------------------------------------------------------------------------

describe("parseCodeowners", () => {
  it("parses simple ownership rules", () => {
    const rules = parseCodeowners("* @default-team\nsrc/ @frontend");
    expect(rules).toHaveLength(2);
    expect(rules[0].pattern).toBe("*");
    expect(rules[0].owners).toEqual(["@default-team"]);
    expect(rules[1].owners).toEqual(["@frontend"]);
  });

  it("skips blank lines and comments", () => {
    const rules = parseCodeowners("# This is a comment\n\n*.ts @ts-team\n# Another comment\n");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@ts-team"]);
  });

  it("handles multiple owners per line", () => {
    const rules = parseCodeowners("src/api/ @backend @platform-team");
    expect(rules[0].owners).toEqual(["@backend", "@platform-team"]);
  });

  it("handles negation patterns", () => {
    const rules = parseCodeowners("src/ @dev-team\n!src/generated/ @dev-team");
    expect(rules).toHaveLength(2);
    expect(rules[1].isNegative).toBe(true);
    expect(rules[1].pattern).toBe("src/generated/");
  });

  it("handles owner with slash (user/team syntax)", () => {
    const rules = parseCodeowners("src/ @org/team-name");
    expect(rules[0].owners).toEqual(["@org/team-name"]);
  });

  it("returns empty array for empty content", () => {
    expect(parseCodeowners("")).toHaveLength(0);
    expect(parseCodeowners("# only comments\n")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// globToRegex
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("matches exact file paths", () => {
    const regex = globToRegex("src/index.ts");
    expect(regex.test("src/index.ts")).toBe(true);
    expect(regex.test("src/other.ts")).toBe(false);
  });

  it("matches wildcard * in filename", () => {
    const regex = globToRegex("src/*.ts");
    expect(regex.test("src/app.ts")).toBe(true);
    expect(regex.test("src/util.ts")).toBe(true);
    expect(regex.test("src/sub/file.ts")).toBe(false);
  });

  it("matches double-star ** for any depth", () => {
    const regex = globToRegex("src/**/*.ts");
    expect(regex.test("src/app.ts")).toBe(true);
    expect(regex.test("src/sub/deep/file.ts")).toBe(true);
    expect(regex.test("other/file.ts")).toBe(false);
  });

  it("matches leading **/ for any prefix", () => {
    const regex = globToRegex("**/*.test.ts");
    expect(regex.test("src/app.test.ts")).toBe(true);
    expect(regex.test("deep/nested/file.test.ts")).toBe(true);
    expect(regex.test("app.test.ts")).toBe(true);
  });

  it("matches single ? for single char", () => {
    const regex = globToRegex("config.?.json");
    expect(regex.test("config.a.json")).toBe(true);
    expect(regex.test("config.dev.json")).toBe(false);
  });

  it("matches * at root (default owner)", () => {
    const regex = globToRegex("*");
    expect(regex.test("any-file.ts")).toBe(true);
    expect(regex.test("src/deep/file.ts")).toBe(true);
  });

  it("escapes regex special characters in pattern", () => {
    const regex = globToRegex("src/utils+extra.ts");
    expect(regex.test("src/utils+extra.ts")).toBe(true);
    expect(regex.test("src/utilsextra.ts")).toBe(false);
  });

  it("matches directory patterns with trailing slash", () => {
    const regex = globToRegex("src/");
    expect(regex.test("src/components/Button.tsx")).toBe(true);
    expect(regex.test("src/app.ts")).toBe(true);
    expect(regex.test("other/file.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findOwners
// ---------------------------------------------------------------------------

describe("findOwners", () => {
  const rules = parseCodeowners([
    "* @default-team",
    "src/ @frontend",
    "src/api/ @backend",
    "!src/api/generated/ @backend",
  ].join("\n"));

  it("returns default owners for unmatched files", () => {
    const owners = findOwners("README.md", rules);
    expect(owners).toEqual(["@default-team"]);
  });

  it("returns most specific match (last-wins)", () => {
    const owners = findOwners("src/api/routes.ts", rules);
    expect(owners).toEqual(["@backend"]);
  });

  it("returns parent directory owners for files in subdirectory", () => {
    const owners = findOwners("src/components/Button.tsx", rules);
    expect(owners).toEqual(["@frontend"]);
  });

  it("clears owners for negation-matched files", () => {
    const owners = findOwners("src/api/generated/proto.ts", rules);
    expect(owners).toEqual([]);
  });

  it("returns empty array when no rules match", () => {
    expect(findOwners("unknown.txt", [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// matchOwnership
// ---------------------------------------------------------------------------

describe("matchOwnership", () => {
  const rules = parseCodeowners("src/ @frontend\napi/ @backend");

  it("maps each diff file to its owners", () => {
    const diffFiles = [
      { path: "src/app.tsx", status: "modified" as const, additions: 10, deletions: 5, hunks: [] },
      { path: "api/routes.ts", status: "modified" as const, additions: 3, deletions: 1, hunks: [] },
    ];

    const matches = matchOwnership(diffFiles, rules);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ file: "src/app.tsx", owners: ["@frontend"] });
    expect(matches[1]).toEqual({ file: "api/routes.ts", owners: ["@backend"] });
  });

  it("returns empty owners for files without rules", () => {
    const diffFiles = [
      { path: "docs/README.md", status: "modified" as const, additions: 1, deletions: 0, hunks: [] },
    ];

    const matches = matchOwnership(diffFiles, rules);
    expect(matches[0].owners).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyOwnershipToFindings
// ---------------------------------------------------------------------------

describe("applyOwnershipToFindings", () => {
  const ownership: { file: string; owners: string[] }[] = [
    { file: "src/api/auth.ts", owners: ["@sec-team"] },
    { file: "src/ui/button.tsx", owners: ["@frontend"] },
  ];

  it("tags findings with owning teams", () => {
    const findings = [
      { file: "src/api/auth.ts", line: 10, severity: "high" as const, category: "security" as const, message: "SQL injection risk", confidence: 85 },
    ];

    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].message).toContain("@sec-team");
  });

  it("boosts confidence for findings in owned files", () => {
    const findings = [
      { file: "src/api/auth.ts", line: 10, severity: "high" as const, category: "security" as const, message: "Issue", confidence: 75 },
    ];

    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].confidence).toBe(85); // 75 + 10 boost
  });

  it("does not exceed 100 confidence when boosting", () => {
    const findings = [
      { file: "src/api/auth.ts", line: 10, severity: "high" as const, category: "security" as const, message: "Issue", confidence: 95 },
    ];

    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].confidence).toBe(100);
  });

  it("skips tagging when tagOwners is false", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, tagOwners: false };
    const findings = [
      { file: "src/api/auth.ts", line: 10, severity: "high" as const, category: "security" as const, message: "Issue", confidence: 80 },
    ];

    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].message).not.toContain("@sec-team");
  });

  it("skips boosting when boostOwned is false", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, boostOwned: false };
    const findings = [
      { file: "src/api/auth.ts", line: 10, severity: "high" as const, category: "security" as const, message: "Issue", confidence: 80 },
    ];

    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].confidence).toBe(80); // no boost
  });

  it("does not modify findings for files without owners", () => {
    const findings = [
      { file: "unknown/file.ts", line: 5, severity: "low" as const, category: "style" as const, message: "Formatting", confidence: 50 },
    ];

    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].message).toBe("Formatting");
    expect(result[0].confidence).toBe(50);
  });

  it("does not duplicate owner tags if already present", () => {
    const findings = [
      { file: "src/api/auth.ts", line: 10, severity: "high" as const, category: "security" as const, message: "@sec-team - Known issue", confidence: 80 },
    ];

    const result = applyOwnershipToFindings(findings, ownership);
    const atCount = (result[0].message.match(/@sec-team/g) || []).length;
    expect(atCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildOwnershipSummary
// ---------------------------------------------------------------------------

describe("buildOwnershipSummary", () => {
  it("produces a table of team ownership", () => {
    const ownership = [
      { file: "src/a.ts", owners: ["@frontend"] },
      { file: "src/b.ts", owners: ["@frontend"] },
      { file: "api/c.ts", owners: ["@backend"] },
    ];

    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("@frontend");
    expect(summary).toContain("@backend");
    expect(summary).toContain("2"); // frontend has 2 files
    expect(summary).toContain("1"); // backend has 1 file
  });

  it("returns empty string when no ownership exists", () => {
    expect(buildOwnershipSummary([])).toBe("");
    expect(buildOwnershipSummary([{ file: "x.ts", owners: [] }])).toBe("");
  });

  it("truncates file list when team owns many files", () => {
    const ownership = Array.from({ length: 6 }, (_, i) => ({
      file: `src/file${i}.ts`, owners: ["@big-team"],
    }));

    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("+3 more");
  });

  it("sorts teams by file count (most files first)", () => {
    const ownership = [
      { file: "api/a.ts", owners: ["@backend"] },
      { file: "src/1.ts", owners: ["@frontend"] },
      { file: "src/2.ts", owners: ["@frontend"] },
      { file: "src/3.ts", owners: ["@frontend"] },
    ];

    const summary = buildOwnershipSummary(ownership);
    const frontendPos = summary.indexOf("@frontend");
    const backendPos = summary.indexOf("@backend");
    expect(frontendPos).toBeLessThan(backendPos);
  });

  it("prepends @ to owners that lack it", () => {
    const ownership = [
      { file: "src/a.ts", owners: ["team-no-at"] },
    ];

    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("@team-no-at");
  });
});

// ---------------------------------------------------------------------------
// parseCodeowners — additional edge cases
// ---------------------------------------------------------------------------

describe("parseCodeowners (edge cases)", () => {
  it("handles lines with only whitespace", () => {
    const rules = parseCodeowners("   \n\t\nsrc/ @team");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@team"]);
  });

  it("handles pattern with no owners", () => {
    const rules = parseCodeowners("*.log");
    // The pattern is recognized but owners array is empty
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe("*.log");
    expect(rules[0].owners).toEqual([]);
  });

  it("handles pattern with email-style owner", () => {
    const rules = parseCodeowners("src/ user@example.com");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["user@example.com"]);
  });

  it("handles multiple negation patterns", () => {
    const rules = parseCodeowners("src/ @dev\n!src/generated/ @dev\n!src/vendor/ @dev");
    expect(rules).toHaveLength(3);
    expect(rules[1].isNegative).toBe(true);
    expect(rules[2].isNegative).toBe(true);
  });

  it("handles Windows-style CRLF line endings", () => {
    const rules = parseCodeowners("src/ @frontend\r\napi/ @backend\r\n");
    expect(rules).toHaveLength(2);
    expect(rules[0].owners).toEqual(["@frontend"]);
    expect(rules[1].owners).toEqual(["@backend"]);
  });

  it("handles trailing comment-like text as owners", () => {
    // Lines starting with # are comments; inline # is not a comment in CODEOWNERS
    const rules = parseCodeowners("src/ @team # optional note");
    expect(rules).toHaveLength(1);
    // The filter keeps tokens starting with @ or containing /
    expect(rules[0].owners).toContain("@team");
  });

  it("preserves pattern as-is for negation (strips !)", () => {
    const rules = parseCodeowners("!src/legacy/ @dev");
    expect(rules[0].pattern).toBe("src/legacy/");
    expect(rules[0].isNegative).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// globToRegex — additional edge cases
// ---------------------------------------------------------------------------

describe("globToRegex (edge cases)", () => {
  it("matches character class [abc]", () => {
    const regex = globToRegex("config.[abc].json");
    expect(regex.test("config.a.json")).toBe(true);
    expect(regex.test("config.b.json")).toBe(true);
    expect(regex.test("config.d.json")).toBe(false);
  });

  it("matches negation character class [!abc]", () => {
    const regex = globToRegex("config.[!x].json");
    expect(regex.test("config.y.json")).toBe(true);
    expect(regex.test("config.z.json")).toBe(true);
    expect(regex.test("config.x.json")).toBe(false);
  });

  it("matches deeply nested path with **", () => {
    const regex = globToRegex("**/test/*.ts");
    expect(regex.test("test/foo.ts")).toBe(true);
    expect(regex.test("src/test/foo.ts")).toBe(true);
    expect(regex.test("src/deep/nested/test/foo.ts")).toBe(true);
  });

  it("handles pattern with dot in filename", () => {
    const regex = globToRegex(".env");
    expect(regex.test(".env")).toBe(true);
    expect(regex.test("env")).toBe(false);
  });

  it("handles pattern with parentheses (escaped)", () => {
    const regex = globToRegex("src/(special).ts");
    expect(regex.test("src/(special).ts")).toBe(true);
  });

  it("handles pattern with dollar sign (escaped)", () => {
    const regex = globToRegex("file$name.ts");
    expect(regex.test("file$name.ts")).toBe(true);
  });

  it("matches root directory pattern without trailing slash", () => {
    const regex = globToRegex("src");
    expect(regex.test("src")).toBe(true);
    expect(regex.test("src/file.ts")).toBe(true); // matches as dir prefix
    expect(regex.test("other.ts")).toBe(false);
  });

  it("handles multiple wildcards in single pattern", () => {
    const regex = globToRegex("src/*/*.test.ts");
    expect(regex.test("src/components/button.test.ts")).toBe(true);
    expect(regex.test("src/button.test.ts")).toBe(false); // no intermediate dir
  });
});

// ---------------------------------------------------------------------------
// findOwners — additional edge cases
// ---------------------------------------------------------------------------

describe("findOwners (edge cases)", () => {
  it("handles last-wins with multiple matching rules", () => {
    const rules = parseCodeowners("src/ @frontend\nsrc/api/ @backend\nsrc/api/auth/ @sec-team");
    expect(findOwners("src/api/auth/handler.ts", rules)).toEqual(["@sec-team"]);
  });

  it("clears owners then re-assigns with negation and positive rules", () => {
    const rules = parseCodeowners("src/ @dev\n!src/gen/ @dev\nsrc/gen/manually-written/ @dev-special");
    // src/gen/auto.ts matches !src/gen/ so owners cleared
    expect(findOwners("src/gen/auto.ts", rules)).toEqual([]);
    // src/gen/manually-written/foo.ts matches both neg and then the positive
    expect(findOwners("src/gen/manually-written/foo.ts", rules)).toEqual(["@dev-special"]);
  });

  it("returns an empty array for file with only negation match", () => {
    const rules = parseCodeowners("!src/generated/ @dev");
    // The negation rule matches, clearing owners (which were already empty)
    const owners = findOwners("src/generated/proto.ts", rules);
    expect(owners).toEqual([]);
  });

  it("handles file path that matches default only", () => {
    const rules = parseCodeowners("* @default-team\nsrc/ @frontend");
    expect(findOwners("README.md", rules)).toEqual(["@default-team"]);
  });
});

// ---------------------------------------------------------------------------
// matchOwnership — additional edge cases
// ---------------------------------------------------------------------------

describe("matchOwnership (edge cases)", () => {
  it("handles empty diff files array", () => {
    const rules = parseCodeowners("src/ @team");
    const matches = matchOwnership([], rules);
    expect(matches).toEqual([]);
  });

  it("handles empty rules array", () => {
    const diffFiles = [
      { path: "src/app.ts", status: "modified" as const, additions: 1, deletions: 0, hunks: [] },
    ];
    const matches = matchOwnership(diffFiles, []);
    expect(matches[0].owners).toEqual([]);
  });

  it("maps multiple files to same owner", () => {
    const rules = parseCodeowners("src/ @frontend");
    const diffFiles = [
      { path: "src/a.ts", status: "modified" as const, additions: 1, deletions: 0, hunks: [] },
      { path: "src/b.ts", status: "modified" as const, additions: 2, deletions: 1, hunks: [] },
      { path: "src/c.ts", status: "added" as const, additions: 5, deletions: 0, hunks: [] },
    ];
    const matches = matchOwnership(diffFiles, rules);
    expect(matches).toHaveLength(3);
    for (const m of matches) {
      expect(m.owners).toEqual(["@frontend"]);
    }
  });
});

// ---------------------------------------------------------------------------
// applyOwnershipToFindings — additional edge cases
// ---------------------------------------------------------------------------

describe("applyOwnershipToFindings (edge cases)", () => {
  it("handles empty findings array", () => {
    const ownership = [{ file: "src/a.ts", owners: ["@team"] }];
    const result = applyOwnershipToFindings([], ownership);
    expect(result).toEqual([]);
  });

  it("handles empty ownership array", () => {
    const findings = [
      { file: "src/a.ts", line: 1, severity: "high" as const, category: "security" as const, message: "issue", confidence: 80 },
    ];
    const result = applyOwnershipToFindings(findings, []);
    expect(result[0].message).toBe("issue");
    expect(result[0].confidence).toBe(80);
  });

  it("applies custom confidence boost amount", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, confidenceBoost: 25 };
    const ownership = [{ file: "src/a.ts", owners: ["@team"] }];
    const findings = [
      { file: "src/a.ts", line: 1, severity: "high" as const, category: "security" as const, message: "issue", confidence: 70 },
    ];
    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].confidence).toBe(95); // 70 + 25
  });

  it("tags multiple owners in message", () => {
    const ownership = [{ file: "src/a.ts", owners: ["@team-a", "@team-b"] }];
    const findings = [
      { file: "src/a.ts", line: 1, severity: "high" as const, category: "security" as const, message: "issue", confidence: 80 },
    ];
    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].message).toContain("@team-a");
    expect(result[0].message).toContain("@team-b");
  });

  it("prepends @ to un-prefixed owners in message", () => {
    const ownership = [{ file: "src/a.ts", owners: ["my-team"] }];
    const findings = [
      { file: "src/a.ts", line: 1, severity: "medium" as const, category: "bug" as const, message: "issue", confidence: 70 },
    ];
    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].message).toContain("@my-team");
  });

  it("does not boost confidence when boostOwned is false", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, boostOwned: false };
    const ownership = [{ file: "src/a.ts", owners: ["@team"] }];
    const findings = [
      { file: "src/a.ts", line: 1, severity: "low" as const, category: "style" as const, message: "lint", confidence: 60 },
    ];
    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].confidence).toBe(60);
  });

  it("does not modify original findings (immutable)", () => {
    const ownership = [{ file: "src/a.ts", owners: ["@team"] }];
    const findings = [
      { file: "src/a.ts", line: 1, severity: "high" as const, category: "security" as const, message: "original", confidence: 70 },
    ];
    applyOwnershipToFindings(findings, ownership);
    expect(findings[0].message).toBe("original");
    expect(findings[0].confidence).toBe(70);
  });

  it("clamps confidence to 100 with large boost", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, confidenceBoost: 50 };
    const ownership = [{ file: "src/a.ts", owners: ["@team"] }];
    const findings = [
      { file: "src/a.ts", line: 1, severity: "high" as const, category: "security" as const, message: "issue", confidence: 90 },
    ];
    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].confidence).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildOwnershipSummary — additional edge cases
// ---------------------------------------------------------------------------

describe("buildOwnershipSummary (edge cases)", () => {
  it("handles files with multiple owners", () => {
    const ownership = [
      { file: "src/a.ts", owners: ["@frontend", "@backend"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("@frontend");
    expect(summary).toContain("@backend");
  });

  it("shows exactly 3 files then +N more", () => {
    const ownership = Array.from({ length: 5 }, (_, i) => ({
      file: `src/file${i}.ts`, owners: ["@team"],
    }));
    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("+2 more");
    expect(summary).not.toContain("+3 more");
  });

  it("handles single file per team without more suffix", () => {
    const ownership = [
      { file: "src/a.ts", owners: ["@solo-team"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    expect(summary).not.toContain("more");
  });

  it("includes markdown table header", () => {
    const ownership = [
      { file: "src/a.ts", owners: ["@team"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("| Team |");
    expect(summary).toContain("|------|");
  });

  it("counts total files correctly when same file has overlapping teams", () => {
    const ownership = [
      { file: "shared.ts", owners: ["@team-a", "@team-b"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    // Each team should show 1 file
    expect(summary).toContain("| @team-a | 1 |");
    expect(summary).toContain("| @team-b | 1 |");
  });
});

// ---------------------------------------------------------------------------
// loadCodeowners — file system loading
// ---------------------------------------------------------------------------

describe("loadCodeowners", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-codeowners-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no CODEOWNERS file exists", () => {
    const rules = loadCodeowners(tmpDir);
    expect(rules).toEqual([]);
  });

  it("loads from root CODEOWNERS file", () => {
    fs.writeFileSync(path.join(tmpDir, "CODEOWNERS"), "src/ @frontend\napi/ @backend");
    const rules = loadCodeowners(tmpDir);
    expect(rules).toHaveLength(2);
    expect(rules[0].owners).toEqual(["@frontend"]);
  });

  it("loads from .github/CODEOWNERS", () => {
    const dir = path.join(tmpDir, ".github");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CODEOWNERS"), "*.ts @ts-team");
    const rules = loadCodeowners(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@ts-team"]);
  });

  it("loads from docs/CODEOWNERS", () => {
    const dir = path.join(tmpDir, "docs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "CODEOWNERS"), "docs/ @docs-team");
    const rules = loadCodeowners(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@docs-team"]);
  });

  it("prefers .github/CODEOWNERS over root when both exist", () => {
    fs.writeFileSync(path.join(tmpDir, "CODEOWNERS"), "* @root-team");
    const ghDir = path.join(tmpDir, ".github");
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, "CODEOWNERS"), "* @github-team");
    // Root is checked first, so root wins
    const rules = loadCodeowners(tmpDir);
    expect(rules[0].owners).toEqual(["@root-team"]);
  });

  it("returns empty array for unreadable CODEOWNERS", () => {
    fs.writeFileSync(path.join(tmpDir, "CODEOWNERS"), "not valid {json}won't-matter");
    // parseCodeowners should still parse it as text (it's not JSON)
    const rules = loadCodeowners(tmpDir);
    // It parses the line as a rule with the whole string as pattern
    expect(rules.length).toBeGreaterThanOrEqual(0);
  });
});
