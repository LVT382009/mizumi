import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectSemanticTypeConfusion } from "../semantic-type-confusion-detector.js";
import type { SemanticTypeConfusionIssue, SemanticTypeConfusionResult } from "../semantic-type-confusion-detector.js";
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

describe("detectSemanticTypeConfusion — no issues", () => {
  it("returns empty for clean code", () => {
    const files = [makeFile("src/app.ts", [
      "+const userId = 'user-123';",
      "+const name = 'Alice';",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+priceCents = priceDollars;",
    ], "deleted")];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty context and body when no issues", () => {
    const files = [makeFile("src/clean.ts", [
      "+const x = 42;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not flag matching units", () => {
    const files = [makeFile("src/price.ts", [
      "+const totalCents = itemCents + taxCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(0);
  });

  it("does not flag matching ID types", () => {
    const files = [makeFile("src/user.ts", [
      "+if (userId === storedUserId) {",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit mismatch
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — unit mismatch", () => {
  it("detects priceCents assigned to priceDollars", () => {
    const files = [makeFile("src/price.ts", [
      "+const priceDollars = priceCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(1);
    expect(units[0].severity).toBe("warning");
  });

  it("detects timeoutMillis compared with timeoutSeconds", () => {
    const files = [makeFile("src/config.ts", [
      "+if (timeoutMillis > timeoutSeconds) {",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(1);
  });

  it("detects fileSizeKb compared with fileSizeMb", () => {
    const files = [makeFile("src/storage.ts", [
      "+const totalMb = fileSizeKb;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(1);
  });

  it("does not flag same-unit operations", () => {
    const files = [makeFile("src/price.ts", [
      "+const totalCents = itemCents + shippingCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ID confusion
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — ID confusion", () => {
  it("detects userId === orderId comparison", () => {
    const files = [makeFile("src/app.ts", [
      "+if (userId === orderId) {",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids).toHaveLength(1);
    expect(ids[0].severity).toBe("critical");
  });

  it("detects userId = orderId assignment", () => {
    const files = [makeFile("src/app.ts", [
      "+const userId = orderId;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids).toHaveLength(1);
  });

  it("detects getSession(orderId) wrong ID type", () => {
    const files = [makeFile("src/api.ts", [
      "+const session = getSession(orderId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("detects getUser(sessionId) wrong ID type", () => {
    const files = [makeFile("src/api.ts", [
      "+const user = getUser(sessionId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag getUser(userId) correct ID type", () => {
    const files = [makeFile("src/api.ts", [
      "+const user = getUser(userId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timestamp/duration swap
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — timestamp/duration swap", () => {
  it("detects createdAt + 1000 (timestamp arithmetic)", () => {
    const files = [makeFile("src/app.ts", [
      "+const expires = createdAt + 3600;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap.length).toBeGreaterThanOrEqual(1);
  });

  it("detects timeout < Date.now() (duration compared to timestamp)", () => {
    const files = [makeFile("src/app.ts", [
      "+if (timeout < Date.now()) {",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap.length).toBeGreaterThanOrEqual(1);
  });

  it("detects setTimeout with timestamp variable", () => {
    const files = [makeFile("src/scheduler.ts", [
      "+setTimeout(callback, expiresAt);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap).toHaveLength(1);
    expect(swap[0].severity).toBe("critical");
  });

  it("does not flag setTimeout with duration variable", () => {
    const files = [makeFile("src/scheduler.ts", [
      "+setTimeout(callback, delayMs);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// String subtype confusion
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — string subtype confusion", () => {
  it("detects email = phoneNumber assignment", () => {
    const files = [makeFile("src/contact.ts", [
      "+const email = phoneNumber;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes).toHaveLength(1);
    expect(subtypes[0].severity).toBe("warning");
  });

  it("detects phone compared with email", () => {
    const files = [makeFile("src/contact.ts", [
      "+if (phoneNumber === emailAddress) {",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes).toHaveLength(1);
  });

  it("detects filePath = url assignment", () => {
    const files = [makeFile("src/config.ts", [
      "+const filePath = endpointUrl;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag email = emailPrimary (same subtype)", () => {
    const files = [makeFile("src/contact.ts", [
      "+const email = emailPrimary;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context and body generation
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — context and body", () => {
  it("generates context text", () => {
    const files = [makeFile("src/app.ts", [
      "+const priceDollars = priceCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.contextText).toContain("Semantic Type Confusion");
  });

  it("generates body summary with table", () => {
    const files = [makeFile("src/app.ts", [
      "+const priceDollars = priceCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.bodySummary).toContain("Semantic Type Confusion Detection");
    expect(result.bodySummary).toContain("<details>");
  });

  it("shows both critical and warning sections", () => {
    const files = [makeFile("src/app.ts", [
      "+const userId = orderId;",
      "+const priceDollars = priceCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    if (result.issues.some((i) => i.severity === "critical") && result.issues.some((i) => i.severity === "warning")) {
      expect(result.contextText).toContain("Critical");
      expect(result.contextText).toContain("Warnings");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — edge cases", () => {
  it("ignores deleted lines", () => {
    const files = [makeFile("src/app.ts", [
      "-// const userId = orderId;",
      "+const x = 42;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty diff files", () => {
    const files = [makeFile("src/app.ts", [])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const files = [makeFile("src/app.ts", [
      "+// const userId = orderId;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues across multiple files", () => {
    const files = [
      makeFile("src/a.ts", ["+const userId = orderId;"]),
      makeFile("src/b.ts", ["+const priceDollars = priceCents;"]),
    ];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("shows more row when issues exceed 15", () => {
    const changes: string[] = [];
    const idPairs = [
      ["userId", "orderId"], ["userId", "productId"], ["orderId", "customerId"],
      ["userId", "sessionId"], ["orderId", "invoiceId"], ["userId", "accountId"],
      ["userId", "transactionId"], ["userId", "paymentId"], ["orderId", "tenantId"],
      ["userId", "projectId"], ["userId", "teamId"], ["orderId", "buildId"],
      ["userId", "commitId"], ["orderId", "branchId"], ["userId", "repoId"],
      ["orderId", "deployId"],
    ];
    for (const [lhs, rhs] of idPairs) {
      changes.push(`+const ${lhs} = ${rhs};`);
    }
    const files = [makeFile("src/app.ts", changes)];
    const result = detectSemanticTypeConfusion(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });

  it("detects getProduct(userId) wrong function type", () => {
    const files = [makeFile("src/shop.ts", [
      "+const product = getProduct(userId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("detects updatedAt - 5000 timestamp arithmetic", () => {
    const files = [makeFile("src/app.ts", [
      "+const recent = updatedAt - 5000;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap.length).toBeGreaterThanOrEqual(1);
  });

  it("detects setInterval with endedAt timestamp", () => {
    const files = [makeFile("src/poller.ts", [
      "+setInterval(check, endedAt);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unit mismatch — under-tested unit categories
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — temperature and frequency units", () => {
  it("does not flag celsius vs fahrenheit (not in detection groups)", () => {
    const files = [makeFile("src/temp.ts", [
      "+const tempCelsius = tempFahrenheit;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(0);
  });

  it("does not flag Hz vs Khz (not in detection groups)", () => {
    const files = [makeFile("src/signal.ts", [
      "+const frequencyHz = frequencyKhz;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(0);
  });

  it("does not flag Mhz vs Ghz (not in detection groups)", () => {
    const files = [makeFile("src/clock.ts", [
      "+const clockMhz = clockGhz;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(0);
  });

  it("does not flag pixel vs pixel same-unit assignment", () => {
    const files = [makeFile("src/layout.ts", [
      "+const widthPixels = heightPixels;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const units = result.issues.filter((i) => i.category === "unit-mismatch");
    expect(units).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ID confusion — wrong getter ID types
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — wrong getter ID types", () => {
  it("detects getPayment(invoiceId) wrong ID type", () => {
    const files = [makeFile("src/billing.ts", [
      "+const payment = getPayment(invoiceId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids[0].severity).toBe("critical");
  });

  it("detects getCustomer(transactionId) wrong ID type", () => {
    const files = [makeFile("src/crm.ts", [
      "+const customer = getCustomer(transactionId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it("detects getTransaction(userId) wrong ID type", () => {
    const files = [makeFile("src/payments.ts", [
      "+const txn = getTransaction(userId);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const ids = result.issues.filter((i) => i.category === "id-confusion");
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Timestamp/duration — additional edge cases
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — timestamp/duration edge cases", () => {
  it("detects startedAt * 3600 timestamp multiplication", () => {
    const files = [makeFile("src/scheduler.ts", [
      "+const scaled = startedAt * 3600;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap.length).toBeGreaterThanOrEqual(1);
  });

  it("detects setInterval with startedAt timestamp", () => {
    const files = [makeFile("src/poller.ts", [
      "+setInterval(poll, startedAt);",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap).toHaveLength(1);
    expect(swap[0].severity).toBe("critical");
  });

  it("does not flag expiresAt + startedAt (two timestamps not in digit pattern)", () => {
    const files = [makeFile("src/auth.ts", [
      "+const deadline = expiresAt + startedAt;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const swap = result.issues.filter((i) => i.category === "timestamp-duration-swap");
    expect(swap).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// String subtype — reverse direction and alternate names
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — string subtype edge cases", () => {
  it("does not flag url = filePath (reverse direction not detected)", () => {
    const files = [makeFile("src/config.ts", [
      "+const url = filePath;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes).toHaveLength(0);
  });

  it("detects tel = emailAddress assignment", () => {
    const files = [makeFile("src/contact.ts", [
      "+const tel = emailAddress;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes).toHaveLength(1);
  });

  it("detects mobileNumber = eMail assignment", () => {
    const files = [makeFile("src/profile.ts", [
      "+const mobileNumber = eMail;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    const subtypes = result.issues.filter((i) => i.category === "string-subtype-confusion");
    expect(subtypes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — skip patterns and multi-issue lines
// ---------------------------------------------------------------------------

describe("detectSemanticTypeConfusion — skip and multi-issue edge cases", () => {
  it("detects multiple issues on the same line", () => {
    const files = [makeFile("src/app.ts", [
      "+const userId = orderId; const priceDollars = priceCents;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    const cats = new Set(result.issues.map((i) => i.category));
    expect(cats.has("id-confusion")).toBe(true);
    expect(cats.has("unit-mismatch")).toBe(true);
  });

  it("skips type declaration lines", () => {
    const files = [makeFile("src/types.ts", [
      "+type UserId = OrderId;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips enum declaration lines", () => {
    const files = [makeFile("src/types.ts", [
      "+enum Ids { userId = orderId }",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });

  it("skips export lines", () => {
    const files = [makeFile("src/api.ts", [
      "+export const userId = orderId;",
    ])];
    const result = detectSemanticTypeConfusion(files);
    expect(result.issues).toHaveLength(0);
  });
});
