import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  generateSARIF,
  severityToLevel,
  buildRuleId,
  buildRules,
  writeSARIF,
  uploadSARIF,
} from "../sarif.js";
import type { ReviewCommentType } from "../review.js";

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: "src/auth/login.ts",
    line: 42,
    severity: "high",
    category: "security",
    message: "SQL injection vulnerability",
    confidence: 90,
    ...overrides,
  };
}

describe("severityToLevel", () => {
  it("maps critical to error", () => {
    expect(severityToLevel("critical")).toBe("error");
  });

  it("maps high to error", () => {
    expect(severityToLevel("high")).toBe("error");
  });

  it("maps medium to warning", () => {
    expect(severityToLevel("medium")).toBe("warning");
  });

  it("maps low to note", () => {
    expect(severityToLevel("low")).toBe("note");
  });

  it("maps nitpick to none", () => {
    expect(severityToLevel("nitpick")).toBe("none");
  });

  it("maps unknown severity to warning (fallback)", () => {
    expect(severityToLevel("unknown")).toBe("warning");
  });
});

describe("buildRuleId", () => {
  it("uses MIZ-SEC prefix for security", () => {
    expect(buildRuleId("security", 0)).toBe("MIZ-SEC/1");
  });

  it("uses MIZ prefix for bug", () => {
    expect(buildRuleId("bug", 0)).toBe("MIZ/1");
  });

  it("uses MIZ-PERF prefix for performance", () => {
    expect(buildRuleId("performance", 0)).toBe("MIZ-PERF/1");
  });

  it("uses MIZ-STYLE prefix for style", () => {
    expect(buildRuleId("style", 2)).toBe("MIZ-STYLE/3");
  });

  it("uses MIZ-ARCH prefix for architecture", () => {
    expect(buildRuleId("architecture", 0)).toBe("MIZ-ARCH/1");
  });

  it("uses MIZ-COMP prefix for compliance", () => {
    expect(buildRuleId("compliance", 0)).toBe("MIZ-COMP/1");
  });

  it("uses MIZ default for unknown category", () => {
    expect(buildRuleId("other", 0)).toBe("MIZ/1");
  });

  it("increments index correctly", () => {
    expect(buildRuleId("bug", 4)).toBe("MIZ/5");
  });
});

describe("buildRules", () => {
  it("creates one rule per unique category", () => {
    const findings = [
      makeFinding({ category: "security", severity: "high" }),
      makeFinding({ category: "security", severity: "medium" }),
      makeFinding({ category: "bug", severity: "high" }),
    ];
    const rules = buildRules(findings);
    expect(rules).toHaveLength(2);
  });

  it("deduplicates categories", () => {
    const findings = [
      makeFinding({ category: "security" }),
      makeFinding({ category: "security" }),
      makeFinding({ category: "security" }),
    ];
    const rules = buildRules(findings);
    expect(rules).toHaveLength(1);
  });

  it("returns empty array for no findings", () => {
    const rules = buildRules([]);
    expect(rules).toHaveLength(0);
  });

  it("includes category in tags", () => {
    const findings = [makeFinding({ category: "bug" })];
    const rules = buildRules(findings);
    expect(rules[0].properties.tags).toContain("bug");
    expect(rules[0].properties.tags).toContain("ai-review");
    expect(rules[0].properties.tags).toContain("mizumi");
  });

  it("sets default configuration level from first finding severity", () => {
    const findings = [makeFinding({ category: "security", severity: "critical" })];
    const rules = buildRules(findings);
    expect(rules[0].defaultConfiguration.level).toBe("error");
  });

  it("sets help URI with category anchor", () => {
    const findings = [makeFinding({ category: "bug" })];
    const rules = buildRules(findings);
    expect(rules[0].helpUri).toContain("#bug");
  });

  it("handles all six categories", () => {
    const categories = ["bug", "security", "performance", "style", "architecture", "compliance"];
    const findings = categories.map(cat => makeFinding({ category: cat as any }));
    const rules = buildRules(findings);
    expect(rules).toHaveLength(6);
  });
});

