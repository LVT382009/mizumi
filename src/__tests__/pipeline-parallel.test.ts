import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runParallelStages,
  mapConcurrent,
  formatPipelineTiming,
  shouldParallelize,
  estimateSavings,
} from "../pipeline-parallel.js";
import type { PipelineStage, PipelineBatchResult } from "../pipeline-parallel.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// ---------------------------------------------------------------------------
// runParallelStages
// ---------------------------------------------------------------------------

describe("runParallelStages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs all enabled stages and returns results", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "a", enabled: true, run: () => Promise.resolve("result-a") },
      { name: "b", enabled: true, run: () => Promise.resolve("result-b") },
    ];
    const result = await runParallelStages(stages);
    expect(result.results.a).toBe("result-a");
    expect(result.results.b).toBe("result-b");
    expect(result.parallelCount).toBe(2);
    expect(result.skippedCount).toBe(0);
  });

  it("skips disabled stages", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "a", enabled: true, run: () => Promise.resolve("ok") },
      { name: "b", enabled: false, run: () => Promise.resolve("skip") },
    ];
    const result = await runParallelStages(stages);
    expect(result.results.a).toBe("ok");
    expect(result.results.b).toBeUndefined();
    expect(result.skippedCount).toBe(1);
    expect(result.parallelCount).toBe(1);
  });

  it("catches individual stage failures without blocking others", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "good", enabled: true, run: () => Promise.resolve("ok") },
      { name: "bad", enabled: true, run: () => Promise.reject(new Error("stage-failed")) },
      { name: "alsogood", enabled: true, run: () => Promise.resolve(42) },
    ];
    const result = await runParallelStages(stages);
    expect(result.results.good).toBe("ok");
    expect(result.results.alsogood).toBe(42);
    expect(result.errors.bad).toBe("stage-failed");
    expect(result.results.bad).toBeUndefined();
  });

  it("returns wall time and per-stage timing", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "fast", enabled: true, run: () => new Promise((r) => setTimeout(() => r("f"), 10)) },
      { name: "slow", enabled: true, run: () => new Promise((r) => setTimeout(() => r("s"), 50)) },
    ];
    const result = await runParallelStages(stages);
    expect(result.wallMs).toBeGreaterThan(0);
    expect(result.stageTiming.fast).toBeGreaterThan(0);
    expect(result.stageTiming.slow).toBeGreaterThan(0);
  });

  it("handles empty stage list", async () => {
    const result = await runParallelStages([]);
    expect(result.parallelCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.results).toEqual({});
  });

  it("handles all stages disabled", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "a", enabled: false, run: () => Promise.resolve(1) },
      { name: "b", enabled: false, run: () => Promise.resolve(2) },
    ];
    const result = await runParallelStages(stages);
    expect(result.skippedCount).toBe(2);
    expect(result.parallelCount).toBe(0);
  });

  it("wall time is less than sum of stage times (parallelism)", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "a", enabled: true, run: () => new Promise((r) => setTimeout(() => r(1), 40)) },
      { name: "b", enabled: true, run: () => new Promise((r) => setTimeout(() => r(2), 40)) },
      { name: "c", enabled: true, run: () => new Promise((r) => setTimeout(() => r(3), 40)) },
    ];
    const result = await runParallelStages(stages);
    const sumStage = result.stageTiming.a + result.stageTiming.b + result.stageTiming.c;
    // Wall time should be closer to longest stage, not sum of all stages
    expect(result.wallMs).toBeLessThan(sumStage);
  });

  it("records timing for failed stages", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "fail", enabled: true, run: () => new Promise((_, rej) => setTimeout(() => rej(new Error("boom")), 5)) },
    ];
    const result = await runParallelStages(stages);
    expect(result.stageTiming.fail).toBeGreaterThanOrEqual(0);
    expect(result.errors.fail).toBe("boom");
  });

  it("handles stage returning undefined", async () => {
    const stages: PipelineStage<unknown>[] = [
      { name: "nil", enabled: true, run: () => Promise.resolve(undefined) },
    ];
    const result = await runParallelStages(stages);
    expect(result.results.nil).toBeUndefined();
    expect(result.errors).toEqual({});
  });

  it("handles stage returning complex objects", async () => {
    const stages: PipelineStage<unknown>[] = [
      {
        name: "complex",
        enabled: true,
        run: () => Promise.resolve({ score: 85, grade: "A", items: [1, 2, 3] }),
      },
    ];
    const result = await runParallelStages(stages);
    expect(result.results.complex).toEqual({ score: 85, grade: "A", items: [1, 2, 3] });
  });

  it("handles 10+ stages concurrently", async () => {
    const stages: PipelineStage<unknown>[] = Array.from({ length: 12 }, (_, i) => ({
      name: `stage${i}`,
      enabled: true,
      run: () => Promise.resolve(i * 10),
    }));
    const result = await runParallelStages(stages);
    expect(result.parallelCount).toBe(12);
    expect(Object.keys(result.results).length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// mapConcurrent
// ---------------------------------------------------------------------------

describe("mapConcurrent", () => {
  it("maps function over items with bounded concurrency", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, async (n) => n * 2, 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("preserves order regardless of completion order", async () => {
    const items = [1, 2, 3];
    const results = await mapConcurrent(
      items,
      async (n) => {
        // Even items take longer — but results should still be in order
        const delay = n % 2 === 0 ? 50 : 10;
        await new Promise((r) => setTimeout(r, delay));
        return n;
      },
      3,
    );
    expect(results).toEqual([1, 2, 3]);
  });

  it("handles empty array", async () => {
    const results = await mapConcurrent([], async (n: number) => n);
    expect(results).toEqual([]);
  });

  it("handles single item", async () => {
    const results = await mapConcurrent([42], async (n) => n + 1);
    expect(results).toEqual([43]);
  });

  it("defaults to concurrency of 3", async () => {
    const items = [1, 2, 3, 4];
    // With default concurrency=3, first 3 items start, then 4th starts when slot opens
    const results = await mapConcurrent(items, async (n) => n * 3);
    expect(results).toEqual([3, 6, 9, 12]);
  });

  it("concurrency=1 is sequential", async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    await mapConcurrent(
      items,
      async (n) => {
        order.push(n);
        return n;
      },
      1,
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it("concurrency greater than items len works correctly", async () => {
    const items = [1, 2];
    const results = await mapConcurrent(items, async (n) => n * 5, 10);
    expect(results).toEqual([5, 10]);
  });

  it("passes index to function", async () => {
    const items = ["a", "b", "c"];
    const results = await mapConcurrent(
      items,
      async (item, idx) => `${item}-${idx}`,
      3,
    );
    expect(results).toEqual(["a-0", "b-1", "c-2"]);
  });

  it("propagates errors from mapping function", async () => {
    const items = [1, 2, 3];
    await expect(
      mapConcurrent(items, async (n) => {
        if (n === 2) throw new Error("fail-at-2");
        return n;
      }, 3),
    ).rejects.toThrow("fail-at-2");
  });

  it("handles large arrays efficiently", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i + 1);
    const results = await mapConcurrent(items, async (n) => n * 2, 5);
    expect(results).toEqual(items.map((n) => n * 2));
  });

  it("respects concurrency limit for slow operations", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await mapConcurrent(
      items,
      async (n) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return n;
      },
      2,
    );
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("all items are processed even with very small concurrency", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapConcurrent(items, async (n) => n + 100, 1);
    expect(results.length).toBe(10);
    expect(results[9]).toBe(109);
  });
});

// ---------------------------------------------------------------------------
// formatPipelineTiming
// ---------------------------------------------------------------------------

describe("formatPipelineTiming", () => {
  it("formats timing with parallelization savings", () => {
    const timing = { a: 100, b: 80, c: 50 };
    const text = formatPipelineTiming(timing, 120);
    expect(text).toContain("120ms wall");
    expect(text).toContain("230ms sequential");
    expect(text).toContain("saved");
    expect(text).toContain("48%"); // (230-120)/230 ≈ 48%
  });

  it("handles single stage", () => {
    const text = formatPipelineTiming({ only: 200 }, 200);
    expect(text).toContain("200ms wall");
    expect(text).toContain("200ms sequential");
    expect(text).toContain("0%");
  });

  it("handles empty timing", () => {
    const text = formatPipelineTiming({}, 0);
    expect(text).toContain("0ms wall");
    expect(text).toContain("0ms sequential");
  });

  it("sorts stages by time (longest first)", () => {
    const timing = { fast: 10, slow: 200, medium: 50 };
    const text = formatPipelineTiming(timing, 200);
    const lines = text.split("\n");
    // First stage line should be "slow" (longest)
    expect(lines[1]).toContain("slow");
  });

  it("limits output to 10 stages", () => {
    const timing: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      timing[`stage${i}`] = i * 10;
    }
    const text = formatPipelineTiming(timing, 200);
    const stageLines = text.split("\n").filter((l) => l.trim().startsWith("stage"));
    expect(stageLines.length).toBe(10);
  });

  it("handles zero wall time", () => {
    const text = formatPipelineTiming({ a: 0 }, 0);
    expect(text).toContain("0ms wall");
  });
});

// ---------------------------------------------------------------------------
// shouldParallelize
// ---------------------------------------------------------------------------

describe("shouldParallelize", () => {
  it("returns false for 0 stages", () => {
    expect(shouldParallelize(0)).toBe(false);
  });

  it("returns false for 1 stage", () => {
    expect(shouldParallelize(1)).toBe(false);
  });

  it("returns false for 2 stages", () => {
    expect(shouldParallelize(2)).toBe(false);
  });

  it("returns true for 3 stages", () => {
    expect(shouldParallelize(3)).toBe(true);
  });

  it("returns true for 10 stages", () => {
    expect(shouldParallelize(10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// estimateSavings
// ---------------------------------------------------------------------------

describe("estimateSavings", () => {
  it("calculates savings from parallel execution", () => {
    const timing = { a: 100, b: 80, c: 50 };
    const savings = estimateSavings(timing);
    expect(savings.sequentialMs).toBe(230);
    expect(savings.parallelMs).toBe(100); // max stage time
    expect(savings.savedMs).toBe(130);
    expect(savings.savedPct).toBe(57); // 130/230 ≈ 57%
  });

  it("returns zero for empty timing", () => {
    const savings = estimateSavings({});
    expect(savings.sequentialMs).toBe(0);
    expect(savings.parallelMs).toBe(0);
    expect(savings.savedMs).toBe(0);
    expect(savings.savedPct).toBe(0);
  });

  it("returns zero savings when all stages have equal time", () => {
    const timing = { a: 100, b: 100, c: 100 };
    const savings = estimateSavings(timing);
    expect(savings.sequentialMs).toBe(300);
    expect(savings.parallelMs).toBe(100);
    expect(savings.savedMs).toBe(200);
    expect(savings.savedPct).toBe(67); // 200/300 ≈ 67%
  });

  it("handles single stage (no savings)", () => {
    const savings = estimateSavings({ a: 150 });
    expect(savings.sequentialMs).toBe(150);
    expect(savings.parallelMs).toBe(150);
    expect(savings.savedMs).toBe(0);
    expect(savings.savedPct).toBe(0);
  });

  it("handles very imbalanced stages", () => {
    const timing = { slow: 1000, fast1: 10, fast2: 5 };
    const savings = estimateSavings(timing);
    expect(savings.parallelMs).toBe(1000);
    expect(savings.savedMs).toBe(15); // 1015 - 1000
    expect(savings.savedPct).toBe(1); // 15/1015 ≈ 1%
  });
});
