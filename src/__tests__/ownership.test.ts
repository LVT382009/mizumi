import { describe, it, expect } from "vitest";
import {
  parseCodeowners,
  globToRegex,
  findOwners,
  matchOwnership,
  applyOwnershipToFindings,
  buildOwnershipSummary,
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
