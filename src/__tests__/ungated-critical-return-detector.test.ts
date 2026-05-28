import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectUngatedCriticalReturns } from "../ungated-critical-return-detector.js";
import type { UngatedCriticalReturnIssue, UngatedCriticalReturnResult } from "../ungated-critical-return-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (
  filePath: string,
  changes: string[],
  status: DiffFile["status"] = "modified",
): DiffFile => ({
  path: filePath,
  status,
  additions: changes.filter((c) => c.startsWith("+")).length,
  deletions: changes.filter((c) => c.startsWith("-")).length,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      changes: changes.map((content, i) => ({
        type: content.startsWith("+")
          ? ("add" as const)
          : content.startsWith("-")
            ? ("delete" as const)
            : ("normal" as const),
        content,
        line: i + 1,
      })),
    },
  ],
});

// ---------------------------------------------------------------------------
// No issues
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = 'Alice';",
      "+const count = 42;",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+validateInput(data);",
    ], "deleted")];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag guarded validation", () => {
    const files = [makeFile("src/validate.ts", [
      "+const isValid = validateInput(data);",
      "+if (!isValid) throw new Error('Invalid');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag console.log bare calls", () => {
    const files = [makeFile("src/app.ts", [
      "+console.log('done');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag awaited calls", () => {
    const files = [makeFile("src/api.ts", [
      "+await saveRecord(data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag logger calls", () => {
    const files = [makeFile("src/app.ts", [
      "+logError(err);",
      "+trackEvent('click');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag import/export lines", () => {
    const files = [makeFile("src/app.ts", [
      "+import { validateInput } from './validators';",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Discarded validation returns
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — discarded validation", () => {
  it("detects validateInput called as bare statement", () => {
    const files = [makeFile("src/app.ts", [
      "+validateInput(data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
    expect(disc[0].severity).toBe("critical");
  });

  it("detects checkPermission called as bare statement", () => {
    const files = [makeFile("src/auth.ts", [
      "+checkPermission(user, 'admin');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects verifyToken called as bare statement", () => {
    const files = [makeFile("src/auth.ts", [
      "+verifyToken(token);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects assertValid called as bare statement", () => {
    const files = [makeFile("src/check.ts", [
      "+assertValid(schema, data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects ensureInitialized called as bare statement", () => {
    const files = [makeFile("src/init.ts", [
      "+ensureInitialized();",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects confirmDelivery called as bare statement", () => {
    const files = [makeFile("src/ship.ts", [
      "+confirmDelivery(orderId);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects sanitizeInput called as bare statement", () => {
    const files = [makeFile("src/input.ts", [
      "+sanitizeInput(userInput);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects requireAuth called as bare statement", () => {
    const files = [makeFile("src/middleware.ts", [
      "+requireAuth(request);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Discarded auth returns
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — discarded auth", () => {
  it("detects isAuthenticated called as bare statement", () => {
    const files = [makeFile("src/auth.ts", [
      "+isAuthenticated(req);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
    expect(disc[0].severity).toBe("critical");
  });

  it("detects canAccess called as bare statement", () => {
    const files = [makeFile("src/gate.ts", [
      "+canAccess(user, resource);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects hasPermission called as bare statement", () => {
    const files = [makeFile("src/perms.ts", [
      "+hasPermission(user, 'write');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects hasRole called as bare statement", () => {
    const files = [makeFile("src/roles.ts", [
      "+hasRole(user, 'admin');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects isAllowed called as bare statement", () => {
    const files = [makeFile("src/gate.ts", [
      "+isAllowed(action);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects isPermitted called as bare statement", () => {
    const files = [makeFile("src/perm.ts", [
      "+isPermitted(user, resource);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects authorize called as bare statement", () => {
    const files = [makeFile("src/auth.ts", [
      "+authorize(request);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects authenticate called as bare statement", () => {
    const files = [makeFile("src/auth.ts", [
      "+authenticate(credentials);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects checkAuth called as bare statement", () => {
    const files = [makeFile("src/mw.ts", [
      "+checkAuth(session);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });

  it("detects verifyAuth called as bare statement", () => {
    const files = [makeFile("src/mw.ts", [
      "+verifyAuth(token);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-auth-return");
    expect(disc).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unguarded write path
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — unguarded write path", () => {
  it("detects saveRecord called as bare statement", () => {
    const files = [makeFile("src/db.ts", [
      "+saveRecord(data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
    expect(wp[0].severity).toBe("warning");
  });

  it("detects insertRow called as bare statement", () => {
    const files = [makeFile("src/db.ts", [
      "+insertRow(table, row);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects updateRecord called as bare statement", () => {
    const files = [makeFile("src/db.ts", [
      "+updateRecord(id, data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects deleteRecord called as bare statement", () => {
    const files = [makeFile("src/db.ts", [
      "+deleteRecord(id);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects writeFile called as bare statement", () => {
    const files = [makeFile("src/io.ts", [
      "+writeFile(path, content);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects sendEmail called as bare statement", () => {
    const files = [makeFile("src/notify.ts", [
      "+sendEmail(to, subject, body);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects createOrder called as bare statement", () => {
    const files = [makeFile("src/orders.ts", [
      "+createOrder(items);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects publishEvent called as bare statement", () => {
    const files = [makeFile("src/events.ts", [
      "+publishEvent('user.created', payload);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Assigned but ungated
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — assigned but ungated", () => {
  it("detects validation result assigned but never guarded", () => {
    const files = [makeFile("src/app.ts", [
      "+const isValid = validateInput(data);",
      "+processData(data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const ungated = result.issues.filter((i) => i.category === "assigned-but-ungated");
    expect(ungated).toHaveLength(1);
    expect(ungated[0].severity).toBe("warning");
  });

  it("detects auth result assigned but never guarded", () => {
    const files = [makeFile("src/auth.ts", [
      "+const allowed = isAuthenticated(req);",
      "+handleRequest(req);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const ungated = result.issues.filter((i) => i.category === "assigned-but-ungated");
    expect(ungated).toHaveLength(1);
  });

  it("detects permission result assigned but never guarded", () => {
    const files = [makeFile("src/perms.ts", [
      "+const hasAccess = hasPermission(user, 'read');",
      "+sendData(user);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const ungated = result.issues.filter((i) => i.category === "assigned-but-ungated");
    expect(ungated).toHaveLength(1);
  });

  it("detects verify result assigned but never guarded", () => {
    const files = [makeFile("src/auth.ts", [
      "+const verified = verifySignature(payload, sig);",
      "+acceptPayload(payload);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const ungated = result.issues.filter((i) => i.category === "assigned-but-ungated");
    expect(ungated).toHaveLength(1);
  });

  it("does not flag when guard follows assignment", () => {
    const files = [makeFile("src/app.ts", [
      "+const isValid = validateInput(data);",
      "+if (!isValid) throw new Error('Invalid');",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag when return follows assignment", () => {
    const files = [makeFile("src/app.ts", [
      "+const isValid = validateInput(data);",
      "+if (isValid) return data;",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag when assigned auth result is guarded", () => {
    const files = [makeFile("src/auth.ts", [
      "+const ok = isAuthenticated(req);",
      "+if (!ok) return unauthorized();",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — context and body", () => {
  it("generates context text with issues", () => {
    const files = [makeFile("src/auth.ts", [
      "+isAuthenticated(req);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.contextText).toContain("Ungated Critical Returns");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/auth.ts", [
      "+isAuthenticated(req);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.bodySummary).toContain("Ungated Critical Return Detection");
    expect(result.bodySummary).toContain("<details>");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectUngatedCriticalReturns — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-validateInput(data);",
      "+const x = 42;",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+validateInput(data);"]),
      makeFile("src/b.ts", ["+isAuthenticated(req);"]),
    ];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag normal calculateFunction calls", () => {
    const files = [makeFile("src/app.ts", [
      "+calculateTotal(items);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag emit.on calls", () => {
    const files = [makeFile("src/app.ts", [
      "+emitter.on('event', handler);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("does not flag removeEventListener calls", () => {
    const files = [makeFile("src/app.ts", [
      "+removeEventListener('click', handler);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects checkOwnership called as bare statement", () => {
    const files = [makeFile("src/owner.ts", [
      "+checkOwnership(user, resource);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects hasAccess assigned but ungated", () => {
    const files = [makeFile("src/auth.ts", [
      "+const permitted = hasAccess(user, doc);",
      "+return doc;",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const ungated = result.issues.filter((i) => i.category === "assigned-but-ungated");
    expect(ungated).toHaveLength(1);
  });

  it("detects testConnection called as bare statement", () => {
    const files = [makeFile("src/db.ts", [
      "+testConnection(db);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects normalizeInput called as bare statement", () => {
    const files = [makeFile("src/input.ts", [
      "+normalizeInput(raw);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return");
    expect(disc).toHaveLength(1);
  });

  it("detects persistState called as bare statement", () => {
    const files = [makeFile("src/state.ts", [
      "+persistState(state);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects commitChanges called as bare statement", () => {
    const files = [makeFile("src/git.ts", [
      "+commitChanges(files);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("does not flag if guard references variable", () => {
    const files = [makeFile("src/val.ts", [
      "+const ok = validateInput(data);",
      "+if (!ok) { return; }",
    ])];
    const result = detectUngatedCriticalReturns(files);
    expect(result.issues).toHaveLength(0);
  });

  it("sorts critical before warning", () => {
    const files = [makeFile("src/mix.ts", [
      "+validateInput(data);",
      "+saveRecord(data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const severities = result.issues.map((i) => i.severity);
    const criticalIdx = severities.indexOf("critical");
    const warningIdx = severities.indexOf("warning");
    if (criticalIdx !== -1 && warningIdx !== -1) {
      expect(criticalIdx).toBeLessThan(warningIdx);
    }
  });

  it("deduplicates same category:file:line", () => {
    const files = [makeFile("src/app.ts", [
      "+validateInput(data);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const disc = result.issues.filter((i) => i.category === "discarded-validation-return" && i.line === 1);
    expect(disc).toHaveLength(1);
  });

  it("detects uploadFile called as bare statement", () => {
    const files = [makeFile("src/upload.ts", [
      "+uploadFile(buffer, name);",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });

  it("detects dispatchAction called as bare statement", () => {
    const files = [makeFile("src/redux.ts", [
      "+dispatchAction({ type: 'SUBMIT' });",
    ])];
    const result = detectUngatedCriticalReturns(files);
    const wp = result.issues.filter((i) => i.category === "unguarded-write-path");
    expect(wp).toHaveLength(1);
  });
});
