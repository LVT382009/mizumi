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

  it("propagates LLM rejection errors", async () => {
    mockGenerateObject.mockRejectedValue(new Error("Rate limit exceeded"));

    await expect(generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "XSS" },
    ], makeConfig())).rejects.toThrow("Rate limit exceeded");
  });

  it("returns early for findings with only low/nitpick severity", async () => {
    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "low", category: "style", message: "Trailing whitespace" },
      { file: "src/b.ts", line: 2, severity: "nitpick", category: "style", message: "Extra semicolon" },
    ], makeConfig());

    expect(result).toContain("No critical/high findings");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("includes critical and high findings but not medium in LLM prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass" },
      { file: "src/b.ts", line: 2, severity: "high", category: "bug", message: "Null deref" },
      { file: "src/c.ts", line: 3, severity: "medium", category: "performance", message: "Slow loop" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    expect(promptText).toContain("[critical]");
    expect(promptText).toContain("[high]");
    expect(promptText).not.toContain("[medium]");
  });

  it("handles findings without suggestion field", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Buffer overflow" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).not.toContain("Suggestion:");
  });

  it("formats code blocks in output with typescript language tag", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/x.test.ts", code: "it('works', () => { expect(1).toBe(1); })" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("```typescript");
  });

  it("includes diff context in prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const diff = "+ const x = dangerous();\n- const x = safe();";
    await generateTests(diff, [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("dangerous()");
    expect(callOpts.prompt).toContain("safe()");
  });

  it("correctly references finding file and line in summary", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/auth/login.ts", line: 42, severity: "critical", category: "security", message: "Identity spoofing" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("src/auth/login.ts:42");
    expect(callOpts.prompt).toContain("Identity spoofing");
  });

  it("preserves multiple test code blocks separately in output", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        tests: [
          { file: "src/__tests__/alpha.test.ts", code: "it('alpha test', () => { /* ... */ })" },
          { file: "src/__tests__/beta.test.ts", code: "it('beta test', () => { /* ... */ })" },
          { file: "src/__tests__/gamma.test.ts", code: "it('gamma test', () => { /* ... */ })" },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("alpha.test.ts");
    expect(result).toContain("beta.test.ts");
    expect(result).toContain("gamma.test.ts");
    // Each should have its own heading and code block
    const headingMatches = result.match(/### src\/__tests__\/\w+\.test\.ts/g);
    expect(headingMatches).toHaveLength(3);
  });

  it("throws when LLM returns null object", async () => {
    mockGenerateObject.mockResolvedValue({
      object: null,
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await expect(generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig())).rejects.toThrow();
  });

  it("uses correct schema for generateObject call", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.maxOutputTokens).toBe(2048);
    expect(callOpts.schema).toBeDefined();
  });

  it("includes empty diff without error", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("Generated Tests");
  });

  it("formats findings with category in prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/api.ts", line: 15, severity: "high", category: "security", message: "IDOR vulnerability" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("(security)");
    expect(callOpts.prompt).toContain("IDOR vulnerability");
  });

  it("does not call LLM when findings array is empty", async () => {
    const result = await generateTests("some diff", [], makeConfig());
    expect(result).toContain("No critical/high findings");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("separates each test file section with heading", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        tests: [
          { file: "src/__tests__/one.test.ts", code: "it('one', () => {})" },
          { file: "src/__tests__/two.test.ts", code: "it('two', () => {})" },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("### src/__tests__/one.test.ts");
    expect(result).toContain("### src/__tests__/two.test.ts");
  });

  it("only includes up to 5 critical/high findings even with more", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const findings = Array.from({ length: 12 }, (_, i) => ({
      file: `src/${i}.ts`, line: i + 1, severity: "critical", category: "security", message: `Vuln ${i}`,
    }));

    await generateTests("diff", findings, makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    const vulnLines = promptText.split("\n").filter((l: string) => l.includes("[critical]"));
    expect(vulnLines.length).toBe(5);
  });

  it("returns early with specific message for medium-only findings", async () => {
    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "medium", category: "performance", message: "N+1 query" },
      { file: "src/b.ts", line: 2, severity: "medium", category: "style", message: "Naming" },
    ], makeConfig());

    expect(result).toContain("No critical/high findings");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("uses minimal focused tests instruction in system prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.system).toContain("focused, minimal");
    expect(callOpts.system).toContain("one test per finding");
  });
});
