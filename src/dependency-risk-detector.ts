/**
 * Dependency Risk Detector — detect risky dependency changes in PRs.
 *
 * No AI code reviewer flags dependency risk patterns beyond known CVEs
 * (Dependabot/Snyk). This detector catches:
 *
 * 1. major-version-bump: SemVer major bumps (v1.x → v2.x) that may break
 *    APIs — reviewer should verify migration guide
 * 2. unused-new-dependency: Package added to package.json but no import
 *    of it in the diff — leftover from AI scaffolding
 * 3. dependency-downgrade: Version number decreased — security risk or
 *    accidental revert
 * 4. typosquatting-suspect: Package name similar to popular package
 *    but with transposed/missing chars — supply chain attack vector
 *
 * arxiv 2601.17548: 73% of AI platforms fail trust boundaries; skills
 * define tool types but not targets. LLMs fetch packages without
 * verifying provenance, leading to typosquatting and phantom deps.
 *
 * Zero LLM cost — regex analysis on package.json/package-lock diff.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DepRiskCategory =
  | "major-version-bump"
  | "unused-new-dependency"
  | "dependency-downgrade"
  | "typosquatting-suspect";

export interface DepRiskIssue {
  category: DepRiskCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface DepRiskResult {
  issues: DepRiskIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^[-+]/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

function getRemovedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "delete");
}

const PKG_JSON_RE = /(?:^|[\\/])package\.json$/;
const PKG_LOCK_RE = /(?:^|[\\/])package-lock\.json$/;
const YARN_LOCK_RE = /(?:^|[\\/])yarn\.lock$/;
const PNPM_LOCK_RE = /(?:^|[\\/])pnpm-lock\.yaml$/;
const TEST_FILE_RE = /(?:__tests__|\.test\.|\.spec\.)/;

// Package.json dep line pattern: "package-name": "^1.2.3" or "package-name": "~1.2.3"
// Must match semver ranges: starts with ^, ~, >=, >, or digit
const DEP_LINE_RE = /^\s*["'](@?[\w\-./@]+)["']\s*:\s*["']([~^>=<\s]*\d+\.\d+[^"']+)["']/;

// ---------------------------------------------------------------------------
// Popular packages for typosquatting detection
// ---------------------------------------------------------------------------

const POPULAR_PACKAGES = [
  "react", "lodash", "express", "axios", "moment", "jquery",
  "typescript", "webpack", "babel", "eslint", "prettier",
  "next", "vue", "angular", "svelte", "tailwindcss",
  "prisma", "mongoose", "sequelize", "knex", "drizzle-orm",
  "jest", "mocha", "vitest", "cypress", "playwright",
  "dotenv", "cors", "helmet", "morgan", "chalk",
  "uuid", "nanoid", "zod", "joi", "yup",
  "dayjs", "date-fns", "rxjs", "socket.io", "cron",
  "commander", "yargs", "inquirer", "ora", "execa",
  "node-fetch", "got", "superagent", "undici",
];

// Levenshtein distance for typosquatting detection
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 999;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function isTyposquat(pkgName: string): string | null {
  const name = pkgName.replace(/^@[\w-]+\//, "").split("/").pop()!;
  for (const popular of POPULAR_PACKAGES) {
    if (name === popular) return null;
    if (editDistance(name, popular) <= 2 && name.length >= 3 && popular.length >= 3) {
      return popular;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SemVer helpers
// ---------------------------------------------------------------------------

function parseSemVer(version: string): [number, number, number] | null {
  const m = version.replace(/^[~^>=<\s]+/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function extractVersionFromRange(range: string): string {
  return range.replace(/^[~^>=<\s]+/, "").split("-")[0].split(" ")[0];
}

// ---------------------------------------------------------------------------
// Detection: major-version-bump
// ---------------------------------------------------------------------------

function detectMajorVersionBump(file: DiffFile): DepRiskIssue[] {
  const issues: DepRiskIssue[] = [];
  if (!PKG_JSON_RE.test(file.path)) return issues;

  const removed = getRemovedChanges(file);
  const added = getAddedChanges(file);

  const oldVersions = new Map<string, { version: string; line: number }>();
  for (const change of removed) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (match) {
      oldVersions.set(match[1], { version: match[2], line: change.line });
    }
  }

  for (const change of added) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (!match) continue;

    const pkgName = match[1];
    const newRange = match[2];
    const old = oldVersions.get(pkgName);
    if (!old) continue;

    const oldVer = parseSemVer(extractVersionFromRange(old.version));
    const newVer = parseSemVer(extractVersionFromRange(newRange));
    if (!oldVer || !newVer) continue;

    if (newVer[0] > oldVer[0]) {
      issues.push({
        category: "major-version-bump",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Major version bump for \`${pkgName}\`: ${old.version} → ${newRange} may introduce breaking changes; verify migration guide and test coverage; semver major changes can break API contracts, deprecate methods, or change default behaviors`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: unused-new-dependency
// ---------------------------------------------------------------------------

function detectUnusedNewDependency(
  pkgFile: DiffFile,
  allFiles: DiffFile[]
): DepRiskIssue[] {
  const issues: DepRiskIssue[] = [];
  if (!PKG_JSON_RE.test(pkgFile.path)) return issues;

  const removed = getRemovedChanges(pkgFile);
  const removedPkgs = new Set<string>();
  for (const change of removed) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (match) removedPkgs.add(match[1]);
  }

  const added = getAddedChanges(pkgFile);
  const newPkgs: Array<{ name: string; line: number; range: string }> = [];

  for (const change of added) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (!match) continue;
    if (removedPkgs.has(match[1])) continue; // version change, not new

    newPkgs.push({ name: match[1], line: change.line, range: match[2] });
  }

  if (newPkgs.length === 0) return issues;

  // Collect all import specifiers from non-package.json files
  const importedPkgs = new Set<string>();
  for (const file of allFiles) {
    if (file.status === "deleted") continue;
    if (PKG_JSON_RE.test(file.path)) continue;
    if (PKG_LOCK_RE.test(file.path) || YARN_LOCK_RE.test(file.path) || PNPM_LOCK_RE.test(file.path)) continue;
    if (TEST_FILE_RE.test(file.path)) continue; // test files don't prove production usage

    const addedChanges = getAddedChanges(file);
    for (const change of addedChanges) {
      const trimmed = stripPrefix(change.content);
      // import ... from 'pkg' or require('pkg')
      const importMatch = trimmed.match(/(?:import\s+.*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"](@?[\w\-./@]+)['"]/);
      if (importMatch) {
        // Only root package name (first segment before /)
        const rootPkg = importMatch[1].startsWith("@")
          ? importMatch[1].split("/").slice(0, 2).join("/")
          : importMatch[1].split("/")[0];
        importedPkgs.add(rootPkg);
      }
    }
  }

  for (const pkg of newPkgs) {
    // Check if the package (or its root scope) is imported
    const rootName = pkg.name.startsWith("@")
      ? pkg.name.split("/").slice(0, 2).join("/")
      : pkg.name.split("/")[0];

    if (!importedPkgs.has(rootName)) {
      issues.push({
        category: "unused-new-dependency",
        file: pkgFile.path,
        line: pkg.line,
        code: `"${pkg.name}": "${pkg.range}"`,
        description: `New dependency \`${pkg.name}\` added but not imported in any changed file; LLMs frequently add dependencies for "completeness" without using them; phantom deps increase attack surface and bundle size; verify this dependency is actually needed`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: dependency-downgrade
// ---------------------------------------------------------------------------

function detectDependencyDowngrade(file: DiffFile): DepRiskIssue[] {
  const issues: DepRiskIssue[] = [];
  if (!PKG_JSON_RE.test(file.path)) return issues;

  const removed = getRemovedChanges(file);
  const added = getAddedChanges(file);

  const oldVersions = new Map<string, { version: string; line: number }>();
  for (const change of removed) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (match) {
      oldVersions.set(match[1], { version: match[2], line: change.line });
    }
  }

  for (const change of added) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (!match) continue;

    const pkgName = match[1];
    const newRange = match[2];
    const old = oldVersions.get(pkgName);
    if (!old) continue;

    const oldVer = parseSemVer(extractVersionFromRange(old.version));
    const newVer = parseSemVer(extractVersionFromRange(newRange));
    if (!oldVer || !newVer) continue;

    if (newVer[0] < oldVer[0] || (newVer[0] === oldVer[0] && newVer[1] < oldVer[1])) {
      issues.push({
        category: "dependency-downgrade",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Dependency downgrade for \`${pkgName}\`: ${old.version} → ${newRange}; downgrades may reintroduce fixed security vulnerabilities; verify this is intentional and the older version has no known CVEs`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: typosquatting-suspect
// ---------------------------------------------------------------------------

function detectTyposquatting(file: DiffFile): DepRiskIssue[] {
  const issues: DepRiskIssue[] = [];
  if (!PKG_JSON_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);

  for (const change of added) {
    const trimmed = stripPrefix(change.content);
    const match = trimmed.match(DEP_LINE_RE);
    if (!match) continue;

    const pkgName = match[1];
    const similar = isTyposquat(pkgName);
    if (similar) {
      issues.push({
        category: "typosquatting-suspect",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Potential typosquatting: \`${pkgName}\` is similar to popular package \`${similar}\`; supply chain attacks use naming confusion to inject malicious code; verify this package is from a trusted source, check npm maintainers and download count`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildContext(result: DepRiskResult): string {
  if (result.issues.length === 0) return "";

  let ctx = `## Dependency Risk Detection (${result.issues.length})\n`;
  ctx += "This PR introduces dependency changes that may carry risk:\n\n";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const i of warnings.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }

  return ctx.trim();
}

function buildBodySummary(result: DepRiskResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Dependency Risk Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | Package | File | Line | Severity |\n";
  body += "|----------|---------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const pkgMatch = i.code.match(DEP_LINE_RE);
    const pkgName = pkgMatch ? pkgMatch[1] : i.code.slice(0, 30);
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${pkgName}\` | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Dependency risk: arxiv 2601.17548 — AI platforms fail trust boundaries. Major bumps may break APIs; unused deps increase attack surface; downgrades may reintroduce CVEs; typosquatting is a known supply chain attack vector.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: DepRiskIssue[]): DepRiskIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run dependency risk detection on diff files. Zero LLM cost. */
export function detectDependencyRisk(diffFiles: DiffFile[]): DepRiskResult {
  const allIssues: DepRiskIssue[] = [];

  const pkgFiles = diffFiles.filter(
    (f) => f.status !== "deleted" && PKG_JSON_RE.test(f.path)
  );

  for (const pkgFile of pkgFiles) {
    allIssues.push(...detectMajorVersionBump(pkgFile));
    allIssues.push(...detectUnusedNewDependency(pkgFile, diffFiles));
    allIssues.push(...detectDependencyDowngrade(pkgFile));
    allIssues.push(...detectTyposquatting(pkgFile));
  }

  const issues = dedupIssues(allIssues);
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: DepRiskResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildContext(result);
  result.bodySummary = buildBodySummary(result);

  if (issues.length > 0) {
    core.info(`Dependency risk: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
