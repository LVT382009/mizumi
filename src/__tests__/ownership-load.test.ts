import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  isDebug: vi.fn(() => false),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

import {
  loadCodeowners,
  parseCodeowners,
  globToRegex,
  findOwners,
  matchOwnership,
  applyOwnershipToFindings,
  buildOwnershipSummary,
  DEFAULT_OWNERSHIP_CONFIG,
} from "../ownership.js";
import type { OwnershipRule, OwnershipMatch, OwnershipConfig } from "../ownership.js";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// loadCodeowners (file loading)
// ---------------------------------------------------------------------------

describe("loadCodeowners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("loads from .github/CODEOWNERS", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p.toString().endsWith(".github/CODEOWNERS"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("src/ @team");

    const rules = loadCodeowners("/workspace");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@team"]);
  });

  it("tries root CODEOWNERS first", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p.toString().endsWith("CODEOWNERS") && !p.toString().includes(".github") && !p.toString().includes("docs"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("* @all-team");

    const rules = loadCodeowners("/workspace");
    expect(rules[0].owners).toEqual(["@all-team"]);
  });

  it("returns empty array when no CODEOWNERS file exists", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const rules = loadCodeowners("/workspace");
    expect(rules).toHaveLength(0);
  });

  it("continues to next path when read fails", () => {
    let callCount = 0;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("Permission denied");
      return "src/ @fallback-team";
    });

    loadCodeowners("/workspace");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("loads from docs/CODEOWNERS as fallback", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p.toString().includes("docs/CODEOWNERS"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("*.md @docs-team");

    const rules = loadCodeowners("/workspace");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@docs-team"]);
  });
});

// ---------------------------------------------------------------------------
// parseCodeowners
// ---------------------------------------------------------------------------

