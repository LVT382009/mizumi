import { describe, it, expect } from "vitest";
import { classifyCohort, buildChangeStack } from "../changestack.js";
import type { ReviewCommentType } from "../review.js";

function makeFinding(overrides: Partial<ReviewCommentType> & { file: string }): ReviewCommentType {
  return {
    file: overrides.file,
    line: overrides.line ?? 1,
    severity: overrides.severity ?? "medium",
    category: overrides.category ?? "bug",
    message: overrides.message ?? "issue",
    confidence: overrides.confidence ?? 80,
    ...overrides,
  };
}

describe("classifyCohort", () => {
  it("classifies schema files as data-model", () => {
    expect(classifyCohort("src/schema/user.ts")).toBe("data-model");
  });

  it("classifies model files as data-model", () => {
    expect(classifyCohort("src/models/user.ts")).toBe("data-model");
  });

  it("classifies migration files as data-model", () => {
    expect(classifyCohort("migrations/001_create_users.sql")).toBe("data-model");
  });

  it("classifies type definition files as data-model", () => {
    expect(classifyCohort("src/types/user.d.ts")).toBe("data-model");
  });

  it("classifies API route files as contract", () => {
    expect(classifyCohort("src/api/users.ts")).toBe("contract");
  });

  it("classifies endpoint files as contract", () => {
    expect(classifyCohort("src/endpoints/users.ts")).toBe("contract");
  });

  it("classifies controller files as contract", () => {
    expect(classifyCohort("src/controllers/userController.ts")).toBe("contract");
  });

  it("classifies util files as logic", () => {
    expect(classifyCohort("src/utils/format.ts")).toBe("logic");
  });

  it("classifies helper files as logic", () => {
    expect(classifyCohort("src/helpers/date.ts")).toBe("logic");
  });

  it("classifies component files as consumer", () => {
    expect(classifyCohort("src/components/Button.tsx")).toBe("consumer");
  });

  it("classifies page files as consumer", () => {
    expect(classifyCohort("src/pages/Home.tsx")).toBe("consumer");
  });

  it("classifies hook files as consumer", () => {
    expect(classifyCohort("src/hooks/useAuth.ts")).toBe("consumer");
  });

  it("classifies use[A-Z] hook convention as consumer, not plain 'user'", () => {
    expect(classifyCohort("src/hooks/useAuth.ts")).toBe("consumer");
    expect(classifyCohort("src/types/user.d.ts")).toBe("data-model");
  });

  it("classifies test files as test", () => {
    expect(classifyCohort("src/__tests__/user.test.ts")).toBe("test");
  });

  it("classifies spec files as test", () => {
    expect(classifyCohort("tests/user.spec.ts")).toBe("test");
  });

  it("classifies config files as other", () => {
    expect(classifyCohort("tsconfig.json")).toBe("other");
  });

  it("classifies CI files as other", () => {
    expect(classifyCohort(".github/workflows/ci.yml")).toBe("other");
  });

  it("prioritizes first match (data-model before test)", () => {
    // A file with both "model" and "test" should match data-model first
    expect(classifyCohort("src/models/user.test.ts")).toBe("data-model");
  });
});


  // --- Additional classifyCohort edge cases ---

  it("classifies entity files as data-model", () => {
    expect(classifyCohort("src/entity/User.ts")).toBe("data-model");
  });

  it("classifies interface files as data-model", () => {
    expect(classifyCohort("src/interfaces/IUser.ts")).toBe("data-model");
  });

  it("classifies /types/ directory files as data-model", () => {
    expect(classifyCohort("src/types/index.ts")).toBe("data-model");
  });

  it("classifies .d.ts files as data-model", () => {
    expect(classifyCohort("src/global.d.ts")).toBe("data-model");
  });

  it("classifies function files as logic", () => {
    expect(classifyCohort("src/functions/transform.ts")).toBe("logic");
  });

  it("classifies view files as consumer", () => {
    expect(classifyCohort("src/views/Dashboard.tsx")).toBe("consumer");
  });

  it("classifies files under schema directory as data-model", () => {
    expect(classifyCohort("prisma/schema.prisma")).toBe("data-model");
  });

  it("is case-insensitive for cohort classification", () => {
    expect(classifyCohort("src/Models/User.ts").toLowerCase()).toBe("data-model");
  });

  it("classifies deep path by matching first pattern", () => {
    // src/api/users/helpers.ts — api matches before helper
    expect(classifyCohort("src/api/users/helpers.ts")).toBe("contract");
  });

  it("classifies files with multiple pattern matches by first cohort", () => {
    // src/test-utils/mock.ts — test matches before util/logic
    expect(classifyCohort("src/test-utils/mock.ts")).toBe("logic");
  });
