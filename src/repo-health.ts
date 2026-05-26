/**
 * Repository Health Score — zero-LLM static health assessment.
 *
 * Scans the workspace for 10 health signals and computes a 0-100 score.
 * Injects into review context so the LLM calibrates finding severity
 * against overall project health (high-health projects get stricter
 * review; low-health projects get guidance-focused review).
 *
 * New in v0.1: no competitor computes repo health at review time.
 * CodeClimate/Codacy require pre-indexing. Mizumi does it ad-hoc <10ms.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthSignal {
  id: string;
  name: string;
  weight: number;
  score: number;
  maxScore: number;
  detail: string;
}

export interface RepoHealthResult {
  score: number;
  grade: string;
  signals: HealthSignal[];
  contextText: string;
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Signal detectors (each returns 0..maxScore)
// ---------------------------------------------------------------------------

function detectCIConfig(workspace: string, keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasCI = keyFiles.some(f => f.role === "CI/CD") ||
    fs.existsSync(path.join(workspace, ".github", "workflows")) ||
    fs.existsSync(path.join(workspace, ".gitlab-ci.yml")) ||
    fs.existsSync(path.join(workspace, "Jenkinsfile")) ||
    fs.existsSync(path.join(workspace, ".circleci"));

  const score = hasCI ? 10 : 0;
  return {
    id: "ci_config",
    name: "CI/CD Configuration",
    weight: 1.0,
    score,
    maxScore: 10,
    detail: hasCI ? "CI pipeline detected" : "No CI configuration found",
  };
}

function detectTestFramework(workspace: string, keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasTestConfig = keyFiles.some(f =>
    f.role === "test config" || f.path.includes("__tests__") || f.path.includes(".test.") || f.path.includes(".spec.")
  );
  const hasTestDir = fs.existsSync(path.join(workspace, "test")) ||
    fs.existsSync(path.join(workspace, "tests")) ||
    fs.existsSync(path.join(workspace, "__tests__")) ||
    fs.existsSync(path.join(workspace, "spec"));

  const score = (hasTestConfig ? 6 : 0) + (hasTestDir ? 4 : 0);
  return {
    id: "test_framework",
    name: "Test Framework",
    weight: 1.2,
    score,
    maxScore: 10,
    detail: hasTestConfig && hasTestDir
      ? "Test framework + test directory detected"
      : hasTestConfig
        ? "Test config found but no test directory"
        : hasTestDir
          ? "Test directory found but no test config"
          : "No test framework detected",
  };
}

function detectLintConfig(_workspace: string, keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasLinter = keyFiles.some(f => f.role === "linter");
  const score = hasLinter ? 10 : 0;
  return {
    id: "lint_config",
    name: "Linter Configuration",
    weight: 0.8,
    score,
    maxScore: 10,
    detail: hasLinter ? "Linter configuration found" : "No linter configuration found",
  };
}

function detectFormatterConfig(keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasFormatter = keyFiles.some(f => f.role === "formatter");
  const score = hasFormatter ? 10 : 0;
  return {
    id: "formatter_config",
    name: "Code Formatter",
    weight: 0.5,
    score,
    maxScore: 10,
    detail: hasFormatter ? "Formatter configuration found" : "No formatter configuration found",
  };
}

function detectContainerConfig(keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasContainer = keyFiles.some(f => f.role === "container");
  const score = hasContainer ? 10 : 0;
  return {
    id: "container_config",
    name: "Container Configuration",
    weight: 0.6,
    score,
    maxScore: 10,
    detail: hasContainer ? "Docker/container config found" : "No container configuration found",
  };
}

function detectDependencyManagement(keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasDeps = keyFiles.some(f => f.role === "dependencies");
  const hasLockfile = keyFiles.some(f => f.role === "lockfile");
  const score = (hasDeps ? 6 : 0) + (hasLockfile ? 4 : 0);
  return {
    id: "dependency_mgmt",
    name: "Dependency Management",
    weight: 1.0,
    score,
    maxScore: 10,
    detail: hasDeps && hasLockfile
      ? "Dependency file + lockfile present"
      : hasDeps
        ? "Dependency file without lockfile"
        : "No dependency management detected",
  };
}

function detectEnvConfig(workspace: string, keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasEnv = keyFiles.some(f => f.role === "environment");
  const hasEnvExample = fs.existsSync(path.join(workspace, ".env.example")) || fs.existsSync(path.join(workspace, ".env.sample"));
  const score = hasEnv ? (hasEnvExample ? 10 : 5) : 5;
  return {
    id: "env_config",
    name: "Environment Configuration",
    weight: 0.7,
    score,
    maxScore: 10,
    detail: hasEnv && !hasEnvExample
      ? ".env file present but no .env.example — add a template for new developers"
      : hasEnvExample
        ? "Environment template found"
        : "No .env files detected",
  };
}

function detectOwnership(keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasOwnership = keyFiles.some(f => f.role === "ownership");
  const score = hasOwnership ? 10 : 0;
  return {
    id: "code_ownership",
    name: "Code Ownership",
    weight: 0.8,
    score,
    maxScore: 10,
    detail: hasOwnership ? "CODEOWNERS file found" : "No CODEOWNERS file found",
  };
}

function detectDocumentation(workspace: string): HealthSignal {
  const hasReadme = fs.existsSync(path.join(workspace, "README.md"));
  const hasContributing = fs.existsSync(path.join(workspace, "CONTRIBUTING.md")) ||
    fs.existsSync(path.join(workspace, ".github", "CONTRIBUTING.md"));
  const hasChangelog = fs.existsSync(path.join(workspace, "CHANGELOG.md")) ||
    fs.existsSync(path.join(workspace, "CHANGES.md"));

  const score = (hasReadme ? 5 : 0) + (hasContributing ? 3 : 0) + (hasChangelog ? 2 : 0);
  return {
    id: "documentation",
    name: "Documentation",
    weight: 0.6,
    score,
    maxScore: 10,
    detail: [hasReadme && "README", hasContributing && "CONTRIBUTING", hasChangelog && "CHANGELOG"]
      .filter(Boolean)
      .join(", ") || "No documentation files found",
  };
}

function detectSecurityConfig(workspace: string, keyFiles: Array<{ path: string; role: string }>): HealthSignal {
  const hasSecurityPolicy = fs.existsSync(path.join(workspace, "SECURITY.md")) ||
    fs.existsSync(path.join(workspace, ".github", "SECURITY.md"));
  const hasDependabot = fs.existsSync(path.join(workspace, ".github", "dependabot.yml")) ||
    fs.existsSync(path.join(workspace, ".github", "dependabot.yaml"));
  const hasCodeowners = keyFiles.some(f => f.role === "ownership");
  const hasSecurityPaths = fs.existsSync(path.join(workspace, ".github", "CODEOWNERS"));

  const score = (hasSecurityPolicy ? 4 : 0) + (hasDependabot ? 3 : 0) + ((hasCodeowners || hasSecurityPaths) ? 3 : 0);
  return {
    id: "security_config",
    name: "Security Configuration",
    weight: 1.0,
    score,
    maxScore: 10,
    detail: [hasSecurityPolicy && "Security policy", hasDependabot && "Dependabot", (hasCodeowners || hasSecurityPaths) && "Code ownership"]
      .filter(Boolean)
      .join(", ") || "No security configuration found",
  };
}

// ---------------------------------------------------------------------------
// Grade computation
// ---------------------------------------------------------------------------

function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  if (score >= 50) return "E";
  return "F";
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function generateRecommendations(signals: HealthSignal[]): string[] {
  const recs: string[] = [];
  for (const sig of signals) {
    const ratio = sig.score / sig.maxScore;
    if (ratio < 0.5) {
      if (sig.id === "ci_config") recs.push("Set up CI/CD to catch issues before merge");
      else if (sig.id === "test_framework") recs.push("Add a test framework and write initial test suite");
      else if (sig.id === "lint_config") recs.push("Add ESLint or similar linter for consistent code style");
      else if (sig.id === "formatter_config") recs.push("Add Prettier or similar formatter for consistent formatting");
      else if (sig.id === "dependency_mgmt") recs.push("Add a lockfile to pin dependency versions");
      else if (sig.id === "env_config") recs.push("Add .env.example to document required environment variables");
      else if (sig.id === "code_ownership") recs.push("Add CODEOWNERS to define code ownership and review routing");
      else if (sig.id === "documentation") recs.push("Add README.md with project setup and usage instructions");
      else if (sig.id === "security_config") recs.push("Add SECURITY.md and enable Dependabot for vulnerability alerts");
      else if (sig.id === "container_config") recs.push("Add Dockerfile for reproducible builds");
    }
  }
  return recs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute repository health score from workspace scan.
 * Zero LLM cost. Ad-hoc detection of 10 health signals.
 */
