import { describe, it, expect } from "vitest";
import { detectPartialSecurityControls } from "../partial-security-control-detector.js";
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
// auth-without-authz
// ---------------------------------------------------------------------------

describe("detectPartialSecurityControls — auth-without-authz", () => {
  it("detects authenticate without any authorization", () => {
    const file = makeFile("src/auth.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "auth-without-authz");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("authorization");
  });

  it("detects isAuthenticated check without hasRole", () => {
    const file = makeFile("src/middleware.ts", [
      "if (!req.isAuthenticated()) { return res.status(401).send(); }",
      "next();",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "auth-without-authz");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when both auth and authz are present", () => {
    const file = makeFile("src/guard.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
      "function authorize(user: User, role: string) { return user.hasRole(role); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const criticalIssues = result.issues.filter(
      (i) => i.category === "auth-without-authz" && i.severity === "critical"
    );
    expect(criticalIssues).toHaveLength(0);
  });

  it("flags warning when authz is in a different file", () => {
    const file1 = makeFile("src/auth.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
    ]);
    const file2 = makeFile("src/authz.ts", [
      "function authorize(user: User, role: string) { return user.hasPermission(role); }",
    ]);

    const result = detectPartialSecurityControls([file1, file2]);
    const warningIssues = result.issues.filter(
      (i) => i.category === "auth-without-authz" && i.severity === "warning"
    );
    expect(warningIssues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects login without checkRole", () => {
    const file = makeFile("src/login.ts", [
      "app.post('/login', async (req, res) => { const user = await login(req.body); res.json(user); });",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "auth-without-authz");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// encrypt-without-kdf
// ---------------------------------------------------------------------------

describe("detectPartialSecurityControls — encrypt-without-kdf", () => {
  it("detects encrypt without key derivation", () => {
    const file = makeFile("src/crypto.ts", [
      "const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "encrypt-without-kdf");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects HMAC without salt/derive", () => {
    const file = makeFile("src/sign.ts", [
      "const hmac = crypto.createHmac('sha256', secret);",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "encrypt-without-kdf");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when both encrypt and kdf are present", () => {
    const file = makeFile("src/crypto.ts", [
      "const key = await crypto.pbkdf2(password, salt, 100000, 32, 'sha256');",
      "const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);",
    ]);

    const result = detectPartialSecurityControls([file]);
    const criticalIssues = result.issues.filter(
      (i) => i.category === "encrypt-without-kdf" && i.severity === "critical"
    );
    expect(criticalIssues).toHaveLength(0);
  });

  it("does not flag when bcrypt is used for hashing", () => {
    const file = makeFile("src/hash.ts", [
      "const hashed = await bcrypt.hash(password, 12);",
    ]);

    const result = detectPartialSecurityControls([file]);
    const encryptIssues = result.issues.filter(
      (i) => i.category === "encrypt-without-kdf" && i.severity === "critical"
    );
    // bcrypt IS a KDF, so it should match KDF patterns and prevent the false positive
    expect(encryptIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validate-without-sanitize
// ---------------------------------------------------------------------------

describe("detectPartialSecurityControls — validate-without-sanitize", () => {
  it("detects validateInput without sanitize", () => {
    const file = makeFile("src/input.ts", [
      "function validateInput(data: string) { return schema.check(data); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "validate-without-sanitize");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects joi validation without sanitize", () => {
    const file = makeFile("src/validate.ts", [
      "const schema = joi.object({ name: joi.string().required() });",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "validate-without-sanitize");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects zod validation without sanitize", () => {
    const file = makeFile("src/schema.ts", [
      "const schema = zod.object({ email: zod.string().email() });",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "validate-without-sanitize");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when both validate and sanitize are present", () => {
    const file = makeFile("src/safe.ts", [
      "function validateInput(data: string) { return schema.check(data); }",
      "function sanitize(data: string) { return DOMPurify.sanitize(data); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const criticalIssues = result.issues.filter(
      (i) => i.category === "validate-without-sanitize" && i.severity === "critical"
    );
    expect(criticalIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rate-count-without-enforce
// ---------------------------------------------------------------------------

describe("detectPartialSecurityControls — rate-count-without-enforce", () => {
  it("detects RateLimiter class without reject/block", () => {
    const file = makeFile("src/rate-limiter.ts", [
      "class rateLimiter {",
      "  private requestCount = 0;",
      "  check() { this.requestCount++; }",
      "}",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "rate-count-without-enforce");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects request counter without enforcement", () => {
    const file = makeFile("src/throttle.ts", [
      "function trackRequest() { requestCount++; }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "rate-count-without-enforce");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when rate limit enforcement exists", () => {
    const file = makeFile("src/rate.ts", [
      "let requestCount = 0;",
      "function trackRequest() { requestCount++; }",
      "if (requestCount >= MAX) { throw new RateLimitError('429 Too Many Requests'); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const criticalIssues = result.issues.filter(
      (i) => i.category === "rate-count-without-enforce" && i.severity === "critical"
    );
    expect(criticalIssues).toHaveLength(0);
  });

  it("detects token bucket without throttle", () => {
    const file = makeFile("src/bucket.ts", [
      "const tokenCount = refillRate;",
      "function consume() { tokenCount--; }",
    ]);

    const result = detectPartialSecurityControls([file]);
    const issues = result.issues.filter((i) => i.category === "rate-count-without-enforce");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectPartialSecurityControls — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectPartialSecurityControls([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectPartialSecurityControls([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file = makeFile("src/auth.ts", [
      "// function authenticate(token: string) { return jwt.verify(token); }",
    ]);
    const result = detectPartialSecurityControls([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type-only imports", () => {
    const file = makeFile("src/types.ts", [
      "import type { authenticate } from './auth';",
    ]);
    const result = detectPartialSecurityControls([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no security patterns", () => {
    const file = makeFile("src/utils.ts", [
      "function add(a: number, b: number) { return a + b; }",
    ]);
    const result = detectPartialSecurityControls([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectPartialSecurityControls — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/auth.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Partial Security Control Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectPartialSecurityControls([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/auth.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectPartialSecurityControls([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeFile("src/auth.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
    ]);
    const file2 = makeFile("src/authz.ts", [
      "function authorize(user: User, role: string) { return user.hasPermission(role); }",
    ]);

    const result = detectPartialSecurityControls([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeFile("src/auth.ts", [
      "async function authenticate(token: string) { return jwt.verify(token, secret); }",
    ]);

    const result = detectPartialSecurityControls([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});
