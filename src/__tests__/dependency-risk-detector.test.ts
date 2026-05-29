/**
 * Tests for Dependency Risk Detector
 */
import { describe, it, expect } from "vitest";
import { detectDependencyRisk } from "../dependency-risk-detector.js";
import type { DiffFile } from "../diff.js";

function makeDiffFile(path: string, added: string[], removed: string[] = [], status: "modified" | "added" = "modified"): DiffFile {
  const addChanges = added.map((content, i) => ({ type: "add" as const, content: `+${content}`, line: i + 1, ln: i + 1 }));
  const delChanges = removed.map((content, i) => ({ type: "delete" as const, content: `-${content}`, line: i + 1, ln: i + 1 }));
  return {
    path,
    status,
    hunks: [{ header: "@@ -0 +0 @@", changes: [...delChanges, ...addChanges] }],
  };
}

// ---------------------------------------------------------------------------
// major-version-bump
// ---------------------------------------------------------------------------

describe("detectDependencyRisk — major-version-bump", () => {
  it("detects major version bump", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "express": "^5.0.0",'],
      ['    "express": "^4.18.2",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "major-version-bump");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("express");
  });

  it("does NOT flag minor version bump", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "lodash": "^4.18.0",'],
      ['    "lodash": "^4.17.21",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "major-version-bump");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag patch version bump", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "react": "^18.3.2",'],
      ['    "react": "^18.3.1",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "major-version-bump");
    expect(issues).toHaveLength(0);
  });

  it("detects scoped package major bump", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "@prisma/client": "^6.0.0",'],
      ['    "@prisma/client": "^5.10.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "major-version-bump");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores non-package.json files", () => {
    const pkgFile = makeDiffFile("src/config.ts", ['"express": "^5.0.0"'], ['"express": "^4.18.2"']);
    const result = detectDependencyRisk([pkgFile]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// unused-new-dependency
// ---------------------------------------------------------------------------

describe("detectDependencyRisk — unused-new-dependency", () => {
  it("detects new dep without import", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "moment": "^2.30.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "unused-new-dependency");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("moment");
  });

  it("does NOT flag new dep with import", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "lodash": "^4.17.21",']
    );
    const consumerFile = makeDiffFile("src/utils.ts", [
      'import { debounce } from "lodash";',
      'const fn = debounce(handler, 100);',
    ]);
    const result = detectDependencyRisk([pkgFile, consumerFile]);
    const issues = result.issues.filter((i) => i.category === "unused-new-dependency");
    const lodashIssue = issues.find((i) => i.description.includes("lodash"));
    expect(lodashIssue).toBeUndefined();
  });

  it("detects scoped package without import", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "@aws-sdk/client-s3": "^3.500.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "unused-new-dependency");
    expect(issues.some((i) => i.description.includes("@aws-sdk"))).toBe(true);
  });

  it("does NOT flag new dep with scoped import", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "@aws-sdk/client-s3": "^3.500.0",']
    );
    const consumerFile = makeDiffFile("src/s3.ts", [
      'import { S3Client } from "@aws-sdk/client-s3";',
    ]);
    const result = detectDependencyRisk([pkgFile, consumerFile]);
    const issues = result.issues.filter((i) => i.category === "unused-new-dependency");
    const awsIssue = issues.find((i) => i.description.includes("@aws-sdk"));
    expect(awsIssue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dependency-downgrade
// ---------------------------------------------------------------------------

describe("detectDependencyRisk — dependency-downgrade", () => {
  it("detects major version downgrade", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "react": "^17.0.2",'],
      ['    "react": "^18.2.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "dependency-downgrade");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects minor version downgrade", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "next": "^14.1.0",'],
      ['    "next": "^14.2.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "dependency-downgrade");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag version upgrade", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "express": "^4.19.0",'],
      ['    "express": "^4.18.2",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "dependency-downgrade");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// typosquatting-suspect
// ---------------------------------------------------------------------------

describe("detectDependencyRisk — typosquatting-suspect", () => {
  it("detects typo of popular package (lodass vs lodash)", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "lodass": "^4.17.21",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "typosquatting-suspect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("lodash");
  });

  it("detects typo (expres vs express)", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "expres": "^4.18.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "typosquatting-suspect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag legitimate package", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "lodash": "^4.17.21",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "typosquatting-suspect");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag unrelated package with long name", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "my-company-utils": "^1.0.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "typosquatting-suspect");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined / edge cases
// ---------------------------------------------------------------------------

describe("detectDependencyRisk — combined scenarios", () => {
  it("detects multiple categories", () => {
    const pkgFile = makeDiffFile("package.json",
      [
        '    "react": "^17.0.0",',       // downgrade from 18
        '    "lodass": "^4.17.0",',       // typosquat
        '    "moment": "^2.30.0",',        // unused
      ],
      [
        '    "react": "^18.2.0",',        // old version 18
      ]
    );
    const result = detectDependencyRisk([pkgFile]);
    const cats = new Set(result.issues.map((i) => i.category));
    expect(cats.size).toBeGreaterThanOrEqual(2);
  });

  it("sorts critical before warning", () => {
    const pkgFile = makeDiffFile("package.json",
      [
        '    "moment": "^2.30.0",',        // unused (warning)
        '    "react": "^17.0.0",',        // downgrade (critical)
      ],
      [
        '    "react": "^18.2.0",',
      ]
    );
    const result = detectDependencyRisk([pkgFile]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("handles deleted package.json", () => {
    const file: DiffFile = { path: "package.json", status: "deleted", hunks: [] };
    const result = detectDependencyRisk([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "package.json",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectDependencyRisk([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("produces context text", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "react": "^17.0.0",'],
      ['    "react": "^18.2.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Dependency Risk");
    }
  });

  it("produces body summary with table", () => {
    const pkgFile = makeDiffFile("package.json",
      ['    "react": "^17.0.0",'],
      ['    "react": "^18.2.0",']
    );
    const result = detectDependencyRisk([pkgFile]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty for clean PR with no package.json", () => {
    const file = makeDiffFile("src/app.ts", ["const x = 1;"]);
    const result = detectDependencyRisk([file]);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("returns empty for package.json with no dep changes", () => {
    const pkgFile = makeDiffFile("package.json", ['  "name": "my-app",']);
    const result = detectDependencyRisk([pkgFile]);
    expect(result.issues).toHaveLength(0);
  });
});
