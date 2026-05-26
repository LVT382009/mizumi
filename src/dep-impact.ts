/**
 * Dependency Change Impact Analysis — competitive gap #4.
 *
 * When a PR modifies package.json, package-lock.json, yarn.lock, or
 * pnpm-lock.yaml, detect which dependencies changed, classify the risk
 * (major version bump, new dep, removed dep, dev vs prod), and trace
 * which source files import the affected packages.
 *
 * No other AI code reviewer analyzes dependency changes. CodeRabbit
 * comments on package.json diffs like any other file; CodeGuru and
 * Sourcery ignore dependency changes entirely. Mizumi surfaces:
 * - "You added 3 new production dependencies and bumped 2 to major versions"
 * - "These 5 source files import `lodash` which was bumped from 3.x to 4.x"
 * - Risk-prioritized guidance for the reviewer
 *
 * Implementation: purely heuristic, zero LLM cost.
 * 1. Detect package.json / lockfile changes from diff paths
 * 2. Parse added/removed lines from hunks to find dependency changes
 * 3. Classify changes: new, removed, bumped (major/minor/patch)
 * 4. Trace source files that import affected packages
 * 5. Generate risk context for LLM and review body
 */
import type { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DepChangeKind = "added" | "removed" | "bumped-major" | "bumped-minor" | "bumped-patch" | "downgraded";

export interface DepChange {
  /** Package name */
  name: string;
  /** What kind of change */
  kind: DepChangeKind;
  /** Old version (empty for added, "unknown" for lockfile-only) */
  oldVersion: string;
  /** New version (empty for removed) */
  newVersion: string;
  /** Dependency group */
  group: "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
  /** Which file the change was detected in */
  sourceFile: string;
}

export interface DepImpactResult {
  /** List of dependency changes detected */
  changes: DepChange[];
  /** Number of production dependency changes */
  prodChanges: number;
  /** Number of dev dependency changes */
  devChanges: number;
  /** Number of major version bumps */
  majorBumps: number;
  /** Number of new dependencies */
  addedDeps: number;
  /** Number of removed dependencies */
  removedDeps: number;
  /** Source files that import affected packages */
  impactedFiles: ImpactedImport[];
  /** Risk level summary */
  riskLevel: "high" | "medium" | "low";
  /** Context text for LLM prompt injection */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

export interface ImpactedImport {
  /** Source file that imports the affected package */
  file: string;
  /** Package being imported */
  package: string;
  /** Import kind (from blast-radius terminology) */
  kind: "import" | "require" | "dynamic-import";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_JSON_PATTERN = /(^|\/)package\.json$/;
const LOCKFILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bun\.lockb$/,
];

const DEP_SECTION_PATTERN = /^\s+"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/;
const DEP_LINE_PATTERN = /^\s+"([^"]+)"\s*:\s*"([^"]+)"/;
const CLOSE_BRACE_PATTERN = /^\s*\}/;

// High-risk packages: known to have frequent breaking changes or security issues
const HIGH_RISK_PACKAGES = new Set([
  "express", "next", "react", "react-dom", "vue", "angular",
  "webpack", "vite", "rollup", "esbuild",
  "typescript", "babel-core", "@babel/core",
  "eslint", "prettier",
  "lodash", "underscore",
  "axios", "node-fetch", "got",
  "jsonwebtoken", "bcrypt", "crypto-js",
  "mongoose", "prisma", "typeorm", "knex",
  "electron",
]);

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

/**
 * Detect dependency changes from package.json diff hunks.
 * Parses added and deleted lines to find version changes.
 */
export function parsePackageJsonDiff(file: DiffFile): DepChange[] {
  const changes: DepChange[] = [];

  const addedLines = file.hunks
    .flatMap(h => h.changes)
    .filter(c => c.type === "add")
    .map(c => c.content);

  const deletedLines = file.hunks
    .flatMap(h => h.changes)
    .filter(c => c.type === "delete")
    .map(c => c.content);

  // Parse deleted lines to get old versions
  const oldDeps = new Map<string, { version: string; group: DepChange["group"] }>();
  let deletedSection: DepChange["group"] | null = null;
  for (const line of deletedLines) {
    const sectionMatch = DEP_SECTION_PATTERN.exec(line);
    if (sectionMatch) {
      deletedSection = sectionMatch[1] as DepChange["group"];
      continue;
    }
    if (CLOSE_BRACE_PATTERN.test(line) && deletedSection) {
      deletedSection = null;
      continue;
    }
    if (deletedSection) {
      const match = DEP_LINE_PATTERN.exec(line);
      if (match) {
        oldDeps.set(match[1], { version: match[2], group: deletedSection });
      }
    }
  }

  // Parse added lines to get new versions
  const newDeps = new Map<string, { version: string; group: DepChange["group"] }>();
  let addedSection: DepChange["group"] | null = null;
  for (const line of addedLines) {
    const sectionMatch = DEP_SECTION_PATTERN.exec(line);
    if (sectionMatch) {
      addedSection = sectionMatch[1] as DepChange["group"];
      continue;
    }
    if (CLOSE_BRACE_PATTERN.test(line) && addedSection) {
      addedSection = null;
      continue;
    }
    if (addedSection) {
      const match = DEP_LINE_PATTERN.exec(line);
      if (match) {
        newDeps.set(match[1], { version: match[2], group: addedSection });
      }
    }
  }

  // Compare old vs new to produce changes
  const allPackages = new Set([...oldDeps.keys(), ...newDeps.keys()]);
  for (const name of allPackages) {
    const oldDep = oldDeps.get(name);
    const newDep = newDeps.get(name);

    if (!oldDep && newDep) {
      // Added
      changes.push({
        name,
        kind: "added",
        oldVersion: "",
        newVersion: newDep.version,
        group: newDep.group,
        sourceFile: file.path,
      });
    } else if (oldDep && !newDep) {
      // Removed
      changes.push({
        name,
        kind: "removed",
        oldVersion: oldDep.version,
        newVersion: "",
        group: oldDep.group,
        sourceFile: file.path,
      });
    } else if (oldDep && newDep) {
      // Version change
      const kind = classifyVersionChange(oldDep.version, newDep.version);
      changes.push({
        name,
        kind,
        oldVersion: oldDep.version,
        newVersion: newDep.version,
        group: newDep.group,
        sourceFile: file.path,
      });
    }
  }

  return changes;
}

/**
 * Classify a version change as major, minor, patch, or downgrade.
 */
export function classifyVersionChange(oldVer: string, newVer: string): DepChangeKind {
  const oldParts = parseSemver(oldVer);
  const newParts = parseSemver(newVer);

  if (!oldParts || !newParts) {
    // Can't parse — assume minor bump
    return "bumped-minor";
  }

  if (newParts.major < oldParts.major) return "downgraded";
  if (newParts.major > oldParts.major) return "bumped-major";
  if (newParts.minor < oldParts.minor) return "downgraded";
  if (newParts.minor > oldParts.minor) return "bumped-minor";
  if (newParts.patch !== oldParts.patch) return "bumped-patch";

  return "bumped-patch"; // same version but different prerelease/build
}

/**
 * Parse a semver string (with leading ^, ~, >=, etc.) into parts.
 */
export function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  // Strip leading range operators and workspace/file/git references
  const cleaned = version.replace(/^[~^>=<]*\s*/, "");
  // Skip non-semver refs
  if (cleaned.startsWith("file:") || cleaned.startsWith("workspace:") ||
      cleaned.startsWith("github:") || cleaned.startsWith("git+") ||
      cleaned.startsWith("npm:") || cleaned.startsWith("link:")) {
    return null;
  }
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(cleaned);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: match[2] ? parseInt(match[2], 10) : 0,
    patch: match[3] ? parseInt(match[3], 10) : 0,
  };
}

