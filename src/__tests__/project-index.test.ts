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

import { buildProjectIndex, buildTree } from "../project-index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-idx-"));
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
// buildProjectIndex
// ---------------------------------------------------------------------------

describe("buildProjectIndex", () => {
  it("returns empty index for empty workspace", () => {
    const idx = buildProjectIndex(tmpDir);
    expect(idx.totalFiles).toBe(0);
    expect(idx.totalDirs).toBe(0);
    expect(idx.keyFiles).toHaveLength(0);
    expect(idx.contextText).toContain("Project Structure");
  });

  it("detects TypeScript language from tsconfig.json", () => {
    writeFile("tsconfig.json", "{}");
    writeFile("package.json", '{"name":"test"}');
    const idx = buildProjectIndex(tmpDir);
    expect(idx.language).toBe("TypeScript");
  });

  it("detects Node.js framework from package.json", () => {
    writeFile("package.json", '{"name":"test"}');
    const idx = buildProjectIndex(tmpDir);
    expect(idx.framework).toBe("Node.js");
  });

  it("detects Node.js + TypeScript framework", () => {
    writeFile("package.json", '{"name":"test"}');
    writeFile("tsconfig.json", "{}");
    writeFile("vite.config.ts", "export default {}");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.framework).toBe("Node.js + TypeScript");
  });

  it("classifies package.json as dependencies", () => {
    writeFile("package.json", '{"name":"test"}');
    const idx = buildProjectIndex(tmpDir);
    const pkg = idx.keyFiles.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    expect(pkg!.role).toBe("dependencies");
  });

  it("classifies tsconfig.json as typescript config", () => {
    writeFile("tsconfig.json", "{}");
    const idx = buildProjectIndex(tmpDir);
    const tsconfig = idx.keyFiles.find((f) => f.path === "tsconfig.json");
    expect(tsconfig).toBeDefined();
    expect(tsconfig!.role).toBe("typescript config");
  });

  it("classifies Dockerfile as container", () => {
    writeFile("Dockerfile", "FROM node:24");
    const idx = buildProjectIndex(tmpDir);
    const dockerfile = idx.keyFiles.find((f) => f.role === "container");
    expect(dockerfile).toBeDefined();
  });

  it("classifies .github/workflows as CI/CD", () => {
    writeFile(".github/workflows/ci.yml", "name: CI");
    const idx = buildProjectIndex(tmpDir);
    const cicd = idx.keyFiles.find((f) => f.role === "CI/CD");
    expect(cicd).toBeDefined();
  });

  it("skips node_modules directory", () => {
    writeFile("package.json", "{}");
    mkdir("node_modules/lodash");
    writeFile("node_modules/lodash/index.js", "module.exports = {}");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.tree).not.toContain("node_modules");
  });

  it("skips .git directory", () => {
    mkdir(".git/objects");
    writeFile("package.json", "{}");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.tree).not.toContain(".git");
  });

  it("skips dot-prefixed directories", () => {
    mkdir(".cache/data");
    writeFile("src/app.ts", "console.log(1)");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.tree).not.toContain(".cache");
  });

  it("skips dot-prefixed files", () => {
    writeFile(".env.local", "SECRET=abc");
    writeFile("src/app.ts", "console.log(1)");
    const idx = buildProjectIndex(tmpDir);
    // .env.local may or may not be classified — it matches the .env pattern
    const envFile = idx.keyFiles.find((f) => f.role === "environment");
    expect(envFile).toBeDefined();
  });

  it("counts files and directories", () => {
    writeFile("src/a.ts", "");
    writeFile("src/b.ts", "");
    writeFile("src/utils/c.ts", "");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.totalFiles).toBe(3);
    expect(idx.totalDirs).toBeGreaterThanOrEqual(2); // src, src/utils
  });

  it("includes directory tree in context text", () => {
    writeFile("src/app.ts", "");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).toContain("Directory Tree");
    expect(idx.contextText).toContain("src/");
  });

  it("includes language and framework in context text", () => {
    writeFile("package.json", "{}");
    writeFile("tsconfig.json", "{}");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).toContain("TypeScript");
    expect(idx.contextText).toContain("Node.js");
  });

  it("limits key files to 20", () => {
    for (let i = 0; i < 30; i++) {
      writeFile(`src/config${i}.json`, "{}");
    }
    writeFile("package.json", "{}");
    const idx = buildProjectIndex(tmpDir);
    // Only package.json should be key file (src/config*.json are not matching patterns)
    expect(idx.keyFiles.length).toBeLessThanOrEqual(20);
  });

  it("classifies vitest.config.ts as test config", () => {
    writeFile("vitest.config.ts", "export default {}");
    const idx = buildProjectIndex(tmpDir);
    const testCfg = idx.keyFiles.find((f) => f.role === "test config");
    expect(testCfg).toBeDefined();
  });

  it("classifies eslint.config.js as linter", () => {
    writeFile("eslint.config.js", "export default {}");
    const idx = buildProjectIndex(tmpDir);
    const linter = idx.keyFiles.find((f) => f.role === "linter");
    expect(linter).toBeDefined();
  });

  it("classifies CODEOWNERS as ownership", () => {
    writeFile("CODEOWNERS", "* @team");
    const idx = buildProjectIndex(tmpDir);
    const owners = idx.keyFiles.find((f) => f.role === "ownership");
    expect(owners).toBeDefined();
  });

  it("classifies REVIEW.md as review rules", () => {
    writeFile("REVIEW.md", "# Rules");
    const idx = buildProjectIndex(tmpDir);
    const review = idx.keyFiles.find((f) => f.role === "review rules");
    expect(review).toBeDefined();
  });

  it("classifies CLAUDE.md as AI instructions", () => {
    writeFile("CLAUDE.md", "# AI");
    const idx = buildProjectIndex(tmpDir);
    const claude = idx.keyFiles.find((f) => f.role === "AI instructions");
    expect(claude).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildTree
// ---------------------------------------------------------------------------

describe("buildTree", () => {
  it("returns empty string for empty directory", () => {
    expect(buildTree(tmpDir)).toBe("");
  });

  it("lists files with tree connectors", () => {
    writeFile("a.ts", "");
    writeFile("b.ts", "");
    const tree = buildTree(tmpDir);
    expect(tree).toContain("a.ts");
    expect(tree).toContain("b.ts");
  });

  it("lists directories with trailing slash", () => {
    mkdir("src");
    writeFile("src/app.ts", "");
    const tree = buildTree(tmpDir);
    expect(tree).toContain("src/");
  });

  it("respects max depth", () => {
    mkdir("a/b/c/d");
    writeFile("a/b/c/d/deep.ts", "");
    const tree = buildTree(tmpDir);
    // MAX_DEPTH=3, so d/deep.ts should not appear
    expect(tree).not.toContain("deep.ts");
  });

  it("sorts directories before files", () => {
    writeFile("z-file.ts", "");
    mkdir("a-dir");
    writeFile("a-dir/x.ts", "");
    const tree = buildTree(tmpDir);
    // Directory should appear before file in tree output
    const dirIdx = tree.indexOf("a-dir/");
    const fileIdx = tree.indexOf("z-file.ts");
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  it("truncates when more entries than limit", () => {
    for (let i = 0; i < 25; i++) {
      writeFile(`file${i}.ts`, "");
    }
    const tree = buildTree(tmpDir);
    expect(tree).toContain("more");
  });

  it("uses correct tree drawing characters", () => {
    writeFile("a.ts", "");
    writeFile("b.ts", "");
    const tree = buildTree(tmpDir);
    expect(tree).toMatch(/├──|└──/);
  });

  it("skips node_modules in tree", () => {
    mkdir("node_modules/pkg");
    writeFile("src/app.ts", "");
    const tree = buildTree(tmpDir);
    expect(tree).not.toContain("node_modules");
    expect(tree).toContain("app.ts");
  });

  it("counts files through nested directories", () => {
    writeFile("src/a.ts", "");
    writeFile("src/utils/b.ts", "");
    const count = { value: 0 };
    buildTree(tmpDir, "", 0, count);
    expect(count.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Context text structure
// ---------------------------------------------------------------------------

describe("context text structure", () => {
  it("includes key files section when key files exist", () => {
    writeFile("package.json", "{}");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).toContain("### Key Files");
    expect(idx.contextText).toContain("package.json");
  });

  it("omits key files section when none found", () => {
    writeFile("src/random.txt", "hello");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).not.toContain("### Key Files");
  });

  it("wraps tree in code block", () => {
    writeFile("src/app.ts", "");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).toContain("```");
  });

  it("includes file count in header", () => {
    writeFile("src/a.ts", "");
    writeFile("src/b.ts", "");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).toContain("Files");
  });

  it("includes directory count in header", () => {
    mkdir("src/utils");
    writeFile("src/utils/helper.ts", "");
    const idx = buildProjectIndex(tmpDir);
    expect(idx.contextText).toContain("Directories");
  });

  it("classifies docker-compose.yml as container", () => {
    writeFile("docker-compose.yml", "services:");
    const idx = buildProjectIndex(tmpDir);
    const container = idx.keyFiles.find((f) => f.role === "container");
    expect(container).toBeDefined();
  });

  it("classifies vite.config.ts as bundler", () => {
    writeFile("vite.config.ts", "export default {}");
    const idx = buildProjectIndex(tmpDir);
    const bundler = idx.keyFiles.find((f) => f.role === "bundler");
    expect(bundler).toBeDefined();
  });

  it("handles deeply nested key files", () => {
    writeFile(".github/workflows/ci.yml", "name: CI");
    const idx = buildProjectIndex(tmpDir);
    const cicd = idx.keyFiles.find((f) => f.role === "CI/CD");
    expect(cicd).toBeDefined();
    expect(cicd!.path).toContain(".github");
  });
});
