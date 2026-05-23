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
});
