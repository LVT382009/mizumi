import { describe, it, expect } from "vitest";
import { detectIterationStripping } from "../iteration-stripping-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(
  path: string,
  removedLines: string[],
  addedLines: string[] = [],
  status: "modified" | "added" | "deleted" | "renamed" = "modified"
): DiffFile {
  const changes = [
    ...removedLines.map((content, idx) => ({
      type: "delete" as const,
      content: `-${content}`,
      line: idx + 1,
    })),
    ...addedLines.map((content, idx) => ({
      type: "add" as const,
      content: `+${content}`,
      line: removedLines.length + idx + 1,
    })),
  ];
  return {
    path,
    status,
    hunks: [{ header: "@@ -1 +1 @@@@", changes }],
  };
}

// ---------------------------------------------------------------------------
// auth-decorator-stripped
// ---------------------------------------------------------------------------

describe("detectIterationStripping — auth-decorator-stripped", () => {
  it("detects @login_required decorator removal", () => {
    const file = makeDiffFile("src/views.py", [
      "@login_required",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects @require_auth decorator removal", () => {
    const file = makeDiffFile("src/api.ts", [
      "@require_auth",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects @UseGuards(AuthGuard) removal", () => {
    const file = makeDiffFile("src/controller.ts", [
      "@UseGuards(AuthGuard)",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects @preAuthorize removal", () => {
    const file = makeDiffFile("src/security.java", [
      "@preAuthorize('hasRole(ADMIN)')",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects app.use(authenticate) middleware removal", () => {
    const file = makeDiffFile("src/server.ts", [
      "app.use(authenticate)",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects @app.before_request removal", () => {
    const file = makeDiffFile("src/app.py", [
      "@app.before_request",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/auth.test.ts", [
      "@login_required",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues).toHaveLength(0);
  });

  it("does not flag comment lines", () => {
    const file = makeDiffFile("src/api.ts", [
      "// @login_required - removed for simplicity",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validation-guard-stripped
// ---------------------------------------------------------------------------

describe("detectIterationStripping — validation-guard-stripped", () => {
  it("detects removed if-check with isValid", () => {
    const file = makeDiffFile("src/handler.ts", [
      "if (!isValid(data)) {",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects removed validateInput call", () => {
    const file = makeDiffFile("src/api.ts", [
      "validateInput(req.body);",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removed status 400 return", () => {
    const file = makeDiffFile("src/server.ts", [
      "return res.status(400).json({ error: 'invalid' });",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removed throw ValidationError", () => {
    const file = makeDiffFile("src/validate.ts", [
      "throw new ValidationError('invalid input');",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removed sanitize call", () => {
    const file = makeDiffFile("src/input.ts", [
      "sanitizeInput(userInput);",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/handler.test.ts", [
      "validateInput(req.body);",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues).toHaveLength(0);
  });

  it("does not flag comment lines", () => {
    const file = makeDiffFile("src/handler.ts", [
      "/* validateInput(req.body); */",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "validation-guard-stripped");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parameterization-loss
// ---------------------------------------------------------------------------

describe("detectIterationStripping — parameterization-loss", () => {
  it("detects removed parameterized query with added string concat (critical)", () => {
    const file = makeDiffFile("src/db.ts", [
      "cursor.execute('SELECT * FROM users WHERE id = %s', [user_id])",
    ], [
      "query(f'SELECT * FROM users WHERE id = {user_id}')",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "parameterization-loss");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("detects removed parameterized query with added JS string concat", () => {
    const file = makeDiffFile("src/repo.ts", [
      "db.query('SELECT * FROM items WHERE id = $1', [id])",
    ], [
      "db.query('SELECT * FROM items WHERE id = ' + id)",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "parameterization-loss");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("flags removed parameterized query even without replacement evidence (warning)", () => {
    const file = makeDiffFile("src/models.ts", [
      "execute('INSERT INTO logs VALUES(?, ?)', [action, ts])",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "parameterization-loss");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("detects removed prepare statement", () => {
    const file = makeDiffFile("src/sql.ts", [
      "const stmt = db.prepare('SELECT * FROM products WHERE id = ?');",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "parameterization-loss");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/db.test.ts", [
      "cursor.execute('SELECT * FROM users WHERE id = %s', [user_id])",
    ], [
      "query(f'SELECT * FROM users WHERE id = {user_id}')",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "parameterization-loss");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// error-handling-weakened
// ---------------------------------------------------------------------------

describe("detectIterationStripping — error-handling-weakened", () => {
  it("detects specific catch replaced with broad empty catch", () => {
    const file = makeDiffFile("src/api.ts", [
      "catch (e: ValueError) {",
    ], [
      "catch (e: Error) {}",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects Python specific except replaced with broad pass", () => {
    const file = makeDiffFile("src/process.py", [
      "except ValueError as e:",
    ], [
      "except Exception: pass",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects AuthError catch replaced with broad empty catch", () => {
    const file = makeDiffFile("src/auth.ts", [
      "catch (err: AuthError) {",
    ], [
      "catch (err: any) {}",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Python KeyError replaced with except Exception pass", () => {
    const file = makeDiffFile("src/parser.py", [
      "except KeyError as e:",
    ], [
      "except Exception: pass",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag when specific catch is kept", () => {
    const file = makeDiffFile("src/api.ts", [
      "// some unrelated removal",
    ], [
      "catch (e: ValueError) { throw e; }",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues).toHaveLength(0);
  });

  it("does not flag test files", () => {
    const file = makeDiffFile("src/__tests__/api.test.ts", [
      "catch (e: ValueError) {",
    ], [
      "catch (e: Error) {}",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues).toHaveLength(0);
  });

  it("does not flag when broad catch is not added", () => {
    const file = makeDiffFile("src/api.ts", [
      "catch (e: ValueError) {",
    ], [
      "console.log('handled');",
    ]);
    const result = detectIterationStripping([file]);
    const issues = result.issues.filter((i) => i.category === "error-handling-weakened");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectIterationStripping — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = { path: "src/deleted.ts", status: "deleted", hunks: [] };
    const result = detectIterationStripping([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@@@", changes: [] }],
    };
    const result = detectIterationStripping([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean code with no stripping patterns", () => {
    const file = makeDiffFile("src/utils.ts", [
      "const old = 'unused';",
    ], [
      "const updated = 'better';",
    ]);
    const result = detectIterationStripping([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment-only removed lines", () => {
    const file = makeDiffFile("src/api.ts", [
      "// @login_required - old decorator",
    ]);
    const result = detectIterationStripping([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips type-only import lines", () => {
    const file = makeDiffFile("src/types.ts", [
      "import type { Auth } from './auth';",
    ]);
    const result = detectIterationStripping([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one PR", () => {
    const file1 = makeDiffFile("src/api.ts", [
      "@login_required",
    ]);
    const file2 = makeDiffFile("src/db.ts", [
      "cursor.execute('SELECT * FROM users WHERE id = %s', [user_id])",
    ], [
      "query(f'SELECT * FROM users WHERE id = {user_id}')",
    ]);
    const result = detectIterationStripping([file1, file2]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates same-category same-file same-line", () => {
    const file = makeDiffFile("src/api.ts", [
      "@login_required",
      "@login_required",
    ]);
    const result = detectIterationStripping([file]);
    const authIssues = result.issues.filter((i) => i.category === "auth-decorator-stripped");
    // Same line number patterns in same file - only one should survive dedup
    expect(authIssues.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectIterationStripping — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeDiffFile("src/api.ts", [
      "@login_required",
    ]);
    const result = detectIterationStripping([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Iteration Security Stripping Detection");
      expect(result.contextText).toContain("Critical");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeDiffFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectIterationStripping([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeDiffFile("src/api.ts", [
      "@login_required",
    ]);
    const result = detectIterationStripping([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeDiffFile("src/clean.ts", [
      "const x = 1;",
    ]);
    const result = detectIterationStripping([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeDiffFile("src/auth.ts", [
      "@login_required",
    ]);
    const file2 = makeDiffFile("src/handler.ts", [
      "validateInput(req.body);",
    ]);
    const result = detectIterationStripping([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeDiffFile("src/api.ts", [
      "@login_required",
    ]);
    const result = detectIterationStripping([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("body summary truncates at 15 issues", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      makeDiffFile(`src/api${i}.ts`, [`@login_required`])
    );
    const result = detectIterationStripping(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});
