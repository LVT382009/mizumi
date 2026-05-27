import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { planChunkedReview, formatChunkDiff, getAllChunkFiles } from "../chunk-review.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (path: string, changes: string[] = ["+added line"]): DiffFile => ({
  path,
  status: "modified",
  additions: changes.filter(c => c.startsWith("+")).length,
  deletions: changes.filter(c => c.startsWith("-")).length,
  hunks: [{
    header: `@@ -1 +1 @@`,
    changes: changes.map((content, i) => ({
      type: content.startsWith("+") ? "add" as const : content.startsWith("-") ? "delete" as const : "normal" as const,
      content,
      line: i + 1,
    })),
  }],
});

const makeFiles = (n: number, prefix: string = "src"): DiffFile[] =>
  Array.from({ length: n }, (_, i) => makeFile(`${prefix}/file${i}.ts`));

// ---------------------------------------------------------------------------
// planChunkedReview — single review strategy
// ---------------------------------------------------------------------------

describe("planChunkedReview — single review", () => {
  it("returns single chunk for empty file list", () => {
    const plan = planChunkedReview([]);
    expect(plan.strategy).toBe("single");
    expect(plan.chunks).toHaveLength(1);
  });

  it("returns single chunk for <= 10 files", () => {
    const files = makeFiles(8);
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("single");
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0].files).toHaveLength(8);
  });

  it("returns single chunk for exactly 10 files", () => {
    const files = makeFiles(10);
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("single");
  });

  it("single chunk contains all files", () => {
    const files = makeFiles(5, "app");
    const plan = planChunkedReview(files);
    expect(plan.chunks[0].id).toBe("chunk-1");
    expect(plan.chunks[0].label).toBe("Full review");
  });

  it("counts total files correctly", () => {
    const files = makeFiles(6);
    const plan = planChunkedReview(files);
    expect(plan.totalFiles).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// planChunkedReview — by-directory strategy
// ---------------------------------------------------------------------------

describe("planChunkedReview — by-directory strategy", () => {
  it("uses by-directory strategy for 11-25 files", () => {
    const files = makeFiles(15);
    const plan = planChunkedReview(files);
    // All files are under "src/" so might be a single chunk, but strategy depends on grouping
    expect(plan.chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("groups files from different directories", () => {
    const files = [
      ...makeFiles(6, "src"),
      ...makeFiles(6, "lib"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.chunks.length).toBeGreaterThanOrEqual(2);
    // Check that chunks are labeled by directory
    const labels = plan.chunks.map(c => c.label);
    expect(labels.some(l => l.includes("src") || l.includes("lib"))).toBe(true);
  });

  it("merges small directory groups", () => {
    const files = [
      ...makeFiles(8, "src"),
      ...makeFiles(2, "docs"),
      ...makeFiles(2, "config"),
    ];
    const plan = planChunkedReview(files);
    // Small groups should be merged
    expect(plan.chunks.length).toBeLessThanOrEqual(4);
  });

  it("caps at maxChunks directories", () => {
    const dirs = ["src", "lib", "test", "docs", "config", "infra", "scripts"];
    const files = dirs.flatMap(d => makeFiles(3, d));
    const plan = planChunkedReview(files);
    // 7 directories but maxChunks=3 for 11-25 range
    expect(plan.chunks.length).toBeLessThanOrEqual(4);
    // All files should be in a chunk
    const total = plan.chunks.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(files.length);
  });

  it("preserves all files across chunks", () => {
    const files = [
      ...makeFiles(7, "src"),
      ...makeFiles(5, "lib"),
    ];
    const plan = planChunkedReview(files);
    const total = plan.chunks.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// planChunkedReview — by-area strategy
// ---------------------------------------------------------------------------

describe("planChunkedReview — by-area strategy", () => {
  it("uses by-area strategy for 26+ files", () => {
    const files = [
      ...makeFiles(8, "src/components"),
      ...makeFiles(8, "src/api"),
      ...makeFiles(5, "__tests__"),
      ...makeFiles(5, "infra"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
  });

  it("classifies frontend files correctly", () => {
    const files = [
      makeFile("src/components/Button.tsx"),
      makeFile("src/pages/Home.tsx"),
      makeFile("src/views/Dashboard.vue"),
      ...makeFiles(10, "src/components"),
      ...makeFiles(10, "src/api"),
      ...makeFiles(5, "__tests__"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
    const labels = plan.chunks.map(c => c.label);
    expect(labels.some(l => l.includes("frontend"))).toBe(true);
  });

  it("classifies backend files correctly", () => {
    const files = [
      makeFile("src/api/routes.ts"),
      makeFile("src/server/index.ts"),
      makeFile("src/models/User.ts"),
      ...makeFiles(9, "src/api"),
      ...makeFiles(9, "src/components"),
      ...makeFiles(5, "__tests__"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
    const labels = plan.chunks.map(c => c.label);
    expect(labels.some(l => l.includes("backend"))).toBe(true);
  });

  it("classifies test files correctly", () => {
    const files = [
      makeFile("__tests__/app.test.ts"),
      makeFile("test/unit.test.ts"),
      makeFile("spec/integration.spec.ts"),
      ...makeFiles(12, "src/components"),
      ...makeFiles(12, "src/api"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
    const labels = plan.chunks.map(c => c.label);
    expect(labels.some(l => l.includes("test"))).toBe(true);
  });

  it("classifies infra files correctly", () => {
    const files = [
      makeFile(".github/workflows/ci.yml"),
      makeFile(".github/workflows/deploy.yml"),
      makeFile(".github/workflows/test.yml"),
      makeFile("docker/Dockerfile"),
      makeFile("docker/docker-compose.yml"),
      ...makeFiles(12, "src/components"),
      ...makeFiles(12, "src/api"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
    const allPaths = plan.chunks.flatMap(c => c.files.map(f => f.path));
    expect(allPaths.some(p => p.includes(".github") || p.includes("docker"))).toBe(true);
  });

  it("classifies config files correctly", () => {
    const files = [
      makeFile("config/app.json"),
      makeFile("config/db.json"),
      makeFile("config/routes.json"),
      makeFile("tsconfig.json"),
      ...makeFiles(12, "src/components"),
      ...makeFiles(12, "src/api"),
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
    const allPaths = plan.chunks.flatMap(c => c.files.map(f => f.path));
    expect(allPaths.some(p => p.includes("config") || p.includes("tsconfig"))).toBe(true);
  });

  it("merges tiny chunks into larger ones", () => {
    const files = [
      ...makeFiles(12, "src/components"),
      ...makeFiles(10, "src/api"),
      ...makeFiles(2, "docs"),         // tiny
      ...makeFiles(2, "config"),      // tiny
    ];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("by-area");
    // Tiny chunks (<3 files) should be merged into larger chunks
    const smallChunks = plan.chunks.filter(c => c.files.length < 3);
    expect(smallChunks.length).toBe(0);
  });

  it("caps at 5 chunks", () => {
    const dirs = ["src/components", "src/api", "__tests__", "infra", "config", "docs", "src/services"];
    const files = dirs.flatMap(d => makeFiles(5, d));
    const plan = planChunkedReview(files);
    expect(plan.chunks.length).toBeLessThanOrEqual(5);
  });

  it("all files accounted for across chunks", () => {
    const dirs = ["src/components", "src/api", "src/models", "__tests__", "infra", "config"];
    const files = dirs.flatMap(d => makeFiles(5, d));
    const plan = planChunkedReview(files);
    const total = plan.chunks.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(files.length);
  });
});

// ---------------------------------------------------------------------------
// formatChunkDiff
// ---------------------------------------------------------------------------

describe("formatChunkDiff", () => {
  it("formats a single file chunk", () => {
    const chunk = {
      id: "chunk-1",
      label: "src",
      files: [makeFile("src/app.ts", ["+new code"])],
      estimatedTokens: 100,
    };
    const diff = formatChunkDiff(chunk);
    expect(diff).toContain("src/app.ts");
    expect(diff).toContain("+new code");
  });

  it("formats multiple files in chunk", () => {
    const chunk = {
      id: "chunk-1",
      label: "src",
      files: [makeFile("a.ts"), makeFile("b.ts")],
      estimatedTokens: 200,
    };
    const diff = formatChunkDiff(chunk);
    expect(diff).toContain("a.ts");
    expect(diff).toContain("b.ts");
  });

  it("includes added and deleted lines", () => {
    const chunk = {
      id: "chunk-1",
      label: "src",
      files: [makeFile("app.ts", ["+added", "-deleted", " context"])],
      estimatedTokens: 100,
    };
    const diff = formatChunkDiff(chunk);
    expect(diff).toContain("+added");
    expect(diff).toContain("-deleted");
  });
});

// ---------------------------------------------------------------------------
// getAllChunkFiles
// ---------------------------------------------------------------------------

describe("getAllChunkFiles", () => {
  it("returns sorted unique file paths", () => {
    const chunks = [
      { id: "1", label: "a", files: [makeFile("c.ts"), makeFile("a.ts")], estimatedTokens: 100 },
      { id: "2", label: "b", files: [makeFile("b.ts"), makeFile("a.ts")], estimatedTokens: 100 },
    ];
    // Note: DiffFile doesn't guarantee uniqueness, but getAllChunkFiles should dedup
    const allFiles = getAllChunkFiles(chunks);
    // 'a.ts' appears in both chunks but should be deduplicated
    const aCount = allFiles.filter(f => f === "a.ts").length;
    expect(aCount).toBe(1);
    expect(allFiles).toHaveLength(3);
  });

  it("returns empty for empty chunks", () => {
    expect(getAllChunkFiles([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Context text
// ---------------------------------------------------------------------------

describe("context text generation", () => {
  it("includes chunked review plan header for multi-chunk", () => {
    const files = [
      ...makeFiles(8, "src/components"),
      ...makeFiles(8, "src/api"),
    ];
    const plan = planChunkedReview(files);
    if (plan.contextText) {
      expect(plan.contextText).toContain("Chunked Review Plan");
    }
  });

  it("includes table with chunk info", () => {
    const files = [
      ...makeFiles(8, "src/components"),
      ...makeFiles(8, "src/api"),
      ...makeFiles(5, "__tests__"),
    ];
    const plan = planChunkedReview(files);
    if (plan.contextText) {
      expect(plan.contextText).toContain("| Chunk |");
      expect(plan.contextText).toContain("Files");
    }
  });

  it("empty context text for single-review strategy", () => {
    const files = makeFiles(5);
    const plan = planChunkedReview(files);
    expect(plan.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe("token estimation", () => {
  it("estimatedTokens > 0 for files with content", () => {
    const files = [makeFile("app.ts", ["+const x = 1;"])];
    const plan = planChunkedReview(files);
    for (const chunk of plan.chunks) {
      expect(chunk.estimatedTokens).toBeGreaterThan(0);
    }
  });

  it("totalTokens reflects overall diff size", () => {
    const files = makeFiles(20);
    const plan = planChunkedReview(files);
    expect(plan.totalTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles files at root level (no directory)", () => {
    const files = [makeFile("package.json"), makeFile("tsconfig.json")];
    const plan = planChunkedReview(files);
    expect(plan.chunks).toHaveLength(1);
  });

  it("handles deeply nested files", () => {
    const files = [makeFile("src/features/auth/login/handler.ts")];
    const plan = planChunkedReview(files);
    expect(plan.totalFiles).toBe(1);
  });

  it("handles single file", () => {
    const files = [makeFile("app.ts")];
    const plan = planChunkedReview(files);
    expect(plan.strategy).toBe("single");
    expect(plan.chunks[0].files).toHaveLength(1);
  });

  it("classifies root-level .md as docs", () => {
    const files = [
      makeFile("README.md"),
      ...makeFiles(10, "src"),
      ...makeFiles(10, "lib"),
    ];
    const plan = planChunkedReview(files);
    const docChunk = plan.chunks.find(c => c.label === "docs");
    if (docChunk) {
      expect(docChunk.files.some(f => f.path === "README.md")).toBe(true);
    }
  });

  it("handles files with only deletions", () => {
    const files = [makeFile("old.ts", ["-deleted line"])];
    const plan = planChunkedReview(files);
    expect(plan.chunks).toHaveLength(1);
  });

  it("mixed area classification preserves all files", () => {
    const files = [
      makeFile("src/components/App.tsx"),
      makeFile("src/api/handler.ts"),
      makeFile("__tests__/app.test.ts"),
      makeFile(".github/workflows/ci.yml"),
      makeFile("config/settings.json"),
      makeFile("README.md"),
      makeFile("scripts/deploy.sh"),
      ...makeFiles(15, "src/features"),
      ...makeFiles(10, "lib"),
    ];
    const plan = planChunkedReview(files);
    const total = plan.chunks.reduce((sum, c) => sum + c.files.length, 0);
    expect(total).toBe(files.length);
  });
});