describe("parseCodeowners", () => {
  it("parses single pattern with single owner", () => {
    const rules = parseCodeowners("src/ @frontend");
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe("src/");
    expect(rules[0].owners).toEqual(["@frontend"]);
    expect(rules[0].isNegative).toBe(false);
  });

  it("parses pattern with multiple owners", () => {
    const rules = parseCodeowners("src/api/ @backend @devops");
    expect(rules[0].owners).toEqual(["@backend", "@devops"]);
  });

  it("skips blank lines and comments", () => {
    const content = "# This is a comment\n\nsrc/ @team\n# another comment\n";
    const rules = parseCodeowners(content);
    expect(rules).toHaveLength(1);
  });

  it("parses negation patterns", () => {
    const rules = parseCodeowners("!src/generated/ @nobody");
    expect(rules[0].isNegative).toBe(true);
    expect(rules[0].pattern).toBe("src/generated/");
  });

  it("parses wildcard patterns", () => {
    const rules = parseCodeowners("*.ts @ts-team\nsrc/**/*.js @js-team");
    expect(rules).toHaveLength(2);
    expect(rules[0].pattern).toBe("*.ts");
    expect(rules[1].pattern).toBe("src/**/*.js");
  });

  it("parses glob with character class", () => {
    const rules = parseCodeowners("src/[abc]/*.ts @team");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@team"]);
  });

  it("returns empty array for empty content", () => {
    expect(parseCodeowners("")).toHaveLength(0);
    expect(parseCodeowners("# only comments\n\n")).toHaveLength(0);
  });

  it("handles default owner line (no path prefix)", () => {
    const rules = parseCodeowners("* @default-team");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@default-team"]);
  });

  it("includes email-style owners", () => {
    const rules = parseCodeowners("src/ user@example.com");
    expect(rules[0].owners).toEqual(["user@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// globToRegex
// ---------------------------------------------------------------------------

describe("globToRegex", () => {
  it("matches exact file", () => {
    const re = globToRegex("README.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("src/README.md")).toBe(false);
  });

  it("matches directory pattern with trailing slash", () => {
    const re = globToRegex("src/");
    expect(re.test("src/")).toBe(true);
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("lib/foo.ts")).toBe(false);
  });

  it("matches * wildcard (no slash)", () => {
    const re = globToRegex("*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("dir/foo.ts")).toBe(false);
  });

  it("matches ** globstar (any depth)", () => {
    const re = globToRegex("src/**/*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/sub/foo.ts")).toBe(true);
    expect(re.test("src/a/b/c/foo.ts")).toBe(true);
    expect(re.test("lib/foo.ts")).toBe(false);
  });

  it("matches ** at start (optional prefix)", () => {
    const re = globToRegex("**/auth/**");
    expect(re.test("auth/login.ts")).toBe(true);
    expect(re.test("pkg/auth/login.ts")).toBe(true);
    expect(re.test("src/pkg/auth/util.ts")).toBe(true);
    expect(re.test("src/app.ts")).toBe(false);
  });

  it("matches ? single char", () => {
    const re = globToRegex("file?.ts");
    expect(re.test("file1.ts")).toBe(true);
    expect(re.test("fileA.ts")).toBe(true);
    expect(re.test("file12.ts")).toBe(false);
  });

  it("matches character class [abc]", () => {
    const re = globToRegex("[abc].ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("b.ts")).toBe(true);
    expect(re.test("d.ts")).toBe(false);
  });

  it("matches negation class [!abc]", () => {
    const re = globToRegex("[!abc].ts");
    expect(re.test("d.ts")).toBe(true);
    expect(re.test("a.ts")).toBe(false);
  });

  it("escapes dot characters", () => {
    const re = globToRegex("config.json");
    expect(re.test("config.json")).toBe(true);
    expect(re.test("configXjson")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findOwners
// ---------------------------------------------------------------------------

describe("findOwners", () => {
  const rules: OwnershipRule[] = [
    { pattern: "src/", owners: ["@frontend"], isNegative: false, regex: globToRegex("src/") },
    { pattern: "src/api/", owners: ["@backend"], isNegative: false, regex: globToRegex("src/api/") },
    { pattern: "!src/api/generated/", owners: [], isNegative: true, regex: globToRegex("src/api/generated/") },
  ];

  it("returns owners for matching file", () => {
    expect(findOwners("src/app.ts", rules)).toEqual(["@frontend"]);
  });

  it("returns last-match-wins owners", () => {
    expect(findOwners("src/api/routes.ts", rules)).toEqual(["@backend"]);
  });

  it("returns empty for negation match", () => {
    expect(findOwners("src/api/generated/proto.ts", rules)).toEqual([]);
  });

  it("returns empty array for no match", () => {
    expect(findOwners("README.md", rules)).toEqual([]);
  });

  it("default * pattern wins for unmatched files when last", () => {
    const allRules: OwnershipRule[] = [
      { pattern: "src/", owners: ["@team"], isNegative: false, regex: globToRegex("src/") },
      { pattern: "*", owners: ["@default"], isNegative: false, regex: globToRegex("*") },
    ];
    expect(findOwners("package.json", allRules)).toEqual(["@default"]);
  });
});

// ---------------------------------------------------------------------------
// matchOwnership
// ---------------------------------------------------------------------------

describe("matchOwnership", () => {
  const rules: OwnershipRule[] = [
    { pattern: "src/", owners: ["@frontend"], isNegative: false, regex: globToRegex("src/") },
    { pattern: "*.md", owners: ["@docs"], isNegative: false, regex: globToRegex("*.md") },
  ];

  it("maps diff files to owners", () => {
    const matches = matchOwnership(
      [
        { path: "src/app.ts", additions: 1, deletions: 0 },
        { path: "README.md", additions: 2, deletions: 0 },
        { path: "package.json", additions: 0, deletions: 1 },
      ],
      rules,
    );
    expect(matches).toEqual([
      { file: "src/app.ts", owners: ["@frontend"] },
      { file: "README.md", owners: ["@docs"] },
      { file: "package.json", owners: [] },
    ]);
  });

  it("returns empty owners when no rules match", () => {
    const matches = matchOwnership(
      [{ path: "Dockerfile", additions: 1, deletions: 0 }],
      rules,
    );
    expect(matches[0].owners).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyOwnershipToFindings
// ---------------------------------------------------------------------------

describe("applyOwnershipToFindings", () => {
  const ownership: OwnershipMatch[] = [
    { file: "src/auth.ts", owners: ["@sec-team"] },
    { file: "src/ui.ts", owners: ["@frontend"] },
    { file: "README.md", owners: [] },
  ];

  const findings = [
    { file: "src/auth.ts", line: 10, severity: "high", category: "security", message: "SQL injection", confidence: 75 },
    { file: "src/ui.ts", line: 5, severity: "low", category: "style", message: "Missing semicolon", confidence: 60 },
    { file: "README.md", line: 1, severity: "nitpick", category: "docs", message: "Typo", confidence: 40 },
  ] as any[];

  it("tags owners in messages", () => {
    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].message).toContain("@sec-team");
    expect(result[1].message).toContain("@frontend");
  });

  it("boosts confidence for owned files", () => {
    const result = applyOwnershipToFindings(findings, ownership);
    expect(result[0].confidence).toBe(85); // 75 + 10
    expect(result[1].confidence).toBe(70); // 60 + 10
    expect(result[2].confidence).toBe(40); // no boost, no owners
  });

  it("caps confidence at 100", () => {
    const highConfidence = [{ ...findings[0], confidence: 95 }];
    const result = applyOwnershipToFindings(highConfidence, ownership);
    expect(result[0].confidence).toBe(100);
  });

  it("does not duplicate owner tags", () => {
    const alreadyTagged = [{ ...findings[0], message: "@sec-team - SQL injection" }];
    const result = applyOwnershipToFindings(alreadyTagged as any[], ownership);
    expect(result[0].message.match(/@sec-team/g)?.length).toBe(1);
  });

  it("skips tagging when tagOwners is false", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, tagOwners: false };
    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].message).not.toContain("@sec-team");
  });

  it("skips boost when boostOwned is false", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, boostOwned: false };
    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].confidence).toBe(75);
  });

  it("uses custom confidenceBoost value", () => {
    const config: OwnershipConfig = { ...DEFAULT_OWNERSHIP_CONFIG, confidenceBoost: 25 };
    const result = applyOwnershipToFindings(findings, ownership, config);
    expect(result[0].confidence).toBe(100); // 75 + 25 = 100
  });
});

// ---------------------------------------------------------------------------
// buildOwnershipSummary
// ---------------------------------------------------------------------------

describe("buildOwnershipSummary", () => {
  it("returns empty string when no ownership matches", () => {
    expect(buildOwnershipSummary([])).toBe("");
  });

  it("returns empty string when all owners are empty", () => {
    expect(buildOwnershipSummary([{ file: "a.ts", owners: [] }])).toBe("");
  });

  it("builds markdown table with team coverage", () => {
    const ownership: OwnershipMatch[] = [
      { file: "src/auth.ts", owners: ["@sec-team"] },
      { file: "src/api.ts", owners: ["@sec-team"] },
      { file: "src/ui.ts", owners: ["@frontend"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("| Team |");
    expect(summary).toContain("@sec-team");
    expect(summary).toContain("@frontend");
    expect(summary).toContain("2"); // sec-team has 2 files
  });

  it("truncates file list at 3 files", () => {
    const ownership: OwnershipMatch[] = Array.from({ length: 5 }, (_, i) => ({
      file: `src/file${i}.ts`,
      owners: ["@team"],
    }));
    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("+2 more");
  });

  it("sorts teams by file count descending", () => {
    const ownership: OwnershipMatch[] = [
      { file: "a.ts", owners: ["@small-team"] },
      { file: "b.ts", owners: ["@big-team"] },
      { file: "c.ts", owners: ["@big-team"] },
      { file: "d.ts", owners: ["@big-team"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    const bigIdx = summary.indexOf("@big-team");
    const smallIdx = summary.indexOf("@small-team");
    expect(bigIdx).toBeLessThan(smallIdx);
  });

  it("adds @ prefix to owners without it", () => {
    const ownership: OwnershipMatch[] = [
      { file: "src/app.ts", owners: ["frontend"] },
    ];
    const summary = buildOwnershipSummary(ownership);
    expect(summary).toContain("@frontend");
  });
});