export function computeRepoHealth(
  workspace: string,
  keyFiles: Array<{ path: string; role: string }> = [],
): RepoHealthResult {
  // If keyFiles not provided, do a lightweight scan
  if (keyFiles.length === 0) {
    keyFiles = scanKeyFiles(workspace);
  }

  const signals: HealthSignal[] = [
    detectCIConfig(workspace, keyFiles),
    detectTestFramework(workspace, keyFiles),
    detectLintConfig(workspace, keyFiles),
    detectFormatterConfig(keyFiles),
    detectContainerConfig(keyFiles),
    detectDependencyManagement(keyFiles),
    detectEnvConfig(workspace, keyFiles),
    detectOwnership(keyFiles),
    detectDocumentation(workspace),
    detectSecurityConfig(workspace, keyFiles),
  ];

  // Weighted score
  let totalWeighted = 0;
  let maxWeighted = 0;
  for (const sig of signals) {
    totalWeighted += sig.score * sig.weight;
    maxWeighted += sig.maxScore * sig.weight;
  }

  const score = maxWeighted > 0 ? Math.round((totalWeighted / maxWeighted) * 100) : 0;
  const grade = scoreToGrade(score);
  const recommendations = generateRecommendations(signals);

  // Build context text
  let contextText = "## Repository Health\n\n";
  contextText += `- **Health Score**: ${score}/100 (Grade: ${grade})\n\n`;
  contextText += "| Signal | Score | Status |\n";
  contextText += "|--------|-------|--------|\n";
  for (const sig of signals) {
    const pct = Math.round((sig.score / sig.maxScore) * 100);
    const status = pct >= 80 ? "good" : pct >= 50 ? "partial" : "missing";
    contextText += `| ${sig.name} | ${sig.score}/${sig.maxScore} | ${status} |\n`;
  }

  if (recommendations.length > 0) {
    contextText += "\n### Recommendations\n\n";
    for (const rec of recommendations) {
      contextText += `- ${rec}\n`;
    }
  }

  return { score, grade, signals, contextText, recommendations };
}

