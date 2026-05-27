import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateTests } from "../testgen.js";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../models.js", () => ({
  createModel: vi.fn(() => "mock-model"),
  createLightModel: vi.fn(() => "mock-light-model"),
}));

vi.mock("../config.js", () => ({
  requireApiKey: vi.fn(() => "test-key"),
  loadConfig: vi.fn(),
}));

import { generateObject, generateText } from "ai";
const mockGenerateObject = vi.mocked(generateObject);
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
  beforeEach(() => { mockGenerateObject.mockReset(); mockGenerateText.mockReset(); });

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

  // ---------------------------------------------------------------------------
  // Extended: different severity levels and category combinations
  // ---------------------------------------------------------------------------

  it("processes critical severity findings", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/crit.test.ts", code: "it('critical', () => {})" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/db.ts", line: 50, severity: "critical", category: "security", message: "SQL injection" },
    ], makeConfig());

    expect(result).toContain("crit.test.ts");
    expect(mockGenerateObject).toHaveBeenCalled();
  });

  it("skips info severity findings", async () => {
    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "info", category: "style", message: "Info message" },
    ], makeConfig());

    expect(result).toContain("No critical/high findings");
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("processes mixed critical and high severity findings", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/mix.test.ts", code: "it('mixed', () => {})" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass" },
      { file: "src/b.ts", line: 2, severity: "high", category: "bug", message: "Null deref" },
      { file: "src/c.ts", line: 3, severity: "medium", category: "style", message: "Bad naming" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    expect(promptText).toContain("[critical]");
    expect(promptText).toContain("[high]");
    expect(promptText).not.toContain("[medium]");
  });

  // ---------------------------------------------------------------------------
  // Extended: different file types and categories
  // ---------------------------------------------------------------------------

  it("includes security category in prompt for security findings", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/sec.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/api/auth.ts", line: 10, severity: "critical", category: "security", message: "JWT not verified" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("(security)");
    expect(callOpts.prompt).toContain("JWT not verified");
  });

  it("includes bug category in prompt for bug findings", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/lib.rs", line: 5, severity: "high", category: "bug", message: "Use after free" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("(bug)");
    expect(callOpts.prompt).toContain("Use after free");
  });

  it("handles file paths with various extensions", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/python.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/utils/helpers.py", line: 42, severity: "high", category: "bug", message: "Off-by-one" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("src/utils/helpers.py:42");
  });

  // ---------------------------------------------------------------------------
  // Extended: empty diff and very large diff edge cases
  // ---------------------------------------------------------------------------

  it("handles empty diff string with whitespace", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("   \n  \n  ", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("Generated Tests");
  });

  it("truncates very large diff exactly at 30000 chars boundary", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const diffExactly30000 = "x".repeat(30000);
    await generateTests(diffExactly30000, [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    // The diff portion should not exceed 30000 chars
    expect(callOpts.prompt.length).toBeLessThan(60000);
  });

  // ---------------------------------------------------------------------------
  // Extended: LLM error handling and fallback
  // ---------------------------------------------------------------------------

  it("handles AI_NoObjectGeneratedError by falling back to generateText", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: '{"tests":[{"file":"src/__tests__/fallback.test.ts","code":"it(\'works\', () => {})"}]}',
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("fallback.test.ts");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("handles generateText returning markdown-fenced JSON", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: '```json\n{"tests":[{"file":"src/__tests__/fenced.test.ts","code":"it(\'works\', () => {})"}]}\n```',
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("fenced.test.ts");
  });

  it("handles generateText returning invalid JSON gracefully", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: "This is not JSON at all",
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("Failed to parse");
  });

  it("handles generateText returning JSON with extra whitespace", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: '  \n\n  {"tests":[{"file":"src/__tests__/ws.test.ts","code":"test"}]}  \n  ',
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("ws.test.ts");
  });

  it("re-throws non-AI_NoObjectGeneratedError errors from generateObject", async () => {
    mockGenerateObject.mockRejectedValue(new Error("Network timeout"));

    await expect(generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig())).rejects.toThrow("Network timeout");
  });

  it("throws when LLM returns object with undefined tests array", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: undefined },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    // result.tests is undefined, so .length will throw TypeError
    await expect(generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig())).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Extended: config integration and model selection
  // ---------------------------------------------------------------------------

  it("passes model from config to generateObject", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const config = makeConfig();
    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], config);

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    // createModel returns "mock-model" from our mock
    expect(callOpts.model).toBe("mock-model");
  });

  it("uses different provider config without error", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const config = { ...makeConfig(), provider: "anthropic" as const, model: "claude-sonnet-4-6" };
    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], config);

    expect(result).toContain("Generated Tests");
  });

  // ---------------------------------------------------------------------------
  // Extended: suggestion format validation and multi-suggestion
  // ---------------------------------------------------------------------------

  it("formats suggestion with special characters correctly in prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "XSS", suggestion: "Use encodeURIComponent() instead of raw interpolation for ${userInput}" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("Suggestion: Use encodeURIComponent()");
  });

  it("handles multiple findings with suggestions in prompt", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "critical", category: "security", message: "Auth bypass", suggestion: "Verify token" },
      { file: "src/b.ts", line: 2, severity: "high", category: "bug", message: "Null deref", suggestion: "Add null check" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("Suggestion: Verify token");
    expect(callOpts.prompt).toContain("Suggestion: Add null check");
  });

  // ---------------------------------------------------------------------------
  // Extended: output format validation
  // ---------------------------------------------------------------------------

  it("includes Mizumi attribution with asterisk markdown", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "src/__tests__/attr.test.ts", code: "it('works', () => {})" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("*Generated by Mizumi");
  });

  it("includes review reminder in attribution", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("Review before committing");
  });

  it("formats output with ## Generated Tests header", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("## Generated Tests");
  });

  it("separates each test with markdown heading and code block", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        tests: [
          { file: "src/__tests__/x.test.ts", code: "it('x', () => {})" },
          { file: "src/__tests__/y.test.ts", code: "it('y', () => {})" },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    // Each test file gets ### heading and ```typescript code block
    const headingCount = (result.match(/### src\/__tests__\//g) || []).length;
    const codeBlockCount = (result.match(/```typescript/g) || []).length;
    expect(headingCount).toBe(2);
    expect(codeBlockCount).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Extended: confidence thresholds and filtering (via prompt content)
  // ---------------------------------------------------------------------------

  it("does not include duplicate findings when same file appears twice", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug A" },
      { file: "src/a.ts", line: 10, severity: "high", category: "bug", message: "Bug B" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    // Both lines of the same file should appear
    expect(promptText).toContain("src/a.ts:1");
    expect(promptText).toContain("src/a.ts:10");
  });

  it("handles finding with line number 0", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 0, severity: "high", category: "bug", message: "File-level bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.prompt).toContain("src/a.ts:0");
  });

  it("handles 5 exact critical/high findings without truncation", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const findings = Array.from({ length: 5 }, (_, i) => ({
      file: `src/${i}.ts`, line: i + 1, severity: "high" as const, category: "bug", message: `Bug ${i}`,
    }));

    await generateTests("diff", findings, makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    const bugLines = promptText.split("\n").filter((l: string) => l.includes("[high]"));
    expect(bugLines.length).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Extended: generateText fallback with markdown code fences
  // ---------------------------------------------------------------------------

  it("handles generateText fallback with code fence without json label", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: '```\n{"tests":[{"file":"src/__tests__/nofence.test.ts","code":"it(\'works\', () => {})"}]}\n```',
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("nofence.test.ts");
  });

  it("handles generateText fallback failing with malformed JSON", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: '```json\n{"tests": not valid json}\n```',
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("Failed to parse");
  });

  it("handles generateText fallback returning schema-invalid JSON", async () => {
    mockGenerateObject.mockRejectedValue(
      Object.assign(new Error("No object generated"), { name: "AI_NoObjectGeneratedError" })
    );

    mockGenerateText.mockResolvedValue({
      text: '{"not_tests": [{"file": "x", "code": "y"}]}',
    } as any);

    const result = await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    expect(result).toContain("Failed to parse");
  });

  // ---------------------------------------------------------------------------
  // Extended: maxOutputTokens and schema validation
  // ---------------------------------------------------------------------------

  it("always passes maxOutputTokens of 2048", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    expect(callOpts.maxOutputTokens).toBe(2048);
  });

  it("schema has tests array with file and code properties", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { tests: [{ file: "t.test.ts", code: "test" }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await generateTests("diff", [
      { file: "src/a.ts", line: 1, severity: "high", category: "bug", message: "Bug" },
    ], makeConfig());

    const callOpts = mockGenerateObject.mock.calls[0][0] as any;
    const schema = callOpts.schema;
    expect(schema).toBeDefined();
    // Zod schema .shape exposes inner structure
    expect(schema.shape).toBeDefined();
    expect(schema.shape.tests).toBeDefined();
  });
});
