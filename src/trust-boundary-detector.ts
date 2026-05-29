/**
 * Trust Boundary Erosion Detector — detect architectural privilege escalation
 * paths that SAST cannot see.
 *
 * CSA 2026 research note found 322% more privilege escalation paths and 153%
 * more architectural design flaws in AI-generated code. Apiiro and
 * beyondscale.tech confirm: code is syntactically correct but *architecturally
 * absent* of security controls that should exist by design.
 *
 * Patterns detected:
 * 1. over-permissive-iam: IAM policies with s3:*, resource:"*", Action:"*"
 * 2. missing-auth-middleware: Data-handling routes without auth middleware
 * 3. absent-audit-logging: Auth/security events without logging
 *
 * Zero LLM cost — pattern analysis on added diff lines.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustBoundaryCategory =
  | "over-permissive-iam"
  | "missing-auth-middleware"
  | "absent-audit-logging";

export interface TrustBoundaryIssue {
  category: TrustBoundaryCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface TrustBoundaryResult {
  issues: TrustBoundaryIssue[];
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

const SKIP_LINE_RE = /^[-+]\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

const TEST_PATH_RE = /(?:__tests__|\.test\.|\.spec\.|_test\.|_spec\.|tests?\/)/;

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Category 1: Over-permissive IAM policies
// Category 1 patterns used inline in detectOverPermissiveIAM()

// File types where IAM patterns are meaningful (not false-positive in app code)
const IAM_RELEVANT_PATHS = /\.(?:yml|yaml|tf|json|jsonnet|cdk\.ts|template\.)/i;

// Category 2: Data-handling routes without auth middleware
// Patterns that look like route handlers handling data without auth
const ROUTE_HANDLER_PATTERNS = [
  // Express/Connect routes
  /\b(?:app|router)\.(?:get|post|put|patch|delete|all)\s*\(\s*['"]/i,
  // Fastify routes
  /\.route\s*\(\s*\{/i,
  // Koa routes
  /\.use\s*\(\s*\/\w+/i,
  // Flask/Django routes
  /@(?:app|bp|router)\.(?:route|get|post|put|delete|patch)\s*\(/i,
  // Spring @RequestMapping family
  /@(?:Request(?:Mapping|Mapping)|Get|Post|Put|Delete|Patch)Mapping\b/i,
  // .NET [HttpGet] etc
  /\[(?:Http(?:Get|Post|Put|Delete|Patch))\]/i,
  // AWS Lambda handlers
  /exports?\.(?:handler|lambda)\s*=/i,
  /async\s+function\s+(?:handler|lambdaHandler)\s*\(/i,
];

// Auth middleware patterns that SHOULD accompany route handlers
const AUTH_MIDDLEWARE_PATTERNS = [
  /\b(?:auth|authenticate|verifyToken|checkAuth|isAuthenticated|requireAuth|isAllowed)\b/i,
  /\bUseGuards\s*\(\s*AuthGuard/i,
  /@(?:login_required|require_auth|preAuthorize|RolesAllowed)\b/i,
  /\bmiddleware\s*[:=]\s*\[.*(?:auth|authenticate)/i,
  /\bbefore_action\s*:/i,
  /\[Authorize\]/i,
  /\[AllowAnonymous\]/i,
];

// Category 3: Absent audit logging on security events
// Security event patterns that should have logging
const SECURITY_EVENT_PATTERNS = [
  /\b(?:login|signin|auth(?:enticate|orize)?)\s*\(/i,
  /\b(?:logout|signout|revoke)\s*\(/i,
  /\b(?:grant|revoke|assign|remove)\w*(?:Role|Permission|Access|Privilege)\b/i,
  /\b(?:create|delete|update)\w*(?:User|Account|Admin|Secret|Key|Token|Credential)\b/i,
  /\b(?:password|passwd|secret)\w*(?:reset|change|update|rotate)\b/i,
  /\b(?:permission|privilege|capability)\w*(?:escalat|elevat|chang|modif)\b/i,
  /\b(?:escalat|elevat)\w*(?:Privilege|Permission|Access|Capability)\b/i,
];

// Logging patterns that SHOULD accompany security events
const LOGGING_PATTERNS = [
  /\b(?:log|logger|audit|record|track|trace|monitor|alert)\w*\s*\.\s*(?:info|warn|error|debug|audit)\s*\(/i,
  /\bconsole\.\s*(?:log|warn|error|info)\s*\(/i,
  /\bwrite(?:Log|Audit|Event|Record)\s*\(/i,
  /\b(?:emit|dispatch|publish|send)\w*(?:Event|Audit|Log)\s*\(/i,
  /\.audit\s*\.\s*(?:log|record|write)\s*\(/i,
];

// ---------------------------------------------------------------------------
// Detection: over-permissive-iam
// ---------------------------------------------------------------------------

function detectOverPermissiveIAM(file: DiffFile): TrustBoundaryIssue[] {
  const issues: TrustBoundaryIssue[] = [];
  if (!IAM_RELEVANT_PATHS.test(file.path)) return issues;

  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (TEST_PATH_RE.test(file.path)) continue;

    // Check for star actions (CloudFormation YAML: Action: "*", Terraform: actions = ["*"])
    if (/["']?(?:Action|actions?)["']?\s*[:=]\s*\[?["']\*["']\]?/i.test(trimmed)) {
      issues.push({
        category: "over-permissive-iam",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Over-permissive IAM in \`${file.path}:${change.line}\` — wildcard action grants all permissions; CSA 2026: privilege escalation paths rose 322% in AI-generated code; follow least-privilege principle: grant only the specific actions needed`,
        severity: "critical",
      });
      continue;
    }

    // Check for star resources (CloudFormation: Resource: "*", Terraform: resources = ["*"])
    if (/["']?(?:Resource|resources?)["']?\s*[:=]\s*\[?["']\*["']\]?/i.test(trimmed)) {
      issues.push({
        category: "over-permissive-iam",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Over-permissive IAM in \`${file.path}:${change.line}\` — wildcard resource grants access to all resources; CSA 2026: privilege escalation +322% in AI-iterated code; restrict to specific resource ARNs`,
        severity: "critical",
      });
      continue;
    }

    // Check for star principal (public access)
    if (/["']?(?:Principal|principals?)["']?\s*[:=]\s*\[?["']\*["']\]?/i.test(trimmed)) {
      issues.push({
        category: "over-permissive-iam",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Public IAM principal in \`${file.path}:${change.line}\` — Principal:"*" grants access to everyone; restrict to specific IAM roles or accounts`,
        severity: "critical",
      });
      continue;
    }

    // AWS service-specific wildcards
    const SERVICE_STAR_RE = /\b(s3|sqs|sns|lambda|ec2|secretsmanager|kms|dynamodb|iam|sts):\*/i;
    const starMatch = SERVICE_STAR_RE.exec(trimmed);
    if (starMatch) {
      issues.push({
        category: "over-permissive-iam",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Over-permissive IAM in \`${file.path}:${change.line}\`: \`${starMatch[1]}:*\` grants all ${starMatch[1]} permissions; follow least-privilege: specify only the actions needed`,
        severity: "warning",
      });
      continue;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: missing-auth-middleware
// ---------------------------------------------------------------------------

function detectMissingAuthMiddleware(file: DiffFile): TrustBoundaryIssue[] {
  const issues: TrustBoundaryIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (TEST_PATH_RE.test(file.path)) continue;

    // Check if this line is a route handler
    const isRoute = ROUTE_HANDLER_PATTERNS.some((re) => re.test(trimmed));
    if (!isRoute) continue;

    // Check if auth middleware is present on the same line
    const hasAuth = AUTH_MIDDLEWARE_PATTERNS.some((re) => re.test(trimmed));
    if (hasAuth) continue;

    // Check if this is explicitly allowAnonymous
    if (/\[AllowAnonymous\]/i.test(trimmed)) continue;

    // Check for data-handling verbs in route (POST, PUT, DELETE, PATCH)
    const isDataMutating = /\b(?:post|put|delete|patch)\b/i.test(trimmed);

    issues.push({
      category: "missing-auth-middleware",
      file: file.path,
      line: change.line,
      code: trimmed,
      description: `Missing auth middleware in \`${file.path}:${change.line}\`: route handler${isDataMutating ? " with data mutation" : ""} without authentication/authorization guard; CSA 2026: architectural design flaws rose 153% as LLMs iterate — controls that should exist by design are absent; add auth middleware or document why this route is intentionally public`,
      severity: isDataMutating ? "critical" : "warning",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: absent-audit-logging
// ---------------------------------------------------------------------------

function detectAbsentAuditLogging(file: DiffFile): TrustBoundaryIssue[] {
  const issues: TrustBoundaryIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (TEST_PATH_RE.test(file.path)) continue;

    // Check if this line is a security event
    const isSecurityEvent = SECURITY_EVENT_PATTERNS.some((re) => re.test(trimmed));
    if (!isSecurityEvent) continue;

    // Check if logging is present on the same line
    const hasLogging = LOGGING_PATTERNS.some((re) => re.test(trimmed));
    if (hasLogging) continue;

    issues.push({
      category: "absent-audit-logging",
      file: file.path,
      line: change.line,
      code: trimmed,
      description: `Absent audit logging in \`${file.path}:${change.line}\`: security event without logging/audit trail; CSA 2026: "architectural design flaws rose 153%" — security events must produce audit records for compliance and incident response; add structured logging for this security-relevant operation`,
      severity: "warning",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: TrustBoundaryIssue[]): TrustBoundaryIssue[] {
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

function buildTrustBoundaryContext(result: TrustBoundaryResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Trust Boundary Erosion Detection (${result.issues.length})\n`;
  ctx += "This PR has trust boundary erosion — missing or overly broad security controls:\n\n";

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

function buildTrustBoundaryBodySummary(result: TrustBoundaryResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Trust Boundary Erosion Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Trust boundary erosion — CSR 2026: privilege escalation +322%, design flaws +153% in AI-iterated code. Over-permissive IAM, missing auth middleware on data-handling routes, absent audit logging on security events. These are architectural vulnerabilities invisible to SAST.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run trust boundary erosion detection on diff files. Zero LLM cost. */
export function detectTrustBoundaryErosion(diffFiles: DiffFile[]): TrustBoundaryResult {
  const allIssues: TrustBoundaryIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectOverPermissiveIAM(file));
    allIssues.push(...detectMissingAuthMiddleware(file));
    allIssues.push(...detectAbsentAuditLogging(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: TrustBoundaryResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildTrustBoundaryContext(result);
  result.bodySummary = buildTrustBoundaryBodySummary(result);

  if (issues.length > 0) {
    core.info(`Trust boundary erosion detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