describe("buildChangeStack", () => {
  it("returns empty string for fewer than 5 findings", () => {
    const findings = [
      makeFinding({ file: "src/api/users.ts", severity: "high" }),
      makeFinding({ file: "src/models/user.ts", severity: "medium" }),
      makeFinding({ file: "src/utils/format.ts", severity: "low" }),
    ];
    expect(buildChangeStack(findings)).toBe("");
  });

  it("returns empty string for 4 findings", () => {
    const findings = Array.from({ length: 4 }, (_, i) =>
      makeFinding({ file: `src/file${i}.ts`, severity: "low" })
    );
    expect(buildChangeStack(findings)).toBe("");
  });

  it("builds change stack for 5+ findings", () => {
    const findings = [
      makeFinding({ file: "src/models/user.ts", severity: "high", category: "bug", message: "Null pointer" }),
      makeFinding({ file: "src/api/users.ts", severity: "critical", category: "security", message: "SQL injection" }),
      makeFinding({ file: "src/utils/format.ts", severity: "medium", category: "performance", message: "Slow loop" }),
      makeFinding({ file: "src/components/Button.tsx", severity: "low", category: "style", message: "Missing key" }),
      makeFinding({ file: "src/__tests__/user.test.ts", severity: "nitpick", category: "architecture", message: "Test structure" }),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("## Change Stack");
    expect(stack).toContain("Data Models & Schemas");
    expect(stack).toContain("API Contracts & Endpoints");
    expect(stack).toContain("Core Logic & Utilities");
    expect(stack).toContain("Consumers & UI Components");
    expect(stack).toContain("Tests & Specifications");
  });

  it("outputs cohorts in dependency order", () => {
    const findings = [
      makeFinding({ file: "src/tests/a.test.ts", severity: "low", category: "style", message: "test" }),
      makeFinding({ file: "src/api/a.ts", severity: "high", category: "bug", message: "api" }),
      makeFinding({ file: "src/models/a.ts", severity: "critical", category: "security", message: "model" }),
      makeFinding({ file: "src/components/a.tsx", severity: "medium", category: "performance", message: "comp" }),
      makeFinding({ file: "src/helpers/a.ts", severity: "nitpick", category: "style", message: "help" }),
    ];
    const stack = buildChangeStack(findings);
    const modelIdx = stack.indexOf("Data Models & Schemas");
    const contractIdx = stack.indexOf("API Contracts & Endpoints");
    const logicIdx = stack.indexOf("Core Logic & Utilities");
    const consumerIdx = stack.indexOf("Consumers & UI Components");
    const testIdx = stack.indexOf("Tests & Specifications");
    expect(modelIdx).toBeLessThan(contractIdx);
    expect(contractIdx).toBeLessThan(logicIdx);
    expect(logicIdx).toBeLessThan(testIdx);
    expect(testIdx).toBeLessThan(consumerIdx);
  });

  it("includes severity counts in section headers", () => {
    const findings = [
      makeFinding({ file: "src/models/a.ts", severity: "critical", category: "bug", message: "m1" }),
      makeFinding({ file: "src/models/b.ts", severity: "high", category: "security", message: "m2" }),
      makeFinding({ file: "src/api/a.ts", severity: "medium", category: "performance", message: "a1" }),
      makeFinding({ file: "src/utils/a.ts", severity: "low", category: "style", message: "u1" }),
      makeFinding({ file: "src/utils/b.ts", severity: "nitpick", category: "style", message: "u2" }),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toMatch(/1 critical.*1 high/);
    expect(stack).toMatch(/1 medium/);
  });

  it("skips cohorts with zero findings", () => {
    const findings = [
      makeFinding({ file: "src/models/a.ts", severity: "high", category: "bug", message: "m1" }),
      makeFinding({ file: "src/models/b.ts", severity: "medium", category: "bug", message: "m2" }),
      makeFinding({ file: "src/models/c.ts", severity: "low", category: "bug", message: "m3" }),
      makeFinding({ file: "src/utils/a.ts", severity: "nitpick", category: "style", message: "u1" }),
      makeFinding({ file: "config.json", severity: "nitpick", category: "style", message: "c1" }),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("Data Models & Schemas");
    expect(stack).not.toContain("API Contracts & Endpoints");
    expect(stack).toContain("Other Changes");
  });

  it("formats each finding with file, line, severity, category, message", () => {
    const findings = [
      makeFinding({ file: "src/api/auth.ts", line: 42, severity: "critical", category: "security", message: "Auth bypass" }),
      makeFinding({ file: "src/models/user.ts", line: 10, severity: "high", category: "bug", message: "Null ref" }),
      makeFinding({ file: "src/components/Header.tsx", line: 7, severity: "low", category: "style", message: "Missing semicolon" }),
      makeFinding({ file: "src/helpers/date.ts", line: 15, severity: "medium", category: "performance", message: "N+1 query" }),
      makeFinding({ file: "src/__tests__/auth.test.ts", line: 99, severity: "nitpick", category: "architecture", message: "Flaky test" }),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("`src/api/auth.ts:42`");
    expect(stack).toContain("[CRITICAL] security");
    expect(stack).toContain("Auth bypass");
  });

  it("classifies service files as contract", () => {
    expect(classifyCohort("src/services/userService.ts")).toBe("contract");
  });

  it("classifies route files as contract", () => {
    expect(classifyCohort("src/routes/index.ts")).toBe("contract");
  });

  it("classifies handler files as contract", () => {
    expect(classifyCohort("src/handlers/createUser.ts")).toBe("contract");
  });

  it("classifies module files as logic", () => {
    expect(classifyCohort("src/modules/auth.ts")).toBe("logic");
  });

  it("classifies class files as logic", () => {
    expect(classifyCohort("src/classes/User.ts")).toBe("logic");
  });

  it("classifies core files as logic", () => {
    expect(classifyCohort("src/core/engine.ts")).toBe("logic");
  });

  it("classifies page/view files as consumer", () => {
    expect(classifyCohort("src/views/Dashboard.tsx")).toBe("consumer");
  });

  it("classifies import-only files names as consumer", () => {
    expect(classifyCohort("src/imports/reexport.ts")).toBe("consumer");
  });

  it("returns other for files with no matching patterns", () => {
    expect(classifyCohort("scripts/deploy.sh")).toBe("other");
    expect(classifyCohort("Dockerfile")).toBe("other");
  });

  it("handles change stack with only one cohort type", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ file: `src/models/entity${i}.ts`, severity: "medium", category: "bug", message: `Bug ${i}` })
    );
    const stack = buildChangeStack(findings);
    expect(stack).toContain("Data Models & Schemas");
    expect(stack).not.toContain("API Contracts");
  });

  it("includes test cohort for spec files", () => {
    expect(classifyCohort("tests/integration/user.spec.ts")).toBe("test");
  });

  it("data model matched before contract for model files", () => {
    expect(classifyCohort("src/models/api.ts")).toBe("data-model");
  });

  // --- Additional buildChangeStack edge cases ---

  it("returns empty string for exactly 4 findings", () => {
    const findings = Array.from({ length: 4 }, (_, i) =>
      makeFinding({ file: "src/api/file" + i + ".ts", severity: "low", category: "style", message: "m" + i })
    );
    expect(buildChangeStack(findings)).toBe("");
  });

  it("handles exactly 5 findings", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ file: "src/api/file" + i + ".ts", severity: "low", category: "style", message: "m" + i })
    );
    const stack = buildChangeStack(findings);
    expect(stack).toContain("Change Stack");
  });

  it("outputs correct severity for CRITICAL findings", () => {
    const findings = [
      makeFinding({ file: "src/api/a.ts", line: 1, severity: "critical", category: "security", message: "RCE" }),
      makeFinding({ file: "src/models/b.ts", line: 2, severity: "high", category: "bug", message: "Null" }),
      makeFinding({ file: "src/utils/c.ts", line: 3, severity: "medium", category: "performance", message: "Slow" }),
      makeFinding({ file: "src/components/d.tsx", line: 4, severity: "low", category: "style", message: "Fmt" }),
      makeFinding({ file: "src/__tests__/e.test.ts", line: 5, severity: "nitpick", category: "architecture", message: "Test" }),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("[CRITICAL]");
    expect(stack).toContain("[HIGH]");
    expect(stack).toContain("[MEDIUM]");
  });

  it("handles all-other cohort", () => {
    const findings = [
      { file: "Dockerfile", line: 1, severity: "low" as const, category: "style", message: "m1", confidence: 80 },
      { file: "Makefile", line: 2, severity: "low" as const, category: "style", message: "m2", confidence: 80 },
      { file: ".github/workflows/ci.yml", line: 3, severity: "low" as const, category: "style", message: "m3", confidence: 80 },
      { file: "scripts/deploy.sh", line: 4, severity: "low" as const, category: "style", message: "m4", confidence: 80 },
      { file: "config.json", line: 5, severity: "low" as const, category: "style", message: "m5", confidence: 80 },
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("Other Changes");
  });

  it("formats file references as backtick code", () => {
    const findings = [
      makeFinding({ file: "src/api/auth.ts", line: 42, severity: "critical", category: "security", message: "Bypass" }),
      makeFinding({ file: "src/models/user.ts", line: 10, severity: "high", category: "bug", message: "Null" }),
      makeFinding({ file: "src/utils/format.ts", line: 5, severity: "medium", category: "performance", message: "N+1" }),
      makeFinding({ file: "src/components/Button.tsx", line: 3, severity: "low", category: "style", message: "Key" }),
      makeFinding({ file: "src/tests/a.test.ts", line: 1, severity: "nitpick", category: "style", message: "Fmt" }),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("`src/api/auth.ts:42`");
  });

  it("builds stack for many findings across all cohorts", () => {
    const findings = [
      ...Array.from({ length: 3 }, (_, i) => makeFinding({ file: "src/models/m" + i + ".ts", severity: "high", category: "bug", message: "m" + i })),
      ...Array.from({ length: 3 }, (_, i) => makeFinding({ file: "src/api/a" + i + ".ts", severity: "medium", category: "security", message: "a" + i })),
      ...Array.from({ length: 3 }, (_, i) => makeFinding({ file: "src/utils/u" + i + ".ts", severity: "low", category: "performance", message: "u" + i })),
      ...Array.from({ length: 3 }, (_, i) => makeFinding({ file: "src/components/c" + i + ".tsx", severity: "nitpick", category: "style", message: "c" + i })),
      ...Array.from({ length: 3 }, (_, i) => makeFinding({ file: "src/__tests__/t" + i + ".test.ts", severity: "nitpick", category: "style", message: "t" + i })),
    ];
    const stack = buildChangeStack(findings);
    expect(stack).toContain("Data Models");
    expect(stack).toContain("API Contracts");
    expect(stack).toContain("Core Logic");
    expect(stack).toContain("Tests &");
    expect(stack).toContain("Consumers");
  });
});
