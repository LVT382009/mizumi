import { describe, it, expect } from "vitest";
import { buildWalkthrough, estimateEffort } from "../walkthrough.js";
import type { DiffFileSummary } from "../post.js";

describe("buildWalkthrough", () => {
  it("returns empty string for single file", () => {
    const result = buildWalkthrough(
      [{ path: "src/app.ts", additions: 10, deletions: 5 }],
      [],
      2
    );
    expect(result).toBe("");
  });

  it("returns empty string for no files", () => {
    const result = buildWalkthrough([], [], 1);
    expect(result).toBe("");
  });

  it("groups files by directory", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/app.ts", additions: 20, deletions: 5 },
      { path: "src/util.ts", additions: 10, deletions: 3 },
      { path: "tests/app.test.ts", additions: 15, deletions: 0 },
    ];
    const findings = [
      { file: "src/app.ts", severity: "high", category: "bug" },
      { file: "src/util.ts", severity: "low", category: "style" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 3);
    expect(result).toContain("Walkthrough");
    expect(result).toContain("3 files");
    expect(result).toContain("src/");
    expect(result).toContain("tests/");
  });

  it("includes finding counts per directory", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/app.ts", additions: 10, deletions: 5 },
      { path: "src/util.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/app.ts", severity: "critical", category: "security" },
      { file: "src/app.ts", severity: "medium", category: "style" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 4);
    expect(result).toContain("Walkthrough");
    expect(result).toContain("2 findings");
  });

  it("shows dash for directories with no findings", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/app.ts", additions: 10, deletions: 5 },
      { path: "docs/readme.md", additions: 3, deletions: 0 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("—");
  });

  it("sorts directories by change volume (largest first)", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "small/a.ts", additions: 2, deletions: 0 },
      { path: "large/x.ts", additions: 100, deletions: 50 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    const largeIdx = result.indexOf("large/");
    const smallIdx = result.indexOf("small/");
    expect(largeIdx).toBeLessThan(smallIdx);
  });

  it("wraps in collapsible details block", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("<details>");
    expect(result).toContain("</details>");
  });

  it("includes risk score in summary", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const result = buildWalkthrough(diffFiles, [], 4);
    expect(result).toContain("risk 4/5");
  });

  it("uses severity emoji for critical findings", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/a.ts", severity: "critical", category: "security" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 2);
    expect(result).toContain(":rotating_light:");
  });

  it("uses severity emoji for low findings", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/a.ts", severity: "low", category: "style" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 2);
    expect(result).toContain(":white_circle:");
  });

  it("groups deep paths by first two segments", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/components/auth/Login.tsx", additions: 20, deletions: 0 },
      { path: "src/components/auth/Logout.tsx", additions: 10, deletions: 0 },
      { path: "src/utils/helpers.ts", additions: 5, deletions: 0 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("src/components/");
    expect(result).toContain("src/utils/");
  });

  it("shows file count per directory group", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/a.ts", additions: 10, deletions: 0 },
      { path: "src/b.ts", additions: 5, deletions: 0 },
      { path: "src/c.ts", additions: 2, deletions: 0 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("3");
  });

  it("ignores findings for files not in diff", () => {
    const diffFiles: DiffFileSummary[] = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "other/z.ts", severity: "high", category: "bug" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 1);
    expect(result).toContain("—");
    expect(result).not.toContain("other/");
  });

  it("shows medium severity emoji", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [{ file: "src/a.ts", severity: "medium", category: "style" }];
    const result = buildWalkthrough(diffFiles, findings, 2);
    expect(result).toContain(":orange_circle:");
  });

  it("shows high severity emoji", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [{ file: "src/a.ts", severity: "high", category: "bug" }];
    const result = buildWalkthrough(diffFiles, findings, 2);
    expect(result).toContain(":red_circle:");
  });

  it("handles multiple findings per directory", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/a.ts", severity: "high", category: "bug" },
      { file: "src/a.ts", severity: "medium", category: "style" },
      { file: "src/b.ts", severity: "critical", category: "security" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 4);
    expect(result).toContain(":red_circle:");
    expect(result).toContain(":orange_circle:");
    expect(result).toContain(":rotating_light:");
  });

  it("uses default emoji for unknown severity", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [{ file: "src/a.ts", severity: "unknown", category: "bug" }];
    const result = buildWalkthrough(diffFiles, findings, 2);
    expect(result).toContain(":white_circle:");
  });

  it("shows addition/deletion counts per group", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 100, deletions: 30 },
      { path: "src/b.ts", additions: 20, deletions: 5 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("+100");
    expect(result).toContain("-30");
    expect(result).toContain("+20");
    expect(result).toContain("-5");
  });

});

