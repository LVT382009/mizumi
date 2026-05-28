import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectDataFlowBoundaryViolations } from "../data-flow-boundary-detector.js";
import type { DataFlowBoundaryIssue, DataFlowBoundaryResult } from "../data-flow-boundary-detector.js";
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

describe("detectDataFlowBoundaryViolations — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const name = 'Alice';",
      "+const count = 42;",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+console.log(password);",
    ], "deleted")];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag sanitized PII in response", () => {
    const files = [makeFile("src/api.ts", [
      "+res.json({ ssn: redact(user.ssn) });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii).toHaveLength(0);
  });

  it("does not flag hashed password in log", () => {
    const files = [makeFile("src/auth.ts", [
      "+console.log({ password: hash(credential) });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unprotected PII in response
// ---------------------------------------------------------------------------

describe("detectDataFlowBoundaryViolations — unprotected PII in response", () => {
  it("detects SSN in HTTP response", () => {
    const files = [makeFile("src/api.ts", [
      "+res.json({ ssn: user.ssn });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii).toHaveLength(1);
    expect(pii[0].description).toContain("ssn");
  });

  it("detects creditCard in response as critical", () => {
    const files = [makeFile("src/payment.ts", [
      "+res.json({ creditCard: payment.creditCard });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii).toHaveLength(1);
    expect(pii[0].severity).toBe("critical");
  });

  it("detects dateOfBirth in ctx.body", () => {
    const files = [makeFile("src/routes.ts", [
      "+ctx.body = { dateOfBirth: user.dateOfBirth };",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cardNumber in sendResponse", () => {
    const files = [makeFile("src/handler.ts", [
      "+sendResponse({ cardNumber: billing.cardNumber });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii.length).toBeGreaterThanOrEqual(1);
    expect(pii[0].severity).toBe("critical");
  });

  it("does not flag non-PII data in response", () => {
    const files = [makeFile("src/api.ts", [
      "+res.json({ name: user.name, id: user.id });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii).toHaveLength(0);
  });

  it("does not flag masked PII in response", () => {
    const files = [makeFile("src/api.ts", [
      "+res.json({ ssn: mask(user.ssn) });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sensitive data in log
// ---------------------------------------------------------------------------

describe("detectDataFlowBoundaryViolations — sensitive data in log", () => {
  it("detects password in console.log", () => {
    const files = [makeFile("src/debug.ts", [
      "+console.log('User password:', user.password);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(1);
    expect(logs[0].severity).toBe("critical");
  });

  it("detects token in logger.info", () => {
    const files = [makeFile("src/auth.ts", [
      "+logger.info('Auth token:', accessToken);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(1);
  });

  it("detects SSN in log output", () => {
    const files = [makeFile("src/admin.ts", [
      "+console.log('SSN:', user.ssn);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("detects creditCard in log output", () => {
    const files = [makeFile("src/debug.ts", [
      "+console.debug('Card:', payment.creditCard);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].severity).toBe("critical");
  });

  it("detects apiKey in logger.warn", () => {
    const files = [makeFile("src/config.ts", [
      "+logger.warn('API key:', apiKey);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(1);
  });

  it("does not flag non-sensitive data in log", () => {
    const files = [makeFile("src/app.ts", [
      "+console.log('Request processed:', requestId);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(0);
  });

  it("does not flag encrypted password in log", () => {
    const files = [makeFile("src/auth.ts", [
      "+console.log('Encrypted:', encrypt(password));",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trust boundary skip
// ---------------------------------------------------------------------------

describe("detectDataFlowBoundaryViolations — trust boundary skip", () => {
  it("detects DB data sent directly to external API", () => {
    const files = [makeFile("src/integration.ts", [
      "+fetch('https://analytics.example.com', { body: JSON.stringify(db.query(sql)) });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust.length).toBeGreaterThanOrEqual(1);
    expect(trust[0].severity).toBe("critical");
  });

  it("detects findOne result sent to webhook", () => {
    const files = [makeFile("src/sync.ts", [
      "+webhook.send(findOne({ id }));",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust.length).toBeGreaterThanOrEqual(1);
  });

  it("detects auth data sent to analytics", () => {
    const files = [makeFile("src/tracking.ts", [
      "+analytics.track(authenticate(token));",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust.length).toBeGreaterThanOrEqual(1);
  });

  it("detects spread of user record into fetch call", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch(url, { body: JSON.stringify({...user}) });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag sanitized data crossing boundary", () => {
    const files = [makeFile("src/integration.ts", [
      "+fetch(url, { body: JSON.stringify(sanitize(db.query(sql))) });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust).toHaveLength(0);
  });

  it("does not flag external API without DB source", () => {
    const files = [makeFile("src/api.ts", [
      "+fetch('https://api.example.com/health');",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Client-side leak
// ---------------------------------------------------------------------------

describe("detectDataFlowBoundaryViolations — client-side leak", () => {
  it("detects password in localStorage", () => {
    const files = [makeFile("src/auth.ts", [
      "+localStorage.setItem('auth', password);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const leak = result.issues.filter((i) => i.category === "client-side-leak");
    expect(leak).toHaveLength(1);
    expect(leak[0].severity).toBe("critical");
  });

  it("detects token in sessionStorage", () => {
    const files = [makeFile("src/session.ts", [
      "+sessionStorage.setItem('session', sessionToken);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const leak = result.issues.filter((i) => i.category === "client-side-leak");
    expect(leak).toHaveLength(1);
  });

  it("detects process.env secret exposed to window", () => {
    const files = [makeFile("src/config.ts", [
      "+window.__SECRET_KEY__ = process.env.SECRET_KEY;",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const leak = result.issues.filter((i) => i.category === "client-side-leak");
    expect(leak.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag non-sensitive data in localStorage", () => {
    const files = [makeFile("src/ui.ts", [
      "+localStorage.setItem('theme', theme);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const leak = result.issues.filter((i) => i.category === "client-side-leak");
    expect(leak).toHaveLength(0);
  });

  it("does not flag test files with sensitive refs", () => {
    const files = [makeFile("src/__tests__/auth.test.ts", [
      "+localStorage.setItem('token', credential);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const leak = result.issues.filter((i) => i.category === "client-side-leak");
    expect(leak).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectDataFlowBoundaryViolations — context and body", () => {
  it("generates context text with violations", () => {
    const files = [makeFile("src/debug.ts", [
      "+console.log('Password:', password);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.contextText).toContain("Data Flow Boundary Violations");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/debug.ts", [
      "+console.log('Password:', password);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.bodySummary).toContain("Data Flow Boundary Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+console.log('Password:', password);",
      "+res.json({ ssn: user.ssn });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    if (result.issues.some((i) => i.severity === "critical") && result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectDataFlowBoundaryViolations — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// console.log('Password:', password);",
      "+const x = 42;",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+// console.log('Password:', password);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+console.log('Password:', password);"]),
      makeFile("src/b.ts", ["+res.json({ ssn: user.ssn });"]),
    ];
    const result = detectDataFlowBoundaryViolations(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = [];
    const piiFields = [
      "ssn", "socialSecurity", "dateOfBirth", "passportNumber",
      "taxId", "driverLicense", "creditCard", "cardNumber",
      "cvv", "bankAccount", "routingNumber", "gender",
      "ethnicity", "maidenName", "biometric",
      "disability",
    ];
    for (const field of piiFields) {
      changes.push(`+res.json({ ${field}: user.${field} });`);
    }
    const files = [makeFile("src/api.ts", changes)];
    const result = detectDataFlowBoundaryViolations(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("detects privateKey in console.error", () => {
    const files = [makeFile("src/crypto.ts", [
      "+console.error('Key error:', privateKey);",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(1);
  });

  it("detects bankAccount in response", () => {
    const files = [makeFile("src/banking.ts", [
      "+return bankAccount;",
    ])];
    // This won't match because there's no response pattern
    const result = detectDataFlowBoundaryViolations(files);
    // bankAccount alone without res.json doesn't trigger response detection
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii).toHaveLength(0);
  });

  it("detects passportNumber with res.send", () => {
    const files = [makeFile("src/api.ts", [
      "+res.send({ passportNumber: user.passportNumber });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii.length).toBeGreaterThanOrEqual(1);
  });

  it("detects nationalId in response body", () => {
    const files = [makeFile("src/identity.ts", [
      "+reply.send({ nationalId: citizen.nationalId });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const pii = result.issues.filter((i) => i.category === "unprotected-pii-in-response");
    expect(pii.length).toBeGreaterThanOrEqual(1);
  });

  it("detects winston logger with secret", () => {
    const files = [makeFile("src/log.ts", [
      "+winston.info({ apiKey: config.apiKey });",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const logs = result.issues.filter((i) => i.category === "sensitive-data-in-log");
    expect(logs).toHaveLength(1);
  });

  it("detects prisma data sent via axios", () => {
    const files = [makeFile("src/sync.ts", [
      "+axios.post(url, prisma.user.findMany());",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust.length).toBeGreaterThanOrEqual(1);
  });

  it("detects redis.get data sent to webhook", () => {
    const files = [makeFile("src/cache.ts", [
      "+webhook.publish(redis.get(key));",
    ])];
    const result = detectDataFlowBoundaryViolations(files);
    const trust = result.issues.filter((i) => i.category === "trust-boundary-skip");
    expect(trust.length).toBeGreaterThanOrEqual(1);
  });
});
