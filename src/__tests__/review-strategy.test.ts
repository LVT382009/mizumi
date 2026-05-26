import { describe, it, expect } from "vitest";
import {
  getReviewStrategy,
  buildStrategyPrompt,
} from "../review-strategy.js";
import type { PRCategory } from "../classifier.js";

// ---------------------------------------------------------------------------
// getReviewStrategy
// ---------------------------------------------------------------------------

describe("getReviewStrategy", () => {
  it("returns strategy for security category", () => {
    const strategy = getReviewStrategy("security");
    expect(strategy.focusAreas).toContain("authentication");
    expect(strategy.skipAreas).toContain("style");
    expect(strategy.riskBias).toBe(1);
  });

  it("returns strategy for logic category", () => {
    const strategy = getReviewStrategy("logic");
    expect(strategy.focusAreas).toContain("bugs");
    expect(strategy.skipAreas).toHaveLength(0);
    expect(strategy.riskBias).toBe(0);
  });

  it("returns strategy for docs category", () => {
    const strategy = getReviewStrategy("docs");
    expect(strategy.focusAreas).toContain("accuracy");
    expect(strategy.skipAreas).toContain("runtime bugs");
    expect(strategy.riskBias).toBe(-2);
  });

  it("returns strategy for tests category", () => {
    const strategy = getReviewStrategy("tests");
    expect(strategy.focusAreas).toContain("test correctness");
    expect(strategy.skipAreas).toContain("style");
    expect(strategy.riskBias).toBe(-1);
  });

  it("returns strategy for config category", () => {
    const strategy = getReviewStrategy("config");
    expect(strategy.focusAreas).toContain("misconfigurations");
    expect(strategy.riskBias).toBe(0);
  });

  it("returns strategy for cosmetic category", () => {
    const strategy = getReviewStrategy("cosmetic");
    expect(strategy.focusAreas).toContain("accessibility");
    expect(strategy.skipAreas).toContain("runtime bugs");
    expect(strategy.riskBias).toBe(-2);
  });

  it("falls back to logic for unknown category", () => {
    const strategy = getReviewStrategy("unknown" as PRCategory);
    expect(strategy.focusAreas).toContain("bugs");
    expect(strategy.riskBias).toBe(0);
  });

  it("all strategies have promptAddition", () => {
    const categories: PRCategory[] = ["security", "logic", "docs", "tests", "config", "cosmetic"];
    for (const cat of categories) {
      const strategy = getReviewStrategy(cat);
      expect(strategy.promptAddition.length).toBeGreaterThan(20);
      expect(strategy.promptAddition).toBeTruthy();
    }
  });

  it("all strategies have non-empty focusAreas", () => {
    const categories: PRCategory[] = ["security", "logic", "docs", "tests", "config", "cosmetic"];
    for (const cat of categories) {
      const strategy = getReviewStrategy(cat);
      expect(strategy.focusAreas.length).toBeGreaterThan(0);
    }
  });

  it("security strategy elevates severity", () => {
    const strategy = getReviewStrategy("security");
    expect(strategy.riskBias).toBeGreaterThan(0);
    expect(strategy.promptAddition).toContain("Elevate severity");
  });

  it("docs strategy reduces severity", () => {
    const strategy = getReviewStrategy("docs");
    expect(strategy.riskBias).toBeLessThan(0);
    expect(strategy.promptAddition).toContain("Reduce severity");
  });
});

// ---------------------------------------------------------------------------
// buildStrategyPrompt
// ---------------------------------------------------------------------------

describe("buildStrategyPrompt", () => {
  it("includes PR type in prompt", () => {
    const prompt = buildStrategyPrompt("security");
    expect(prompt).toContain("security");
    expect(prompt).toContain("Adaptive Review Strategy");
  });

  it("includes focus areas in prompt", () => {
    const prompt = buildStrategyPrompt("security");
    expect(prompt).toContain("Focus areas:");
    expect(prompt).toContain("authentication");
  });

  it("includes skip areas in prompt", () => {
    const prompt = buildStrategyPrompt("security");
    expect(prompt).toContain("Skip areas:");
    expect(prompt).toContain("style");
  });

  it("omits skip areas when empty (logic)", () => {
    const prompt = buildStrategyPrompt("logic");
    expect(prompt).not.toContain("Skip areas:");
  });

  it("omits risk bias when zero (logic)", () => {
    const prompt = buildStrategyPrompt("logic");
    expect(prompt).not.toContain("Risk bias:");
  });

  it("includes positive risk bias for security", () => {
    const prompt = buildStrategyPrompt("security");
    expect(prompt).toContain("Risk bias:");
    expect(prompt).toContain("elevate");
  });

  it("includes negative risk bias for docs", () => {
    const prompt = buildStrategyPrompt("docs");
    expect(prompt).toContain("Risk bias:");
    expect(prompt).toContain("reduce");
  });

  it("includes strategy promptAddition text", () => {
    const prompt = buildStrategyPrompt("security");
    expect(prompt).toContain("security-sensitive code");
  });

  it("generates prompt for all categories", () => {
    const categories: PRCategory[] = ["security", "logic", "docs", "tests", "config", "cosmetic"];
    for (const cat of categories) {
      const prompt = buildStrategyPrompt(cat);
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt).toContain(cat);
    }
  });

  it("docs prompt mentions documentation-specific guidance", () => {
    const prompt = buildStrategyPrompt("docs");
    expect(prompt).toContain("documentation-only");
    expect(prompt).toContain("Do NOT flag");
  });

  it("tests prompt mentions test-specific guidance", () => {
    const prompt = buildStrategyPrompt("tests");
    expect(prompt).toContain("test-focused review");
    expect(prompt).toContain("flaky test");
  });

  it("config prompt mentions config-specific guidance", () => {
    const prompt = buildStrategyPrompt("config");
    expect(prompt).toContain("configuration files");
    expect(prompt).toContain("misconfigurations");
  });

  it("cosmetic prompt is lightweight", () => {
    const prompt = buildStrategyPrompt("cosmetic");
    expect(prompt).toContain("lightweight review");
    expect(prompt).toContain("nitpick/low");
  });
});
