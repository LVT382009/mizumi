/**
 * Linter pre-scan — run project linters (ESLint, tsc, prettier) before LLM review.
 * Linter findings are deterministic (never hallucinate), saving LLM tokens
 * and improving accuracy for style/formatting issues.
 *
 * This is a best-effort scan: linters are optional and may not be installed.
 * Failures are logged as warnings and skipped gracefully.
 *
 * Security: uses execFileSync (argv array) instead of execSync to prevent
 * shell injection via malicious file paths.
 */
import * as core from "@actions/core";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface LinterFinding {
  file: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  category: "style" | "bug" | "security" | "compliance";
  message: string;
  linter: string;
}

/** Normalize workspace-relative path (handles both / and \ on Windows) */
function relativePath(workspace: string, absPath: string): string {
  const normWs = path.normalize(workspace);
  const normAbs = path.normalize(absPath);
  if (normAbs.startsWith(normWs)) {
    return normAbs.slice(normWs.length).replace(/^[\\/]+/, "");
  }
  return absPath;
}

/**
 * Run project linters on changed files and return deterministic findings.
 * Each linter is optional — if not installed or configured, it's skipped.
 */
export function runLinters(
  workspace: string,
  changedFiles: string[]
): LinterFinding[] {
  const findings: LinterFinding[] = [];
  const jsFiles = changedFiles.filter((f) =>
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)
  );

  if (jsFiles.length === 0) return findings;

  // ESLint
  try {
    const eslintResults = runEslint(workspace, jsFiles);
    findings.push(...eslintResults);
  } catch (e) {
    core.debug("ESLint scan skipped: " + (e instanceof Error ? e.message : String(e)));
  }

  // TypeScript compiler (tsc --noEmit)
  try {
    const tscResults = runTsc(workspace);
    findings.push(...tscResults);
  } catch (e) {
    core.debug("tsc scan skipped: " + (e instanceof Error ? e.message : String(e)));
  }

  // Prettier check
  try {
    const prettierResults = runPrettier(workspace, jsFiles);
    findings.push(...prettierResults);
  } catch (e) {
    core.debug("Prettier scan skipped: " + (e instanceof Error ? e.message : String(e)));
  }

  if (findings.length > 0) {
    core.info(`Linter pre-scan: ${findings.length} finding(s) from linters`);
  }

  return findings;
}

