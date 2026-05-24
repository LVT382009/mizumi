/**
 * Deterministic rule engine — runs before LLM, never hallucinates.
 * 12 rules: hardcoded secrets, auth middleware, SQL concat, eval, innerHTML,
 * debugger, weak crypto, timing-unsafe compare, unsafe regex, TODO/FIXME,
 * duplicate approval guard, and no-evil-eval.
 */
import { DiffFile, DiffHunk } from "./diff.js";
import { minimatch } from "minimatch";

export interface RuleFinding {
  file: string;
  line: number;
  severity: "critical" | "high" | "medium" | "low";
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

    // Rule: eval/Function usage — code injection risk
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasEvalUsage(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "critical",
            category: "security",
            message: "eval() or Function() constructor detected — allows arbitrary code execution. Use safer alternatives.",
            rule: "no-eval",
          });
        }
      }
    }

    // Rule: unsafe innerHTML — XSS risk
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasUnsafeInnerHTML(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "high",
            category: "security",
            message: "innerHTML assignment detected — potential XSS vector. Use textContent or DOMPurify.sanitize() instead.",
            rule: "no-unsafe-innerhtml",
          });
        }
      }
    }

    // Rule: debugger statement left in code
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasDebugger(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "medium",
            category: "compliance",
            message: "debugger statement detected — remove before production",
            rule: "no-debugger",
          });
        }
      }
    }

    // Rule: weak crypto algorithms
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasWeakCrypto(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "high",
            category: "security",
            message: "Weak crypto algorithm detected — use AES-256, SHA-256+, or modern equivalents",
            rule: "no-weak-crypto",
          });
        }
      }
    }

    // Rule: timing-unsafe comparison for secrets
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasTimingUnsafeCompare(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "high",
            category: "security",
            message: "Direct comparison of secrets (== or !=) is vulnerable to timing attacks. Use crypto.timingSafeEqual() or hmac.compare()",
            rule: "no-timing-unsafe-compare",
          });
        }
      }
    }

    // Rule: unsafe regex (ReDoS risk)
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasUnsafeRegex(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "medium",
            category: "security",
            message: "Potentially unsafe regex — nested quantifiers can cause catastrophic backtracking (ReDoS)",
            rule: "no-unsafe-regex",
          });
        }
      }
    }

    // Rule: TODO/FIXME/HACK — technical debt tracker
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add" && hasTodoFixme(change.content)) {
          findings.push({
            file: file.path,
            line: change.line,
            severity: "low",
            category: "compliance",
            message: "TODO/FIXME/HACK comment detected — track as technical debt",
            rule: "track-todo",
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
  return hunk.changes
    .filter((c: { line: number; type: string }) => Math.abs(c.line - line) <= 10 && c.type !== "delete")
    .map((c: { content: string }) => c.content);
}

function hasHardcodedSecret(line: string): boolean {
  return /(api[-_]?key|password|passwd|secret|token|credential)\s*[:=]\s*["'][^"']{8,}["']/i.test(line)
    && !/process\.env|import\.meta|ENV|getenv/i.test(line);
}

export function hasEvalUsage(line: string): boolean {
  return /\b(eval|Function)\s*\(/.test(line);
}

export function hasUnsafeInnerHTML(line: string): boolean {
  return /\.innerHTML\s*=/.test(line) && !/DOMPurify\.sanitize/.test(line);
}

export function hasDebugger(line: string): boolean {
  return /^\s*debugger\s*;?\s*$/.test(line);
}

export function hasWeakCrypto(line: string): boolean {
  return /\b(md5|sha1|des|rc4|blowfish)\s*\(/i.test(line) || /createHash\s*\(\s*["'](?:md5|sha1)["']\s*\)/.test(line);
}

export function hasTimingUnsafeCompare(line: string): boolean {
  return /(?:password|secret|token|key|hash|signature)\s*(===|!==|==|!=)\s*/i.test(line)
    && !/timingSafeEqual|hmac\.verify|crypto\.verify/.test(line);
}

export function hasUnsafeRegex(line: string): boolean {
  return /\([^)]*[+*][^)]*\)[+*]/.test(line) && /RegExp|new\s+RegExp|\/.*\/[gimsuy]/.test(line);
}

export function hasTodoFixme(line: string): boolean {
  return /\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line);
}

function hasSQLConcat(line: string): boolean {
  return /(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\s.*[+`]/i.test(line)
    && /\$\{/.test(line) === false;
}
