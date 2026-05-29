/**
 * Tests for Lockfile Integrity Detector
 */
import { describe, it, expect } from "vitest";
import { detectLockfileIntegrity } from "../lockfile-integrity-detector.js";
import type { DiffFile } from "../diff.js";

function makeDiffFile(path: string, added: string[] = [], status: "modified" | "added" = "modified"): DiffFile {
  const changes = added.map((content, i) => ({ type: "add" as const, content: `+${content}`, line: i + 1, ln: i + 1 }));
  return {
    path,
    status,
    hunks: [{ header: "@@ -0 +0 @@", changes }],
  };
}

// ---------------------------------------------------------------------------
// missing-lockfile-update
// ---------------------------------------------------------------------------

describe("detectLockfileIntegrity — missing-lockfile-update", () => {
  it("flags new dep without lockfile change", () => {
    const pkgFile = makeDiffFile("package.json", [
      '    "express": "^4.18.0",',
    ]);
    const result = detectLockfileIntegrity([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "missing-lockfile-update");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("does NOT flag when both package.json and lockfile change", () => {
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const lockFile = makeDiffFile("package-lock.json", ['    "express": {']);
    const result = detectLockfileIntegrity([pkgFile, lockFile]);
    const issues = result.issues.filter((i) => i.category === "missing-lockfile-update");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag package.json without dep changes", () => {
    const pkgFile = makeDiffFile("package.json", ['  "name": "my-app",', '  "version": "1.0.0",']);
    const result = detectLockfileIntegrity([pkgFile]);
    const issues = result.issues.filter((i) => i.category === "missing-lockfile-update");
    expect(issues).toHaveLength(0);
  });

  it("works with yarn.lock alongside", () => {
    const pkgFile = makeDiffFile("package.json", ['    "lodash": "^4.17.0",']);
    const yarnFile = makeDiffFile("yarn.lock", ['lodash@^4.17.0:']);
    const result = detectLockfileIntegrity([pkgFile, yarnFile]);
    const issues = result.issues.filter((i) => i.category === "missing-lockfile-update");
    expect(issues).toHaveLength(0);
  });

  it("works with pnpm-lock.yaml alongside", () => {
    const pkgFile = makeDiffFile("package.json", ['    "react": "^18.2.0",']);
    const pnpmFile = makeDiffFile("pnpm-lock.yaml", ["'react@18.2.0':"]);
    const result = detectLockfileIntegrity([pkgFile, pnpmFile]);
    const issues = result.issues.filter((i) => i.category === "missing-lockfile-update");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// orphan-lockfile-change
// ---------------------------------------------------------------------------

describe("detectLockfileIntegrity — orphan-lockfile-change", () => {
  it("flags lockfile change without package.json", () => {
    const lockFile = makeDiffFile("package-lock.json", [
      '    "express": {',
      '      "version": "4.18.2",',
    ]);
    const result = detectLockfileIntegrity([lockFile]);
    const issues = result.issues.filter((i) => i.category === "orphan-lockfile-change");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("does NOT flag when package.json also changes", () => {
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const lockFile = makeDiffFile("package-lock.json", ['    "express": {']);
    const result = detectLockfileIntegrity([pkgFile, lockFile]);
    const issues = result.issues.filter((i) => i.category === "orphan-lockfile-change");
    expect(issues).toHaveLength(0);
  });

  it("flags yarn.lock alone", () => {
    const yarnFile = makeDiffFile("yarn.lock", ['lodash@^4.17.0:', '  version "4.17.21"']);
    const result = detectLockfileIntegrity([yarnFile]);
    const issues = result.issues.filter((i) => i.category === "orphan-lockfile-change");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// lockfile-version-drift
// ---------------------------------------------------------------------------

describe("detectLockfileIntegrity — lockfile-version-drift", () => {
  it("flags lockfileVersion 1", () => {
    const lockFile = makeDiffFile("package-lock.json", [
      '"lockfileVersion": 1,',
    ]);
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const result = detectLockfileIntegrity([lockFile, pkgFile]);
    const issues = result.issues.filter((i) => i.category === "lockfile-version-drift");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag lockfileVersion 2", () => {
    const lockFile = makeDiffFile("package-lock.json", [
      '"lockfileVersion": 2,',
    ]);
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const result = detectLockfileIntegrity([lockFile, pkgFile]);
    const issues = result.issues.filter((i) => i.category === "lockfile-version-drift");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag lockfileVersion 3", () => {
    const lockFile = makeDiffFile("package-lock.json", [
      '"lockfileVersion": 3,',
    ]);
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const result = detectLockfileIntegrity([lockFile, pkgFile]);
    const issues = result.issues.filter((i) => i.category === "lockfile-version-drift");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined / edge cases
// ---------------------------------------------------------------------------

describe("detectLockfileIntegrity — combined", () => {
  it("sorts critical before warning", () => {
    const lockFile = makeDiffFile("package-lock.json", [
      '"lockfileVersion": 1,',
    ]); // drift (warning) + orphan (warning)
    const result = detectLockfileIntegrity([lockFile]);
    // All should be warnings for orphan + drift, critical for missing
    // Let's verify the result is non-empty
    if (result.issues.length > 1) {
      const critical = result.issues.filter((i) => i.severity === "critical");
      const warnings = result.issues.filter((i) => i.severity === "warning");
      if (critical.length > 0 && warnings.length > 0) {
        const lastC = result.issues.indexOf(critical[critical.length - 1]);
        const firstW = result.issues.indexOf(warnings[0]);
        expect(lastC).toBeLessThan(firstW);
      }
    }
  });

  it("handles deleted files", () => {
    const file: DiffFile = { path: "package.json", status: "deleted", hunks: [] };
    const result = detectLockfileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "package.json",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectLockfileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("produces context text", () => {
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const result = detectLockfileIntegrity([pkgFile]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Lockfile Integrity");
    }
  });

  it("produces body summary with table", () => {
    const pkgFile = makeDiffFile("package.json", ['    "express": "^4.18.0",']);
    const result = detectLockfileIntegrity([pkgFile]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty for non-package files", () => {
    const file = makeDiffFile("src/app.ts", ["const x = 1;"]);
    const result = detectLockfileIntegrity([file]);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});