/** Run ESLint with JSON output format and parse results (execFileSync — no shell injection) */
export function runEslint(
  workspace: string,
  files: string[]
): LinterFinding[] {
  const findings: LinterFinding[] = [];
  const fileArgs = files.slice(0, 50);

  try {
    const output = execFileSync(
      "npx", ["eslint", "--format", "json", "--no-error-on-unmatched-pattern", ...fileArgs],
      { cwd: workspace, timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    const results = JSON.parse(output) as Array<{
      filePath: string;
      messages: Array<{
        line: number;
        severity: number; // 1=warn, 2=error
        message: string;
        ruleId: string;
      }>;
    }>;

    for (const result of results) {
      const relPath = relativePath(workspace, result.filePath);
      for (const msg of result.messages) {
        findings.push({
          file: relPath,
          line: msg.line,
          severity: msg.severity === 2 ? "high" : "low",
          category: categorizeRule(msg.ruleId),
          message: msg.message + (msg.ruleId ? ` (${msg.ruleId})` : ""),
          linter: "eslint",
        });
      }
    }
  } catch (e: any) {
    // ESLint exits with non-zero on findings — parse the stdout
    if (e?.stdout) {
      try {
        const results = JSON.parse(e.stdout) as Array<{
          filePath: string;
          messages: Array<{
            line: number;
            severity: number;
            message: string;
            ruleId: string;
          }>;
        }>;

        for (const result of results) {
          const relPath = relativePath(workspace, result.filePath);
          for (const msg of result.messages) {
            findings.push({
              file: relPath,
              line: msg.line,
              severity: msg.severity === 2 ? "high" : "low",
              category: categorizeRule(msg.ruleId),
              message: msg.message + (msg.ruleId ? ` (${msg.ruleId})` : ""),
              linter: "eslint",
            });
          }
        }
      } catch {
        // Not JSON output — likely ESLint not installed
      }
    }
  }

  return findings;
}

/** Run tsc --noEmit and parse diagnostic output */
export function runTsc(workspace: string): LinterFinding[] {
  const findings: LinterFinding[] = [];
  try {
    execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
      cwd: workspace, timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    // No errors — tsc exits 0
  } catch (e: any) {
    const output = e?.stdout || e?.stderr || "";
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^(.+?)\((\d+),\d+\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/);
      if (match) {
        findings.push({
          file: relativePath(workspace, match[1]),
          line: parseInt(match[2], 10),
          severity: match[3] === "error" ? "high" : "low",
          category: "bug",
          message: `${match[4]}: ${match[5]}`,
          linter: "tsc",
        });
      }
    }
  }
  return findings;
}

/** Run prettier --check and report unformatted files */
export function runPrettier(
  workspace: string,
  files: string[]
): LinterFinding[] {
  const findings: LinterFinding[] = [];
  const fileArgs = files.slice(0, 50);

  try {
    execFileSync("npx", ["prettier", "--check", ...fileArgs], {
      cwd: workspace, timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    const output = e?.stdout || e?.stderr || "";
    for (const line of output.split("\n")) {
      const trimmed = line.trim().replace(/^\[warn\]\s*/, "");
      if (trimmed && files.some((f) => trimmed.endsWith(f) || f.endsWith(trimmed))) {
        findings.push({
          file: trimmed,
          line: 1,
          severity: "low",
          category: "style",
          message: "File not formatted with Prettier",
          linter: "prettier",
        });
      }
    }
  }
  return findings;
}

/** Map ESLint rule IDs to Mizumi categories */
export function categorizeRule(ruleId: string): "style" | "bug" | "security" | "compliance" {
  if (!ruleId) return "style";
  if (ruleId.includes("security") || ruleId.includes("no-eval") ||
    ruleId.includes("no-implied-eval") || ruleId.includes("no-new-func") ||
    ruleId.startsWith("security/")) return "security";
  if (ruleId.includes("no-") && (ruleId.includes("undef") || ruleId.includes("unused") ||
    ruleId.includes("console") || ruleId.includes("debugger"))) return "bug";
  return "style";
}

/**
 * Run dependency vulnerability audit (npm audit / pip-audit).
 * Surfaces CVE findings as deterministic LinterFindings with confidence=100.
 * Best-effort: if the tool isn't installed or no lockfile exists, returns [].
 */
export function runDependencyAudit(workspace: string): LinterFinding[] {
  const findings: LinterFinding[] = [];

  // npm audit (Node.js projects)
  try {
    const npmFindings = runNpmAudit(workspace);
    findings.push(...npmFindings);
  } catch (e) {
    core.debug("npm audit skipped: " + (e instanceof Error ? e.message : String(e)));
  }

  // pip-audit (Python projects)
  try {
    const pipFindings = runPipAudit(workspace);
    findings.push(...pipFindings);
  } catch (e) {
    core.debug("pip-audit skipped: " + (e instanceof Error ? e.message : String(e)));
  }

  if (findings.length > 0) {
    core.info(`Dependency audit: ${findings.length} CVE finding(s)`);
  }

  return findings;
}

/** Run npm audit --json and parse vulnerability results */
export function runNpmAudit(workspace: string): LinterFinding[] {
  const findings: LinterFinding[] = [];

  try {
    execFileSync("npm", ["audit", "--json"], {
      cwd: workspace, timeout: 60000, encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // npm audit exits 0 when no vulnerabilities
  } catch (e: any) {
    const output = e?.stdout || "";
    if (!output) return findings;

    try {
      const audit = JSON.parse(output) as {
        vulnerabilities?: Record<string, {
          severity: string;
          via: Array<string | { title: string; url: string; severity: string }>;
          fixAvailable?: boolean | { name: string; version: string };
        }>;
      };

      if (!audit.vulnerabilities) return findings;

      for (const [pkg, vuln] of Object.entries(audit.vulnerabilities)) {
        const sev = mapNpmSeverity(vuln.severity);
        const cves = vuln.via
          .filter((v): v is { title: string; url: string; severity: string } => typeof v === "object")
          .map((v) => v.title)
          .filter(Boolean);

        const message = cves.length > 0
          ? `${pkg}: ${cves.join(", ")}${vuln.fixAvailable ? " (fix available)" : " (no fix available)"}`
          : `${pkg}: vulnerability found${vuln.fixAvailable ? " (fix available)" : " (no fix available)"}`;

        findings.push({
          file: "package.json",
          line: 1,
          severity: sev,
          category: "security",
          message,
          linter: "npm-audit",
        });
      }
    } catch {
      // Not JSON — npm audit not available or malformed output
    }
  }

  return findings;
}

/** Run pip-audit --format json and parse vulnerability results */
export function runPipAudit(workspace: string): LinterFinding[] {
  const findings: LinterFinding[] = [];

  try {
    const output = execFileSync("pip-audit", ["--format", "json"], {
      cwd: workspace, timeout: 60000, encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      const audit = JSON.parse(output) as {
        dependencies?: Array<{
          name: string;
          version: string;
          skipped?: string;
          vulns?: Array<{
            vid: string;
            aliases: string[];
            severity: string;
          }>;
        }>;
      };

      if (!audit.dependencies) return findings;

      for (const dep of audit.dependencies) {
        if (!dep.vulns || dep.vulns.length === 0) continue;

        const worstSev = dep.vulns.reduce((worst, v) => {
          const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
          const vOrd = order[v.severity] ?? 4;
          const wOrd = order[worst] ?? 4;
          return vOrd < wOrd ? v.severity : worst;
        }, "low");

        const aliases = dep.vulns.flatMap((v) => [v.vid, ...v.aliases]).slice(0, 3).join(", ");

        findings.push({
          file: "requirements.txt",
          line: 1,
          severity: worstSev as "critical" | "high" | "medium" | "low",
          category: "security",
          message: `${dep.name}@${dep.version}: ${aliases}`,
          linter: "pip-audit",
        });
      }
    } catch {
      // Not JSON — skip
    }
  } catch (e: any) {
    // pip-audit not installed or no requirements.txt
    core.debug("pip-audit not available: " + (e?.message || String(e)));
  }

  return findings;
}

export function mapNpmSeverity(sev: string): "critical" | "high" | "medium" | "low" {
  switch (sev) {
    case "critical": return "critical";
    case "high": return "high";
    case "moderate": return "medium";
    case "low": return "low";
    default: return "medium";
  }
}
