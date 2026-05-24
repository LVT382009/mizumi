import { describe, it, expect } from "vitest";
import { runRules, checkDuplicateApprovalGuard, hasEvalUsage, hasUnsafeInnerHTML, hasDebugger, hasWeakCrypto, hasTimingUnsafeCompare, hasUnsafeRegex, hasTodoFixme } from "../rules.js";
import { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers — minimal DiffFile factory
// ---------------------------------------------------------------------------

/** Build a single-change DiffFile with one added line at the given content. */
function addFile(
  path: string,
  addLines: string[],
  startLine = 1
): DiffFile {
  return {
    path,
    status: "added",
    additions: addLines.length,
    deletions: 0,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: startLine,
        newLines: addLines.length,
        content: "",
        changes: addLines.map((content, i) => ({
          type: "add" as const,
          line: startLine + i,
          oldLine: 0,
          content,
        })),
      },
    ],
  };
}

/** Build a DiffFile with both add and normal (context) lines. */
function fileWithRouteAndAuth(
  path: string,
  routeLine: string,
  authLine: string,
  routeLineNum: number,
  authLineNum: number
): DiffFile {
  const changes = [
    { type: "normal" as const, line: authLineNum, oldLine: authLineNum, content: authLine },
    { type: "add" as const, line: routeLineNum, oldLine: 0, content: routeLine },
  ];
  // Sort by line number so getSurroundingBlock works correctly
  changes.sort((a, b) => a.line - b.line);
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        content: "",
        changes,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Rule 1: auth-middleware-required
// ---------------------------------------------------------------------------

describe("auth-middleware-required", () => {
  it("flags route in routes/ without auth middleware", () => {
    const files = [addFile("src/routes/users.ts", ['app.get("/users", handler)'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("auth-middleware-required");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("security");
    expect(findings[0].file).toBe("src/routes/users.ts");
  });

  it("flags route in api/ without auth middleware", () => {
    const files = [addFile("src/api/orders.ts", ['router.post("/orders", createOrder)'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("auth-middleware-required");
  });

  it("flags .put route definition", () => {
    const files = [addFile("src/routes/items.ts", ['app.put("/items/:id", updateItem)'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("auth-middleware-required");
  });

  it("flags .delete route definition", () => {
    const files = [addFile("src/api/admin.ts", ['router.delete("/users/:id", removeUser)'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("auth-middleware-required");
  });

  it("flags .patch route definition", () => {
    const files = [addFile("src/routes/profile.ts", ['app.patch("/profile", editProfile)'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("auth-middleware-required");
  });

  it("flags .route() definition without auth", () => {
    const files = [addFile("src/api/legacy.ts", ['app.route("/legacy").get(handler)'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("auth-middleware-required");
  });

  it("does NOT flag route when auth middleware is within ±10 lines", () => {
    const files = [
      fileWithRouteAndAuth(
        "src/routes/dashboard.ts",
        'app.get("/dashboard", getDashboard)',
        'router.use(authenticate({ scope: "read" }));',
        20, // route at line 20
        15  // auth at line 15 (within ±10)
      ),
    ];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "auth-middleware-required")).toHaveLength(0);
  });

  it("does NOT flag route when requireAuth is nearby", () => {
    const files = [
      fileWithRouteAndAuth(
        "src/api/secure.ts",
        'app.get("/secure", handler)',
        "requireAuth(req, res, next);",
        10,
        5
      ),
    ];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "auth-middleware-required")).toHaveLength(0);
  });

  it("does NOT flag route when isAuth is nearby", () => {
    const files = [
      fileWithRouteAndAuth(
        "src/routes/me.ts",
        'router.get("/me", getMe)',
        "if (!isAuth(req)) return res.status(401).end();",
        10,
        8
      ),
    ];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "auth-middleware-required")).toHaveLength(0);
  });

  it("does NOT flag files outside routes/ or api/", () => {
    const files = [addFile("src/utils/helpers.ts", ['app.get("/ping", pong)'])];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "auth-middleware-required")).toHaveLength(0);
  });

  it("does NOT flag deleted lines in routes/", () => {
    const file: DiffFile = {
      path: "src/routes/old.ts",
      status: "deleted",
      additions: 0,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          content: "",
          changes: [
            { type: "delete", line: 0, oldLine: 1, content: 'app.get("/old", handler)' },
          ],
        },
      ],
    };
    const findings = runRules([file]);
    expect(findings.filter((f) => f.rule === "auth-middleware-required")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: no-hardcoded-secrets
// ---------------------------------------------------------------------------

describe("no-hardcoded-secrets", () => {
  it("flags hardcoded api_key assignment", () => {
    const files = [addFile("src/config.ts", ['const api_key = "abcdefghij12345"'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-hardcoded-secrets");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("security");
  });

  it("flags hardcoded password with colon", () => {
    const files = [addFile("src/setup.ts", ['password: "supersecret99"'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-hardcoded-secrets");
  });

  it("flags hardcoded secret with equals sign", () => {
    const files = [addFile(".env.local", ['SECRET="my-very-long-secret-value"'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-hardcoded-secrets");
  });

  it("flags hardcoded token assignment", () => {
    const files = [addFile("src/auth.ts", ['token = "sk-proj-1234567890abcdef"'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-hardcoded-secrets");
  });

  it("flags hardcoded credential with single quotes", () => {
    const files = [addFile("src/db.ts", ["credential: 'database-password-123'"])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-hardcoded-secrets");
  });

  it("does NOT flag when value uses process.env", () => {
    const files = [addFile("src/config.ts", ['const apiKey = process.env.API_KEY'])];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-hardcoded-secrets")).toHaveLength(0);
  });

  it("does NOT flag when value uses import.meta.env", () => {
    const files = [addFile("src/client.ts", ['const secret = import.meta.env.VUE_SECRET'])];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-hardcoded-secrets")).toHaveLength(0);
  });

  it("does NOT flag when value uses ENV", () => {
    const files = [addFile("src/env.ts", ['const token = ENV.JWT_SECRET'])];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-hardcoded-secrets")).toHaveLength(0);
  });

  it("does NOT flag when value uses getenv", () => {
    const files = [addFile("src/legacy.php", ['password = getenv("DB_PASS")'])];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-hardcoded-secrets")).toHaveLength(0);
  });

  it("does NOT flag short secret values (under 8 chars)", () => {
    const files = [addFile("src/test.ts", ['const apiKey = "short"'])];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-hardcoded-secrets")).toHaveLength(0);
  });

  it("does NOT flag deleted lines", () => {
    const file: DiffFile = {
      path: "src/old.ts",
      status: "modified",
      additions: 0,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          content: "",
          changes: [
            { type: "delete", line: 0, oldLine: 1, content: 'const password = "oldpassword12345"' },
          ],
        },
      ],
    };
    const findings = runRules([file]);
    expect(findings.filter((f) => f.rule === "no-hardcoded-secrets")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: no-sql-concat
// ---------------------------------------------------------------------------

describe("no-sql-concat", () => {
  it("flags SELECT with string concatenation (+)", () => {
    const files = [addFile("src/db/queries.ts", ['const q = "SELECT * FROM users WHERE id = " + userId'])];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-sql-concat");
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("security");
  });

  it("flags INSERT with string concatenation", () => {
    const files = [
      addFile("src/db/insert.ts", ['const q = "INSERT INTO logs VALUES (" + data + ")"']),
    ];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-sql-concat");
  });

  it("flags UPDATE with backtick concatenation", () => {
    const files = [
      addFile("src/db/update.ts", ["const q = `UPDATE users SET name = ` + userName"]),
    ];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-sql-concat");
  });

  it("flags DELETE with string concatenation", () => {
    const files = [
      addFile("src/db/delete.ts", ['const q = "DELETE FROM sessions WHERE id = " + sessionId']),
    ];
    const findings = runRules(files);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("no-sql-concat");
  });

  it("does NOT flag SQL using template literals with ${}", () => {
    const files = [
      addFile("src/db/safe.ts", [
        "const q = `SELECT * FROM users WHERE id = ${userId}`",
      ]),
    ];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-sql-concat")).toHaveLength(0);
  });

  it("does NOT flag non-SQL string concatenation", () => {
    const files = [
      addFile("src/util.ts", ['const msg = "Hello " + name']),
    ];
    const findings = runRules(files);
    expect(findings.filter((f) => f.rule === "no-sql-concat")).toHaveLength(0);
  });

  it("does NOT flag deleted lines with SQL concat", () => {
    const file: DiffFile = {
      path: "src/db/legacy.ts",
      status: "modified",
      additions: 0,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          content: "",
          changes: [
            { type: "delete", line: 0, oldLine: 1, content: '"SELECT * FROM x WHERE y = " + userInput' },
          ],
        },
      ],
    };
    const findings = runRules([file]);
    expect(findings.filter((f) => f.rule === "no-sql-concat")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting / edge cases
// ---------------------------------------------------------------------------

describe("cross-cutting and edge cases", () => {
  it("returns empty array for empty diff", () => {
    expect(runRules([])).toEqual([]);
  });

  it("returns empty array for files with no hunks", () => {
    const file: DiffFile = {
      path: "src/routes/empty.ts",
      status: "added",
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    expect(runRules([file])).toEqual([]);
  });

  it("returns empty array when all changes are normal (no additions)", () => {
    const file: DiffFile = {
      path: "src/routes/index.ts",
      status: "modified",
      additions: 0,
      deletions: 0,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          content: "",
          changes: [
            { type: "normal", line: 1, oldLine: 1, content: 'app.get("/health", healthCheck)' },
          ],
        },
      ],
    };
    expect(runRules([file])).toEqual([]);
  });

  it("can return multiple findings from a single file", () => {
    const file: DiffFile = {
      path: "src/routes/admin.ts",
      status: "added",
      additions: 3,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          content: "",
          changes: [
            { type: "add", line: 1, oldLine: 0, content: 'app.get("/admin", adminHandler)' },
            { type: "add", line: 2, oldLine: 0, content: 'const apiKey = "sk-1234567890abcdefgh"' },
            { type: "add", line: 3, oldLine: 0, content: '"SELECT * FROM users WHERE id = " + req.params.id' },
          ],
        },
      ],
    };
    const findings = runRules([file]);
    // auth-middleware-required (route without auth) + no-hardcoded-secrets + no-sql-concat
    expect(findings).toHaveLength(3);
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain("auth-middleware-required");
    expect(rules).toContain("no-hardcoded-secrets");
    expect(rules).toContain("no-sql-concat");
  });

  it("can return findings from multiple files", () => {
    const files = [
      addFile("src/routes/a.ts", ['app.get("/a", a)']),
      addFile("src/routes/b.ts", ['router.post("/b", b)']),
    ];
    const findings = runRules(files);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.rule === "auth-middleware-required")).toBe(true);
  });

  it("shows auth-middleware-required only for files in routes/ or api/", () => {
    const files = [
      addFile("src/middleware/auth.ts", ['app.get("/check", check)']),
    ];
    const findings = runRules(files);
    // Path does not contain routes/ or api/ => no auth-middleware-required finding
    expect(findings.filter((f) => f.rule === "auth-middleware-required")).toHaveLength(0);
  });

  it("records the correct line number for each finding", () => {
    const file: DiffFile = {
      path: "src/routes/data.ts",
      status: "added",
      additions: 2,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 42,
          newLines: 2,
          content: "",
          changes: [
            { type: "add", line: 42, oldLine: 0, content: 'app.get("/data", handler)' },
            { type: "add", line: 43, oldLine: 0, content: 'const secret = "a-long-secret-value-here"' },
          ],
        },
      ],
    };
    const findings = runRules([file]);
    expect(findings).toHaveLength(2);
    const authFinding = findings.find((f) => f.rule === "auth-middleware-required")!;
    expect(authFinding.line).toBe(42);
    const secretFinding = findings.find((f) => f.rule === "no-hardcoded-secrets")!;
    expect(secretFinding.line).toBe(43);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: duplicate-approval-guard
// ---------------------------------------------------------------------------

describe("duplicate-approval-guard", () => {
  it("returns null when only auth files are changed", () => {
    const files = [addFile("src/auth/login.ts", ["export function login() {}"])];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).toBeNull();
  });

  it("returns null when only non-auth files are changed", () => {
    const files = [addFile("src/utils/helpers.ts", ["export function trim(s: string) { return s.trim(); }"])];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).toBeNull();
  });

  it("flags when auth and non-auth files are both changed", () => {
    const files = [
      addFile("src/auth/login.ts", ["export function login() {}"]),
      addFile("src/utils/format.ts", ["export function format() {}"]),
    ];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).not.toBeNull();
    expect(result!.rule).toBe("duplicate-approval-guard");
    expect(result!.severity).toBe("high");
    expect(result!.category).toBe("security");
    expect(result!.file).toBe("src/auth/login.ts");
  });

  it("detects rbac/ path as approval file", () => {
    const files = [
      addFile("src/rbac/roles.ts", ["export const ADMIN = 'admin';"]),
      addFile("src/components/Button.tsx", ["export function Button() {}"]),
    ];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).not.toBeNull();
    expect(result!.rule).toBe("duplicate-approval-guard");
  });

  it("detects middleware/auth* path as approval file", () => {
    const files = [
      addFile("src/middleware/authMiddleware.ts", ["export function auth() {}"]),
      addFile("src/pages/Home.tsx", ["export function Home() {}"]),
    ];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).not.toBeNull();
    expect(result!.rule).toBe("duplicate-approval-guard");
  });

  it("detects guard/ path as approval file", () => {
    const files = [
      addFile("src/guard/canActivate.ts", ["export function canActivate() {}"]),
      addFile("src/styles/main.css", ["body { margin: 0; }"]),
    ];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).not.toBeNull();
    expect(result!.rule).toBe("duplicate-approval-guard");
  });

  it("detects permission* path as approval file", () => {
    const files = [
      addFile("src/permissions.ts", ["export const READ = 'read';"]),
      addFile("src/lib/db.ts", ["export function query() {}"]),
    ];
    const result = checkDuplicateApprovalGuard(files);
    expect(result).not.toBeNull();
    expect(result!.rule).toBe("duplicate-approval-guard");
  });

  it("returns null for empty file list", () => {
    expect(checkDuplicateApprovalGuard([])).toBeNull();
  });

  it("is integrated into runRules — mixed PR produces the finding", () => {
    const files = [
      addFile("src/auth/verify.ts", ["export function verify() {}"]),
      addFile("src/ui/Header.tsx", ["export function Header() {}"]),
    ];
    const findings = runRules(files);
    const guard = findings.find((f) => f.rule === "duplicate-approval-guard");
    expect(guard).toBeDefined();
    expect(guard!.message).toContain("authorization bypass");
  });
});

// ---------------------------------------------------------------------------
// Rule 5: no-eval
// ---------------------------------------------------------------------------

describe("no-eval", () => {
  it("flags eval() call", () => {
    const files = [addFile("src/exec.ts", ["eval(userInput)"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "no-eval")).toBe(true);
  });

  it("flags Function() constructor", () => {
    const files = [addFile("src/exec.ts", ["new Function('return ' + code)()"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "no-eval")).toBe(true);
  });

  it("does NOT flag eval in comments", () => {
    expect(hasEvalUsage("// eval is dangerous")).toBe(false);
  });

  it("does NOT flag without parentheses", () => {
    expect(hasEvalUsage("const evaluate = true")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: no-unsafe-innerhtml
// ---------------------------------------------------------------------------

describe("no-unsafe-innerhtml", () => {
  it("flags innerHTML assignment", () => {
    const files = [addFile("src/view.ts", ["el.innerHTML = userInput"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "no-unsafe-innerhtml")).toBe(true);
  });

  it("does NOT flag innerHTML with DOMPurify", () => {
    expect(hasUnsafeInnerHTML("el.innerHTML = DOMPurify.sanitize(html)")).toBe(false);
  });

  it("does NOT flag textContent", () => {
    expect(hasUnsafeInnerHTML("el.textContent = text")).toBe(false);
  });

  it("detects hasUnsafeInnerHTML correctly", () => {
    expect(hasUnsafeInnerHTML("element.innerHTML = data")).toBe(true);
    expect(hasUnsafeInnerHTML("div.innerHTML = '<b>safe</b>'")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 7: no-debugger
// ---------------------------------------------------------------------------

describe("no-debugger", () => {
  it("flags standalone debugger statement", () => {
    const files = [addFile("src/debug.ts", ["debugger;"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "no-debugger")).toBe(true);
  });

  it("does NOT flag debugger in a string", () => {
    expect(hasDebugger('const x = "debugger"')).toBe(false);
  });

  it("does NOT flag debugger keyword in other contexts", () => {
    expect(hasDebugger("const debuggerMode = true")).toBe(false);
  });

  it("detects hasDebugger correctly", () => {
    expect(hasDebugger("debugger;")).toBe(true);
    expect(hasDebugger("  debugger  ")).toBe(true);
    expect(hasDebugger("debugger")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 8: no-weak-crypto
// ---------------------------------------------------------------------------

describe("no-weak-crypto", () => {
  it("flags md5 usage", () => {
    const files = [addFile("src/hash.ts", ["const h = md5(data)"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "no-weak-crypto")).toBe(true);
  });

  it("flags sha1 usage", () => {
    expect(hasWeakCrypto("const h = sha1(input)")).toBe(true);
  });

  it("flags createHash('md5')", () => {
    expect(hasWeakCrypto("crypto.createHash('md5')")).toBe(true);
  });

  it("flags createHash('sha1')", () => {
    expect(hasWeakCrypto("crypto.createHash('sha1')")).toBe(true);
  });

  it("does NOT flag sha256", () => {
    expect(hasWeakCrypto("crypto.createHash('sha256')")).toBe(false);
  });

  it("does NOT flag aes-256", () => {
    expect(hasWeakCrypto("crypto.createCipher('aes-256-cbc', key)")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 9: no-timing-unsafe-compare
// ---------------------------------------------------------------------------

describe("no-timing-unsafe-compare", () => {
  it("flags password === comparison", () => {
    const files = [addFile("src/auth.ts", ["if (password === input) login()"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "no-timing-unsafe-compare")).toBe(true);
  });

  it("flags token == comparison", () => {
    expect(hasTimingUnsafeCompare("if (token == req.headers.auth)")).toBe(true);
  });

  it("flags secret !== comparison", () => {
    expect(hasTimingUnsafeCompare("if (secret !== stored)")).toBe(true);
  });

  it("does NOT flag timingSafeEqual", () => {
    expect(hasTimingUnsafeCompare("if (crypto.timingSafeEqual(password, input))")).toBe(false);
  });

  it("does NOT flag hmac.verify", () => {
    expect(hasTimingUnsafeCompare("if (hmac.verify(signature, token))")).toBe(false);
  });

  it("does NOT flag regular variable comparison", () => {
    expect(hasTimingUnsafeCompare("if (count === 0)")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 10: no-unsafe-regex
// ---------------------------------------------------------------------------

describe("no-unsafe-regex", () => {
  it("detects nested quantifier regex", () => {
    expect(hasUnsafeRegex("const re = new RegExp('(a+)+')")).toBe(true);
  });

  it("does NOT flag simple regex", () => {
    expect(hasUnsafeRegex("const re = /hello/")).toBe(false);
  });

  it("does NOT flag non-regex nested parens", () => {
    expect(hasUnsafeRegex("const x = (1+2)*3")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 11: track-todo
// ---------------------------------------------------------------------------

describe("track-todo", () => {
  it("flags TODO comment", () => {
    const files = [addFile("src/work.ts", ["// TODO: implement error handling"])];
    const findings = runRules(files);
    expect(findings.some((f) => f.rule === "track-todo")).toBe(true);
  });

  it("flags FIXME comment", () => {
    expect(hasTodoFixme("// FIXME: this is broken")).toBe(true);
  });

  it("flags HACK comment", () => {
    expect(hasTodoFixme("// HACK: workaround for bug 123")).toBe(true);
  });

  it("flags XXX comment", () => {
    expect(hasTodoFixme("// XXX: dangerous code")).toBe(true);
  });

  it("does NOT flag regular comments", () => {
    expect(hasTodoFixme("// This is a normal comment")).toBe(false);
  });

  it("does NOT flag todo in a string", () => {
    expect(hasTodoFixme('message = "todo list item"')).toBe(false);
  });

  it("has low severity", () => {
    const files = [addFile("src/app.ts", ["// TODO: refactor later"])];
    const findings = runRules(files).filter((f) => f.rule === "track-todo");
    expect(findings[0].severity).toBe("low");
    expect(findings[0].category).toBe("compliance");
  });
});
