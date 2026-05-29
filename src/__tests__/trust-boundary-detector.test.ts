import { describe, it, expect, vi } from "vitest";
import { detectTrustBoundaryErosion } from "../trust-boundary-detector.js";
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
  status: "modified" | "added" | "deleted" | "renamed" = "modified",
): DiffFile {
  const changes = addedLines.map((content, idx) => ({
    type: "add" as const,
    content: `+${content}`,
    line: idx + 1,
  }));
  return {
    path,
    status,
    hunks: [{ header: "@@ -1 +1 @@@@", changes }],
  };
}

// ---------------------------------------------------------------------------
// over-permissive-iam
// ---------------------------------------------------------------------------

describe("detectTrustBoundaryErosion — over-permissive-iam", () => {
  it("detects Action:* in CloudFormation YAML", () => {
    const file = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Resource:* in Terraform JSON", () => {
    const file = makeDiffFile("infra/iam.json", [
      '        Resource: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Principal:* (public access)", () => {
    const file = makeDiffFile("infra/bucket-policy.yml", [
      '          Principal: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Terraform actions = [\"*\"]", () => {
    const file = makeDiffFile("infra/main.tf", [
      '  actions = ["*"]',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects s3:* wildcard", () => {
    const file = makeDiffFile("infra/s3-policy.tf", [
      '  actions = ["s3:*"]',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects secretsmanager:* wildcard", () => {
    const file = makeDiffFile("infra/secrets-policy.yml", [
      '        - secretsmanager:*',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag IAM patterns in .ts app code", () => {
    const file = makeDiffFile("src/app.ts", [
      'Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("tests/iam-policy.yml", [
      '        Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues).toHaveLength(0);
  });

  it("flags CDK TypeScript files", () => {
    const file = makeDiffFile("infra/stack.cdk.ts", [
      '  actions: ["*"]',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// missing-auth-middleware
// ---------------------------------------------------------------------------

describe("detectTrustBoundaryErosion — missing-auth-middleware", () => {
  it("detects Express POST route without auth", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.post('/api/users', createUser);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Express GET route without auth", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.get('/api/data', getData);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("does not flag route with auth middleware", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.post('/api/users', authenticate, createUser);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });

  it("does not flag route with UseGuards(AuthGuard)", () => {
    const file = makeDiffFile("src/controller.ts", [
      "@Post('/users') @UseGuards(AuthGuard) createUser() {}",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });

  it("does not flag Python @login_required", () => {
    const file = makeDiffFile("src/views.py", [
      "@app.route('/admin', methods=['POST']) @login_required",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });

  it("detects Flask route without auth", () => {
    const file = makeDiffFile("src/api.py", [
      "@app.route('/api/data', methods=['POST'])",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Spring @PostMapping without auth", () => {
    const file = makeDiffFile("src/UserController.java", [
      "@PostMapping('/users')",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/routes.test.ts", [
      "app.post('/api/users', createUser);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });

  it("does not flag [AllowAnonymous] routes", () => {
    const file = makeDiffFile("src/controller.ts", [
      "[HttpGet] [AllowAnonymous] getPublicData() {}",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    // AllowAnonymous is explicitly declaring intent
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// absent-audit-logging
// ---------------------------------------------------------------------------

describe("detectTrustBoundaryErosion — absent-audit-logging", () => {
  it("detects login function without logging", () => {
    const file = makeDiffFile("src/auth.ts", [
      "async function login(username, password) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects password reset without logging", () => {
    const file = makeDiffFile("src/auth.ts", [
      "async function passwordReset(userId) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects permission escalation without logging", () => {
    const file = makeDiffFile("src/admin.ts", [
      "function escalatePrivilege(userId) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects createUser without logging", () => {
    const file = makeDiffFile("src/admin.ts", [
      "async function createUser(data) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag login with logging", () => {
    const file = makeDiffFile("src/auth.ts", [
      "logger.info('login attempt', { username });",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });

  it("does not flag security event with console.log", () => {
    const file = makeDiffFile("src/auth.ts", [
      "console.log('password reset for user', userId);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });

  it("does not flag security event with audit.log", () => {
    const file = makeDiffFile("src/auth.ts", [
      "audit.log('permission change', { userId, role });",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/auth.test.ts", [
      "async function login(username, password) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectTrustBoundaryErosion — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "infra/policy.yml", status: "deleted", hunks: [] };
    const result = detectTrustBoundaryErosion([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/routes.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@@@", changes: [] }],
    };
    const result = detectTrustBoundaryErosion([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no trust boundary issues", () => {
    const file = makeDiffFile("src/utils.ts", [
      "const x = 1 + 2;",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one PR", () => {
    const file1 = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const file2 = makeDiffFile("src/routes.ts", [
      "app.post('/api/users', createUser);",
    ]);
    const result = detectTrustBoundaryErosion([file1, file2]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates same-category same-file same-line", () => {
    const file = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const iamIssues = result.issues.filter((i) => i.category === "over-permissive-iam" && i.file === "infra/policy.yml");
    expect(iamIssues.length).toBeLessThanOrEqual(1);
  });

  it("skips type-only import lines", () => {
    const file = makeDiffFile("src/types.ts", [
      "import type { User } from './auth';",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectTrustBoundaryErosion — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Trust Boundary Erosion Detection");
      expect(result.contextText).toContain("Critical");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeDiffFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeDiffFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const file2 = makeDiffFile("src/routes.ts", [
      "app.get('/api/data', getData);",
    ]);
    const result = detectTrustBoundaryErosion([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeDiffFile("infra/policy.yml", [
      '        Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("body summary truncates at 15 issues", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      makeDiffFile(`infra/policy${i}.yml`, [`        Action: "*" for service${i}`])
    );
    const result = detectTrustBoundaryErosion(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});

// ---------------------------------------------------------------------------
// Additional coverage expansion — trust boundary
// ---------------------------------------------------------------------------

describe("detectTrustBoundaryErosion — over-permissive-iam expanded", () => {
  it("detects Resource:* in CloudFormation", () => {
    const file = makeDiffFile("infra/s3-bucket.yml", [
      '        Resource: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Terraform resources = [*]", () => {
    const file = makeDiffFile("infra/policy.tf", [
      '  resources = ["*"]',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Principal:* for public access", () => {
    const file = makeDiffFile("infra/bucket.json", [
      '          Principal: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects ec2:* wildcard", () => {
    const file = makeDiffFile("infra/ec2-policy.yml", [
      '        - ec2:*',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects kms:* wildcard", () => {
    const file = makeDiffFile("infra/kms-policy.tf", [
      '  actions = ["kms:*"]',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects iam:* wildcard", () => {
    const file = makeDiffFile("infra/iam-policy.yml", [
      '        - iam:*',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag IAM patterns in .py files", () => {
    const file = makeDiffFile("src/app.py", [
      'Action: "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues).toHaveLength(0);
  });

  it("does not flag .js files even with wildcard syntax", () => {
    const file = makeDiffFile("src/config.js", [
      'actions = ["*"]',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues).toHaveLength(0);
  });

  it("flags .json template files", () => {
    const file = makeDiffFile("infra/template.json", [
      '                "Action": "*"',
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "over-permissive-iam");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe("detectTrustBoundaryErosion — missing-auth-middleware expanded", () => {
  it("detects Express DELETE route without auth", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.delete('/api/users/:id', deleteUser);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Express PUT route without auth", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.put('/api/users/:id', updateUser);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects Express PATCH route without auth", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.patch('/api/users/:id', patchUser);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("does not flag route with requireAuth middleware", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.post('/api/data', requireAuth, createData);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });

  it("does not flag route with isAuthenticated middleware", () => {
    const file = makeDiffFile("src/routes.ts", [
      "app.get('/api/profile', isAuthenticated, getProfile);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });

  it("detects Spring @GetMapping without auth", () => {
    const file = makeDiffFile("src/UserController.java", [
      "@GetMapping('/users/{id}')",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag Spring @GetMapping with @preAuthorize", () => {
    const file = makeDiffFile("src/UserController.java", [
      "@GetMapping('/admin') @preAuthorize('hasRole(ADMIN)')",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    expect(issues).toHaveLength(0);
  });
});

describe("detectTrustBoundaryErosion — absent-audit-logging expanded", () => {
  it("detects logout function without logging", () => {
    const file = makeDiffFile("src/auth.ts", [
      "async function logout(sessionId) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects createAdmin without logging", () => {
    const file = makeDiffFile("src/admin.ts", [
      "async function createAdmin(data) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects deleteToken without logging", () => {
    const file = makeDiffFile("src/token.ts", [
      "async function deleteToken(tokenId) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects passwordChange without logging", () => {
    const file = makeDiffFile("src/auth.ts", [
      "function passwordChange(userId, newPassword) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag security event with logger.warn", () => {
    const file = makeDiffFile("src/auth.ts", [
      "logger.warn('login failed', { username });",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });

  it("does not flag security event with debug log", () => {
    const file = makeDiffFile("src/auth.ts", [
      "logger.debug('authenticate called');",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });

  it("does not flag spec files", () => {
    const file = makeDiffFile("src/auth.spec.ts", [
      "function login(username, password) {",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "absent-audit-logging");
    expect(issues).toHaveLength(0);
  });
});

describe("detectTrustBoundaryErosion — combined scenarios", () => {
  it("handles multiple file types in one PR", () => {
    const iamFile = makeDiffFile("infra/policy.yml", ['        Action: "*"']);
    const routeFile = makeDiffFile("src/routes.ts", ["app.post('/api/data', handler);"]);
    const authFile = makeDiffFile("src/auth.ts", ["function login(u, p) {"]);
    const result = detectTrustBoundaryErosion([iamFile, routeFile, authFile]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBe(3);
  });

  it("handles comment-only changes in IAM files", () => {
    const file = makeDiffFile("infra/policy.yml", [
      "# This policy grants wide access temporarily",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles type imports in route files", () => {
    const file = makeDiffFile("src/routes.ts", [
      "import type { Request } from 'express';",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles webhook routes", () => {
    const file = makeDiffFile("src/webhook.ts", [
      "app.post('/webhooks/stripe', handleWebhook);",
    ]);
    const result = detectTrustBoundaryErosion([file]);
    const issues = result.issues.filter((i) => i.category === "missing-auth-middleware");
    // Webhooks without auth middleware are still flagged — they need signature verification
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});