// ---------------------------------------------------------------------------
// Lightweight key file scanner (used when keyFiles not pre-computed)
// ---------------------------------------------------------------------------

const KEY_PATTERNS: Array<{ test: (name: string) => boolean; role: string }> = [
  { test: n => n === "package.json", role: "dependencies" },
  { test: n => n === "package-lock.json" || n === "pnpm-lock.yaml" || n === "yarn.lock", role: "lockfile" },
  { test: n => n === "tsconfig.json" || n.startsWith("tsconfig."), role: "typescript config" },
  { test: n => n.startsWith(".eslintrc") || n.startsWith("eslint.config."), role: "linter" },
  { test: n => n.startsWith(".prettierrc") || n.startsWith("prettier.config."), role: "formatter" },
  { test: n => n.startsWith("jest.config.") || n.startsWith("vitest.config."), role: "test config" },
  { test: n => n.startsWith("vite.config.") || n.startsWith("webpack.config.") || n.startsWith("rollup.config."), role: "bundler" },
  { test: n => n.startsWith("Dockerfile") || n.startsWith("docker-compose"), role: "container" },
  { test: n => n.startsWith(".env"), role: "environment" },
  { test: n => n === "CODEOWNERS", role: "ownership" },
  { test: n => n === "CLAUDE.md" || n === ".cursorrules", role: "AI instructions" },
  { test: n => n === "REVIEW.md", role: "review rules" },
];

const SKIP_DIRS_SET = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "coverage", ".cache", ".vscode", ".idea", "__pycache__",
  ".terraform", "vendor", ".venv", "venv", ".tox",
]);

function scanKeyFiles(dir: string, relPath: string = ""): Array<{ path: string; role: string }> {
  const results: Array<{ path: string; role: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS_SET.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github")) continue;
      results.push(...scanKeyFiles(entryPath, entryRel));
    } else if (entry.isFile()) {
      const basename = entry.name;
      for (const { test, role } of KEY_PATTERNS) {
        if (test(basename)) {
          results.push({ path: entryRel, role });
          break;
        }
      }
      if (entryRel.startsWith(".github/")) {
        results.push({ path: entryRel, role: "CI/CD" });
      }
    }
  }
  return results;
}
