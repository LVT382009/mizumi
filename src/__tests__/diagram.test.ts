import { describe, it, expect } from "vitest";
import { generateArchDiagram, generateSeverityDiagram } from "../diagram.js";
import type { ReviewCommentType } from "../review.js";

function makeFinding(overrides: Partial<ReviewCommentType> = {}): ReviewCommentType {
  return {
    file: "src/app.ts",
    line: 1,
    type: "bug",
    severity: "medium",
    message: "test finding",
    suggestion: "",
    confidence: 85,
    ...overrides,
  };
}

function makeFile(path: string, additions = 10, deletions = 5) {
  return { path, additions, deletions };
}

describe("generateArchDiagram", () => {
  it("returns empty string for fewer than 2 files", () => {
    expect(generateArchDiagram([makeFile("src/a.ts")])).toBe("");
    expect(generateArchDiagram([])).toBe("");
  });

  it("returns empty string when all files are in the same group", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("src/core/b.ts")];
    expect(generateArchDiagram(files)).toBe("");
  });

  it("wraps output in mermaid code block", () => {
    const files = [makeFile("src/a.ts"), makeFile("lib/b.ts")];
    const result = generateArchDiagram(files);
    expect(result).toMatch(/^```mermaid\n/);
    expect(result).toMatch(/\n```$/);
  });

  it("generates flowchart TD", () => {
    const files = [makeFile("src/a.ts"), makeFile("lib/b.ts")];
    const result = generateArchDiagram(files);
    expect(result).toContain("flowchart TD");
  });

  it("groups src files by subdirectory", () => {
    const files = [
      makeFile("src/core/a.ts", 20, 5),
      makeFile("src/api/b.ts", 10, 3),
    ];
    const result = generateArchDiagram(files);
    // src_core and src_api should appear as node IDs
    expect(result).toContain("src_core");
    expect(result).toContain("src_api");
  });

  it("shows addition/deletion stats per group", () => {
    const files = [
      makeFile("src/core/a.ts", 20, 5),
      makeFile("src/core/b.ts", 10, 3),
    ];
    // All in same group, should return empty
    expect(generateArchDiagram(files)).toBe("");

    const multiGroup = [
      makeFile("src/core/a.ts", 20, 5),
      makeFile("src/core/b.ts", 10, 3),
      makeFile("lib/x.ts", 5, 1),
    ];
    const result = generateArchDiagram(multiGroup);
    expect(result).toContain("+30/-8"); // summed for src_core
  });

  it("draws connections between adjacent sorted groups", () => {
    const files = [makeFile("src/a.ts"), makeFile("lib/b.ts"), makeFile("test/c.ts")];
    const result = generateArchDiagram(files);
    expect(result).toContain("-->");
  });

  it("shows finding count badge when findings exist for a group", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("lib/b.ts")];
    const findings: ReviewCommentType[] = [
      makeFinding({ file: "src/core/a.ts", severity: "high" }),
    ];
    const result = generateArchDiagram(files, findings);
    expect(result).toContain("[1]");
  });

  it("omits badge when no findings for a group", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("lib/b.ts")];
    const findings: ReviewCommentType[] = [
      makeFinding({ file: "other/x.ts", severity: "high" }),
    ];
    const result = generateArchDiagram(files, findings);
    // Badge [1] should not appear since finding is in unrelated file
    expect(result).not.toContain("[1]");
  });

  it("applies critical class to groups with critical/high findings", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("lib/b.ts")];
    const findings: ReviewCommentType[] = [
      makeFinding({ file: "src/core/a.ts", severity: "critical" }),
    ];
    const result = generateArchDiagram(files, findings);
    expect(result).toContain(":::critical");
  });

  it("includes critical classDef", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("lib/b.ts")];
    const result = generateArchDiagram(files, []);
    expect(result).toContain("classDef critical");
  });

  it("handles root-level files as 'root' group", () => {
    const files = [makeFile("readme.md"), makeFile("src/app.ts")];
    const result = generateArchDiagram(files);
    expect(result).toContain("root");
  });

  it("sanitizes group keys for safe mermaid IDs", () => {
    const files = [makeFile("my-module/a.ts"), makeFile("src/app.ts")];
    const result = generateArchDiagram(files);
    // Node ID should be sanitized (hyphens → underscores)
    expect(result).toContain("my_module[");
    // Label still shows original hyphenated name
    expect(result).toContain("my-module");
  });
});

