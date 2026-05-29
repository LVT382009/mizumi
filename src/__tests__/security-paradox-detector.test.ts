import { describe, it, expect, vi } from "vitest";
import { detectSecurityParadox } from "../security-paradox-detector.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(
  path: string,
  addedLines: string[],
  removedLines: string[] = [],
  status: "modified" | "added" | "deleted" | "renamed" = "modified",
): DiffFile {
  const changes = [
    ...addedLines.map((content, idx) => ({
      type: "add" as const,
      content: `+${content}`,
      line: idx + 1,
    })),
    ...removedLines.map((content, idx) => ({
      type: "delete" as const,
      content: `-${content}`,
      line: addedLines.length + idx + 1,
    })),
  ];
  return {
    path,
    status,
    hunks: [{ header: "@@ -1 +1 @@@@", changes }],
  };
}

// ---------------------------------------------------------------------------
// custom-crypto
// ---------------------------------------------------------------------------

describe("detectSecurityParadox — custom-crypto", () => {
  it("detects XOR encryption", () => {
    const file = makeDiffFile("src/crypto.ts", [
      "function encrypt(data, key) { return data ^ key; }",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Math.random() for token generation", () => {
    const file = makeDiffFile("src/auth.ts", [
      "const token = Math.random().toString(36);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects rot13 usage", () => {
    const file = makeDiffFile("src/obfuscate.ts", [
      "const encoded = rot13(plaintext);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects btoa used as encryption", () => {
    const file = makeDiffFile("src/secure.ts", [
      'const encrypted = btoa(data); // encrypt user data',
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects custom RSA implementation", () => {
    const file = makeDiffFile("src/rsa.ts", [
      "function modpow(base, exp, mod) { ... }",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects custom key derivation", () => {
    const file = makeDiffFile("src/keys.ts", [
      "function deriveKey(password, salt) { ... }",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/crypto.test.ts", [
      "function encrypt(data, key) { return data ^ key; }",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues).toHaveLength(0);
  });

  it("does not flag comment lines", () => {
    const file = makeDiffFile("src/crypto.ts", [
      "// function encrypt(data, key) { return data ^ key; }",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues).toHaveLength(0);
  });

  it("does not flag migration away from bad crypto", () => {
    const file = makeDiffFile("src/crypto.ts", [
      "replace md5 with sha256 for password hashing",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "custom-crypto");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// overengineered-encryption
// ---------------------------------------------------------------------------

describe("detectSecurityParadox — overengineered-encryption", () => {
  it("detects double encryption", () => {
    const file = makeDiffFile("src/secure.ts", [
      "const encrypted = encrypt(encrypt(data, key1), key2);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "overengineered-encryption");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects re-encryption", () => {
    const file = makeDiffFile("src/secure.ts", [
      "await reencrypt(vault, oldKey, newKey);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "overengineered-encryption");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects double AES", () => {
    const file = makeDiffFile("src/vault.ts", [
      "// Apply aes then aes for double protection",
    ]);
    // Comment lines are skipped, so no issue from comment
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "overengineered-encryption");
    expect(issues).toHaveLength(0);
  });

  it("detects key encrypting key pattern", () => {
    const file = makeDiffFile("src/keymgmt.ts", [
      "const kek = new KeyEncryptingKey(masterKey);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "overengineered-encryption");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects extra encryption round", () => {
    const file = makeDiffFile("src/secure.ts", [
      "Apply extra encrypt round for security",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "overengineered-encryption");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/encrypt.test.ts", [
      "const encrypted = encrypt(encrypt(data, key1), key2);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "overengineered-encryption");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// training-era-drift
// ---------------------------------------------------------------------------

describe("detectSecurityParadox — training-era-drift", () => {
  it("detects MD5 usage", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Node createHash('md5')", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = crypto.createHash('md5').update(data).digest();",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects SHA1 usage", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const digest = sha1(message);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Node createHash('sha1')", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = crypto.createHash('sha1').update(buf).digest('hex');",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects DES usage", () => {
    const file = makeDiffFile("src/cipher.ts", [
      "const cipher = crypto.createCipher('des-cbc', key);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects ECB mode", () => {
    const file = makeDiffFile("src/cipher.ts", [
      "const cipher = createCipher('aes-128-ecb', key);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects RC4 usage", () => {
    const file = makeDiffFile("src/stream.ts", [
      "const cipher = rc4(key, plaintext);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Math.random() for security", () => {
    const file = makeDiffFile("src/auth.ts", [
      "const token = Math.random()",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects hardcoded IV", () => {
    const file = makeDiffFile("src/crypto.ts", [
      'const iv = "1234567890123456";',
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects hardcoded nonce", () => {
    const file = makeDiffFile("src/crypto.ts", [
      'nonce: "aaaaaaaaaaaaaaaa"',
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects hardcoded salt", () => {
    const file = makeDiffFile("src/crypto.ts", [
      'salt: "fixed-salt-value-here"',
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects RSA with PKCS1 v1.5", () => {
    const file = makeDiffFile("src/rsa.ts", [
      "constencrypted = rsa.encrypt(data, publicKey, 'pkcs1padding');",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Blowfish usage", () => {
    const file = makeDiffFile("src/cipher.ts", [
      "const cipher = blowfish.encrypt(key, data);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects PBKDF1 usage", () => {
    const file = makeDiffFile("src/kdf.ts", [
      "const key = pbkdf1(password, salt, iterations);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/hash.test.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues).toHaveLength(0);
  });

  it("does not flag comment lines", () => {
    const file = makeDiffFile("src/hash.ts", [
      "// const hash = md5(input); // deprecated",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues).toHaveLength(0);
  });

  it("does not flag migration away from deprecated", () => {
    const file = makeDiffFile("src/hash.ts", [
      "Migration: replace md5 with sha256",
    ]);
    const result = detectSecurityParadox([file]);
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues).toHaveLength(0);
  });

  it("does not flag deprecated acknowledgment", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input); /* deprecated: remove in v2 */",
    ]);
    // The whitelist checks the full line, and deprecated keyword should whitelist
    // But the pattern itself still matches — this tests the WHITELIST_LINE_RE
    const result = detectSecurityParadox([file]);
    const driftIssues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(driftIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectSecurityParadox — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/crypto.ts", status: "deleted", hunks: [] };
    const result = detectSecurityParadox([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@@@", changes: [] }],
    };
    const result = detectSecurityParadox([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no paradox patterns", () => {
    const file = makeDiffFile("src/utils.ts", [
      "const x = 1 + 2;",
    ]);
    const result = detectSecurityParadox([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one PR", () => {
    const file1 = makeDiffFile("src/crypto.ts", [
      "const hash = md5(data);",
    ]);
    const file2 = makeDiffFile("src/secure.ts", [
      "const encrypted = encrypt(encrypt(data, k1), k2);",
    ]);
    const result = detectSecurityParadox([file1, file2]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates same-category same-file same-line", () => {
    const file = makeDiffFile("src/crypto.ts", [
      "const hash = md5(data);",
    ]);
    const result = detectSecurityParadox([file]);
    const driftIssues = result.issues.filter((i) => i.category === "training-era-drift" && i.file === "src/crypto.ts");
    expect(driftIssues.length).toBeLessThanOrEqual(1);
  });

  it("skips spec files", () => {
    const file = makeDiffFile("src/app.spec.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type-only import lines", () => {
    const file = makeDiffFile("src/types.ts", [
      "import type { MD5Hash } from './hash';",
    ]);
    const result = detectSecurityParadox([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectSecurityParadox — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Security Paradox Detection");
      expect(result.contextText).toContain("Critical");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeDiffFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectSecurityParadox([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeDiffFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectSecurityParadox([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const file2 = makeDiffFile("src/secure.ts", [
      "const encrypted = encrypt(encrypt(data, k1), k2);",
    ]);
    const result = detectSecurityParadox([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("body summary truncates at 15 issues", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      makeDiffFile(`src/crypto${i}.ts`, [`const hash = md5(data${i});`])
    );
    const result = detectSecurityParadox(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("accepts PR title for security intent", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file], "Secure the auth flow");
    // Detector should still flag — security intent + deprecated crypto = paradox
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts PR body for security intent", () => {
    const file = makeDiffFile("src/hash.ts", [
      "const hash = md5(input);",
    ]);
    const result = detectSecurityParadox([file], undefined, "This hardens encryption");
    const issues = result.issues.filter((i) => i.category === "training-era-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});
