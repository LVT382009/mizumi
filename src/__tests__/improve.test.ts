import { describe, it, expect } from "vitest";
import { parseSuggestions, isDangerousPath, verifyPatch } from "../improve.js";

describe("isDangerousPath", () => {
  it("rejects path traversal with ..", () => {
    expect(isDangerousPath("../etc/passwd")).toBe(true);
    expect(isDangerousPath("src/../../../etc/passwd")).toBe(true);
  });

  it("rejects absolute Unix paths", () => {
    expect(isDangerousPath("/etc/passwd")).toBe(true);
  });

  it("rejects absolute Windows paths", () => {
    expect(isDangerousPath("C:\\Windows\\system32")).toBe(true);
  });

  it("rejects UNC paths", () => {
    expect(isDangerousPath("\\\\server\\share\\file")).toBe(true);
  });

  it("rejects hidden file paths", () => {
    expect(isDangerousPath("./.env")).toBe(true);
    expect(isDangerousPath(".gitignore")).toBe(true);
    expect(isDangerousPath("src/.secret")).toBe(true);
  });

  it("rejects empty or whitespace paths", () => {
    expect(isDangerousPath("")).toBe(true);
    expect(isDangerousPath(" ")).toBe(true);
  });

  it("rejects backslash traversal on Windows", () => {
    expect(isDangerousPath("src\\..\\..\\etc")).toBe(true);
  });

  it("accepts normal relative paths", () => {
    expect(isDangerousPath("src/app.ts")).toBe(false);
    expect(isDangerousPath("lib/utils.js")).toBe(false);
    expect(isDangerousPath("README.md")).toBe(false);
  });

  it("accepts paths with dots in filenames (not leading)", () => {
    expect(isDangerousPath("src/app.test.ts")).toBe(false);
    expect(isDangerousPath("lib/v2.0.module.js")).toBe(false);
  });

  it("rejects paths with encoded traversal", () => {
    // URL-encoded traversal is NOT decoded by path.normalize, but it starts
    // with ".." which is caught by the hidden-file segment check (. prefix).
    expect(isDangerousPath("..%2F..%2Fetc")).toBe(true);
  });

  it("accepts deep nested paths", () => {
    expect(isDangerousPath("src/features/auth/login.ts")).toBe(false);
  });

  it("rejects .ssh directory", () => {
    expect(isDangerousPath(".ssh/config")).toBe(true);
  });

  it("rejects drive letter paths", () => {
    expect(isDangerousPath("D:\\Windows\\system32")).toBe(true);
  });
});

describe("parseSuggestions", () => {
  it("extracts a single suggestion block", () => {
    const body = `**[HIGH] security**: Use const\n\n\`\`\`suggestion\nconst x = 1;\n\`\`\``;
    const results = parseSuggestions(body, "src/a.ts", 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ path: "src/a.ts", line: 5, code: "const x = 1;" });
  });

  it("returns empty array when no suggestion blocks", () => {
    const body = `**[MEDIUM] style**: Consider renaming\nNo code block here.`;
    const results = parseSuggestions(body, "src/a.ts", 3);
    expect(results).toHaveLength(0);
  });

  it("extracts multiple suggestion blocks from one comment", () => {
    const body = `\`\`\`suggestion\nlet a = 1;\n\`\`\`\nand also\n\`\`\`suggestion\nlet b = 2;\n\`\`\``;
    const results = parseSuggestions(body, "src/b.ts", 10);
    expect(results).toHaveLength(2);
    expect(results[0].code).toBe("let a = 1;");
    expect(results[1].code).toBe("let b = 2;");
  });

  it("preserves multi-line suggestion content", () => {
    const body = `\`\`\`suggestion\nif (x) {\n return y;\n}\n\`\`\``;
    const results = parseSuggestions(body, "src/c.ts", 20);
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("if (x) {\n return y;\n}");
  });

  it("strips trailing newline from code", () => {
    const body = "```suggestion\ncode;\n```";
    const results = parseSuggestions(body, "src/d.ts", 1);
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("code;");
  });

  it("handles suggestion with no trailing newline", () => {
    const body = "```suggestion\ncode;```";
    const results = parseSuggestions(body, "src/e.ts", 1);
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("code;");
  });
});

