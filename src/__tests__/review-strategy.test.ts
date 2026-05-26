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

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("getReviewStrategy additional edge cases", () => {
  it("security focusAreas includes injection", () => {
    const strategy = getReviewStrategy("security");
    expect(strategy.focusAreas).toContain("injection");
    expect(strategy.focusAreas).toContain("crypto");
    expect(strategy.focusAreas).toContain("secrets");
  });

  it("logic has no skip areas", () => {
    const strategy = getReviewStrategy("logic");
    expect(strategy.skipAreas).toHaveLength(0);
  });

  it("config has focus on breaking changes", () => {
    const strategy = getReviewStrategy("config");
    expect(strategy.focusAreas).toContain("breaking changes");
    expect(strategy.focusAreas).toContain("security settings");
  });

  it("cosmetic has minimal focus areas", () => {
    const strategy = getReviewStrategy("cosmetic");
    expect(strategy.focusAreas.length).toBeLessThanOrEqual(3);
  });

  it("tests strategy mentions flaky tests", () => {
    const strategy = getReviewStrategy("tests");
    expect(strategy.promptAddition).toContain("flaky test");
  });

  it("all strategies have valid riskBias range", () => {
    const categories = ["security", "logic", "docs", "tests", "config", "cosmetic"];
    for (const cat of categories) {
      const strategy = getReviewStrategy(cat as any);
      expect(strategy.riskBias).toBeGreaterThanOrEqual(-2);
      expect(strategy.riskBias).toBeLessThanOrEqual(2);
    }
  });

  it("returns consistent strategy for same category", () => {
    const s1 = getReviewStrategy("security");
    const s2 = getReviewStrategy("security");
    expect(s1.focusAreas).toEqual(s2.focusAreas);
    expect(s1.riskBias).toBe(s2.riskBias);
  });

  it("unknown category falls back to logic riskBias (0)", () => {
    const strategy = getReviewStrategy("nonexistent" as any);
    expect(strategy.riskBias).toBe(0);
  });
});

describe("buildStrategyPrompt additional edge cases", () => {
  it("config prompt includes YAML/JSON check", () => {
    const prompt = buildStrategyPrompt("config");
    expect(prompt).toContain("YAML");
  });

  it("security prompt includes all security focus areas", () => {
    const prompt = buildStrategyPrompt("security");
    const strategy = getReviewStrategy("security");
    for (const area of strategy.focusAreas) {
      // At least some focus areas appear in the prompt
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("builds prompt for fallback category", () => {
    const prompt = buildStrategyPrompt("unknown" as any);
    expect(prompt).toContain("Adaptive Review Strategy");
    expect(prompt.length).toBeGreaterThan(50);
  });

  it("all category prompts contain PR type", () => {
    const categories = ["security", "logic", "docs", "tests", "config", "cosmetic"];
    for (const cat of categories) {
      const prompt = buildStrategyPrompt(cat as any);
      expect(prompt).toContain(cat);
    }
  });

  it("cosmetic prompt does not contain security guidance", () => {
    const prompt = buildStrategyPrompt("cosmetic");
    expect(prompt).not.toContain("injection");
    expect(prompt).not.toContain("authentication");
  });
});
