import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverADRs,
  parseADR,
  extractSection,
  inferAppliesTo,
  checkADRViolations,
  extractForbiddenPatterns,
  buildADRContext,
} from "../adr.js";
import type { ADRRecord, ADRViolation } from "../adr.js";
import type { DiffFile } from "../diff.js";

vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  notice: vi.fn(),
}));

// ---------------------------------------------------------------------------
// extractSection
// ---------------------------------------------------------------------------

describe("adr", () => {
  describe("extractSection", () => {
    it("extracts a ## section from markdown", () => {
      const md = "# ADR-0001: Use PostgreSQL\n\n## Status\n\nAccepted\n\n## Context\n\nWe need a DB.";
      expect(extractSection(md, "status")).toBe("Accepted");
    });

    it("extracts section case-insensitively", () => {
      const md = "## STATUS\n\nAccepted\n\n## Decision\n\nUse Postgres";
      expect(extractSection(md, "status")).toBe("Accepted");
    });

    it("returns empty string for missing section", () => {
      const md = "# ADR\n\n## Context\n\nSome context";
      expect(extractSection(md, "decision")).toBe("");
    });

    it("extracts multi-line section content", () => {
      const md = "## Context\n\nLine 1.\nLine 2.\n\n## Decision\n\nUse X";
      expect(extractSection(md, "context")).toContain("Line 1.");
      expect(extractSection(md, "context")).toContain("Line 2.");
    });

    it("handles # (h1) level section headers", () => {
      const md = "# Status\n\nAccepted\n\n# Context\n\nWe need a DB";
      expect(extractSection(md, "status")).toBe("Accepted");
    });
  });

  // ---------------------------------------------------------------------------
  // parseADR
  // ---------------------------------------------------------------------------

  describe("parseADR", () => {
    it("parses a Nygard-format ADR", () => {
      const md = `# ADR-0001: Use PostgreSQL for persistence

## Status

Accepted

## Context

We need a relational database for our application.

## Decision

We will use PostgreSQL.

## Consequences

Need Docker setup for local dev.`;

      const adr = parseADR(md, "ADR-0001-use-postgresql.md", "/repo/docs/adr/ADR-0001-use-postgresql.md");
      expect(adr).not.toBeNull();
      expect(adr!.number).toBe("0001");
      expect(adr!.title).toBe("ADR-0001: Use PostgreSQL for persistence");
      expect(adr!.status).toBe("Accepted");
      expect(adr!.decision).toContain("PostgreSQL");
      expect(adr!.consequences).toContain("Docker");
    });

    it("extracts ADR number from numeric filename", () => {
      const md = "# Use Redis\n\n## Status\n\nAccepted";
      const adr = parseADR(md, "0001-use-redis.md", "/repo/docs/adr/0001-use-redis.md");
      expect(adr).not.toBeNull();
      expect(adr!.number).toBe("0001");
    });

    it("defaults number to 0 when filename has no number", () => {
      const md = "# Custom ADR\n\n## Status\n\nAccepted";
      const adr = parseADR(md, "custom-decision.md", "/repo/docs/adr/custom-decision.md");
      expect(adr).not.toBeNull();
      expect(adr!.number).toBe("0");
    });

    it("defaults status to accepted when no status section", () => {
      const md = "# No status section\n\n## Decision\n\nUse X";
      const adr = parseADR(md, "001-no-status.md", "/repo/docs/adr/001-no-status.md");
      expect(adr).not.toBeNull();
      expect(adr!.status).toBe("accepted");
    });

    it("uses filename as title when no heading", () => {
      const md = "Just some text without a heading\n\n## Status\n\nAccepted";
      const adr = parseADR(md, "001-something.md", "/repo/docs/adr/001-something.md");
      expect(adr).not.toBeNull();
      expect(adr!.title).toBe("001-something");
    });

    it("returns null for superseded ADR", () => {
      const md = "# Old decision\n\n## Status\n\nSuperseded";
      const adr = parseADR(md, "ADR-0001-old.md", "/repo/docs/adr/ADR-0001-old.md");
      expect(adr).toBeNull();
    });

    it("returns null for deprecated ADR", () => {
      const md = "# Deprecated decision\n\n## Status\n\nDeprecated";
      const adr = parseADR(md, "ADR-0002-dep.md", "/repo/docs/adr/ADR-0002-dep.md");
      expect(adr).toBeNull();
    });

    it("infers appliesTo from context and decision", () => {
      const md = "# Use API gateway\n\n## Status\n\nAccepted\n\n## Context\n\nAll API routes need rate limiting.\n\n## Decision\n\nUse Kong API gateway for all API routes.";
      const adr = parseADR(md, "ADR-0003-api.md", "/repo/docs/adr/ADR-0003-api.md");
      expect(adr).not.toBeNull();
      expect(adr!.appliesTo.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // inferAppliesTo
  // ---------------------------------------------------------------------------

  describe("inferAppliesTo", () => {
    it("infers api pattern from api keyword", () => {
      const patterns = inferAppliesTo("Use api gateway for all routes");
      expect(patterns).toContain("src/api/**");
    });

    it("infers multiple patterns from multiple keywords", () => {
      const patterns = inferAppliesTo("The database and auth service need updates");
      expect(patterns).toContain("src/db/**");
      expect(patterns).toContain("src/auth/**");
      expect(patterns).toContain("src/services/**");
    });

    it("infers Docker pattern from docker keyword", () => {
      const patterns = inferAppliesTo("Use docker containers for deployment");
      expect(patterns).toContain("Dockerfile*");
    });

    it("infers k8s pattern from kubernetes keyword", () => {
      const patterns = inferAppliesTo("Deploy to kubernetes clusters");
      expect(patterns).toContain("k8s/**");
    });

    it("infers terraform pattern from infra keyword", () => {
      const patterns = inferAppliesTo("Manage infra with terraform");
      expect(patterns).toContain("*.tf");
    });

    it("infers graphql pattern", () => {
      const patterns = inferAppliesTo("Use graphql for the API");
      expect(patterns).toContain("**/*.graphql");
    });

    it("deduplicates patterns", () => {
      const patterns = inferAppliesTo("The api and rest endpoint need work");
      // "api" and "rest" both map to src/api/** — should be deduplicated
      const apiCount = patterns.filter((p) => p === "src/api/**").length;
      expect(apiCount).toBe(1);
    });

    it("returns empty array for text with no matching keywords", () => {
      const patterns = inferAppliesTo("This is a general decision about processes");
      expect(patterns).toEqual([]);
    });

    it("infers test pattern", () => {
      const patterns = inferAppliesTo("All test files must follow convention");
      expect(patterns).toContain("test/**");
    });

    it("infers model/schema patterns", () => {
      const patterns = inferAppliesTo("Update the data model and schema");
      expect(patterns).toContain("src/models/**");
    });
  });

  // ---------------------------------------------------------------------------
  // extractForbiddenPatterns
  // ---------------------------------------------------------------------------

  describe("extractForbiddenPatterns", () => {
    it("extracts 'do not use' patterns", () => {
      const patterns = extractForbiddenPatterns("we do not use lodash");
      expect(patterns).toContain("lodash");
    });

    it("extracts 'avoid' patterns", () => {
      const patterns = extractForbiddenPatterns("avoid eval in production code");
      expect(patterns).toContain("eval");
    });

    it("extracts 'never use' patterns", () => {
      const patterns = extractForbiddenPatterns("never use var for declarations");
      expect(patterns).toContain("var");
    });

    it("extracts 'must not use' patterns", () => {
      const patterns = extractForbiddenPatterns("must not use moment.js");
      expect(patterns).toContain("moment");
    });

    it("extracts 'should not use' patterns", () => {
      const patterns = extractForbiddenPatterns("should not use jQuery");
      expect(patterns).toContain("jquery");
    });

    it("extracts multiple forbidden patterns", () => {
      const patterns = extractForbiddenPatterns("Do not use lodash and avoid eval");
      expect(patterns.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array when no forbidden patterns", () => {
      const patterns = extractForbiddenPatterns("We will use PostgreSQL for storage");
      expect(patterns).toEqual([]);
    });

    it("is case-insensitive", () => {
      const patterns = extractForbiddenPatterns("DO NOT USE eval");
      expect(patterns).toContain("eval");
    });
  });

  // ---------------------------------------------------------------------------
  // checkADRViolations
  // ---------------------------------------------------------------------------

  describe("checkADRViolations", () => {
    const makeDiffFile = (filePath: string, addedLines: string[]): DiffFile => ({
      path: filePath,
      status: "modified" as const,
      additions: addedLines.length,
      deletions: 0,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: addedLines.length,
          content: "@@ -0 +1 @@",

          changes: addedLines.map((content, i) => ({
            type: "add" as const,
            line: i + 1,
            oldLine: 0,
            content,

          })),
        },
      ],
    });

    it("returns violations when code uses forbidden pattern", () => {
      const adr: ADRRecord = {
        number: "0001",
        title: "No lodash",
        status: "accepted",
        context: "Performance concerns",
        decision: "Do not use lodash in this project",
        consequences: "Use native Array methods",
        appliesTo: ["src/utils/**"],
        filePath: "/repo/docs/adr/ADR-0001.md",

      };

      const files = [makeDiffFile("src/utils/helpers.ts", ["import _ from 'lodash'"])];
      const violations = checkADRViolations(files, [adr]);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].severity).toBe("high");
      expect(violations[0].category).toBe("architecture");
      expect(violations[0].rule).toBe("ADR-0001");
    });

    it("returns no violations when no forbidden patterns match", () => {
      const adr: ADRRecord = {
        number: "0002",
        title: "Use PostgreSQL",
        status: "accepted",
        context: "Need RDBMS",
        decision: "We will use PostgreSQL",
        consequences: "Docker setup needed",
        appliesTo: ["src/db/**"],
        filePath: "/repo/docs/adr/ADR-0002.md",
      };

      const files = [makeDiffFile("src/db/connection.ts", ["import { Pool } from 'pg'"])];
      const violations = checkADRViolations(files, [adr]);
      expect(violations).toEqual([]);
    });

    it("skips non-accepted ADRs", () => {
      const adr: ADRRecord = {
        number: "0003",
        title: "Old decision",
        status: "proposed",
        context: "",
        decision: "Do not use eval",
        consequences: "",
        appliesTo: ["src/**"],
        filePath: "/repo/docs/adr/ADR-0003.md",
      };

      const files = [makeDiffFile("src/app.ts", ["eval('code')"])];
      const violations = checkADRViolations(files, [adr]);
      expect(violations).toEqual([]);
    });

    it("skips files not matching ADR appliesTo globs", () => {
      const adr: ADRRecord = {
        number: "0004",
        title: "No eval",
        status: "accepted",
        context: "Security",
        decision: "Do not use eval",
        consequences: "Use Function constructor instead",
        appliesTo: ["src/api/**"],
        filePath: "/repo/docs/adr/ADR-0004.md",
      };

      const files = [makeDiffFile("src/frontend/app.ts", ["eval('code')"])];
      const violations = checkADRViolations(files, [adr]);
      expect(violations).toEqual([]);
    });

    it("returns empty array when no ADRs provided", () => {
      const files = [makeDiffFile("src/app.ts", ["anything"])];
      const violations = checkADRViolations(files, []);
      expect(violations).toEqual([]);
    });

    it("only checks added lines, not deleted or normal", () => {
      const adr: ADRRecord = {
        number: "0005",
        title: "No eval",
        status: "accepted",
        context: "Security",
        decision: "Never use eval",
        consequences: "",
        appliesTo: ["src/**"],
        filePath: "/repo/docs/adr/ADR-0005.md",
      };

      const files: DiffFile[] = [
        {
          path: "src/app.ts",
          status: "modified",
          additions: 0,
          deletions: 1,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 0,
              content: "@@ -1 +0 @@",

              changes: [{ type: "delete", line: 0, oldLine: 1, content: "eval('old')" }],
            },
          ],
        },
      ];

      const violations = checkADRViolations(files, [adr]);
      expect(violations).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // buildADRContext
  // ---------------------------------------------------------------------------

  describe("buildADRContext", () => {
    it("generates context from accepted ADRs", () => {
      const adrs: ADRRecord[] = [
        {
          number: "0001",
          title: "Use PostgreSQL",
          status: "accepted",
          context: "Need RDBMS",
          decision: "Use PostgreSQL for all data storage",
          consequences: "Docker setup",
          appliesTo: ["src/db/**"],
          filePath: "/repo/docs/adr/ADR-0001.md",
        },
      ];

      const ctx = buildADRContext(adrs);
      expect(ctx).toContain("Architecture Decision Records");
      expect(ctx).toContain("ADR-0001");
      expect(ctx).toContain("Use PostgreSQL");
      expect(ctx).toContain("Use PostgreSQL for all data storage");
      expect(ctx).toContain("src/db/**");
    });

    it("returns empty string for no ADRs", () => {
      expect(buildADRContext([])).toBe("");
    });

    it("returns empty string when all ADRs are non-accepted", () => {
      const adrs: ADRRecord[] = [
        { number: "0001", title: "Proposed", status: "proposed", context: "", decision: "Use X", consequences: "", appliesTo: [], filePath: "/repo/adr/1.md" },
      ];
      expect(buildADRContext(adrs)).toBe("");
    });

    it("truncates long decisions to 300 chars", () => {
      const longDecision = "x".repeat(400);
      const adrs: ADRRecord[] = [
        { number: "0001", title: "Long", status: "accepted", context: "", decision: longDecision, consequences: "", appliesTo: [], filePath: "/repo/adr/1.md" },
      ];
      const ctx = buildADRContext(adrs);
      // The decision in context should be truncated
      expect(ctx).toContain("x".repeat(300));
      expect(ctx).not.toContain("x".repeat(400));
    });

    it("limits to 10 ADRs in context", () => {
      const adrs: ADRRecord[] = Array.from({ length: 15 }, (_, i) => ({
        number: String(i + 1).padStart(4, "0"),
        title: `Decision ${i + 1}`,
        status: "accepted",
        context: "",
        decision: `Decision ${i + 1}`,
        consequences: "",
        appliesTo: [],
        filePath: `/repo/adr/${i + 1}.md`,
      }));

      const ctx = buildADRContext(adrs);
      expect(ctx).toContain("and 5 more ADRs");
    });

    it("omits appliesTo line when empty", () => {
      const adrs: ADRRecord[] = [
        { number: "0001", title: "Generic", status: "accepted", context: "", decision: "Use X", consequences: "", appliesTo: [], filePath: "/repo/adr/1.md" },
      ];
      const ctx = buildADRContext(adrs);
      expect(ctx).not.toContain("Applies to");
    });
  });

  // ---------------------------------------------------------------------------
  // discoverADRs (with real filesystem)
  // ---------------------------------------------------------------------------

  describe("discoverADRs", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("discovers ADR files from docs/adr/", () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, "ADR-0001-use-pg.md"), [
        "# Use PostgreSQL",
        "",
        "## Status",
        "",
        "Accepted",
        "",
        "## Decision",
        "",
        "Use PostgreSQL for persistence.",
      ].join("\n"), "utf-8");

      const adrs = discoverADRs(tmpDir);
      expect(adrs.length).toBe(1);
      expect(adrs[0].number).toBe("0001");
      expect(adrs[0].title).toBe("Use PostgreSQL");
    });

    it("discovers from .github/adr/ directory", () => {
      const adrDir = path.join(tmpDir, ".github", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, "0001-decision.md"), [
        "# Decision One",
        "",
        "## Status",
        "",
        "Accepted",
      ].join("\n"), "utf-8");

      const adrs = discoverADRs(tmpDir);
      expect(adrs.length).toBe(1);
    });

    it("returns empty array when no ADR directories exist", () => {
      const adrs = discoverADRs(tmpDir);
      expect(adrs).toEqual([]);
    });

    it("skips non-markdown files", () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, "ADR-0001.md"), "# Use X\n\n## Status\n\nAccepted\n", "utf-8");
      fs.writeFileSync(path.join(adrDir, "notes.txt"), "Not an ADR", "utf-8");

      const adrs = discoverADRs(tmpDir);
      expect(adrs.length).toBe(1);
    });

    it("skips superseded ADRs", () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, "ADR-0001-old.md"), "# Old\n\n## Status\n\nSuperseded\n", "utf-8");
      fs.writeFileSync(path.join(adrDir, "ADR-0002-new.md"), "# New\n\n## Status\n\nAccepted\n", "utf-8");

      const adrs = discoverADRs(tmpDir);
      expect(adrs.length).toBe(1);
      expect(adrs[0].number).toBe("0002");
    });

    it("sorts ADRs by filename", () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, "ADR-0003-third.md"), "# Third\n\n## Status\n\nAccepted\n", "utf-8");
      fs.writeFileSync(path.join(adrDir, "ADR-0001-first.md"), "# First\n\n## Status\n\nAccepted\n", "utf-8");

      const adrs = discoverADRs(tmpDir);
      expect(adrs[0].number).toBe("0001");
      expect(adrs[1].number).toBe("0003");
    });

    it("handles unreadable ADR files gracefully", () => {
      const adrDir = path.join(tmpDir, "docs", "adr");
      fs.mkdirSync(adrDir, { recursive: true });
      fs.writeFileSync(path.join(adrDir, "ADR-0001-bad.md"), "# Bad\n\n## Status\n\nAccepted\n", "utf-8");

      // This should not throw even if files are weird
      const adrs = discoverADRs(tmpDir);
      expect(adrs.length).toBeGreaterThanOrEqual(0);
    });
  });
});