/**
 * Detect lockfile-only changes (no package.json, just lockfile updates).
 * These indicate version pinning or resolution changes.
 */
export function detectLockfileChanges(files: DiffFile[]): { file: string; additions: number; deletions: number }[] {
  const lockfileChanges: { file: string; additions: number; deletions: number }[] = [];
  for (const f of files) {
    for (const pattern of LOCKFILE_PATTERNS) {
      if (pattern.test(f.path)) {
        lockfileChanges.push({ file: f.path, additions: f.additions, deletions: f.deletions });
        break;
      }
    }
  }
  return lockfileChanges;
}

/**
 * Check if a file path is a dependency manifest or lockfile.
 */
export function isDepFile(path: string): boolean {
  if (PACKAGE_JSON_PATTERN.test(path)) return true;
  for (const pattern of LOCKFILE_PATTERNS) {
    if (pattern.test(path)) return true;
  }
  // Also detect requirements.txt, Gemfile, Cargo.toml, go.mod, pom.xml, build.gradle
  if (/(^|\/)(requirements\.txt|Gemfile|Cargo\.toml|go\.mod|go\.sum|pom\.xml|build\.gradle|\.csproj|packages\.config)$/i.test(path)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Import tracing
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = [
  // ESM: import ... from 'pkg' / import 'pkg'
  { re: /import\s+(?:(?:\w+\s*,?\s*)*(?:\{[^}]*\})?\s+from\s+)?['"](@?[^'"]+)['"]/g, kind: "import" as const },
  // CJS: require('pkg')
  { re: /require\s*\(\s*['"](@?[^'"]+)['"]\s*\)/g, kind: "require" as const },
  // Dynamic: import('pkg')
  { re: /import\s*\(\s*['"](@?[^'"]+)['"]\s*\)/g, kind: "dynamic-import" as const },
];

/**
 * Find source files that import any of the changed packages.
 * Scans all diff files for import statements matching package names.
 */
export function traceImportImpact(files: DiffFile[], changedPackages: string[]): ImpactedImport[] {
  if (changedPackages.length === 0) return [];

  const pkgSet = new Set(changedPackages);
  const impacts: ImpactedImport[] = [];

  for (const file of files) {
    // Skip dependency manifest files themselves
    if (isDepFile(file.path)) continue;

    const content = file.hunks
      .flatMap(h => h.changes)
      .map(c => c.content)
      .join("\n");

    for (const pattern of IMPORT_PATTERNS) {
      pattern.re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.re.exec(content)) !== null) {
        const importPath = match[1];
        const pkgName = extractPackageName(importPath);
        if (pkgSet.has(pkgName)) {
          impacts.push({
            file: file.path,
            package: pkgName,
            kind: pattern.kind,
          });
        }
      }
    }
  }

  // Deduplicate by file+package+kind
  const seen = new Set<string>();
  return impacts.filter(i => {
    const key = `${i.file}:${i.package}:${i.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract bare package name from an import path.
 * "@scope/pkg/subpath" → "@scope/pkg"
 * "lodash/map" → "lodash"
 */
export function extractPackageName(importPath: string): string {
  // Scoped package: @scope/name/subpath → @scope/name
  if (importPath.startsWith("@")) {
    const parts = importPath.split("/");
    if (parts.length >= 2) {
      return parts[0] + "/" + parts[1];
    }
    return importPath;
  }
  // Unscoped: name/subpath → name
  const firstSlash = importPath.indexOf("/");
  if (firstSlash > 0) {
    return importPath.substring(0, firstSlash);
  }
  return importPath;
}

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------

function computeRiskLevel(changes: DepChange[]): "high" | "medium" | "low" {
  if (changes.length === 0) return "low";

  const majorBumps = changes.filter(c => c.kind === "bumped-major").length;
  const newProdDeps = changes.filter(c => c.kind === "added" && c.group === "dependencies").length;
  const removedDeps = changes.filter(c => c.kind === "removed").length;
  const highRiskPkgs = changes.filter(c => HIGH_RISK_PACKAGES.has(c.name)).length;
  const downgrades = changes.filter(c => c.kind === "downgraded").length;

  if (majorBumps > 0 || downgrades > 0 || newProdDeps >= 3 || highRiskPkgs >= 2) return "high";
  if (newProdDeps > 0 || removedDeps > 0 || highRiskPkgs > 0) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

function buildDepContext(result: DepImpactResult): string {
  if (result.changes.length === 0) return "";

  let ctx = `## Dependency Change Impact (risk: ${result.riskLevel})\n`;
  ctx += "This PR modifies dependencies. Review attention by risk:\n";
  ctx += "- **Major version bumps / downgrades / new production deps**: high-risk, verify breaking changes\n";
  ctx += "- **Minor bumps / removed deps**: medium-risk, check for API changes\n";
  ctx += "- **Patch bumps / dev deps**: low-risk, usually safe\n\n";

  const highRisk = result.changes.filter(c =>
    c.kind === "bumped-major" || c.kind === "downgraded" ||
    (c.kind === "added" && c.group === "dependencies") ||
    HIGH_RISK_PACKAGES.has(c.name)
  );

  if (highRisk.length > 0) {
    ctx += "**High-risk dependency changes:**\n";
    for (const c of highRisk.slice(0, 8)) {
      ctx += `- \`${c.name}\`: ${c.kind} (${c.oldVersion || "none"} → ${c.newVersion || "none"}, ${c.group})\n`;
    }
    if (highRisk.length > 8) {
      ctx += `- ... and ${highRisk.length - 8} more\n`;
    }
    ctx += "\n";
  }

  if (result.impactedFiles.length > 0) {
    ctx += "**Source files importing affected packages:**\n";
    for (const imp of result.impactedFiles.slice(0, 8)) {
      ctx += `- \`${imp.file}\` imports \`${imp.package}\` (${imp.kind})\n`;
    }
    if (result.impactedFiles.length > 8) {
      ctx += `- ... and ${result.impactedFiles.length - 8} more\n`;
    }
  }

  return ctx.trim() + "\n";
}

function buildDepBodySummary(result: DepImpactResult): string {
  if (result.changes.length === 0) return "";

  const byKind = new Map<DepChangeKind, number>();
  for (const c of result.changes) {
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
  }

  let body = `<details><summary><strong>Dependency Impact</strong> — ${result.riskLevel} risk</summary>\n\n`;
  body += "| Metric | Count |\n|--------|-------|\n";
  body += `| Production changes | ${result.prodChanges} |\n`;
  body += `| Dev changes | ${result.devChanges} |\n`;
  body += `| Major bumps | ${result.majorBumps} |\n`;
  body += `| New deps | ${result.addedDeps} |\n`;
  body += `| Removed deps | ${result.removedDeps} |\n\n`;

  if (result.changes.length > 0) {
    body += "| Package | Change | Old | New | Group |\n|---------|--------|-----|-----|-------|\n";
    for (const c of result.changes.slice(0, 15)) {
      body += `| ${c.name} | ${c.kind} | ${c.oldVersion || "-"} | ${c.newVersion || "-"} | ${c.group} |\n`;
    }
    if (result.changes.length > 15) {
      body += `| ... | ${result.changes.length - 15} more | | | |\n`;
    }
    body += "\n";
  }

  if (result.impactedFiles.length > 0) {
    body += "**Files importing affected packages:**\n";
    for (const imp of result.impactedFiles.slice(0, 8)) {
      body += `- \`${imp.file}\` ← \`${imp.package}\`\n`;
    }
    if (result.impactedFiles.length > 8) {
      body += `- ... and ${result.impactedFiles.length - 8} more\n`;
    }
    body += "\n";
  }

  body += `</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze dependency changes in a PR diff.
 * Zero LLM cost — purely heuristic.
 */
export function analyzeDepImpact(diffFiles: DiffFile[]): DepImpactResult {
  const changes: DepChange[] = [];
  const lockfileChanges = detectLockfileChanges(diffFiles);

  // Find and parse package.json files
  for (const file of diffFiles) {
    if (PACKAGE_JSON_PATTERN.test(file.path)) {
      const fileChanges = parsePackageJsonDiff(file);
      changes.push(...fileChanges);
    }
  }

  // Trace import impact
  const changedPkgNames = changes.map(c => c.name);
  const impactedFiles = traceImportImpact(diffFiles, changedPkgNames);

  // Compute summary metrics
  const prodChanges = changes.filter(c => c.group === "dependencies").length;
  const devChanges = changes.filter(c => c.group === "devDependencies").length;
  const majorBumps = changes.filter(c => c.kind === "bumped-major").length;
  const addedDeps = changes.filter(c => c.kind === "added").length;
  const removedDeps = changes.filter(c => c.kind === "removed").length;
  const riskLevel = computeRiskLevel(changes);

  const result: DepImpactResult = {
    changes,
    prodChanges,
    devChanges,
    majorBumps,
    addedDeps,
    removedDeps,
    impactedFiles,
    riskLevel,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildDepContext(result);
  result.bodySummary = buildDepBodySummary(result);

  // Add lockfile change note to context
  if (lockfileChanges.length > 0 && changes.length === 0) {
    result.riskLevel = "low";
    result.contextText = `## Dependency Lockfile Update\nThis PR updates ${lockfileChanges.length} lockfile(s) without package.json changes. This typically indicates version pinning or resolution updates.\n`;
    result.bodySummary = `<details><summary><strong>Dependency Impact</strong> — lockfile update</summary>\n\n| File | Additions | Deletions |\n|------|-----------|----------|\n`;
    for (const lc of lockfileChanges) {
      result.bodySummary += `| ${lc.file} | +${lc.additions} | -${lc.deletions} |\n`;
    }
    result.bodySummary += `\nNo new or changed packages detected in package.json.\n</details>\n`;
  }

  return result;
}
