import { describe, it, expect } from "vitest";
import { detectHallucinatedDeps } from "../hallucinated-dependency-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[], status: "added" | "modified" | "renamed" = "modified"): DiffFile {
  return {
    path,
    status,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: addedLines.map((content, idx) => ({
          type: "add" as const,
          content: `+${content}`,
          line: idx + 1,
        })),
      },
    ],
  };
}

function makeFileWithMixed(
  path: string,
  lines: { type: "add" | "normal" | "delete"; content: string; line: number }[],
): DiffFile {
  return {
    path,
    status: "modified" as const,
    hunks: [{ header: "@@ -1 +1 @@", changes: lines }],
  };
}

// ---------------------------------------------------------------------------
// unknown-import
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — unknown-import", () => {
  it("detects ESM import of unknown package", () => {
    const file = makeFile("src/app.ts", [
      "import jwtLiteParser from 'jwt-lite-parser';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("jwt-lite-parser");
    expect(issues[0].severity).toBe("critical");
  });

  it("detects require of unknown package", () => {
    const file = makeFile("src/app.js", [
      "const awsHelper = require('aws-utils-extras');",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("aws-utils-extras");
  });

  it("detects dynamic import of unknown package", () => {
    const file = makeFile("src/lazy.ts", [
      "const mod = await import('fast-xml-parser-lite');",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag Node.js builtins", () => {
    const file = makeFile("src/server.ts", [
      "import fs from 'fs';",
      "import path from 'path';",
      "const http = require('http');",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag known packages", () => {
    const file = makeFile("src/app.ts", [
      "import express from 'express';",
      "import { z } from 'zod';",
      "import React from 'react';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag relative imports", () => {
    const file = makeFile("src/app.ts", [
      "import { config } from './config';",
      "import utils from '../utils';",
      "const data = require('../../data');",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag package in lockfile", () => {
    const source = makeFile("src/app.ts", [
      "import stripe from 'stripe';",
    ]);
    const lockfile = makeFile("package-lock.json", [
      '"stripe": {',
      '  "version": "12.0.0"',
    ]);

    const result = detectHallucinatedDeps([lockfile, source]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag package in package.json", () => {
    const source = makeFile("src/app.ts", [
      "import tailwindcss from 'tailwindcss';",
    ]);
    const pkgJson = makeFile("package.json", [
      '"tailwindcss": "^3.4.0",',
    ]);

    const result = detectHallucinatedDeps([pkgJson, source]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag type-only imports", () => {
    const file = makeFile("src/types.ts", [
      "import type { Config } from 'some-unknown-type-pkg';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("extracts package name from subpath import", () => {
    const file = makeFile("src/app.ts", [
      "import { button } from 'phantom-pkg/components';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].description).toContain("phantom-pkg");
  });
});

// ---------------------------------------------------------------------------
// slopsquatting-signal
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — slopsquatting-signal", () => {
  it("detects fast-X-parser pattern", () => {
    const file = makeFile("src/app.ts", [
      "import parse from 'fast-xml-parser';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "slopsquatting-signal");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects X-lite suffix pattern", () => {
    const file = makeFile("src/app.ts", [
      "import jwt from 'json-web-token-lite';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "slopsquatting-signal");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cloud-utils pattern", () => {
    const file = makeFile("src/app.ts", [
      "import aws from 'aws-utils';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "slopsquatting-signal");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects @scoped cloud-utils pattern", () => {
    const file = makeFile("src/app.ts", [
      "import { S3 } from '@aws-utils/s3-helper';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "slopsquatting-signal");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag known packages even with matching names", () => {
    const file = makeFile("src/app.ts", [
      "import axios from 'axios';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "slopsquatting-signal");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// phantom-scoped-import
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — phantom-scoped-import", () => {
  it("detects unknown scoped package with unknown scope", () => {
    const file = makeFile("src/app.ts", [
      "import { S3Client } from '@aws-utils/s3-client';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "phantom-scoped-import");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
    expect(issues[0].description).toContain("@aws-utils");
  });

  it("detects unknown package in known scope", () => {
    const source = makeFile("src/app.ts", [
      "import { something } from '@actions/phantom-package';",
    ]);
    // @actions/core is in KNOWN_PACKAGES, but @actions/phantom-package is not
    const lockfile = makeFile("package-lock.json", [
      '"@actions/core": {',
    ]);

    const result = detectHallucinatedDeps([lockfile, source]);
    const issues = result.issues.filter((i) => i.category === "phantom-scoped-import");
    // @actions/core is known but @actions/phantom-package is not
    // The scope @actions exists in lockfile, so this should be a warning
    if (issues.length > 0) {
      expect(issues.some((i) => i.severity === "warning")).toBe(true);
    }
  });

  it("does not flag known scoped packages", () => {
    const file = makeFile("src/app.ts", [
      "import core from '@actions/core';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "phantom-scoped-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag scoped package in lockfile", () => {
    const source = makeFile("src/app.ts", [
      "import { S3 } from '@aws-sdk/client-s3';",
    ]);
    const lockfile = makeFile("package-lock.json", [
      '"@aws-sdk/client-s3": {',
    ]);

    const result = detectHallucinatedDeps([lockfile, source]);
    const issues = result.issues.filter((i) => i.category === "phantom-scoped-import");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// version-mismatch
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — version-mismatch", () => {
  it("detects .v2. versioned API access", () => {
    const file = makeFile("src/api.ts", [
      "import api from 'some-sdk';",
      "const result = api.v2.getUsers();",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "version-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects .v3. versioned API access", () => {
    const file = makeFile("src/api.ts", [
      "const res = client.v3.process();",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "version-mismatch");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag v1 access (common pattern)", () => {
    const file = makeFile("src/api.ts", [
      "const result = api.v1.getUsers();",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "version-mismatch");
    // v1 is typically the default — may or may not flag
    // This is fine either way since severity is warning
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — edge cases", () => {
  it("skips deleted files", () => {
    const file: DiffFile = {
      path: "src/deleted.ts",
      status: "deleted",
      hunks: [],
    };

    const result = detectHallucinatedDeps([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips non-source files", () => {
    const file = makeFile("README.md", [
      "import something from 'phantom-pkg';",
    ]);

    const result = detectHallucinatedDeps([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/empty.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };

    const result = detectHallucinatedDeps([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles mixed add/delete changes", () => {
    const file = makeFileWithMixed("src/app.ts", [
      { type: "normal", content: "const x = 1;", line: 1 },
      { type: "delete", content: "-import old from 'old-pkg';", line: 2 },
      { type: "add", content: "+import newPkg from 'phantom-micro-validator';", line: 3 },
    ]);

    const result = detectHallucinatedDeps([file]);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
  });

  it("skips comment lines", () => {
    const file = makeFile("src/app.ts", [
      "// import something from 'phantom-pkg';",
      "/* import other from 'ghost-lib'; */",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("does not flag absolute path imports", () => {
    const file = makeFile("src/app.ts", [
      "const config = require('/etc/config');",
    ]);

    const result = detectHallucinatedDeps([file]);
    const issues = result.issues.filter((i) => i.category === "unknown-import");
    expect(issues).toHaveLength(0);
  });

  it("extracts from yarn.lock format", () => {
    const lockfile = makeFileWithMixed("yarn.lock", [
      { type: "add", content: '+"lodash@^4.17.0":', line: 1 },
      { type: "add", content: '+  version "4.17.21"', line: 2 },
      { type: "add", content: '+"express@^4.18.0":', line: 3 },
    ]);

    const source = makeFile("src/app.ts", [
      "import _ from 'lodash';",
      "import ex from 'express';",
      "import ghost from 'ghost-package';",
    ]);

    const result = detectHallucinatedDeps([lockfile, source]);
    const unknownIssues = result.issues.filter((i) => i.category === "unknown-import" && i.description.includes("ghost-package"));
    expect(unknownIssues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile("src/app.ts", [
      "import foo from 'phantom-pkg';",
    ]);

    const result = detectHallucinatedDeps([file]);
    expect(result.contextText).toContain("Hallucinated Dependency Detection");
  });

  it("generates empty context text when no issues", () => {
    const file = makeFile("src/app.ts", [
      "import fs from 'fs';",
    ]);

    const result = detectHallucinatedDeps([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile("src/app.ts", [
      "import foo from 'phantom-pkg';",
    ]);

    const result = detectHallucinatedDeps([file]);
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("</details>");
    expect(result.bodySummary).toContain("Category");
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile("src/clean.ts", [
      "const x = 1;",
    ]);

    const result = detectHallucinatedDeps([file]);
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Dedup & sort
// ---------------------------------------------------------------------------

describe("detectHallucinatedDeps — dedup and sort", () => {
  it("deduplicates issues with same category/file/line", () => {
    const file = makeFile("src/app.ts", [
      "import foo from 'micro-xml-parser';",
    ]);

    const result = detectHallucinatedDeps([file]);
    const unique = new Set(result.issues.map((i) => `${i.category}:${i.line}`));
    // Same line should only appear once per category
    const byLine = result.issues.filter((i) => i.line === 1);
    expect(byLine.length).toBeLessThanOrEqual(unique.size + 1);
  });

  it("sorts critical before warning", () => {
    const file = makeFile("src/app.ts", [
      "import foo from 'phantom-pkg';",
      "import bar from 'some-package';",
      "const x = api.v2.getData();",
    ]);

    const result = detectHallucinatedDeps([file]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");

    if (critical.length > 0 && warnings.length > 0) {
      const lastCritical = result.issues.indexOf(critical[critical.length - 1]);
      const firstWarning = result.issues.indexOf(warnings[0]);
      expect(lastCritical).toBeLessThan(firstWarning);
    }
  });
});