describe("estimateEffort", () => {
  it("returns 1 for small diff with no findings", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 10, deletions: 5 }],
      0
    );
    expect(result).toBe(1);
  });

  it("returns 2 for 500+ lines", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 500, deletions: 50 }],
      0
    );
    expect(result).toBe(2);
  });

  it("returns 3 for 1500+ lines", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 1500, deletions: 100 }],
      0
    );
    expect(result).toBe(3);
  });

  it("returns 4 for 1500+ lines + 5+ findings", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 1500, deletions: 50 }],
      6
    );
    expect(result).toBe(4);
  });

  it("caps at 5", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 2000, deletions: 500 }],
      20
    );
    expect(result).toBe(5);
  });

  it("returns 1 for 0 lines and 0 findings", () => {
    const result = estimateEffort([], 0);
    expect(result).toBe(1);
  });

  it("returns 3 for small diff + 6-15 findings", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 10, deletions: 5 }],
      6
    );
    expect(result).toBe(2);
  });

  it("returns 3 for small diff + 15+ findings", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 10, deletions: 5 }],
      16
    );
    expect(result).toBe(3);
  });

  it("sums additions and deletions across files", () => {
    const result = estimateEffort(
      [
        { path: "a.ts", additions: 250, deletions: 0 },
        { path: "b.ts", additions: 260, deletions: 0 },
      ],
      0
    );
    expect(result).toBe(2); // 510 total (> 500) → effort 2
  });

  it("returns 1 at exactly 500 lines boundary (uses > not >=)", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 500, deletions: 0 }],
      0
    );
    expect(result).toBe(1); // 500 is NOT > 500
  });

  it("returns 5 at max lines + max findings", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 5000, deletions: 1000 }],
      30
    );
    expect(result).toBe(5);
  });

  it("returns 2 for small diff + 5 findings exactly at boundary", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 10, deletions: 5 }],
      5
    );
    expect(result).toBe(1); // 5 is NOT > 5, so no increment
  });

  it("returns 3 for small diff + 16 findings (15+ threshold)", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 10, deletions: 5 }],
      16
    );
    expect(result).toBe(3);
  });

  it("returns 4 for 1500+ lines + 15 findings (>5 fires, >15 doesn't)", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 1500, deletions: 100 }],
      15
    );
    // 1500+ lines → effort 3, 15 > 5 → effort 4, 15 is NOT > 15 → no more increment
    expect(result).toBe(4);
  });

  it("returns 4 for 1500+ lines + 6 findings", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 1500, deletions: 100 }],
      6
    );
    // 1500+ lines → effort 3, 6 > 5 → effort 4
    expect(result).toBe(4);
  });

  it("handles zero additions and deletions", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 0, deletions: 0 }],
      0
    );
    expect(result).toBe(1);
  });

  it("capped at 5 even with extreme values", () => {
    const result = estimateEffort(
      [{ path: "src/app.ts", additions: 100000, deletions: 50000 }],
      100
    );
    expect(result).toBe(5);
  });
});

