import { describe, it, expect } from "vitest";
import { parseSuggestions } from "../improve.js";

describe("isDangerousPath", () => {
  function isDangerousPath(p: string): boolean {
    return p.includes("..") || /\/\.\//.test(p) || /^\/|^\.(\/|$)|^[A-Za-z]:/.test(p);
  }

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

  it("rejects hidden file paths", () => {
    expect(isDangerousPath("./.env")).toBe(true);
  });

  it("accepts normal relative paths", () => {
    expect(isDangerousPath("src/app.ts")).toBe(false);
    expect(isDangerousPath("lib/utils.js")).toBe(false);
    expect(isDangerousPath("README.md")).toBe(false);
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
    const body = `\`\`\`suggestion\nif (x) {\n  return y;\n}\n\`\`\``;
    const results = parseSuggestions(body, "src/c.ts", 20);
    expect(results).toHaveLength(1);
    expect(results[0].code).toBe("if (x) {\n  return y;\n}");
  });
});
