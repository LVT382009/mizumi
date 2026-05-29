/**
 * Lockfile Integrity Detector — detect lockfile inconsistencies in PRs.
 *
 * Package managers use lockfiles (package-lock.json, yarn.lock,
 * pnpm-lock.yaml) to ensure deterministic installs. AI-generated PRs
 * frequently:
 *
 * 1. Add dependencies to package.json without updating the lockfile
 * 2. Modify the lockfile without corresponding package.json changes
 * 3. Commit lockfile changes that indicate version drift
 *
 * npm install without --save creates phantom entries; AI coders run
 * random install commands. This detector catches the discrepancy.
 *
 * arxiv 2601.17548: 73% of AI platforms fail to enforce trust
 * boundaries. Skills define tool types but not targets — AI agents
 * modify package.json targets without verifying lockfile consistency.
 *
 * Zero LLM cost — pure file-presence and diff analysis.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LockfileCategory =
  | "missing-lockfile-update"
  | "orphan-lockfile-change"
  | "lockfile-version-drift";

export interface LockfileIssue {
  category: LockfileCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface LockfileResult {
  issues: LockfileIssue[];
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

const PKG_JSON_RE = /(?:^|[\\/])package\.json$/;
const PKG_LOCK_RE = /(?:^|[\\/])package-lock\.json$/;
const YARN_LOCK_RE = /(?:^|[\\/])yarn\.lock$/;
const PNPM_LOCK_RE = /(?:^|[\\/])pnpm-lock\.yaml$/;

// Dep line pattern — excludes keywords like name, version, description, main, type, license
const NON_DEP_KEYS = /^(?:name|version|description|main|type|license|author|repository|scripts|engines|module|exports|files|keywords|bugs|homepage|contributors|private|workspaces|sideEffects|bin|man|directories|config|browser|eslintConfig|prettier|babel|jest|types|typings|peerDependenciesMeta|optionalDependencies|publishConfig|overrides|resolutions)$/i;
const DEP_LINE_RE = /^\s*["'](@?[\w\-./@]+)["']\s*:\s*["']([~^>=<\s]*\d+\.\d+[^"']+)["']/;

// ---------------------------------------------------------------------------
// Detection: missing-lockfile-update
// ---------------------------------------------------------------------------

function detectMissingLockfileUpdate(diffFiles: DiffFile[]): LockfileIssue[] {
  const issues: LockfileIssue[] = [];

  // Find which package.json files have dep additions
  const pkgFilesWithDepChanges: DiffFile[] = [];
  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (!PKG_JSON_RE.test(file.path)) continue;

    const added = getAddedChanges(file);
    const hasDepAddition = added.some((c) => {
      const trimmed = stripPrefix(c.content);
      const match = trimmed.match(DEP_LINE_RE);
      if (!match) return false;
      return !NON_DEP_KEYS.test(match[1]);
    });
    if (hasDepAddition) {
      pkgFilesWithDepChanges.push(file);
    }
  }

  // Check which lockfiles exist in the diff
  const lockfilePaths = new Set<string>();
  for (const file of diffFiles) {
    if (PKG_LOCK_RE.test(file.path) || YARN_LOCK_RE.test(file.path) || PNPM_LOCK_RE.test(file.path)) {
      lockfilePaths.add(file.path);
    }
  }

  // Check which lockfiles are present in the repo at all (added/modified status)
  const lockfilesInDiff = diffFiles.filter(
    (f) => PKG_LOCK_RE.test(f.path) || YARN_LOCK_RE.test(f.path) || PNPM_LOCK_RE.test(f.path)
  );

  if (pkgFilesWithDepChanges.length > 0 && lockfilesInDiff.length === 0) {
    // package.json has dep additions but no lockfile was changed
    for (const pkgFile of pkgFilesWithDepChanges) {
      const added = getAddedChanges(pkgFile);
      const firstDepLine = added.find((c) => DEP_LINE_RE.test(stripPrefix(c.content)));
      if (firstDepLine) {
        issues.push({
          category: "missing-lockfile-update",
          file: pkgFile.path,
          line: firstDepLine.line,
          code: stripPrefix(firstDepLine.content),
          description: `Dependencies added to \`${pkgFile.path}\` but lockfile was not updated; run \`npm install\` or equivalent to regenerate the lockfile; ai agents frequently add deps without syncing lockfiles, causing CI failures and non-deterministic installs`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: orphan-lockfile-change
// ---------------------------------------------------------------------------

function detectOrphanLockfileChange(diffFiles: DiffFile[]): LockfileIssue[] {
  const issues: LockfileIssue[] = [];

  const hasPkgJsonChange = diffFiles.some(
    (f) => f.status !== "deleted" && PKG_JSON_RE.test(f.path)
  );

  const lockfileChanges = diffFiles.filter(
    (f) => f.status !== "deleted" && (PKG_LOCK_RE.test(f.path) || YARN_LOCK_RE.test(f.path) || PNPM_LOCK_RE.test(f.path))
  );

  if (!hasPkgJsonChange && lockfileChanges.length > 0) {
    for (const lockfile of lockfileChanges) {
      const added = getAddedChanges(lockfile);
      if (added.length > 0) {
        issues.push({
          category: "orphan-lockfile-change",
          file: lockfile.path,
          line: added[0].line,
          code: `lockfile modified without package.json change (${added.length} lines)`,
          description: `Lockfile \`${lockfile.path}\` was modified without a corresponding package.json change; this may indicate a manual lockfile edit, accidental version pinning, or stale lockfile; verify the lockfile matches the current package.json`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: lockfile-version-drift
// ---------------------------------------------------------------------------

function detectLockfileVersionDrift(diffFiles: DiffFile[]): LockfileIssue[] {
  const issues: LockfileIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (!PKG_LOCK_RE.test(file.path)) continue;

    const added = getAddedChanges(file);
    // Look for "version" field changes in the lockfile that don't match package.json
    let lockfileVersion: string | null = null;
    for (const change of added) {
      const trimmed = stripPrefix(change.content);
      const versionMatch = trimmed.match(/"lockfileVersion"\s*:\s*(\d+)/);
      if (versionMatch) {
        lockfileVersion = versionMatch[1];
      }
    }

    if (lockfileVersion && lockfileVersion !== "2" && lockfileVersion !== "3") {
      issues.push({
        category: "lockfile-version-drift",
        file: file.path,
        line: 1,
        code: `lockfileVersion: ${lockfileVersion}`,
        description: `Lockfile version ${lockfileVersion} in \`${file.path}\` may indicate npm version mismatch; npm v7+ uses lockfileVersion 2, npm v9+ uses 3; verify all developers use compatible npm versions`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildContext(result: LockfileResult): string {
  if (result.issues.length === 0) return "";

  let ctx = `## Lockfile Integrity Detection (${result.issues.length})\n`;
  ctx += "This PR has lockfile inconsistencies:\n\n";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical) ctx += `- ${i.description}\n`;
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const i of warnings) ctx += `- ${i.description}\n`;
  }

  return ctx.trim();
}

function buildBodySummary(result: LockfileResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Lockfile Integrity Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Severity |\n";
  body += "|----------|------|----------|\n";

  for (const i of result.issues) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.severity} |\n`;
  }

  body += `\n*Lockfile integrity: arxiv 2601.17548 — AI platforms fail trust boundaries. Missing lockfile updates cause CI failures and non-deterministic builds.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: LockfileIssue[]): LockfileIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run lockfile integrity detection on diff files. Zero LLM cost. */
export function detectLockfileIntegrity(diffFiles: DiffFile[]): LockfileResult {
  const allIssues: LockfileIssue[] = [];

  allIssues.push(...detectMissingLockfileUpdate(diffFiles));
  allIssues.push(...detectOrphanLockfileChange(diffFiles));
  allIssues.push(...detectLockfileVersionDrift(diffFiles));

  const issues = dedupIssues(allIssues);
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    return sv || a.file.localeCompare(b.file);
  });

  const result: LockfileResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildContext(result);
  result.bodySummary = buildBodySummary(result);

  if (issues.length > 0) {
    core.info(`Lockfile integrity: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
