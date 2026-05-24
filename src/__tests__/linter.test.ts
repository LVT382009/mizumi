import { describe, it, expect, vi, beforeEach } from "vitest";
import { categorizeRule, runEslint, runTsc, runPrettier, runLinters, runDependencyAudit, runNpmAudit, runPipAudit, mapNpmSeverity } from "../linter.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExec.mockReset();
});

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

describe("runEslint", () => {
  it("parses JSON output from ESLint with warnings and errors", () => {
    const eslintJson = JSON.stringify([
      {
        filePath: "/workspace/src/app.ts",
        messages: [
          { line: 10, severity: 1, message: "Unexpected var", ruleId: "no-var" },
          { line: 20, severity: 2, message: "'x' is not defined", ruleId: "no-undef" },
        ],
      },
    ]);
    mockExec.mockImplementation(() => {
      const err: any = new Error("eslint failed");
      err.stdout = eslintJson;
      throw err;
    });

    const results = runEslint("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(2);
    expect(results[0].severity).toBe("low"); // severity 1 = warn
    expect(results[0].linter).toBe("eslint");
    expect(results[1].severity).toBe("high"); // severity 2 = error
    expect(results[1].category).toBe("bug"); // no-undef
  });

  it("returns empty array when ESLint exits 0 (no findings)", () => {
    mockExec.mockReturnValue("[]");
    const results = runEslint("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(0);
  });

  it("handles non-JSON error output gracefully", () => {
    mockExec.mockImplementation(() => {
      const err: any = new Error("eslint crashed");
      err.stdout = "Some plain text error";
      throw err;
    });
    const results = runEslint("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(0);
  });

  it("skips when execFileSync throws without stdout", () => {
    mockExec.mockImplementation(() => {
      throw new Error("command not found");
    });
    const results = runEslint("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(0);
  });

  it("uses execFileSync with argv array (no shell injection)", () => {
    mockExec.mockReturnValue("[]");
    runEslint("/workspace", ["src/app.ts", "src/util.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["eslint", "--format", "json", "--no-error-on-unmatched-pattern", "src/app.ts", "src/util.ts"]),
      expect.any(Object)
    );
    // Verify it's an argv array, not a shell string
    const args = mockExec.mock.calls[0][1];
    expect(Array.isArray(args)).toBe(true);
    expect(typeof args[0]).toBe("string");
  });

  it("limits to first 50 files", () => {
    const manyFiles = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`);
    mockExec.mockReturnValue("[]");
    runEslint("/workspace", manyFiles);
    const args = mockExec.mock.calls[0][1] as string[];
    // eslint + --format + json + --no-error-on-unmatched-pattern = 4 fixed args, then files
    const fileArgs = args.slice(4);
    expect(fileArgs.length).toBeLessThanOrEqual(50);
  });
});

describe("runTsc", () => {
  it("parses tsc diagnostic output", () => {
    const tscOutput = [
      "src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/util.ts(3,1): warning TS6133: 'x' is declared but its value is never read.",
    ].join("\n");
    mockExec.mockImplementation(() => {
      const err: any = new Error("tsc failed");
      err.stdout = tscOutput;
      throw err;
    });

    const results = runTsc("/workspace");
    expect(results).toHaveLength(2);
    expect(results[0].file).toBe("src/app.ts");
    expect(results[0].line).toBe(10);
    expect(results[0].severity).toBe("high");
    expect(results[0].category).toBe("bug");
    expect(results[0].linter).toBe("tsc");
    expect(results[1].severity).toBe("low"); // warning
  });

  it("returns empty when tsc exits 0", () => {
    mockExec.mockReturnValue("");
    const results = runTsc("/workspace");
    expect(results).toHaveLength(0);
  });

  it("handles mixed valid/invalid tsc output lines", () => {
    const mixedOutput = [
      "src/app.ts(5,3): error TS2304: Cannot find name 'foo'.",
      "Some random line that doesn't match",
      "",
      "src/other.ts(1,1): error TS1109: Expression expected.",
    ].join("\n");
    mockExec.mockImplementation(() => {
      const err: any = new Error("tsc failed");
      err.stdout = mixedOutput;
      throw err;
    });
    const results = runTsc("/workspace");
    expect(results).toHaveLength(2);
    expect(results[0].message).toContain("TS2304");
    expect(results[1].message).toContain("TS1109");
  });

  it("uses execFileSync with argv array (no shell injection)", () => {
    mockExec.mockReturnValue("");
    runTsc("/workspace");
    expect(mockExec).toHaveBeenCalledWith(
      "npx",
      ["tsc", "--noEmit", "--pretty", "false"],
      expect.any(Object)
    );
  });
});

describe("runPrettier", () => {
  it("detects unformatted files from stderr", () => {
    const prettierOutput = "[warn] src/app.ts\n[warn] src/util.ts\n";
    mockExec.mockImplementation(() => {
      const err: any = new Error("prettier check failed");
      err.stderr = prettierOutput;
      throw err;
    });
    const results = runPrettier("/workspace", ["src/app.ts", "src/util.ts"]);
    expect(results).toHaveLength(2);
    expect(results[0].severity).toBe("low");
    expect(results[0].category).toBe("style");
    expect(results[0].linter).toBe("prettier");
    expect(results[0].message).toBe("File not formatted with Prettier");
  });

  it("returns empty when all files formatted", () => {
    mockExec.mockReturnValue("");
    const results = runPrettier("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(0);
  });

  it("skips files not in the changed files list", () => {
    const output = "[warn] src/other.ts\n";
    mockExec.mockImplementation(() => {
      const err: any = new Error("prettier check failed");
      err.stderr = output;
      throw err;
    });
    const results = runPrettier("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(0);
  });

  it("uses execFileSync with argv array (no shell injection)", () => {
    mockExec.mockReturnValue("");
    runPrettier("/workspace", ["src/app.ts"]);
    expect(mockExec).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["prettier", "--check", "src/app.ts"]),
      expect.any(Object)
    );
    const args = mockExec.mock.calls[0][1];
    expect(Array.isArray(args)).toBe(true);
  });
});

describe("runLinters", () => {
  it("returns empty for non-JS files", () => {
    const results = runLinters("/workspace", ["README.md", "style.css"]);
    expect(results).toHaveLength(0);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("filters JS/TS files and runs all linters", () => {
    mockExec.mockReturnValue("[]"); // All linters return clean
    const results = runLinters("/workspace", ["src/app.ts", "README.md", "src/util.ts"]);
    expect(results).toHaveLength(0);
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("merges findings from multiple linters", () => {
    let callCount = 0;
    mockExec.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const err: any = new Error("eslint failed");
        err.stdout = JSON.stringify([{
          filePath: "/workspace/src/app.ts",
          messages: [{ line: 5, severity: 2, message: "no-undef", ruleId: "no-undef" }],
        }]);
        throw err;
      }
      if (callCount === 2) {
        const err: any = new Error("tsc failed");
        err.stdout = "src/app.ts(10,1): error TS2322: Type error";
        throw err;
      }
      return "";
    });

    const results = runLinters("/workspace", ["src/app.ts"]);
    expect(results).toHaveLength(2);
    expect(results[0].linter).toBe("eslint");
    expect(results[1].linter).toBe("tsc");
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

describe("runNpmAudit", () => {
  it("parses npm audit JSON with vulnerabilities", () => {
    const auditJson = JSON.stringify({
      vulnerabilities: {
        lodash: {
          severity: "high",
          via: [{ title: "Prototype Pollution", url: "https://example.com", severity: "high" }],
          fixAvailable: { name: "lodash", version: "4.17.21" },
        },
      },
    });
    mockExec.mockImplementation(() => {
      const err: any = new Error("audit failed");
      err.stdout = auditJson;
      throw err;
    });

    const results = runNpmAudit("/workspace");
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("package.json");
    expect(results[0].severity).toBe("high");
    expect(results[0].category).toBe("security");
    expect(results[0].linter).toBe("npm-audit");
    expect(results[0].message).toContain("lodash");
    expect(results[0].message).toContain("Prototype Pollution");
    expect(results[0].message).toContain("fix available");
  });

  it("returns empty when no vulnerabilities", () => {
    mockExec.mockReturnValue("{}");
    const results = runNpmAudit("/workspace");
    expect(results).toHaveLength(0);
  });

  it("indicates no fix available when fixAvailable is false", () => {
    const auditJson = JSON.stringify({
      vulnerabilities: {
        "old-pkg": {
          severity: "critical",
          via: [{ title: "RCE", url: "https://example.com", severity: "critical" }],
          fixAvailable: false,
        },
      },
    });
    mockExec.mockImplementation(() => {
      const err: any = new Error("audit failed");
      err.stdout = auditJson;
      throw err;
    });

    const results = runNpmAudit("/workspace");
    expect(results[0].message).toContain("no fix available");
  });

  it("handles string via entries (chain references)", () => {
    const auditJson = JSON.stringify({
      vulnerabilities: {
        axios: {
          severity: "moderate",
          via: ["lodash"], // Chain reference, not an object
          fixAvailable: true,
        },
      },
    });
    mockExec.mockImplementation(() => {
      const err: any = new Error("audit failed");
      err.stdout = auditJson;
      throw err;
    });

    const results = runNpmAudit("/workspace");
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("medium"); // "moderate" maps to "medium"
    expect(results[0].message).toContain("vulnerability found");
  });

  it("returns empty when exec fails without stdout", () => {
    mockExec.mockImplementation(() => { throw new Error("no npm"); });
    const results = runNpmAudit("/workspace");
    expect(results).toHaveLength(0);
  });
});

describe("runPipAudit", () => {
  it("parses pip-audit JSON with vulnerabilities", () => {
    const auditJson = JSON.stringify({
      dependencies: [{
        name: "requests",
        version: "2.25.0",
        vulns: [{
          vid: "PYSEC-2023-123",
          aliases: ["CVE-2023-32681"],
          severity: "high",
        }],
      }],
    });
    mockExec.mockReturnValue(auditJson);

    const results = runPipAudit("/workspace");
    expect(results).toHaveLength(1);
    expect(results[0].file).toBe("requirements.txt");
    expect(results[0].severity).toBe("high");
    expect(results[0].category).toBe("security");
    expect(results[0].linter).toBe("pip-audit");
    expect(results[0].message).toContain("requests@2.25.0");
    expect(results[0].message).toContain("CVE-2023-32681");
  });

  it("returns empty when no dependencies have vulns", () => {
    const auditJson = JSON.stringify({
      dependencies: [{
        name: "flask",
        version: "3.0.0",
        vulns: [],
      }],
    });
    mockExec.mockReturnValue(auditJson);
    const results = runPipAudit("/workspace");
    expect(results).toHaveLength(0);
  });

  it("uses worst severity when multiple vulns exist", () => {
    const auditJson = JSON.stringify({
      dependencies: [{
        name: "django",
        version: "3.1.0",
        vulns: [
          { vid: "PYSEC-1", aliases: [], severity: "low" },
          { vid: "PYSEC-2", aliases: [], severity: "critical" },
        ],
      }],
    });
    mockExec.mockReturnValue(auditJson);
    const results = runPipAudit("/workspace");
    expect(results[0].severity).toBe("critical");
  });

  it("returns empty when pip-audit not installed", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    const results = runPipAudit("/workspace");
    expect(results).toHaveLength(0);
  });

  it("limits alias list to 3 entries", () => {
    const auditJson = JSON.stringify({
      dependencies: [{
        name: "pkg",
        version: "1.0",
        vulns: [{
          vid: "V1",
          aliases: ["A1", "A2", "A3", "A4", "A5"],
          severity: "medium",
        }],
      }],
    });
    mockExec.mockReturnValue(auditJson);
    const results = runPipAudit("/workspace");
    // vid + up to 2 aliases = 3 items max
    const parts = results[0].message.split(": ")[1].split(", ");
    expect(parts.length).toBeLessThanOrEqual(3);
  });
});

describe("mapNpmSeverity", () => {
  it("maps critical", () => { expect(mapNpmSeverity("critical")).toBe("critical"); });
  it("maps high", () => { expect(mapNpmSeverity("high")).toBe("high"); });
  it("maps moderate to medium", () => { expect(mapNpmSeverity("moderate")).toBe("medium"); });
  it("maps low", () => { expect(mapNpmSeverity("low")).toBe("low"); });
  it("maps unknown to medium", () => { expect(mapNpmSeverity("info")).toBe("medium"); });
});

describe("runDependencyAudit", () => {
  it("returns combined findings from both auditors", () => {
    const npmAudit = JSON.stringify({
      vulnerabilities: {
        lodash: {
          severity: "high",
          via: [{ title: "PP", url: "x", severity: "high" }],
          fixAvailable: true,
        },
      },
    });
    const pipAudit = JSON.stringify({
      dependencies: [{
        name: "requests",
        version: "2.25.0",
        vulns: [{ vid: "V1", aliases: [], severity: "medium" }],
      }],
    });

    let callCount = 0;
    mockExec.mockImplementation((cmd: string) => {
      callCount++;
      if (cmd === "npm") {
        const err: any = new Error("audit");
        err.stdout = npmAudit;
        throw err;
      }
      return pipAudit;
    });

    const results = runDependencyAudit("/workspace");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when both auditors return nothing", () => {
    mockExec.mockImplementation(() => { throw new Error("not found"); });
    const results = runDependencyAudit("/workspace");
    expect(results).toHaveLength(0);
  });
});
