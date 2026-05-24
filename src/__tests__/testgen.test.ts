import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateTests } from "../testgen.js";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("../models.js", () => ({
  createModel: vi.fn(() => "mock-model"),
  createLightModel: vi.fn(() => "mock-light-model"),
}));

vi.mock("../config.js", () => ({
  requireApiKey: vi.fn(() => "test-key"),
  loadConfig: vi.fn(),
}));

import { generateObject } from "ai";
const mockGenerateObject = vi.mocked(generateObject);

function makeConfig() {
  return {
    provider: "openai" as const, model: "gpt-4.1-mini", baseUrl: "",
    profile: "chill" as const, maxComments: 15, language: "en-US",
    selfCritique: true, confidenceThreshold: 80, autoReview: true,
    autoPauseAfter: 5, excludePatterns: [], tierRouting: true,
    smallDiffThreshold: 50, securityPaths: ["**/auth/**"],
  };
}

describe("generateTests", () => {
  beforeEach(() => { mockGenerateObject.mockReset(); });

  it("returns message for empty findings", async () => {
    const result = await generateTests("diff", [], makeConfig());
    expect(result).toContain("No critical/high findings");
  });

  it("returns message when only medium findings exist", async () => {
    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "medium", category: "style", message: "Bad naming" },
    ], makeConfig());
    expect(result).toContain("No critical/high findings");
  });

  it("includes critical findings", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/sec.test.ts", code: "it('should fail', () => {})" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/auth.ts", line: 10, severity: "critical", category: "security", message: "Auth bypass" },
    ], makeConfig());

    expect(result).toContain("Generated Tests");
  });

  it("calls LLM and formats test output", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/a.test.ts", code: "it('should work', () => { expect(1).toBe(1); })" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("some diff", [
      { file: "src/a.ts", line: 10, severity: "high", category: "bug", message: "Null deref" },
    ], makeConfig());

    expect(result).toContain("Generated Tests");
    expect(result).toContain("src/__tests__/a.test.ts");
    expect(result).toContain("should work");
  });

  it("includes suggestion in findings summary when present", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 5, severity: "high", category: "bug", message: "Bad code", suggestion: "Use optional chaining" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("Suggestion: Use optional chaining");
  });

  it("handles empty LLM test output", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "SQL injection" },
    ], makeConfig());

    expect(result).toContain("did not generate");
  });

  it("caps findings at 5", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const findings = Array.from({ length: 8 }, (_, i) => ({
      file: `src/${i}.ts`, line: i + 1, severity: "high", category: "bug", message: `Bug ${i}`,
    }));

    await generateTests("diff", findings, makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    const bugLines = promptText.split("\n").filter((l: string) => l.includes("[high]"));
    expect(bugLines.length).toBe(5);
  });

  it("formats multiple test files in output", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        tests: [
          { file: "src/__tests__/a.test.ts", code: "it('a', () => {})" },
          { file: "src/__tests__/b.test.ts", code: "it('b', () => {})" },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug 1" },
    ], makeConfig());

    expect(result).toContain("a.test.ts");
    expect(result).toContain("b.test.ts");
  });

  it("includes Mizumi attribution", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "XSS" },
    ], makeConfig());

    expect(result).toContain("Generated by Mizumi");
  });

  it("uses vitest syntax in system prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.system).toContain("vitest");
    expect(callOpts.system).toContain("describe/it/expect");
  });

  it("truncates diff to 30000 chars", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const longDiff = "x".repeat(50000);
    await generateTests(longDiff, [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt.length).toBeLessThan(50000);
  });
});
