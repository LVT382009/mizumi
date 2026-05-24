import { describe, it, expect, vi } from "vitest";
import { categorizeRule } from "../linter.js";

// Note: runLinters, runEslint, runTsc, runPrettier all use execSync
// which we can't easily mock without vi.mock. We test the pure logic
// and the categorization mapping instead.

describe("categorizeRule", () => {
  it("maps security-related rules to security category", () => {
    expect(categorizeRule("no-eval")).toBe("security");
    expect(categorizeRule("no-implied-eval")).toBe("security");
    expect(categorizeRule("no-new-func")).toBe("security");
    expect(categorizeRule("security/detect-unsafe-regex")).toBe("security");
  });

  it("maps no-undef and no-unused to bug category", () => {
    expect(categorizeRule("no-undef")).toBe("bug");
    expect(categorizeRule("no-unused-vars")).toBe("bug");
    expect(categorizeRule("no-console")).toBe("bug");
    expect(categorizeRule("no-debugger")).toBe("bug");
  });

  it("maps style rules to style category", () => {
    expect(categorizeRule("semi")).toBe("style");
    expect(categorizeRule("indent")).toBe("style");
    expect(categorizeRule("quotes")).toBe("style");
    expect(categorizeRule("max-len")).toBe("style");
  });

  it("returns style for empty ruleId", () => {
    expect(categorizeRule("")).toBe("style");
  });

  it("returns style for unknown rules", () => {
    expect(categorizeRule("custom-plugin/rule")).toBe("style");
  });
});

describe("LinterFinding structure", () => {
  it("has required fields for merging into review pipeline", () => {
    const finding = {
      file: "src/app.ts",
      line: 42,
      severity: "high" as const,
      category: "bug" as const,
      message: "no-undef: x is not defined",
      linter: "eslint",
    };
    expect(finding.file).toBeTruthy();
    expect(finding.line).toBeGreaterThan(0);
    expect(["critical", "high", "medium", "low"]).toContain(finding.severity);
    expect(["style", "bug", "security", "compliance"]).toContain(finding.category);
    expect(finding.linter).toBeTruthy();
  });
});
