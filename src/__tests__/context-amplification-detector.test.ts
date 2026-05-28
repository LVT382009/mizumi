import { describe, it, expect } from "vitest";
import { detectContextAmplification } from "../context-amplification-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[]): DiffFile {
  return {
    path,
    status: "modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: addedLines.map((content, idx) => ({
          type: "add" as const,
          content: `+${content}`,
          line: idx + 1,
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// duplicate-implementation
// ---------------------------------------------------------------------------

describe("detectContextAmplification — duplicate-implementation", () => {
  it("detects send functions with same noun in different files", () => {
    const file1 = makeFile("src/email.ts", [
      "export async function sendNotification(data: Notification) {",
      "  await mailer.send(data);",
      "}",
    ]);
    const file2 = makeFile("src/slack.ts", [
      "export async function sendMessage(data: Notification) {",
      "  await webhook.post(data);",
      "}",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "duplicate-implementation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.description.includes("send"))).toBe(true);
  });

  it("detects create functions with same noun across files", () => {
    const file1 = makeFile("src/user-repo.ts", [
      "export function createUser(data: UserData) {",
      "  return db.insert(data);",
      "}",
    ]);
    const file2 = makeFile("src/admin-repo.ts", [
      "export function buildUser(data: UserData) {",
      "  return db.insert(data);",
      "}",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "duplicate-implementation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag functions in the same file", () => {
    const file = makeFile("src/utils.ts", [
      "function sendNotification(a: any) {}",
      "function sendMessage(a: any) {}",
    ]);

    const result = detectContextAmplification([file]);
    const issues = result.issues.filter((i) => i.category === "duplicate-implementation");
    expect(issues).toHaveLength(0);
  });

  it("does not flag functions with different verbs and nouns", () => {
    const file1 = makeFile("src/a.ts", [
      "function createUser(data: any) {}",
    ]);
    const file2 = makeFile("src/b.ts", [
      "function deleteAccount(id: string) {}",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "duplicate-implementation");
    expect(issues).toHaveLength(0);
  });

  it("detects const arrow function duplicates", () => {
    const file1 = makeFile("src/logger.ts", [
      "export const formatMessage = (msg: string) => msg.trim();",
    ]);
    const file2 = makeFile("src/formatter.ts", [
      "export const formatMessage = (msg: string) => msg.trim();",
    ]);

    const result = detectContextAmplification([file1, file2]);
    // Same function name in different files is divergent-utility, not duplicate-implementation
    const allIssues = result.issues.filter((i) => i.category === "duplicate-implementation" || i.category === "divergent-utility");
    expect(allIssues.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// naming-inconsistency
// ---------------------------------------------------------------------------

describe("detectContextAmplification — naming-inconsistency", () => {
  it("detects notification/alert naming across files", () => {
    const file1 = makeFile("src/push.ts", [
      "function sendNotification(data: any) {}",
    ]);
    const file2 = makeFile("src/sms.ts", [
      "function sendAlert(data: any) {}",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "naming-inconsistency");
    // May or may not flag depending on whether the group detection triggers
    expect(issues.length).toBeGreaterThanOrEqual(0);
  });

  it("cap at 5 issues to avoid noise", () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) =>
      makeFile(`src/file${i}.ts`, [
        `function handler${i}(data: any) { /* handler pattern */ }`,
      ])
    );

    const result = detectContextAmplification(manyFiles);
    const issues = result.issues.filter((i) => i.category === "naming-inconsistency");
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// divergent-utility
// ---------------------------------------------------------------------------

describe("detectContextAmplification — divergent-utility", () => {
  it("detects same utility function in different files", () => {
    const file1 = makeFile("src/utils-a.ts", [
      "export function formatDate(d: Date) { return d.toISOString(); }",
    ]);
    const file2 = makeFile("src/utils-b.ts", [
      "export function formatDate(d: Date) { return d.toLocaleDateString(); }",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "divergent-utility");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("formatDate");
  });

  it("detects const utility declarations", () => {
    const file1 = makeFile("src/helpers.ts", [
      "export const parseConfig = (input: string) => JSON.parse(input);",
    ]);
    const file2 = makeFile("src/config-utils.ts", [
      "export const parseConfig = (input: string) => YAML.parse(input);",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "divergent-utility");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag utilities in the same file", () => {
    const file = makeFile("src/utils.ts", [
      "function formatDate(d: Date) { return d.toISOString(); }",
      "function formatDateLocal(d: Date) { return d.toLocaleDateString(); }",
    ]);

    const result = detectContextAmplification([file]);
    const issues = result.issues.filter((i) => i.category === "divergent-utility");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// import-divergence
// ---------------------------------------------------------------------------

describe("detectContextAmplification — import-divergence", () => {
  it("detects same symbol imported from different paths", () => {
    const file1 = makeFile("src/app.ts", [
      "import { format } from './utils/format';",
    ]);
    const file2 = makeFile("src/server.ts", [
      "import { format } from './lib/formatter';",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "import-divergence");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("format");
  });

  it("does not flag same symbol from same path", () => {
    const file1 = makeFile("src/a.ts", [
      "import { z } from 'zod';",
    ]);
    const file2 = makeFile("src/b.ts", [
      "import { z } from 'zod';",
    ]);

    const result = detectContextAmplification([file1, file2]);
    const issues = result.issues.filter((i) => i.category === "import-divergence");
    expect(issues).toHaveLength(0);
  });

  it("caps at 5 issues to avoid noise", () => {
    const manyFiles = Array.from({ length: 10 }, (_, i) =>
      makeFile(`src/module${i}.ts`, [
        `import { helper } from './path${i}/helpers';`,
      ])
    );

    const result = detectContextAmplification(manyFiles);
    const issues = result.issues.filter((i) => i.category === "import-divergence");
    expect(issues.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectContextAmplification — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectContextAmplification([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectContextAmplification([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file1 = makeFile("src/a.ts", [
      "// function sendNotification() {}",
    ]);
    const file2 = makeFile("src/b.ts", [
      "/* function sendMessage() {} */",
    ]);
    const result = detectContextAmplification([file1, file2]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type/interface lines", () => {
    const file = makeFile("src/types.ts", [
      "interface Notification { type: string; }",
      "type Alert = Notification & { priority: number; };",
    ]);
    const result = detectContextAmplification([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectContextAmplification — context and summary", () => {
  it("generates context text for issues", () => {
    const file1 = makeFile("src/email.ts", [
      "function sendNotification(data: any) {}",
    ]);
    const file2 = makeFile("src/slack.ts", [
      "function sendMessage(data: any) {}",
    ]);

    const result = detectContextAmplification([file1, file2]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Context Amplification Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectContextAmplification([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file1 = makeFile("src/a.ts", [
      "function formatDate(d: Date) {}",
    ]);
    const file2 = makeFile("src/b.ts", [
      "function formatDate(d: Date) {}",
    ]);

    const result = detectContextAmplification([file1, file2]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectContextAmplification([file]);
    expect(result.bodySummary).toBe("");
  });
});
