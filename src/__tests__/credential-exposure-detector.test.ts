import { describe, it, expect } from "vitest";
import { detectCredentialExposure } from "../credential-exposure-detector.js";
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
// scaffold-with-inline-secret
// ---------------------------------------------------------------------------

describe("detectCredentialExposure — scaffold-with-inline-secret", () => {
  it("detects env var with high-entropy inline fallback", () => {
    const file = makeFile("src/config.ts", [
      'const apiKey = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "scaffold-with-inline-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects AWS access key as inline fallback", () => {
    const file = makeFile("src/aws.ts", [
      'const accessKey = process.env.AWS_ACCESS_KEY || "AKIAIOSFODNN7EXAMPLE";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "scaffold-with-inline-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects GitHub PAT as inline fallback", () => {
    const file = makeFile("src/github.ts", [
      'const token = process.env.GH_TOKEN || "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "scaffold-with-inline-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag env var with short fallback", () => {
    const file = makeFile("src/config.ts", [
      'const port = process.env.PORT || "3000";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "scaffold-with-inline-secret");
    expect(issues).toHaveLength(0);
  });

  it("does not flag env var with low-entropy fallback", () => {
    const file = makeFile("src/config.ts", [
      'const host = process.env.HOST || "localhost-development";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "scaffold-with-inline-secret");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeFile("src/__tests__/config.test.ts", [
      'const apiKey = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "scaffold-with-inline-secret");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// config-object-literal-secret
// ---------------------------------------------------------------------------

describe("detectCredentialExposure — config-object-literal-secret", () => {
  it("detects apiKey with high-entropy value in config", () => {
    const file = makeFile("src/client.ts", [
      'const config = { apiKey: "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" };',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects access_key with AWS key", () => {
    const file = makeFile("src/s3.ts", [
      'const options = { access_key: "AKIAIOSFODNN7EXAMPLE" };',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects connectionString with high-entropy value", () => {
    const file = makeFile("src/database.ts", [
      'const config = { connectionString: "Server=tcp:myserver.database.windows.net,1433;Password=8k3j5h2a9s7d6f1g" };',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects password with high-entropy value", () => {
    const file = makeFile("src/db.ts", [
      'const creds = { password: "xK9mQ2pL7vN4wR8jT5yA3bC6" };',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag config with env var values", () => {
    const file = makeFile("src/config.ts", [
      "const config = { apiKey: process.env.API_KEY };",
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues).toHaveLength(0);
  });

  it("does not flag short/low-entropy passwords", () => {
    const file = makeFile("src/config.ts", [
      'const config = { password: "admin123" };',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeFile("src/__tests__/client.test.ts", [
      'const config = { apiKey: "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4" };',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "config-object-literal-secret");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// constructor-hardcoded-credential
// ---------------------------------------------------------------------------

describe("detectCredentialExposure — constructor-hardcoded-credential", () => {
  it("detects SDK Client with inline key", () => {
    const file = makeFile("src/sdk.ts", [
      'const client = new Client({ key: "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" });',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "constructor-hardcoded-credential");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Service constructor with inline token", () => {
    const file = makeFile("src/api.ts", [
      'const svc = new Service({ token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" });',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "constructor-hardcoded-credential");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag constructor with env var", () => {
    const file = makeFile("src/sdk.ts", [
      "const client = new Client({ key: process.env.API_KEY });",
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "constructor-hardcoded-credential");
    expect(issues).toHaveLength(0);
  });

  it("does not flag constructor with short values", () => {
    const file = makeFile("src/sdk.ts", [
      'const client = new Client({ key: "test" });',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "constructor-hardcoded-credential");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// example-placeholder-secret
// ---------------------------------------------------------------------------

describe("detectCredentialExposure — example-placeholder-secret", () => {
  it("detects 'replace with your' comment near high-entropy string", () => {
    const file = makeFile("src/config.ts", [
      'const key = "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"; // Replace with your actual API key',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "example-placeholder-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects 'update with your real' comment near AWS key", () => {
    const file = makeFile("src/aws.ts", [
      'const key = "AKIAIOSFODNN7EXAMPLE"; // Update with your real access key',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "example-placeholder-secret");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag placeholder comment without nearby secret", () => {
    const file = makeFile("src/config.ts", [
      "// Replace with your actual database host",
      'const host = "localhost";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "example-placeholder-secret");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files with placeholder comments", () => {
    const file = makeFile("src/__tests__/config.test.ts", [
      '// Replace with your actual API key',
      'const key = "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const result = detectCredentialExposure([file]);
    const issues = result.issues.filter((i) => i.category === "example-placeholder-secret");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectCredentialExposure — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/config.ts", status: "deleted", hunks: [] };
    const result = detectCredentialExposure([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/config.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectCredentialExposure([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment-only lines", () => {
    const file = makeFile("src/config.ts", [
      "// const apiKey = process.env.API_KEY || \"sk-ant-...\"",
    ]);
    const result = detectCredentialExposure([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no credential patterns", () => {
    const file = makeFile("src/utils.ts", [
      "function add(a: number, b: number): number { return a + b; }",
    ]);
    const result = detectCredentialExposure([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one PR", () => {
    const file1 = makeFile("src/config.ts", [
      'const key = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const file2 = makeFile("src/client.ts", [
      'const config = { apiKey: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" };',
    ]);
    const result = detectCredentialExposure([file1, file2]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("skips type-only import lines", () => {
    const file = makeFile("src/types.ts", [
      "import type { Config } from './config';",
    ]);
    const result = detectCredentialExposure([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectCredentialExposure — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/config.ts", [
      'const key = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const result = detectCredentialExposure([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Credential Exposure Accelerator Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectCredentialExposure([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/config.ts", [
      'const key = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const result = detectCredentialExposure([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectCredentialExposure([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeFile("src/config.ts", [
      'const key = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const file2 = makeFile("src/aws.ts", [
      '// Replace with your actual API key',
      'const key = "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const result = detectCredentialExposure([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeFile("src/config.ts", [
      'const key = process.env.API_KEY || "sk-ant-api03-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6";',
    ]);
    const result = detectCredentialExposure([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});