describe("generateSARIF", () => {
  it("produces valid SARIF 2.1.0 structure", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-schema-2.1.0");
    expect(sarif.runs).toHaveLength(1);
  });

  it("includes tool driver information", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe("Mizumi");
    expect(driver.version).toBe("0.1.0");
    expect(driver.informationUri).toBeTruthy();
  });

  it("maps each finding to a SARIF result", () => {
    const findings = [
      makeFinding({ file: "src/a.ts", line: 1, severity: "high", category: "security", message: "Issue 1" }),
      makeFinding({ file: "src/b.ts", line: 5, severity: "medium", category: "bug", message: "Issue 2" }),
    ];
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results).toHaveLength(2);
  });

  it("sets correct level per finding severity", () => {
    const findings = [
      makeFinding({ severity: "critical" }),
      makeFinding({ severity: "medium" }),
      makeFinding({ severity: "low" }),
      makeFinding({ severity: "nitpick" }),
    ];
    const sarif = generateSARIF(findings);
    const levels = sarif.runs[0].results.map(r => r.level);
    expect(levels).toEqual(["error", "warning", "note", "none"]);
  });

  it("sets file URI in location", () => {
    const findings = [makeFinding({ file: "src/auth/handler.ts" })];
    const sarif = generateSARIF(findings);
    const loc = sarif.runs[0].results[0].locations[0];
    expect(loc.physicalLocation.artifactLocation.uri).toBe("src/auth/handler.ts");
    expect(loc.physicalLocation.artifactLocation.uriBaseId).toBe("%SRCROOT%");
  });

  it("sets startLine from finding line", () => {
    const findings = [makeFinding({ line: 99 })];
    const sarif = generateSARIF(findings);
    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(99);
  });

  it("includes endLine when present and greater than startLine", () => {
    const findings = [makeFinding({ line: 10, endLine: 15 })];
    const sarif = generateSARIF(findings);
    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(10);
    expect(region.endLine).toBe(15);
  });

  it("omits endLine when not present", () => {
    const findings = [makeFinding({ line: 10 })];
    const sarif = generateSARIF(findings);
    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.endLine).toBeUndefined();
  });

  it("omits endLine when equal to startLine", () => {
    const findings = [makeFinding({ line: 10, endLine: 10 })];
    const sarif = generateSARIF(findings);
    const region = sarif.runs[0].results[0].locations[0].physicalLocation.region;
    expect(region.endLine).toBeUndefined();
  });

  it("includes stable fingerprint", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const fp = sarif.runs[0].results[0].fingerprints;
    expect(fp.primaryLocationLineHash).toBeTruthy();
    expect(typeof fp.primaryLocationLineHash).toBe("string");
  });

  it("produces same fingerprint for identical findings", () => {
    const f1 = makeFinding({ file: "src/a.ts", line: 1, category: "bug", message: "Null deref" });
    const f2 = makeFinding({ file: "src/a.ts", line: 1, category: "bug", message: "Null deref" });
    const sarif1 = generateSARIF([f1]);
    const sarif2 = generateSARIF([f2]);
    expect(sarif1.runs[0].results[0].fingerprints.primaryLocationLineHash)
      .toBe(sarif2.runs[0].results[0].fingerprints.primaryLocationLineHash);
  });

  it("produces different fingerprints for different findings", () => {
    const f1 = makeFinding({ file: "src/a.ts", line: 1, message: "Bug A" });
    const f2 = makeFinding({ file: "src/b.ts", line: 2, message: "Bug B" });
    const sarif1 = generateSARIF([f1]);
    const sarif2 = generateSARIF([f2]);
    expect(sarif1.runs[0].results[0].fingerprints.primaryLocationLineHash)
      .not.toBe(sarif2.runs[0].results[0].fingerprints.primaryLocationLineHash);
  });

  it("includes confidence in properties", () => {
    const findings = [makeFinding({ confidence: 85 })];
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results[0].properties.confidence).toBe(85);
  });

  it("includes original severity in properties", () => {
    const findings = [makeFinding({ severity: "high" })];
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results[0].properties.severity).toBe("high");
  });

  it("includes finding message", () => {
    const findings = [makeFinding({ message: "XSS vulnerability in user input" })];
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results[0].message.text).toBe("XSS vulnerability in user input");
  });

  it("handles empty findings list", () => {
    const sarif = generateSARIF([]);
    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });

  it("includes invocation with timestamp", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const invocation = sarif.runs[0].invocations[0];
    expect(invocation.executionSuccessful).toBe(true);
    expect(invocation.startTimeUtc).toBeTruthy();
  });

  it("uses custom repo URL when provided", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings, "https://github.com/org/repo");
    expect(sarif.runs[0].tool.driver.informationUri).toBe("https://github.com/org/repo");
  });

  it("results reference correct ruleIndex", () => {
    const findings = [
      makeFinding({ category: "bug" }),
      makeFinding({ category: "security" }),
      makeFinding({ category: "bug" }),
    ];
    const sarif = generateSARIF(findings);
    const results = sarif.runs[0].results;
    // bug = index 0, security = index 1
    expect(results[0].ruleIndex).toBe(0);
    expect(results[1].ruleIndex).toBe(1);
    expect(results[2].ruleIndex).toBe(0);
  });

  it("handles all severity levels", () => {
    const severities: ReviewCommentType["severity"][] = ["critical", "high", "medium", "low", "nitpick"];
    const findings = severities.map(sev => makeFinding({ severity: sev, category: "bug" }));
    const sarif = generateSARIF(findings);
    const levels = sarif.runs[0].results.map(r => r.level);
    expect(levels).toEqual(["error", "error", "warning", "note", "none"]);
  });

  it("produces valid JSON output", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const json = JSON.stringify(sarif);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe("2.1.0");
  });

  it("handles findings with very long messages", () => {
    const longMessage = "x".repeat(1000);
    const findings = [makeFinding({ message: longMessage })];
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results[0].message.text).toBe(longMessage);
  });

  it("handles findings with special characters in message", () => {
    const specialMessage = 'Path traversal: "../../../etc/passwd" <script>alert(1)</script>';
    const findings = [makeFinding({ message: specialMessage })];
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results[0].message.text).toBe(specialMessage);
    // Verify JSON round-trips correctly
    const json = JSON.stringify(sarif);
    const parsed = JSON.parse(json);
    expect(parsed.runs[0].results[0].message.text).toBe(specialMessage);
  });

  it("handles many findings (50+)", () => {
    const findings = Array.from({ length: 60 }, (_, i) =>
      makeFinding({ file: `src/file${i}.ts`, line: i + 1, category: "bug", message: `Bug ${i}` })
    );
    const sarif = generateSARIF(findings);
    expect(sarif.runs[0].results).toHaveLength(60);
  });
});

