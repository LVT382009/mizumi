import { describe, it, expect } from "vitest";
import { classifyPR } from "../classifier.js";

describe("classifyPR", () => {
  it("classifies docs-only PR as docs", () => {
    const result = classifyPR(
      [
        { from: "README.md", additions: 10, deletions: 2 },
        { from: "docs/api.txt", additions: 5, deletions: 0 },
      ],
      15,
      2
    );
    expect(result.category).toBe("docs");
    expect(result.confidence).toBeGreaterThanOrEqual(90);
  });

  it("classifies .rst docs as docs", () => {
    const result = classifyPR(
      [{ from: "CHANGELOG.rst", additions: 3, deletions: 0 }],
      3,
      0
    );
    expect(result.category).toBe("docs");
  });

  it("classifies test-only additions as tests", () => {
    const result = classifyPR(
      [
        { from: "src/app.test.ts", additions: 20, deletions: 0 },
        { from: "tests/unit.spec.js", additions: 15, deletions: 0 },
      ],
      35,
      0
    );
    expect(result.category).toBe("tests");
  });

  it("does NOT classify tests with deletions as tests", () => {
    const result = classifyPR(
      [{ from: "src/app.test.ts", additions: 20, deletions: 5 }],
      20,
      5
    );
    expect(result.category).not.toBe("tests");
  });

  it("classifies config-only PR as config", () => {
    const result = classifyPR(
      [
        { from: ".github/workflows/ci.yml", additions: 8, deletions: 2 },
        { from: "tsconfig.json", additions: 1, deletions: 1 },
      ],
      9,
      3
    );
    expect(result.category).toBe("config");
  });

  it("classifies Dockerfile as config", () => {
    const result = classifyPR(
      [{ from: "Dockerfile", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("config");
  });

  it("classifies dotfiles as config", () => {
    const result = classifyPR(
      [{ from: ".eslintrc", additions: 2, deletions: 1 }],
      2,
      1
    );
    expect(result.category).toBe("config");
  });

  it("classifies security-sensitive files as security", () => {
    const result = classifyPR(
      [{ from: "src/auth/login.ts", additions: 12, deletions: 3 }],
      12,
      3
    );
    expect(result.category).toBe("security");
  });

  it("detects crypto as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/crypto/hash.ts", additions: 8, deletions: 0 }],
      8,
      0
    );
    expect(result.category).toBe("security");
  });

  it("detects password as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/password-utils.ts", additions: 4, deletions: 1 }],
      4,
      1
    );
    expect(result.category).toBe("security");
  });

  it("classifies high-ratio CSS changes as cosmetic", () => {
    const result = classifyPR(
      [{ from: "src/styles/main.css", additions: 50, deletions: 5 }],
      50,
      5
    );
    expect(result.category).toBe("cosmetic");
  });

  it("does NOT classify low-ratio CSS as cosmetic", () => {
    const result = classifyPR(
      [{ from: "src/styles/main.css", additions: 10, deletions: 5 }],
      10,
      5
    );
    expect(result.category).toBe("logic");
  });

  it("classifies mixed code changes as logic", () => {
    const result = classifyPR(
      [
        { from: "src/app.ts", additions: 15, deletions: 4 },
        { from: "src/utils.ts", additions: 8, deletions: 2 },
      ],
      23,
      6
    );
    expect(result.category).toBe("logic");
  });

  it("handles empty file list as logic with low confidence", () => {
    const result = classifyPR([], 0, 0);
    expect(result.category).toBe("logic");
    expect(result.confidence).toBeLessThan(50);
  });

  it("security takes precedence even among mostly config files", () => {
    const result = classifyPR(
      [
        { from: ".github/workflows/ci.yml", additions: 2, deletions: 0 },
        { from: "src/sql/queries.ts", additions: 10, deletions: 0 },
      ],
      12,
      0
    );
    expect(result.category).toBe("security");
  });

  it("classifies __tests__ path as tests when additions-only", () => {
    const result = classifyPR(
      [{ from: "__tests__/integration.test.ts", additions: 30, deletions: 0 }],
      30,
      0
    );
    expect(result.category).toBe("tests");
  });

  it("classifies image files as cosmetic with high ratio", () => {
    const result = classifyPR(
      [{ from: "assets/icon.svg", additions: 60, deletions: 5 }],
      60,
      5
    );
    expect(result.category).toBe("cosmetic");
  });

  // --- New tests ---

  it("classifies .txt files as docs", () => {
    const result = classifyPR(
      [{ from: "NOTES.txt", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("docs");
  });

  it("classifies docs/ prefix as docs", () => {
    const result = classifyPR(
      [{ from: "docs/guide.md", additions: 15, deletions: 2 }],
      15,
      2
    );
    expect(result.category).toBe("docs");
  });

  it("detects token as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/token-handler.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
  });

  it("detects permission as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/permission-check.ts", additions: 8, deletions: 1 }],
      8,
      1
    );
    expect(result.category).toBe("security");
  });

  it("detects secret as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/secret-manager.ts", additions: 10, deletions: 0 }],
      10,
      0
    );
    expect(result.category).toBe("security");
  });

  it("does NOT classify tests with mixed additions and deletions as tests", () => {
    const result = classifyPR(
      [
        { from: "tests/a.spec.ts", additions: 10, deletions: 0 },
        { from: "tests/b.spec.ts", additions: 5, deletions: 2 },
      ],
      15,
      2
    );
    expect(result.category).not.toBe("tests");
  });

  it("classifies YAML config files as config", () => {
    const result = classifyPR(
      [{ from: "docker-compose.yml", additions: 10, deletions: 2 }],
      10,
      2
    );
    expect(result.category).toBe("config");
  });

  it("classifies JSON config files as config", () => {
    const result = classifyPR(
      [{ from: "package.json", additions: 3, deletions: 1 }],
      3,
      1
    );
    expect(result.category).toBe("config");
  });

  it("classifies .github/ prefix as config", () => {
    const result = classifyPR(
      [{ from: ".github/CODEOWNERS", additions: 2, deletions: 0 }],
      2,
      0
    );
    expect(result.category).toBe("config");
  });

  it("classifies SCSS with high ratio as cosmetic", () => {
    const result = classifyPR(
      [{ from: "src/theme.scss", additions: 60, deletions: 10 }],
      60,
      10
    );
    expect(result.category).toBe("cosmetic");
  });

  it("classifies single addition-only spec file as tests", () => {
    const result = classifyPR(
      [{ from: "src/button.spec.tsx", additions: 25, deletions: 0 }],
      25,
      0
    );
    expect(result.category).toBe("tests");
  });

  it("logic category has confidence 60", () => {
    const result = classifyPR(
      [
        { from: "src/app.ts", additions: 15, deletions: 4 },
        { from: "src/utils.ts", additions: 8, deletions: 2 },
      ],
      23,
      6
    );
    expect(result.confidence).toBe(60);
  });

  it("security reason includes the file path", () => {
    const result = classifyPR(
      [{ from: "src/auth/token.ts", additions: 10, deletions: 0 }],
      10,
      0
    );
    expect(result.reason).toContain("src/auth/token.ts");
  });

  it("docs category has confidence 95", () => {
    const result = classifyPR(
      [{ from: "README.md", additions: 10, deletions: 0 }],
      10,
      0
    );
    expect(result.confidence).toBe(95);
  });

  it("does not classify mixed docs + code as docs", () => {
    const result = classifyPR(
      [
        { from: "README.md", additions: 5, deletions: 0 },
        { from: "src/app.ts", additions: 10, deletions: 2 },
      ],
      15,
      2
    );
    // Not all files are docs, so it should fall through to security/logic check
    expect(result.category).not.toBe("docs");
  });

  it("empty file list returns reason 'no files to classify'", () => {
    const result = classifyPR([], 0, 0);
    expect(result.reason).toBe("no files to classify");
  });

  it("does not classify cosmetic with 0 deletions and non-cosmetic files", () => {
    const result = classifyPR(
      [{ from: "src/app.ts", additions: 60, deletions: 0 }],
      60,
      0
    );
    expect(result.category).not.toBe("cosmetic");
  });

  // --- prTitle and prBody params ---

  it("accepts prTitle parameter without affecting classification", () => {
    const result = classifyPR(
      [{ from: "src/app.ts", additions: 10, deletions: 2 }],
      10,
      2,
      "Fix login bug"
    );
    expect(result.category).toBe("logic");
  });

  it("accepts prBody parameter without affecting classification", () => {
    const result = classifyPR(
      [{ from: "src/app.ts", additions: 10, deletions: 2 }],
      10,
      2,
      undefined,
      "This PR fixes a critical issue"
    );
    expect(result.category).toBe("logic");
  });

  it("accepts both prTitle and prBody without affecting classification", () => {
    const result = classifyPR(
      [{ from: "README.md", additions: 10, deletions: 0 }],
      10,
      0,
      "Update docs",
      "Updating the README with new instructions"
    );
    expect(result.category).toBe("docs");
  });

  // --- All security RE patterns ---

  it("detects auth as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/auth/login.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
  });

  it("detects sql as security keyword", () => {
    const result = classifyPR(
      [{ from: "src/sql/query-builder.ts", additions: 8, deletions: 2 }],
      8,
      2
    );
    expect(result.category).toBe("security");
  });

  // --- Mixed file types: docs + code ---

  it("does NOT classify .md files mixed with code files as docs", () => {
    const result = classifyPR(
      [
        { from: "docs/guide.md", additions: 5, deletions: 0 },
        { from: "src/index.ts", additions: 10, deletions: 2 },
      ],
      15,
      2
    );
    expect(result.category).not.toBe("docs");
  });

  it("classifies .md mixed with .py as logic (not docs)", () => {
    const result = classifyPR(
      [
        { from: "README.md", additions: 3, deletions: 0 },
        { from: "main.py", additions: 20, deletions: 5 },
      ],
      23,
      5
    );
    expect(result.category).not.toBe("docs");
  });

  // --- Config files: combos ---

  it("classifies yml + json combo as config", () => {
    const result = classifyPR(
      [
        { from: "app.yml", additions: 5, deletions: 1 },
        { from: "config.json", additions: 3, deletions: 0 },
      ],
      8,
      1
    );
    expect(result.category).toBe("config");
  });

  it("classifies dotfiles as config", () => {
    const result = classifyPR(
      [
        { from: ".eslintrc", additions: 2, deletions: 0 },
        { from: ".prettierrc", additions: 1, deletions: 0 },
      ],
      3,
      0
    );
    expect(result.category).toBe("config");
  });

  it("classifies .github/ + Dockerfile combo as config", () => {
    const result = classifyPR(
      [
        { from: ".github/workflows/deploy.yml", additions: 10, deletions: 2 },
        { from: "Dockerfile", additions: 5, deletions: 0 },
      ],
      15,
      2
    );
    expect(result.category).toBe("config");
  });

  // --- Cosmetic boundary ratio (5x) ---

  it("does NOT classify as cosmetic at exact 5x ratio (ratio must be >5, not >=5)", () => {
    // 50/10 = 5.0, but the check is > 5 (strictly greater)
    const result = classifyPR(
      [{ from: "styles/main.css", additions: 50, deletions: 10 }],
      50,
      10
    );
    expect(result.category).not.toBe("cosmetic");
  });

  it("classifies as cosmetic just above 5x ratio (51 additions, 10 deletions)", () => {
    // 51/10 = 5.1 > 5, so cosmetic triggers
    const result = classifyPR(
      [{ from: "styles/main.css", additions: 51, deletions: 10 }],
      51,
      10
    );
    expect(result.category).toBe("cosmetic");
  });

  it("does NOT classify as cosmetic below 5x ratio (49 additions, 10 deletions)", () => {
    const result = classifyPR(
      [{ from: "styles/main.css", additions: 49, deletions: 10 }],
      49,
      10
    );
    expect(result.category).not.toBe("cosmetic");
  });

  // --- Security wins over config ---

  it("config wins over security when single file matches both config and security patterns", () => {
    // A yml file matching config pattern triggers the config check first (all-files check).
    // Security only triggers when NOT all files are config. This is by design:
    // pure config changes are categorized as config even if the filename has auth/sql.
    const result = classifyPR(
      [{ from: "config/auth.yml", additions: 5, deletions: 1 }],
      5,
      1
    );
    expect(result.category).toBe("config");
  });

  it("security wins over config with mixed file types", () => {
    const result = classifyPR(
      [
        { from: "tsconfig.json", additions: 2, deletions: 0 },
        { from: "src/auth/middleware.ts", additions: 10, deletions: 0 },
      ],
      12,
      0
    );
    expect(result.category).toBe("security");
  });

  // --- Confidence values per category ---

  it("config category has confidence 90", () => {
    const result = classifyPR(
      [{ from: "app.yml", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("config");
    expect(result.confidence).toBe(90);
  });

  it("tests category has confidence 90", () => {
    const result = classifyPR(
      [{ from: "src/app.test.ts", additions: 20, deletions: 0 }],
      20,
      0
    );
    expect(result.category).toBe("tests");
    expect(result.confidence).toBe(90);
  });

  it("security category has confidence 75", () => {
    const result = classifyPR(
      [{ from: "src/auth/login.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
    expect(result.confidence).toBe(75);
  });

  it("cosmetic category has confidence 80", () => {
    const result = classifyPR(
      [{ from: "styles/main.css", additions: 60, deletions: 5 }],
      60,
      5
    );
    expect(result.category).toBe("cosmetic");
    expect(result.confidence).toBe(80);
  });

  it("empty file list has confidence 30", () => {
    const result = classifyPR([], 0, 0);
    expect(result.category).toBe("logic");
    expect(result.confidence).toBe(30);
  });

  // --- Edge cases ---

  it("handles empty additions and deletions in file list", () => {
    const result = classifyPR(
      [
        { from: "src/app.ts", additions: 0, deletions: 0 },
        { from: "src/util.ts", additions: 0, deletions: 0 },
      ],
      0,
      0
    );
    expect(result.category).toBe("logic");
  });

  it("handles very large file list (100+ files)", () => {
    const files = Array.from({ length: 120 }, (_, i) => ({
      from: `src/module${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const result = classifyPR(files, 120, 0);
    expect(result.category).toBe("logic");
  });

  it("handles file paths with forward slashes", () => {
    const result = classifyPR(
      [{ from: "src/deep/nested/auth/handler.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
  });

  it("handles file paths with backslashes", () => {
    const result = classifyPR(
      [{ from: "src\\deep\\auth\\handler.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
  });

  it("handles test path with backslashes", () => {
    const result = classifyPR(
      [{ from: "tests\\unit\\app.spec.ts", additions: 10, deletions: 0 }],
      10,
      0
    );
    // backslash in test path still matches TEST_PATH_RE with [\\/]
    expect(result.category).toBe("tests");
  });

  // --- Reason strings ---

  it("docs reason is 'all files are documentation'", () => {
    const result = classifyPR(
      [{ from: "README.md", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.reason).toBe("all files are documentation");
  });

  it("tests reason mentions additions in test files", () => {
    const result = classifyPR(
      [{ from: "src/app.test.ts", additions: 20, deletions: 0 }],
      20,
      0
    );
    expect(result.reason).toBe("only additions in test files");
  });

  it("config reason is 'all files are configuration'", () => {
    const result = classifyPR(
      [{ from: "app.yml", additions: 3, deletions: 1 }],
      3,
      1
    );
    expect(result.reason).toBe("all files are configuration");
  });

  it("cosmetic reason mentions high add/rm ratio", () => {
    const result = classifyPR(
      [{ from: "styles/main.css", additions: 60, deletions: 5 }],
      60,
      5
    );
    expect(result.reason).toContain("high add/rm ratio");
  });

  it("logic reason is 'general code changes'", () => {
    const result = classifyPR(
      [{ from: "src/app.ts", additions: 10, deletions: 2 }],
      10,
      2
    );
    expect(result.reason).toBe("general code changes");
  });

  // --- Security keyword edge cases ---

  it("detects security keyword in mixed-case path", () => {
    const result = classifyPR(
      [{ from: "src/Auth/Middleware.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
  });

  it("detects CRYPTO in uppercase as security (case-insensitive)", () => {
    const result = classifyPR(
      [{ from: "src/CRYPTO/hash.ts", additions: 5, deletions: 0 }],
      5,
      0
    );
    expect(result.category).toBe("security");
  });

  // --- Cosmetic edge cases ---

  it("does NOT classify cosmetic when 0 deletions even for CSS files", () => {
    const result = classifyPR(
      [{ from: "styles/main.css", additions: 100, deletions: 0 }],
      100,
      0
    );
    expect(result.category).not.toBe("cosmetic");
  });

  it("classifies SVG as cosmetic with high ratio", () => {
    const result = classifyPR(
      [{ from: "assets/hero.svg", additions: 55, deletions: 5 }],
      55,
      5
    );
    expect(result.category).toBe("cosmetic");
  });

  // --- Config-only combos ---

  it("classifies only Dockerfile as config", () => {
    const result = classifyPR(
      [{ from: "Dockerfile", additions: 10, deletions: 2 }],
      10,
      2
    );
    expect(result.category).toBe("config");
  });

  it("classifies .github/CODEOWNERS as config even though not yml/json", () => {
    const result = classifyPR(
      [{ from: ".github/CODEOWNERS", additions: 3, deletions: 0 }],
      3,
      0
    );
    expect(result.category).toBe("config");
  });
});
