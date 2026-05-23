import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateTests } from "../testgen.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn((opts: any) => opts) },
}));

vi.mock("../config.js", () => ({
  getApiKey: vi.fn(() => "test-key"),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn(() => "anthropic-model")),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => {
    const modelFn = vi.fn(() => "openai-model");
    (modelFn as any).chat = vi.fn(() => "openai-chat-model");
    return modelFn;
  }),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => "google-model")),
}));

import { generateText } from "ai";
const mockGenerateText = vi.mocked(generateText);

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
  beforeEach(() => { mockGenerateText.mockReset(); });

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

  it("calls LLM and formats test output", async () => {
    mockGenerateText.mockResolvedValue({
      output: { tests: [{ file: "src/__tests__/a.test.ts", code: "it('should work', () => { expect(1).toBe(1); })" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("some diff", [
      { file: "src/a.ts", line: 10, severity: "high", category: "bug", message: "Null deref" },
    ], makeConfig());

    expect(result).toContain("Generated Tests");
    expect(result).toContain("src/__tests__/a.test.ts");
    expect(result).toContain("should work");
  });

  it("handles empty LLM test output", async () => {
    mockGenerateText.mockResolvedValue({
      output: { tests: [] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "SQL injection" },
    ], makeConfig());

    expect(result).toContain("did not generate");
  });

  it("caps findings at 5", async () => {
    mockGenerateText.mockResolvedValue({
      output: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const findings = Array.from({ length: 8 }, (_, i) => ({
      file: `src/${i}.ts`, line: i + 1, severity: "high", category: "bug", message: `Bug ${i}`,
    }));

    await generateTests("diff", findings, makeConfig());

    const callOpts = mockGenerateText.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    // Should only include 5 findings
    const bugLines = promptText.split("\n").filter((l: string) => l.includes("[high]"));
    expect(bugLines.length).toBe(5);
  });
});