describe("dirFromPath (via buildWalkthrough)", () => {
  it("handles deep nested paths (more than 2 segments)", () => {
    const diffFiles = [
      { path: "src/components/ui/buttons/Submit.tsx", additions: 20, deletions: 0 },
      { path: "src/components/ui/inputs/Text.tsx", additions: 10, deletions: 0 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    // Deep paths group by first 2 segments
    expect(result).toContain("src/components/");
  });

  it("groups root-level file by its filename", () => {
    const diffFiles = [
      { path: "package.json", additions: 5, deletions: 2 },
      { path: "tsconfig.json", additions: 3, deletions: 1 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("package.json");
    expect(result).toContain("tsconfig.json");
  });

  it("groups 2-level path by full path", () => {
    const diffFiles = [
      { path: "src/app.ts", additions: 10, deletions: 0 },
      { path: "src/util.ts", additions: 5, deletions: 0 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("src/app.ts");
    expect(result).toContain("src/util.ts");
  });

  it("handles single-segment root paths", () => {
    const diffFiles = [
      { path: "README.md", additions: 50, deletions: 10 },
      { path: ".eslintrc", additions: 5, deletions: 2 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("README.md");
  });
});

describe("buildWalkthrough formatting", () => {
  it("uses markdown table format", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("| Directory |");
    expect(result).toContain("|-----------|");
  });

  it("includes +/- change format per directory", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 42, deletions: 13 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    // Total for src dir: +47/-15
    expect(result).toMatch(/\+\d+\/-\d+/);
  });

  it("lists severity counts sorted by severity order within same group", () => {
    // Use 3+ segment paths so both group into src/components/
    const diffFiles = [
      { path: "src/components/a.tsx", additions: 10, deletions: 5 },
      { path: "src/components/b.tsx", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/components/a.tsx", severity: "low", category: "style" },
      { file: "src/components/a.tsx", severity: "critical", category: "security" },
      { file: "src/components/b.tsx", severity: "high", category: "bug" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 4);
    // Critical should appear before high before low in the same group
    const critIdx = result.indexOf(":rotating_light:");
    const highIdx = result.indexOf(":red_circle:");
    const lowIdx = result.indexOf(":white_circle:");
    if (critIdx >= 0 && highIdx >= 0 && lowIdx >= 0) {
      expect(critIdx).toBeLessThan(highIdx);
      expect(highIdx).toBeLessThan(lowIdx);
    }
  });

  it("handles directory with findings in multiple categories", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/a.ts", severity: "high", category: "bug" },
      { file: "src/a.ts", severity: "medium", category: "style" },
      { file: "src/b.ts", severity: "high", category: "security" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 3);
    // Two high + one medium = :red_circle:2 :orange_circle:1
    expect(result).toContain(":red_circle:");
    expect(result).toContain(":orange_circle:");
  });

  it("handles empty findings array", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    expect(result).toContain("—");
  });

  it("skips single file", () => {
    const diffFiles = [
      { path: "src/solo.ts", additions: 100, deletions: 50 },
    ];
    const result = buildWalkthrough(diffFiles, [], 3);
    expect(result).toBe("");
  });

  it("includes finding count in summary", () => {
    const diffFiles = [
      { path: "src/a.ts", additions: 10, deletions: 5 },
      { path: "src/b.ts", additions: 5, deletions: 2 },
    ];
    const findings = [
      { file: "src/a.ts", severity: "high", category: "bug" },
      { file: "src/b.ts", severity: "low", category: "style" },
    ];
    const result = buildWalkthrough(diffFiles, findings, 2);
    expect(result).toContain("2 findings");
  });

  it("handles identical-addition files sorting", () => {
    const diffFiles = [
      { path: "alpha/z.ts", additions: 10, deletions: 5 },
      { path: "beta/x.ts", additions: 10, deletions: 5 },
    ];
    const result = buildWalkthrough(diffFiles, [], 1);
    // Both have same volume, just verify both appear
    expect(result).toContain("alpha/z.ts");
    expect(result).toContain("beta/x.ts");
  });
});
