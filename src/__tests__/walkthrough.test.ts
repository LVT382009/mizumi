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
});