describe("generateSeverityDiagram", () => {
  it("returns empty string for empty findings", () => {
    expect(generateSeverityDiagram([])).toBe("");
  });

  it("wraps output in mermaid code block", () => {
    const findings = [makeFinding({ severity: "high" })];
    const result = generateSeverityDiagram(findings);
    expect(result).toMatch(/^```mermaid\n/);
    expect(result).toMatch(/\n```$/);
  });

  it("generates flowchart LR", () => {
    const findings = [makeFinding({ severity: "high" })];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("flowchart LR");
  });

  it("shows total findings count", () => {
    const findings = [makeFinding({ severity: "high" }), makeFinding({ severity: "low" })];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("2 findings");
  });

  it("creates node for each severity present", () => {
    const findings = [
      makeFinding({ severity: "critical" }),
      makeFinding({ severity: "medium" }),
      makeFinding({ severity: "low" }),
    ];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("critical");
    expect(result).toContain("medium");
    expect(result).toContain("low");
  });

  it("does not create nodes for severities with zero findings", () => {
    const findings = [makeFinding({ severity: "high" })];
    const result = generateSeverityDiagram(findings);
    // nitpick should not appear as a node since no findings
    expect(result).not.toMatch(/nitpick\[.*\d+.*\]/);
  });

  it("shows count per severity", () => {
    const findings = [
      makeFinding({ severity: "high" }),
      makeFinding({ severity: "high" }),
      makeFinding({ severity: "low" }),
    ];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("high<br/>2");
    expect(result).toContain("low<br/>1");
  });

  it("applies color classDefs per severity", () => {
    const findings = [
      makeFinding({ severity: "critical" }),
      makeFinding({ severity: "low" }),
    ];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("classDef critical");
    expect(result).toContain("classDef low");
  });

  it("orders severity nodes in standard order", () => {
    const findings = [
      makeFinding({ severity: "low" }),
      makeFinding({ severity: "critical" }),
      makeFinding({ severity: "high" }),
    ];
    const result = generateSeverityDiagram(findings);
    // critical should appear before high, high before low in the output
    const critIdx = result.indexOf("critical[");
    const highIdx = result.indexOf("high[");
    const lowIdx = result.indexOf("low[");
    expect(critIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

  it("handles deeply nested src subdirectories", () => {
    const files = [
      makeFile("src/core/services/auth.ts"),
      makeFile("src/api/routes/health.ts"),
    ];
    const result = generateArchDiagram(files);
    // src/core and src/api are the group keys
    expect(result).toContain("src_core");
    expect(result).toContain("src_api");
  });

  it("handles mixed root and src files", () => {
    const files = [
      makeFile("package.json", 5, 0),
      makeFile("src/app.ts", 10, 2),
      makeFile("test/main.ts", 3, 1),
    ];
    const result = generateArchDiagram(files);
    expect(result).toContain("root");
    expect(result).toContain("src");
    expect(result).toContain("test");
  });

  it("applies critical class for high severity findings", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("lib/b.ts")];
    const findings: ReviewCommentType[] = [
      makeFinding({ file: "src/core/a.ts", severity: "high" }),
    ];
    const result = generateArchDiagram(files, findings);
    expect(result).toContain(":::critical");
  });

  it("does not apply critical class for medium findings", () => {
    const files = [makeFile("src/core/a.ts"), makeFile("lib/b.ts")];
    const findings: ReviewCommentType[] = [
      makeFinding({ file: "src/core/a.ts", severity: "medium" }),
    ];
    const result = generateArchDiagram(files, findings);
    expect(result).not.toContain(":::critical");
  });

  it("sums additions/deletions across files in same group", () => {
    const files = [
      makeFile("src/core/a.ts", 15, 3),
      makeFile("src/core/b.ts", 5, 7),
      makeFile("lib/c.ts", 2, 1),
    ];
    const result = generateArchDiagram(files);
    expect(result).toContain("+20/-10");
  });

  it("handles files with underscore in directory name", () => {
    const files = [
      makeFile("my_app/src/a.ts"),
      makeFile("other/b.ts"),
    ];
    const result = generateArchDiagram(files);
    expect(result).toContain("my_app");
  });

  it("generates severity diagram with single finding", () => {
    const findings = [makeFinding({ severity: "critical" })];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("1 findings");
    expect(result).toContain("critical<br/>1");
  });

  it("handles nitpick severity in severity diagram", () => {
    const findings = [makeFinding({ severity: "nitpick" })];
    const result = generateSeverityDiagram(findings);
    expect(result).toContain("nitpick<br/>1");
    expect(result).toContain("classDef nitpick");
  });
