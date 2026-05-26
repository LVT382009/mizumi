import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { computeRepoHealth } from "../repo-health.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-health-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function mkdir(relPath: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(fullPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// computeRepoHealth — basic scoring
// ---------------------------------------------------------------------------

describe("computeRepoHealth basic scoring", () => {
  it("returns 0 score for empty workspace", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.score).toBeLessThan(10);
    expect(result.grade).toBe("F");
    expect(result.signals).toHaveLength(10);
  });

  it("returns 100 score for fully configured workspace", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("package-lock.json", '{}');
    writeFile(".github/workflows/ci.yml", "name: CI");
    writeFile("vitest.config.ts", "export default {}");
    writeFile("eslint.config.js", "export default {}");
    writeFile(".prettierrc", "{}");
    writeFile("Dockerfile", "FROM node:24");
    writeFile(".env", "KEY=VAL");
    writeFile(".env.example", "KEY=VAL");
    writeFile("CODEOWNERS", "* @team");
    writeFile("README.md", "# Test");
    writeFile("CONTRIBUTING.md", "# Contrib");
    writeFile("CHANGELOG.md", "# Changelog");
    writeFile("SECURITY.md", "# Security");
    mkdir("test");

    const result = computeRepoHealth(tmpDir);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.grade).toBe("A");
  });

  it("scores CI config when .github/workflows exists", () => {
    writeFile(".github/workflows/ci.yml", "name: CI");
    const result = computeRepoHealth(tmpDir);
    const ci = result.signals.find(s => s.id === "ci_config");
    expect(ci!.score).toBe(10);
  });

  it("scores CI config when .gitlab-ci.yml exists", () => {
    writeFile(".gitlab-ci.yml", "stages: [test]");
    const result = computeRepoHealth(tmpDir);
    const ci = result.signals.find(s => s.id === "ci_config");
    expect(ci!.score).toBe(10);
  });

  it("scores CI config when Jenkinsfile exists", () => {
    writeFile("Jenkinsfile", "pipeline {}");
    const result = computeRepoHealth(tmpDir);
    const ci = result.signals.find(s => s.id === "ci_config");
    expect(ci!.score).toBe(10);
  });

  it("scores CI config when .circleci exists", () => {
    mkdir(".circleci");
    writeFile(".circleci/config.yml", "version: 2.1");
    const result = computeRepoHealth(tmpDir);
    const ci = result.signals.find(s => s.id === "ci_config");
    expect(ci!.score).toBe(10);
  });

  it("gives 0 CI score when no CI config", () => {
    writeFile("package.json", '{"name":"test"}');
    const result = computeRepoHealth(tmpDir);
    const ci = result.signals.find(s => s.id === "ci_config");
    expect(ci!.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test framework detection
// ---------------------------------------------------------------------------

describe("test framework detection", () => {
  it("detects vitest.config.ts", () => {
    writeFile("vitest.config.ts", "export default {}");
    const result = computeRepoHealth(tmpDir);
    const test = result.signals.find(s => s.id === "test_framework");
    expect(test!.score).toBeGreaterThanOrEqual(6);
  });

  it("detects test directory", () => {
    mkdir("test");
    writeFile("test/app.test.ts", "");
    const result = computeRepoHealth(tmpDir);
    const test = result.signals.find(s => s.id === "test_framework");
    expect(test!.score).toBeGreaterThanOrEqual(4);
  });

  it("detects __tests__ directory", () => {
    mkdir("__tests__");
    writeFile("__tests__/app.test.ts", "");
    const result = computeRepoHealth(tmpDir);
    const test = result.signals.find(s => s.id === "test_framework");
    expect(test!.score).toBeGreaterThanOrEqual(4);
  });

  it("full score with config + directory", () => {
    writeFile("jest.config.js", "module.exports = {}");
    mkdir("__tests__");
    const result = computeRepoHealth(tmpDir);
    const test = result.signals.find(s => s.id === "test_framework");
    expect(test!.score).toBe(10);
  });

  it("zero score with no test infrastructure", () => {
    const result = computeRepoHealth(tmpDir);
    const test = result.signals.find(s => s.id === "test_framework");
    expect(test!.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Linter / formatter detection
// ---------------------------------------------------------------------------

describe("linter and formatter detection", () => {
  it("detects eslint config", () => {
    writeFile("eslint.config.js", "export default {}");
    const result = computeRepoHealth(tmpDir);
    const lint = result.signals.find(s => s.id === "lint_config");
    expect(lint!.score).toBe(10);
  });

  it("detects .eslintrc.json", () => {
    writeFile(".eslintrc.json", "{}");
    const result = computeRepoHealth(tmpDir);
    const lint = result.signals.find(s => s.id === "lint_config");
    expect(lint!.score).toBe(10);
  });

  it("zero lint score without config", () => {
    const result = computeRepoHealth(tmpDir);
    const lint = result.signals.find(s => s.id === "lint_config");
    expect(lint!.score).toBe(0);
  });

  it("detects prettier config", () => {
    writeFile(".prettierrc", "{}");
    const result = computeRepoHealth(tmpDir);
    const fmt = result.signals.find(s => s.id === "formatter_config");
    expect(fmt!.score).toBe(10);
  });

  it("detects prettier.config.js", () => {
    writeFile("prettier.config.js", "export default {}");
    const result = computeRepoHealth(tmpDir);
    const fmt = result.signals.find(s => s.id === "formatter_config");
    expect(fmt!.score).toBe(10);
  });

  it("zero formatter score without config", () => {
    const result = computeRepoHealth(tmpDir);
    const fmt = result.signals.find(s => s.id === "formatter_config");
    expect(fmt!.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Container / dependency detection
// ---------------------------------------------------------------------------

describe("container and dependency detection", () => {
  it("detects Dockerfile", () => {
    writeFile("Dockerfile", "FROM node:24");
    const result = computeRepoHealth(tmpDir);
    const container = result.signals.find(s => s.id === "container_config");
    expect(container!.score).toBe(10);
  });

  it("detects docker-compose.yml", () => {
    writeFile("docker-compose.yml", "services: {}");
    const result = computeRepoHealth(tmpDir);
    const container = result.signals.find(s => s.id === "container_config");
    expect(container!.score).toBe(10);
  });

  it("zero container score without config", () => {
    const result = computeRepoHealth(tmpDir);
    const container = result.signals.find(s => s.id === "container_config");
    expect(container!.score).toBe(0);
  });

  it("detects package.json + lockfile", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("package-lock.json", '{}');
    const result = computeRepoHealth(tmpDir);
    const dep = result.signals.find(s => s.id === "dependency_mgmt");
    expect(dep!.score).toBe(10);
    expect(dep!.detail).toContain("lockfile");
  });

  it("detects package.json without lockfile (partial)", () => {
    writeFile("package.json", '{"name":"test"}');
    const result = computeRepoHealth(tmpDir);
    const dep = result.signals.find(s => s.id === "dependency_mgmt");
    expect(dep!.score).toBe(6);
    expect(dep!.detail).toContain("without lockfile");
  });

  it("detects pnpm-lock.yaml", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("pnpm-lock.yaml", "");
    const result = computeRepoHealth(tmpDir);
    const dep = result.signals.find(s => s.id === "dependency_mgmt");
    expect(dep!.score).toBe(10);
  });

  it("detects yarn.lock", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("yarn.lock", "");
    const result = computeRepoHealth(tmpDir);
    const dep = result.signals.find(s => s.id === "dependency_mgmt");
    expect(dep!.score).toBe(10);
  });

  it("zero dep score with no package.json", () => {
    const result = computeRepoHealth(tmpDir);
    const dep = result.signals.find(s => s.id === "dependency_mgmt");
    expect(dep!.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Environment / ownership / documentation
// ---------------------------------------------------------------------------

describe("env, ownership, documentation detection", () => {
  it("detects .env with .env.example (full score)", () => {
    writeFile(".env", "KEY=VAL");
    writeFile(".env.example", "KEY=");
    const result = computeRepoHealth(tmpDir);
    const env = result.signals.find(s => s.id === "env_config");
    expect(env!.score).toBe(10);
  });

  it("detects .env without .env.example (partial)", () => {
    writeFile(".env", "KEY=VAL");
    const result = computeRepoHealth(tmpDir);
    const env = result.signals.find(s => s.id === "env_config");
    expect(env!.score).toBe(5);
    expect(env!.detail).toContain(".env.example");
  });

  it("no .env file gives full score (acceptable)", () => {
    const result = computeRepoHealth(tmpDir);
    const env = result.signals.find(s => s.id === "env_config");
    expect(env!.score).toBe(5);
  });

  it("detects CODEOWNERS", () => {
    writeFile("CODEOWNERS", "* @team");
    const result = computeRepoHealth(tmpDir);
    const own = result.signals.find(s => s.id === "code_ownership");
    expect(own!.score).toBe(10);
  });

  it("zero ownership score without CODEOWNERS", () => {
    const result = computeRepoHealth(tmpDir);
    const own = result.signals.find(s => s.id === "code_ownership");
    expect(own!.score).toBe(0);
  });

  it("detects README.md", () => {
    writeFile("README.md", "# Test");
    const result = computeRepoHealth(tmpDir);
    const doc = result.signals.find(s => s.id === "documentation");
    expect(doc!.score).toBeGreaterThanOrEqual(5);
  });

  it("detects README + CONTRIBUTING + CHANGELOG (full)", () => {
    writeFile("README.md", "# Test");
    writeFile("CONTRIBUTING.md", "# Contrib");
    writeFile("CHANGELOG.md", "# Log");
    const result = computeRepoHealth(tmpDir);
    const doc = result.signals.find(s => s.id === "documentation");
    expect(doc!.score).toBe(10);
  });

  it("zero doc score with no files", () => {
    const result = computeRepoHealth(tmpDir);
    const doc = result.signals.find(s => s.id === "documentation");
    expect(doc!.score).toBe(0);
  });

  it("detects CONTRIBUTING.md in .github/", () => {
    writeFile("README.md", "# Test");
    writeFile(".github/CONTRIBUTING.md", "# Contrib");
    const result = computeRepoHealth(tmpDir);
    const doc = result.signals.find(s => s.id === "documentation");
    expect(doc!.score).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Security configuration detection
// ---------------------------------------------------------------------------

describe("security configuration detection", () => {
  it("detects SECURITY.md", () => {
    writeFile("SECURITY.md", "# Security");
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBeGreaterThanOrEqual(4);
  });

  it("detects .github/SECURITY.md", () => {
    writeFile(".github/SECURITY.md", "# Security");
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBeGreaterThanOrEqual(4);
  });

  it("detects dependabot.yml", () => {
    writeFile(".github/dependabot.yml", "version: 2");
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBeGreaterThanOrEqual(3);
  });

  it("detects dependabot.yaml", () => {
    writeFile(".github/dependabot.yaml", "version: 2");
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBeGreaterThanOrEqual(3);
  });

  it("full security score with all configs", () => {
    writeFile("SECURITY.md", "# Security");
    writeFile(".github/dependabot.yml", "version: 2");
    writeFile("CODEOWNERS", "* @team");
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBe(10);
  });

  it("zero security score with no configs", () => {
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Grade computation
// ---------------------------------------------------------------------------

describe("grade computation", () => {
  it("grade A for score >= 90", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("package-lock.json", '{}');
    writeFile(".github/workflows/ci.yml", "name: CI");
    writeFile("vitest.config.ts", "export default {}");
    mkdir("__tests__");
    writeFile("eslint.config.js", "export default {}");
    writeFile(".prettierrc", "{}");
    writeFile("Dockerfile", "FROM node:24");
    writeFile("CODEOWNERS", "* @team");
    writeFile("README.md", "# Test");
    writeFile("CONTRIBUTING.md", "# Contrib");
    writeFile("SECURITY.md", "# Security");
    writeFile(".github/dependabot.yml", "version: 2");
    const result = computeRepoHealth(tmpDir);
    expect(result.grade).toBe("A");
  });

  it("grade F for score 0", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.grade).toBe("F");
  });

  it("grade B for moderate score", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("package-lock.json", '{}');
    writeFile(".github/workflows/ci.yml", "name: CI");
    writeFile("vitest.config.ts", "export default {}");
    mkdir("__tests__");
    writeFile("README.md", "# Test");
    const result = computeRepoHealth(tmpDir);
    expect(result.grade).toMatch(/^[A-F]$/);
    expect(result.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("context text generation", () => {
  it("includes health score header", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.contextText).toContain("Repository Health");
    expect(result.contextText).toContain("Health Score");
  });

  it("includes grade in header", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.contextText).toContain("Grade:");
  });

  it("includes signal table", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.contextText).toContain("| Signal |");
    expect(result.contextText).toContain("|--------|");
  });

  it("shows good status for high scores", () => {
    writeFile(".github/workflows/ci.yml", "name: CI");
    const result = computeRepoHealth(tmpDir);
    expect(result.contextText).toContain("good");
  });

  it("shows missing status for zero scores", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.contextText).toContain("missing");
  });

  it("shows partial status for mid-range scores", () => {
    writeFile("package.json", '{"name":"test"}');
    const result = computeRepoHealth(tmpDir);
    expect(result.contextText).toContain("partial");
  });

  it("includes recommendations when signals missing", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.contextText).toContain("Recommendations");
  });

  it("omits recommendations when all signals strong", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("package-lock.json", '{}');
    writeFile(".github/workflows/ci.yml", "name: CI");
    writeFile("vitest.config.ts", "export default {}");
    mkdir("__tests__");
    writeFile("eslint.config.js", "export default {}");
    writeFile(".prettierrc", "{}");
    writeFile("Dockerfile", "FROM node:24");
    writeFile("CODEOWNERS", "* @team");
    writeFile("README.md", "# Test");
    writeFile("CONTRIBUTING.md", "# Contrib");
    writeFile("CHANGELOG.md", "# Change");
    writeFile("SECURITY.md", "# Sec");
    writeFile(".github/dependabot.yml", "v: 2");
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recommendations content
// ---------------------------------------------------------------------------

describe("recommendations", () => {
  it("recommends CI setup when missing", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).toContain("Set up CI/CD to catch issues before merge");
  });

  it("recommends test framework when missing", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).toContain("Add a test framework and write initial test suite");
  });

  it("recommends linter when missing", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).toContain("Add ESLint or similar linter for consistent code style");
  });

  it("recommends CODEOWNERS when missing", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).toContain("Add CODEOWNERS to define code ownership and review routing");
  });

  it("recommends documentation when missing", () => {
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).toContain("Add README.md with project setup and usage instructions");
  });

  it("does not recommend CI when present", () => {
    writeFile(".github/workflows/ci.yml", "name: CI");
    const result = computeRepoHealth(tmpDir);
    expect(result.recommendations).not.toContain("Set up CI/CD to catch issues before merge");
  });
});

// ---------------------------------------------------------------------------
// With pre-provided keyFiles
// ---------------------------------------------------------------------------

describe("computeRepoHealth with provided keyFiles", () => {
  it("uses provided keyFiles instead of scanning", () => {
    const keyFiles = [
      { path: "package.json", role: "dependencies" },
      { path: "package-lock.json", role: "lockfile" },
      { path: ".github/workflows/ci.yml", role: "CI/CD" },
      { path: "vitest.config.ts", role: "test config" },
      { path: "eslint.config.js", role: "linter" },
      { path: "Dockerfile", role: "container" },
      { path: "CODEOWNERS", role: "ownership" },
    ];
    writeFile("README.md", "# Test");
    const result = computeRepoHealth(tmpDir, keyFiles);
    expect(result.score).toBeGreaterThan(0);
  });

  it("empty keyFiles triggers local scan", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile(".github/workflows/ci.yml", "name: CI");
    const result = computeRepoHealth(tmpDir, []);
    expect(result.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Signal weights
// ---------------------------------------------------------------------------

describe("signal weights", () => {
  it("test framework has highest weight (1.2)", () => {
    const result = computeRepoHealth(tmpDir);
    const test = result.signals.find(s => s.id === "test_framework");
    expect(test!.weight).toBe(1.2);
  });

  it("formatter has lowest weight (0.5)", () => {
    const result = computeRepoHealth(tmpDir);
    const fmt = result.signals.find(s => s.id === "formatter_config");
    expect(fmt!.weight).toBe(0.5);
  });

  it("all signals have weight > 0", () => {
    const result = computeRepoHealth(tmpDir);
    for (const sig of result.signals) {
      expect(sig.weight).toBeGreaterThan(0);
    }
  });

  it("all signals have maxScore of 10", () => {
    const result = computeRepoHealth(tmpDir);
    for (const sig of result.signals) {
      expect(sig.maxScore).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles unreadable directories gracefully", () => {
    mkdir("restricted");
    const result = computeRepoHealth(tmpDir);
    expect(result).toBeDefined();
    expect(result.signals).toHaveLength(10);
  });

  it("skips node_modules in scan", () => {
    mkdir("node_modules/pkg");
    writeFile("node_modules/pkg/package.json", '{"name":"dep"}');
    writeFile("package.json", '{"name":"test"}');
    const result = computeRepoHealth(tmpDir);
    const dep = result.signals.find(s => s.id === "dependency_mgmt");
    expect(dep!.score).toBeGreaterThanOrEqual(6);
  });

  it("score is always 0-100 range", () => {
    writeFile("package.json", '{"name":"test"}');
    const result = computeRepoHealth(tmpDir);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("detects .github/dependabot.yaml (yaml extension)", () => {
    writeFile(".github/dependabot.yaml", "version: 2");
    const result = computeRepoHealth(tmpDir);
    const sec = result.signals.find(s => s.id === "security_config");
    expect(sec!.score).toBeGreaterThanOrEqual(3);
  });

  it("CHANGELOG.md contributes to documentation score", () => {
    writeFile("CHANGELOG.md", "# Changes");
    const result = computeRepoHealth(tmpDir);
    const doc = result.signals.find(s => s.id === "documentation");
    expect(doc!.score).toBeGreaterThanOrEqual(2);
  });

  it("CHANGES.md also counts as changelog", () => {
    writeFile("CHANGES.md", "# Changes");
    const result = computeRepoHealth(tmpDir);
    const doc = result.signals.find(s => s.id === "documentation");
    expect(doc!.score).toBeGreaterThanOrEqual(2);
  });
});
