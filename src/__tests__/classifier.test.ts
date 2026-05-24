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
});
