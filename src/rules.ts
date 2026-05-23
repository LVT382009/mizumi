/**
 * Deterministic rule engine — runs before LLM, never hallucinates.
 * Phase 1 stub: regex-based checks only. Full Danger integration deferred to Phase 2.
 */
import { DiffFile, DiffHunk } from "./diff.js";
import { minimatch } from "minimatch";

export interface RuleFinding {
  file: string;
  line: number;
  severity: "critical" | "high" | "medium";
  category: "security" | "compliance";
  message: string;
  rule: string;
}

/**
 * Run deterministic rules on the diff before LLM review.
 * These checks are regex-based, zero LLM cost, 100% deterministic.
 */
export function runRules(files: DiffFile[]): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const file of files) {
    // Rule: Every auth endpoint must call auth middleware
    if (file.path.includes("routes/") || file.path.includes("api/")) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          if (change.type === "add" && isRouteDefinition(change.content)) {
            const block = getSurroundingBlock(hunk, change.line);
            if (!callsAuthMiddleware(block)) {
              findings.push({
                file: file.path,
                line: change.line,
                severity: "high",
                category: "security",
                message: "Route handler may be missing authentication middleware",
                rule: "auth-middleware-required",
              });
            }
          }
        }
      }
    }

    // Rule: No hardcoded secrets
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasHardcodedSecret(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "critical",
            category: "security",
            message: "Possible hardcoded secret detected — use environment variables instead",
            rule: "no-hardcoded-secrets",
          });
        }
      }
    }

    // Rule: SQL injection risk (string concatenation in queries)
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasSQLConcat(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "high",
            category: "security",
            message: "Possible SQL injection — use parameterized queries instead of string concatenation",
            rule: "no-sql-concat",
          });
        }
      }
    }
  }

  const dup = checkDuplicateApprovalGuard(files);
  if (dup) findings.push(dup);

  return findings;
}

/** Approval-path glob patterns — files that control authorization. */
const APPROVAL_PATTERNS = [
  "**/auth/**",
  "**/permission*",
  "**/rbac/**",
  "**/policy*",
  "**/access*",
  "**/middleware/auth*",
  "**/guard/**",
];

function isApprovalFile(filePath: string): boolean {
  return APPROVAL_PATTERNS.some((p) => minimatch(filePath, p));
}

/** Phase 3.17 — flag PRs that mix approval/auth changes with unrelated code. */
export function checkDuplicateApprovalGuard(files: DiffFile[]): RuleFinding | null {
  const hasApproval = files.some((f) => isApprovalFile(f.path));
  const hasNonApproval = files.some((f) => !isApprovalFile(f.path));
  if (!hasApproval || !hasNonApproval) return null;
  return {
    file: files.find((f) => isApprovalFile(f.path))!.path,
    line: 0,
    severity: "high",
    category: "security",
    message: "This PR modifies approval logic alongside non-approval changes — potential authorization bypass. Consider splitting into separate PRs.",
    rule: "duplicate-approval-guard",
  };
}

function isRouteDefinition(line: string): boolean {
  return /\.(get|post|put|delete|patch|route)\s*\(/i.test(line);
}

function callsAuthMiddleware(block: string[]): boolean {
  const authPatterns = /auth|authenticate|verify(token|jwt|session)|requireAuth|isAuth/i;
  return block.some((l: string) => authPatterns.test(l));
}

function getSurroundingBlock(hunk: DiffHunk, line: number): string[] {
  // Get ±10 lines around the target line
  return hunk.changes
    .filter((c: { line: number; type: string }) => Math.abs(c.line - line) <= 10 && c.type !== "delete")
    .map((c: { content: string }) => c.content);
}

function hasHardcodedSecret(line: string): boolean {
  // Common patterns: api_key = "xxx", password = "xxx", secret = "xxx"
  return /(api[-_]?key|password|passwd|secret|token|credential)\s*[:=]\s*["'][^"']{8,}["']/i.test(line)
    && !/process\.env|import\.meta|ENV|getenv/i.test(line);
}

function hasSQLConcat(line: string): boolean {
  return /(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s.*[+`]/i.test(line)
    && /\$\{/.test(line) === false; // Template literals are slightly safer
}
