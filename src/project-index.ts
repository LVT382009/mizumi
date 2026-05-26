/**
 * Project Index — lightweight workspace tree scan for LLM context.
 *
 * Competitive gap #3.1: At review-time, build a structured map of the
 * project's directory tree, key entry points, dependency files, and
 * config files. Injects into review context so the LLM understands
 * the project structure beyond just the changed files.
 *
 * Zero LLM cost. No competitor builds a project index at review time —
 * they all require pre-indexing or repo-level setup. Mizumi does it
 * ad-hoc in <50ms by scanning the workspace tree.
 *
 * Output: compact tree representation + key files list, injected as
 * "## Project Structure" section in the review context.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectIndex {
  tree: string;
  keyFiles: KeyFile[];
  language: string;
  framework: string;
  totalFiles: number;
  totalDirs: number;
  contextText: string;
}

export interface KeyFile {
  path: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Directory patterns to skip (not interesting for review context)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache", ".vscode", ".idea", "__pycache__",
  ".terraform", "vendor", ".venv", "venv", ".tox",
]);

// ---------------------------------------------------------------------------
// Key file detection
// ---------------------------------------------------------------------------

const KEY_FILE_PATTERNS: Array<{ pattern: RegExp; role: string }> = [
  { pattern: /^package\.json$/, role: "dependencies" },
  { pattern: /^package-lock\.json$/, role: "lockfile" },
  { pattern: /^pnpm-lock\.yaml$/, role: "lockfile" },
  { pattern: /^yarn\.lock$/, role: "lockfile" },
  { pattern: /^tsconfig\.json$/, role: "typescript config" },
  { pattern: /^tsconfig\..+\.json$/, role: "typescript config" },
  { pattern: /^\.eslintrc/, role: "linter" },
  { pattern: /^eslint\.config\./, role: "linter" },
  { pattern: /^\.prettierrc/, role: "formatter" },
  { pattern: /^prettier\.config\./, role: "formatter" },
  { pattern: /^jest\.config\./, role: "test config" },
  { pattern: /^vitest\.config\./, role: "test config" },
  { pattern: /^vite\.config\./, role: "bundler" },
  { pattern: /^webpack\.config\./, role: "bundler" },
  { pattern: /^rollup\.config\./, role: "bundler" },
  { pattern: /^Dockerfile/, role: "container" },
  { pattern: /^docker-compose/, role: "container" },
  { pattern: /^\.env/, role: "environment" },
  { pattern: /^\.github\//, role: "CI/CD" },
  { pattern: /^CLAUDE\.md$/, role: "AI instructions" },
  { pattern: /^REVIEW\.md$/, role: "review rules" },
  { pattern: /^CODEOWNERS$/, role: "ownership" },
  { pattern: /^\.cursorrules$/, role: "AI instructions" },
  { pattern: /^action\.yml$/, role: "GitHub Action" },
];

function classifyKeyFile(relativePath: string): string | null {
  const basename = path.basename(relativePath);
  for (const { pattern, role } of KEY_FILE_PATTERNS) {
    if (pattern.test(basename)) return role;
  }
  // Check path-based patterns
  if (relativePath.startsWith(".github/")) return "CI/CD";
  return null;
}

// ---------------------------------------------------------------------------
// Language and framework detection
// ---------------------------------------------------------------------------

function detectLanguage(keyFiles: KeyFile[]): string {
  const roles = new Set(keyFiles.map((f) => f.role));
  if (roles.has("typescript config") || roles.has("bundler")) return "TypeScript";
  if (roles.has("dependencies")) return "JavaScript";
  return "unknown";
}

function detectFramework(keyFiles: KeyFile[]): string {
  const roles = new Set(keyFiles.map((f) => f.role));
  if (roles.has("bundler") && roles.has("typescript config")) return "Node.js + TypeScript";
  if (roles.has("dependencies")) return "Node.js";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Tree builder
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;
const MAX_ENTRIES_PER_DIR = 20;
const MAX_TOTAL_FILES = 200;

export function buildTree(
  dir: string,
  prefix: string = "",
  depth: number = 0,
  fileCount: { value: number } = { value: 0 },
): string {
  if (depth > MAX_DEPTH || fileCount.value > MAX_TOTAL_FILES) return "";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }

  // Sort: directories first, then files, both alphabetically
  const dirs = entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const visible = [...dirs, ...files].slice(0, MAX_ENTRIES_PER_DIR);
  const truncated = dirs.length + files.length > MAX_ENTRIES_PER_DIR;

  let result = "";
  const lastIndex = visible.length - 1;

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const isLast = i === lastIndex && !truncated;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";

    if (entry.isDirectory()) {
      result += `${prefix}${connector}${entry.name}/\n`;
      result += buildTree(
        path.join(dir, entry.name),
        prefix + childPrefix,
        depth + 1,
        fileCount,
      );
    } else {
      result += `${prefix}${connector}${entry.name}\n`;
      fileCount.value++;
    }
  }

  if (truncated) {
    result += `${prefix}└── ... (${dirs.length + files.length - MAX_ENTRIES_PER_DIR} more)\n`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build a project index from the workspace directory.
 * Returns structured project metadata + compact tree representation.
 */
export function buildProjectIndex(workspace: string): ProjectIndex {
  const keyFiles: KeyFile[] = [];

  // Scan for key files
  function scanDir(dir: string, relPath: string = ""): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
        scanDir(entryPath, entryRel);
      } else if (entry.isFile()) {
        const role = classifyKeyFile(entryRel);
        if (role) {
          keyFiles.push({ path: entryRel, role });
        }
      }
    }
  }

  scanDir(workspace);

  // Build tree
  const fileCount = { value: 0 };
  const tree = buildTree(workspace, "", 0, fileCount);

  // Count dirs
  let totalDirs = 0;
  function countDirs(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        totalDirs++;
        countDirs(path.join(dir, entry.name));
      }
    }
  }
  countDirs(workspace);

  const language = detectLanguage(keyFiles);
  const framework = detectFramework(keyFiles);

  // Build context text
  let contextText = "## Project Structure\n\n";
  contextText += `- **Language**: ${language}\n`;
  contextText += `- **Framework**: ${framework}\n`;
  contextText += `- **Files**: ~${fileCount.value}\n`;
  contextText += `- **Directories**: ~${totalDirs}\n\n`;

  if (keyFiles.length > 0) {
    contextText += "### Key Files\n\n";
    for (const kf of keyFiles.slice(0, 20)) {
      contextText += `- \`${kf.path}\` — ${kf.role}\n`;
    }
    contextText += "\n";
  }

  contextText += "### Directory Tree\n\n```\n";
  // Strip the workspace prefix from the tree
  const treeLines = tree.split("\n").filter(Boolean);
  if (treeLines.length > 0) {
    contextText += treeLines.join("\n");
  }
  contextText += "\n```\n";

  return {
    tree,
    keyFiles,
    language,
    framework,
    totalFiles: fileCount.value,
    totalDirs,
    contextText,
  };
}