describe("writeSARIF", () => {
  const tmpDir = path.join(process.env.TEMP || "/tmp", "mizumi-sarif-test");

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("writes SARIF JSON to .github/mizumi-results.sarif", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const outPath = writeSARIF(tmpDir, sarif);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(outPath).toContain("mizumi-results.sarif");
  });

  it("writes valid JSON that can be parsed back", () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const outPath = writeSARIF(tmpDir, sarif);
    const content = fs.readFileSync(outPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs[0].results).toHaveLength(1);
  });

  it("creates .github directory if missing", () => {
    const ws = path.join(tmpDir, "no-dot-github");
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const outPath = writeSARIF(ws, sarif);
    expect(fs.existsSync(outPath)).toBe(true);
  });
});

describe("uploadSARIF", () => {
  const tmpDir = path.join(process.env.TEMP || "/tmp", "mizumi-sarif-upload-test");

  beforeEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("returns null for non-existent file", async () => {
    const mockOctokit = {
      rest: {
        codeScanning: { uploadSarif: vi.fn() },
      },
    };
    const result = await uploadSARIF(mockOctokit as any, "owner", "repo", "abc123", "/nonexistent.sarif");
    expect(result).toBeNull();
    expect(mockOctokit.rest.codeScanning.uploadSarif).not.toHaveBeenCalled();
  });

  it("calls codeScanning.uploadSarif with correct params", async () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const sarifPath = writeSARIF(tmpDir, sarif);

    const mockOctokit = {
      rest: {
        codeScanning: {
          uploadSarif: vi.fn().mockResolvedValue({ data: { id: "upload-123" } }),
        },
      },
    };

    const result = await uploadSARIF(mockOctokit as any, "myorg", "myrepo", "deadbeef", sarifPath);
    expect(mockOctokit.rest.codeScanning.uploadSarif).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "myorg",
        repo: "myrepo",
        commit_sha: "deadbeef",
      })
    );
    expect(result).toBe("upload-123");
  });

  it("returns null on upload error (non-fatal)", async () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const sarifPath = writeSARIF(tmpDir, sarif);

    const mockOctokit = {
      rest: {
        codeScanning: {
          uploadSarif: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
        },
      },
    };

    const result = await uploadSARIF(mockOctokit as any, "org", "repo", "sha", sarifPath);
    expect(result).toBeNull();
  });

  it("encodes SARIF content as base64", async () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const sarifPath = writeSARIF(tmpDir, sarif);

    const mockOctokit = {
      rest: {
        codeScanning: {
          uploadSarif: vi.fn().mockResolvedValue({ data: { id: "ok" } }),
        },
      },
    };

    await uploadSARIF(mockOctokit as any, "org", "repo", "sha", sarifPath);

    const callArgs = mockOctokit.rest.codeScanning.uploadSarif.mock.calls[0][0] as any;
    // Verify base64-encoded content can be decoded back
    const decoded = Buffer.from(callArgs.sarif, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    expect(parsed.version).toBe("2.1.0");
  });

  it("returns fallback 'uploaded' when response has no id", async () => {
    const findings = [makeFinding()];
    const sarif = generateSARIF(findings);
    const sarifPath = writeSARIF(tmpDir, sarif);

    const mockOctokit = {
      rest: {
        codeScanning: {
          uploadSarif: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    };

    const result = await uploadSARIF(mockOctokit as any, "org", "repo", "sha", sarifPath);
    expect(result).toBe("uploaded");
  });
});