describe("verifyPatch", () => {
  it("accepts valid replacement", () => {
    const result = verifyPatch("const x = 1;", "const x = 2;");
    expect(result.valid).toBe(true);
  });

  it("rejects empty replacement", () => {
    const result = verifyPatch("const x = 1;", "");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("rejects whitespace-only replacement", () => {
    const result = verifyPatch("const x = 1;", " ");
    expect(result.valid).toBe(false);
  });

  it("rejects indentation mismatch", () => {
    const result = verifyPatch("  const x = 1;", "const x = 2;");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("indentation");
  });

  it("accepts replacement with matching indentation", () => {
    const result = verifyPatch("  const x = 1;", "  const x = 2;");
    expect(result.valid).toBe(true);
  });

  it("accepts multiline replacement even with different indentation", () => {
    const result = verifyPatch("  if (x) {", "if (x && y) {\n  return z;\n}");
    expect(result.valid).toBe(true);
  });

  it("rejects replacement that is too short relative to original", () => {
    const result = verifyPatch("const result = computeValue(input, config, opts);", "}");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too short");
  });

  it("accepts short replacement when original is also short", () => {
    const result = verifyPatch("x", "y");
    expect(result.valid).toBe(true);
  });

  it("accepts replacement with greater indentation", () => {
    const result = verifyPatch("const x = 1;", "  const x = 2;");
    expect(result.valid).toBe(true);
  });

  it("accepts no-indent original with no-indent replacement", () => {
    const result = verifyPatch("export default App;", "export default NewApp;");
    expect(result.valid).toBe(true);
  });

  it("accepts replacement that starts with bracket for short original", () => {
    // Original is 16 chars trimmed (<= 20), so too-short check is bypassed.
    // Both have 0 indent, so no indentation mismatch.
    const result = verifyPatch("function foo() {", "}");
    expect(result.valid).toBe(true);
  });

  it("rejects replacement of just } for long unindented original", () => {
    // Original has 0 indent (no indentation mismatch), but trimmed length > 20
    // and replacement trimmed is 1 char (<= 2), so too-short check fires.
    const result = verifyPatch("const result = computeValue(input, config, opts);", "}");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too short");
  });
});


describe("isDangerousPath - additional edge cases", () => {
  it("rejects path with multiple consecutive dots", () => {
    expect(isDangerousPath("src/.../etc/passwd")).toBe(true);
  });

  it("accepts current directory references", () => {
    expect(isDangerousPath("./src/app.ts")).toBe(false);
  });

  it("rejects paths with only whitespace segments", () => {
    expect(isDangerousPath(".bashrc")).toBe(true);
  });

  it("accepts paths with numeric directories", () => {
    expect(isDangerousPath("v2/api/handler.ts")).toBe(false);
  });

  it("rejects Windows drive letter with forward slash", () => {
    expect(isDangerousPath("C:/Windows/system32")).toBe(true);
  });

  it("accepts simple filename without directory", () => {
    expect(isDangerousPath("index.ts")).toBe(false);
  });
});


const BK = String.fromCharCode(96);
const BT3 = BK + BK + BK;

describe("parseSuggestions - additional edge cases", () => {
  it("ignores non-suggestion code blocks", () => {
    const body = BT3 + "typescript" + String.fromCharCode(10) + "const x = 1;" + String.fromCharCode(10) + BT3;
    const results = parseSuggestions(body, "src/a.ts", 1);
    expect(results).toHaveLength(0);
  });

  it("ignores suggestion in inline backticks", () => {
    const body = "Use the " + BK + "suggestion" + BK + " keyword";
    const results = parseSuggestions(body, "src/a.ts", 1);
    expect(results).toHaveLength(0);
  });

  it("handles unclosed suggestion block gracefully", () => {
    const body = BT3 + "suggestion" + String.fromCharCode(10) + "const fixed = true;";
    const results = parseSuggestions(body, "src/a.ts", 5);
    expect(results).toHaveLength(0);
  });

  it("extracts suggestion from body with Mizumi marker", () => {
    const body = "<!-- mizumi-review-marker -->" + String.fromCharCode(10) + "**[HIGH] bug**: Fix this" + String.fromCharCode(10) + BT3 + "suggestion" + String.fromCharCode(10) + "if (x) { return; }" + String.fromCharCode(10) + BT3;
    const results = parseSuggestions(body, "src/auth.ts", 42);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("src/auth.ts");
    expect(results[0].line).toBe(42);
  });

  it("handles suggestion with only whitespace content", () => {
    const body = BT3 + "suggestion" + String.fromCharCode(10) + "   " + String.fromCharCode(10) + BT3;
    const results = parseSuggestions(body, "src/a.ts", 1);
    expect(results).toHaveLength(1);
    expect(results[0].code.trim()).toBe("");
  });
});

describe("verifyPatch - additional edge cases", () => {
  it("accepts replacement with tabs for indentation", () => {
    const result = verifyPatch("	const x = 1;", "	const x = 2;");
    expect(result.valid).toBe(true);
  });

  it("rejects replacement with inconsistent indentation", () => {
    const result = verifyPatch("    const x = 1;", "const x = 2;");
    expect(result.valid).toBe(false);
  });

  it("accepts replacement that adds indentation", () => {
    const result = verifyPatch("const x = 1;", "    const x = 2;");
    expect(result.valid).toBe(true);
  });

  it("accepts replacement where both have same zero indentation", () => {
    const result = verifyPatch("export function foo() {", "export function bar() {");
    expect(result.valid).toBe(true);
  });

  it("rejects empty string for non-empty original", () => {
    const result = verifyPatch(String.raw`console.log("hello");`, "");
    expect(result.valid).toBe(false);
  });

  it("accepts multiline replacement even with indentation change", () => {
    const result = verifyPatch("  if (cond) {", "if (cond && other) {" + String.fromCharCode(10) + "  doStuff();" + String.fromCharCode(10) + "}");
    expect(result.valid).toBe(true);
  });

  it("accepts short replacement when original is under 20 chars", () => {
    const result = verifyPatch("let a = b;", "}");
    expect(result.valid).toBe(true);
  });

  it("rejects single bracket replacement for long original", () => {
    const result = verifyPatch("const result = await fetchWithRetry(config);", ")");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("too short");
  });
});