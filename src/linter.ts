/**
 * Linter pre-scan — run project linters (ESLint, tsc, prettier) before LLM review.
 * Linter findings are deterministic (never hallucinate), saving LLM tokens
 * and improving accuracy for style/formatting issues.
 *
 * This is a best-effort scan: linters are optional and may not be installed.
 * Failures are logged as warnings and skipped gracefully.
 */
import * as core from "@actions/core";
import { execSync } from "node:child_process";

export interface LinterFinding {
  file: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
  category: "style" | "bug" | "security" | "compliance";
  message: string;
  linter: string;
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

/** Run ESLint with JSON output format and parse results */
export function runEslint(
  workspace: string,
  files: string[]
): LinterFinding[] {
  const findings: LinterFinding[] = [];
  const fileArgs = files.slice(0, 50).join(" ");

  try {
    const output = execSync(
      `npx eslint --format json --no-error-on-unmatched-pattern ${fileArgs}`,
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
      const relPath = result.filePath.replace(workspace + "/", "").replace(workspace + "\\", "");
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
          const relPath = result.filePath.replace(workspace + "/", "").replace(workspace + "\\", "");
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
    execSync("npx tsc --noEmit --pretty false", {
      cwd: workspace, timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    // No errors — tsc exits 0
  } catch (e: any) {
    const output = e?.stdout || e?.stderr || "";
    // Parse tsc output: "file.ts(line,col): error TS1234: message"
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^(.+?)\((\d+),\d+\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/);
      if (match) {
        findings.push({
          file: match[1].replace(workspace + "/", "").replace(workspace + "\\", ""),
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
  const fileArgs = files.slice(0, 50).join(" ");

  try {
    execSync(`npx prettier --check ${fileArgs}`, {
      cwd: workspace, timeout: 30000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    // All formatted — exit 0
  } catch (e: any) {
    const output = e?.stdout || e?.stderr || "";
    // Prettier outputs unformatted file paths
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
