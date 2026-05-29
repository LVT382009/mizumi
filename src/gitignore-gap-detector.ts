/**
 * Gitignore Gap Detector — detect files added in PRs that should be
 * in .gitignore but aren't.
 *
 * LLMs frequently generate code that creates or writes to files that
 * should never be committed: .env files, build output, cache dirs,
 * credentials, IDE configs, OS artifacts. Human reviewers catch these
 * by convention; AI reviewers don't check gitignore coverage.
 *
 * Categories:
 * 1. sensitive-file-added: .env, credentials, secrets, private keys
 * 2. build-artifact-added: dist/, build/, output that should be gitignored
 * 3. os-ide-artifact-added: .DS_Store, Thumbs.db, .idea/, .vscode/ settings
 *
 * Zero LLM cost — file path analysis against gitignore conventions.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitignoreCategory =
  | "sensitive-file-added"
  | "build-artifact-added"
  | "os-ide-artifact-added";

export interface GitignoreIssue {
  category: GitignoreCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface GitignoreResult {
  issues: GitignoreIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Sensitive file patterns — should NEVER be committed
// ---------------------------------------------------------------------------

const SENSITIVE_FILE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:^|[\\/])\.env(?:\.\w+)?$/i, reason: "environment variable files should be in .gitignore; use .env.example for templates" },
  { re: /(?:^|[\\/])\.?(?:credentials|secrets?|tokens?|passwords?|api[_-]?keys?)\.(?:json|yaml|yml|toml|ini|conf)$/i, reason: "credential/secret files should never be committed; use environment variables or secret managers" },
  { re: /(?:^|[\\/])(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.pub)?$/i, reason: "SSH private/public key files should not be in the repo; use secret managers for deploy keys" },
  { re: /(?:^|[\\/])\.?(?:npmrc|pypirc|gemrc|nuget\.config|netrc)$/, reason: "package manager config with embedded tokens should be gitignored" },
  { re: /(?:^|[\\/])\.?(?:aws|gcloud|azure|kube)?config$/i, reason: "cloud CLI config files may contain credentials; should be gitignored" },
  { re: /(?:^|[\\/])\.?(?:npm|yarn|pnpm)-token$/i, reason: "registry token files should be gitignored" },
  { re: /(?:^|[\\/])\.key(?:\.pem)?$|\.pem$|\.p12$|\.pfx$|\.jks$/i, reason: "certificate/private key files should never be committed" },
  { re: /(?:^|[\\/])\.htpasswd$|\.htaccess$/i, reason: "Apache auth files should not be committed" },
];

// ---------------------------------------------------------------------------
// Build artifact patterns — should be gitignored
// ---------------------------------------------------------------------------

const BUILD_ARTIFACT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:^|[\\/])dist[\\/]/i, reason: "build output directories (dist/) should be in .gitignore; rebuild from source" },
  { re: /(?:^|[\\/])build[\\/]/i, reason: "build output directories (build/) should be gitignored" },
  { re: /(?:^|[\\/])out[\\/]/i, reason: "output directories (out/) should be gitignored" },
  { re: /(?:^|[\\/])\.next[\\/]/i, reason: "Next.js build output should be gitignored" },
  { re: /(?:^|[\\/])node_modules[\\/]/i, reason: "node_modules should always be gitignored; use package-lock.json for deterministic installs" },
  { re: /(?:^|[\\/])__pycache__[\\/]/i, reason: "Python bytecode cache should be gitignored" },
  { re: /(?:^|[\\/])\.cache[\\/]/i, reason: "cache directories should be gitignored" },
  { re: /(?:^|[\\/])target[\\/]/i, reason: "Maven/Cargo target directories should be gitignored" },
  { re: /(?:^|[\\/])coverage[\\/]/i, reason: "coverage report output should be gitignored" },
  { re: /(?:^|[\\/])\.(?:turbo|vercel|remix)[\\/]/i, reason: "framework cache directories should be gitignored" },
];

// ---------------------------------------------------------------------------
// OS/IDE artifact patterns — should be gitignored
// ---------------------------------------------------------------------------

const OS_IDE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:^|[\\/])\.DS_Store$/i, reason: "macOS Finder metadata should be gitignored" },
  { re: /(?:^|[\\/])Thumbs\.db$/i, reason: "Windows thumbnail cache should be gitignored" },
  { re: /(?:^|[\\/])Desktop\.ini$/i, reason: "Windows desktop.ini should be gitignored" },
  { re: /(?:^|[\\/])\.idea[\\/]/i, reason: "IntelliJ IDEA project files should be gitignored (individual developer config)" },
  { re: /(?:^|[\\/])\.vs(?:code)?[\\/](?!settings\.json|extensions\.json|launch\.json)/i, reason: "IDE config directories should be gitignored except shared settings" },
  { re: /(?:^|[\\/])\.eclipse[\\/]/i, reason: "Eclipse project config should be gitignored" },
  { re: /(?:^|[\\/])\.classpath$/i, reason: "Eclipse classpath file should be gitignored" },
  { re: /(?:^|[\\/])\.project$/i, reason: "Eclipse project file should be gitignored" },
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function matchFile(file: DiffFile, patterns: Array<{ re: RegExp; reason: string }>, category: GitignoreCategory, severity: "critical" | "warning"): GitignoreIssue[] {
  const issues: GitignoreIssue[] = [];
  if (file.status === "deleted") return issues;

  for (const { re, reason } of patterns) {
    if (re.test(file.path)) {
      issues.push({
        category,
        file: file.path,
        line: 1,
        code: file.path,
        description: `\`${file.path}\` should be in .gitignore: ${reason}`,
        severity,
      });
      break; // one match per file per category
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildContext(result: GitignoreResult): string {
  if (result.issues.length === 0) return "";

  let ctx = `## Gitignore Gap Detection (${result.issues.length})\n`;
  ctx += "This PR adds files that should be in .gitignore:\n\n";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (critical.length > 0) {
    ctx += "### Critical — Sensitive Files\n";
    for (const i of critical) ctx += `- ${i.description}\n`;
  }
  if (warnings.length > 0) {
    ctx += "### Warnings — Build/IDE Artifacts\n";
    for (const i of warnings) ctx += `- ${i.description}\n`;
  }

  return ctx.trim();
}

function buildBodySummary(result: GitignoreResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Gitignore Gap Detection</strong> — ${result.issues.length} file(s) should be gitignored</summary>\n\n`;
  body += "| Category | File | Reason | Severity |\n";
  body += "|----------|------|--------|----------|\n";

  for (const i of result.issues) {
    const catLabel = i.category.replace(/-/g, " ");
    const reasonShort = i.description.split(": ").slice(1).join(": ").substring(0, 60);
    body += `| ${catLabel} | \`${i.file}\` | ${reasonShort} | ${i.severity} |\n`;
  }

  body += `\n*Gitignore gaps: LLMs frequently generate files that should never be committed. Add these to .gitignore immediately.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: GitignoreIssue[]): GitignoreIssue[] {
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

/** Run gitignore gap detection on diff files. Zero LLM cost. */
export function detectGitignoreGaps(diffFiles: DiffFile[]): GitignoreResult {
  const allIssues: GitignoreIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    // Only check added files, not modified
    if (file.status !== "added" && file.status !== "modified") continue;
    // Focus on added files (new to the repo)
    if (file.status === "added") {
      allIssues.push(...matchFile(file, SENSITIVE_FILE_PATTERNS, "sensitive-file-added", "critical"));
      allIssues.push(...matchFile(file, BUILD_ARTIFACT_PATTERNS, "build-artifact-added", "warning"));
      allIssues.push(...matchFile(file, OS_IDE_PATTERNS, "os-ide-artifact-added", "warning"));
    }
    // Also check modified files for sensitive files (should never be in repo at all)
    if (file.status === "modified") {
      allIssues.push(...matchFile(file, SENSITIVE_FILE_PATTERNS, "sensitive-file-added", "critical"));
    }
  }

  const issues = dedupIssues(allIssues);
  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    return sv || a.file.localeCompare(b.file);
  });

  const result: GitignoreResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildContext(result);
  result.bodySummary = buildBodySummary(result);

  if (issues.length > 0) {
    core.info(`Gitignore gap: ${issues.length} file(s) should be gitignored (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
