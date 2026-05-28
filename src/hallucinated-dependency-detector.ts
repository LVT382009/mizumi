/**
 * Hallucinated Dependency Detector — detect phantom package references.
 *
 * LLMs invent ~20% of package references in generated code. When an LLM
 * creates `import jwtLiteParser from 'jwt-lite-parser'`, the code looks
 * valid but the package doesn't exist. npm install either fails (best case)
 * or installs an attacker-registered slopsquatting package (worst case).
 *
 * Slopsquatting attacks increased 340% in Q1 2026. No AI code reviewer
 * detects this category. SCA tools check for CVEs in real packages but
 * have no concept of a package that shouldn't exist at all.
 *
 * Categories:
 * 1. unknown-import: import/require of a package not in the lockfile
 * 2. slopsquatting-signal: package name matching LLM confabulation patterns
 * 3. phantom-scoped-import: @scoped/package where the scope or package is unknown
 * 4. version-mismatch: import of a package version API that doesn't exist
 *
 * Detection works by:
 * - Parsing import/require lines from added diff lines
 * - Extracting package names (JS/TS: from 'pkg' or from '@scope/pkg')
 * - Cross-referencing against lockfile entries visible in the diff
 * - Pattern-matching against LLM confabulation naming patterns
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HallucinatedDepCategory =
  | "unknown-import"
  | "slopsquatting-signal"
  | "phantom-scoped-import"
  | "version-mismatch";

export interface HallucinatedDepIssue {
  category: HallucinatedDepCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface HallucinatedDepResult {
  issues: HallucinatedDepIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^\+/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Import/require patterns
const ESM_IMPORT_RE = /import\s+(?:.*?)\s+from\s+['"]([^'"]+)['"]/;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/;

// Lockfile patterns — used inline in extractLockfilePackages

// Known built-in Node.js modules (not hallucinated)
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster",
  "console", "constants", "crypto", "dgram", "diagnostics_channel",
  "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream",
  "string_decoder", "sys", "timers", "tls", "trace_events",
  "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

// Very well-known packages (top 100 by download count — reduce false positives)
const KNOWN_PACKAGES = new Set([
  "react", "react-dom", "lodash", "express", "next", "typescript",
  "webpack", "axios", "moment", "jquery", "vue", "angular",
  "eslint", "jest", "vitest", "mocha", "chai", "sinon",
  "babel", "rollup", "esbuild", "vite", "prettier", "nodemon",
  "dotenv", "chalk", "commander", "yargs", "inquirer", "ora",
  "prisma", "mongoose", "pg", "mysql", "redis", "kafkajs",
  "zod", "joi", "yup", "ajv", "dayjs", "date-fns", "rxjs",
  "socket.io", "ws", "nanoid", "uuid", "cors", "helmet",
  "morgan", "winston", "pino", "bull", "agenda", "node-cron",
  "sharp", "microsoft", "firebase", "ssh2", "nodemailer",
  "cookie-parser", "body-parser", "multer", "compression",
  "serve-static", "express-rate-limit", "http-errors",
  "supertest", "@types/node", "@types/react", "@types/express",
  "@actions/core", "@actions/github", "@octokit/rest",
  "@octokit/core", "@vercel/ncc",
]);

// LLM confabulation naming patterns — these are patterns LLMs use
// when inventing package names that don't exist
const SLOPSQUAT_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /(?:fast|quick|simple|easy|light|lite|mini|micro|tiny|ultra|super)(?:-?)(\w+)-(?:parser|utils|helper|handler|converter|validator|formatter|resolver|manager|builder|wrapper|client|sdk|driver|adapter|connector|processor|transformer|generator|serializer|encoder|decoder|compressor| sanitizer|security)/i,
    reason: "descriptive compound names like `fast-X-parser` are LLM favorites",
  },
  {
    re: /(?:\w+)-(?:lite|light|minimal|simple|easy|basic|core|pro|plus|extra|advanced)/i,
    reason: "`-lite`/`-minimal` suffixes are common LLM confabulations for imagined lighter alternatives",
  },
  {
    re: /(?:aws|azure|gcp|google|cloud)-(?:utils|helpers|sdk-extra|tools|extras|helpers)/i,
    reason: "cloud provider utility packages are frequently invented by LLMs",
  },
  {
    re: /@(?:aws|azure|gcp|google|cloud)-(?:utils|helpers|tools|extras)/i,
    reason: "scoped cloud utility packages are common hallucinations",
  },
];

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// File patterns where we look for imports
const SOURCE_FILE_RE = /\.(ts|js|tsx|jsx|mjs|cjs)$/;

// Lockfile names
const LOCKFILE_RE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

// ---------------------------------------------------------------------------
// Extract package name from import path
// ---------------------------------------------------------------------------

function extractPackageName(importPath: string): string {
  // @scope/package → @scope/package
  if (importPath.startsWith("@")) {
    const parts = importPath.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return importPath;
  }
  // package/subpath → package
  const firstSlash = importPath.indexOf("/");
  return firstSlash === -1 ? importPath : importPath.substring(0, firstSlash);
}

// ---------------------------------------------------------------------------
// Extract lockfile entries from diff
// ---------------------------------------------------------------------------

function extractLockfilePackages(diffFiles: DiffFile[]): Set<string> {
  const packages = new Set<string>();

  for (const file of diffFiles) {
    if (!LOCKFILE_RE.test(file.path)) continue;

    const allChanges = file.hunks.flatMap((h) => h.changes);
    for (const change of allChanges) {
      const trimmed = stripPrefix(change.content);

      // package-lock.json: "package-name": { or "@scope/name": {
      const npmMatch = trimmed.match(/^[\s"]*"([^":]+)"[\s"]*:/);
      if (npmMatch && npmMatch[1].length > 0) {
        packages.add(npmMatch[1]);
      }

      // yarn.lock: "package@version":
      const yarnMatch = trimmed.match(/^"?(@?[^@":]+)@/);
      if (yarnMatch) {
        packages.add(yarnMatch[1]);
      }

      // pnpm-lock.yaml: /package@version
      const pnpmMatch = trimmed.match(/\/(.+?)@/);
      if (pnpmMatch && file.path.includes("pnpm-lock")) {
        packages.add(pnpmMatch[1]);
      }
    }
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Extract package.json dependencies from diff
// ---------------------------------------------------------------------------

function extractPackageJsonDeps(diffFiles: DiffFile[]): Set<string> {
  const deps = new Set<string>();

  for (const file of diffFiles) {
    if (!file.path.endsWith("package.json")) continue;

    const allChanges = file.hunks.flatMap((h) => h.changes);
    for (const change of allChanges) {
      if (change.type !== "add") continue;
      const trimmed = stripPrefix(change.content);
      // "package-name": "version"
      const depMatch = trimmed.match(/"([^"@:]+)"\s*:\s*"/);
      if (depMatch) {
        deps.add(depMatch[1]);
      }
    }
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Detection: unknown-import
// ---------------------------------------------------------------------------

function detectUnknownImport(
  file: DiffFile,
  lockfilePackages: Set<string>,
  packageJsonDeps: Set<string>,
): HallucinatedDepIssue[] {
  const issues: HallucinatedDepIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Try each import pattern
    const match =
      trimmed.match(ESM_IMPORT_RE) ||
      trimmed.match(DYNAMIC_IMPORT_RE) ||
      trimmed.match(REQUIRE_RE);

    if (!match) continue;
    const importPath = match[1];

    // Skip relative imports, builtins, and path imports
    if (importPath.startsWith(".") || importPath.startsWith("/")) continue;

    const packageName = extractPackageName(importPath);

    // Skip Node builtins and known packages — reduce false positives
    if (NODE_BUILTINS.has(packageName)) continue;
    if (KNOWN_PACKAGES.has(packageName)) continue;

    // Check if package exists in lockfile or package.json
    const inLockfile = lockfilePackages.has(packageName);
    const inPackageJson = packageJsonDeps.has(packageName);

    if (!inLockfile && !inPackageJson) {
      issues.push({
        category: "unknown-import",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Import of unknown package \`${packageName}\` in \`${file.path}:${change.line}\` — not found in lockfile or package.json; LLMs frequently invent package names; verify the package exists on npm and is intentionally added as a dependency before merging`,
        severity: "critical",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: slopsquatting-signal
// ---------------------------------------------------------------------------

function detectSlopsquattingSignal(file: DiffFile): HallucinatedDepIssue[] {
  const issues: HallucinatedDepIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const match =
      trimmed.match(ESM_IMPORT_RE) ||
      trimmed.match(DYNAMIC_IMPORT_RE) ||
      trimmed.match(REQUIRE_RE);

    if (!match) continue;
    const importPath = match[1];

    if (importPath.startsWith(".") || importPath.startsWith("/")) continue;

    const packageName = extractPackageName(importPath);
    if (NODE_BUILTINS.has(packageName)) continue;
    if (KNOWN_PACKAGES.has(packageName)) continue;

    for (const pattern of SLOPSQUAT_PATTERNS) {
      if (pattern.re.test(packageName)) {
        issues.push({
          category: "slopsquatting-signal",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Package \`${packageName}\` matches slopsquatting pattern in \`${file.path}:${change.line}\` — ${pattern.reason}; verify this package actually exists on npm and isn't an LLM invention; slopsquatting attacks register fake packages matching common LLM hallucination patterns`,
          severity: "critical",
        });
        break; // Only flag once per import
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: phantom-scoped-import
// ---------------------------------------------------------------------------

function detectPhantomScopedImport(
  file: DiffFile,
  lockfilePackages: Set<string>,
  packageJsonDeps: Set<string>,
): HallucinatedDepIssue[] {
  const issues: HallucinatedDepIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const match =
      trimmed.match(ESM_IMPORT_RE) ||
      trimmed.match(DYNAMIC_IMPORT_RE) ||
      trimmed.match(REQUIRE_RE);

    if (!match) continue;
    const importPath = match[1];

    // Only check scoped packages (@scope/name)
    if (!importPath.startsWith("@")) continue;

    const packageName = extractPackageName(importPath);
    if (KNOWN_PACKAGES.has(packageName)) continue;

    const inLockfile = lockfilePackages.has(packageName);
    const inPackageJson = packageJsonDeps.has(packageName);

    if (!inLockfile && !inPackageJson) {
      // Check if the scope is known — if even the scope is unknown, higher confidence
      const scope = packageName.split("/")[0];
      const scopeInLockfile = [...lockfilePackages].some((p) => p.startsWith(scope + "/"));

      if (!scopeInLockfile) {
        issues.push({
          category: "phantom-scoped-import",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Scoped import \`${packageName}\` with unknown scope \`${scope}\` in \`${file.path}:${change.line}\` — LLMs invent @scoped packages that don't exist; no other package from this scope exists in the lockfile; verify the scope and package on npm before installing`,
          severity: "critical",
        });
      } else {
        issues.push({
          category: "phantom-scoped-import",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Scoped import \`${packageName}\` not in lockfile in \`${file.path}:${change.line}\` — the scope \`${scope}\` is known but this specific package isn't listed; may be an LLM invention within a real organization's namespace; verify the package exists before installing`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: version-mismatch
// ---------------------------------------------------------------------------

function detectVersionMismatch(file: DiffFile): HallucinatedDepIssue[] {
  const issues: HallucinatedDepIssue[] = [];
  const added = getAddedChanges(file);

  // Look for version-specific API imports or method calls that suggest wrong version
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Pattern: accessing .v2 or .v3 property on an import (e.g., api.v2.method())
    if (/\.v[234]\.\w+/.test(trimmed)) {
      const match = trimmed.match(ESM_IMPORT_RE) || trimmed.match(REQUIRE_RE);
      const pkgRef = match ? match[1] : "unknown";
      issues.push({
        category: "version-mismatch",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Versioned API access (.v2+) in \`${file.path}:${change.line}\` — LLMs call versioned APIs that may not exist in the installed version of \`${pkgRef}\`; verify the installed package version supports this API surface`,
        severity: "warning",
      });
    }

    // Pattern: calling static method as instance or vice versa
    // e.g., someInstance.staticMethod() where staticMethod is actually static
    // This is harder to detect from diff alone — keep it light
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: HallucinatedDepIssue[]): HallucinatedDepIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildHallucinatedDepContext(result: HallucinatedDepResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Hallucinated Dependency Detection (${result.issues.length})\n`;
  ctx += "This PR may import packages that don't exist — a common LLM pattern and active slopsquatting attack vector:\n\n";

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

function buildHallucinatedDepBodySummary(result: HallucinatedDepResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Hallucinated Dependency Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLMs invent ~20% of package references. Slopsquatting attacks register fake packages matching common LLM hallucination patterns. Verify all new imports exist on npm and are in the lockfile before installing.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run hallucinated dependency detection on diff files. Zero LLM cost. */
export function detectHallucinatedDeps(diffFiles: DiffFile[]): HallucinatedDepResult {
  const allIssues: HallucinatedDepIssue[] = [];

  // Extract lockfile and package.json entries for cross-referencing
  const lockfilePackages = extractLockfilePackages(diffFiles);
  const packageJsonDeps = extractPackageJsonDeps(diffFiles);

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (!SOURCE_FILE_RE.test(file.path)) continue;

    allIssues.push(...detectUnknownImport(file, lockfilePackages, packageJsonDeps));
    allIssues.push(...detectSlopsquattingSignal(file));
    allIssues.push(...detectPhantomScopedImport(file, lockfilePackages, packageJsonDeps));
    allIssues.push(...detectVersionMismatch(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: HallucinatedDepResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildHallucinatedDepContext(result);
  result.bodySummary = buildHallucinatedDepBodySummary(result);

  if (issues.length > 0) {
    core.info(`Hallucinated dependency detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
