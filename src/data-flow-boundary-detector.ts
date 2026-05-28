/**
 * Data Flow Boundary Detector — detect sensitive data crossing trust
 * boundaries without proper protection in PR diffs.
 *
 * No AI code reviewer detects data flow boundary violations at PR review
 * time. SAST tools find hardcoded secrets, but miss when PII flows from
 * a trusted layer (database, auth module) to an untrusted layer (HTTP
 * response, log, client bundle, third-party API) without sanitization,
 * encryption, or access control checks.
 *
 * These bugs cause data breaches. Real examples:
 * - User SSNs returned in API response without redaction
 * - Password/hash values logged in plain text
 * - PII sent to third-party analytics without consent check
 * - Internal user IDs exposed in client-facing JWTs
 *
 * Mizumi scans added lines for 4 boundary violation categories:
 * 1. Unprotected PII in response: PII fields returned without redaction
 * 2. Sensitive data in log: credentials/secrets/PII passed to log/console
 * 3. Trust boundary skip: data from DB/auth sent directly to external API
 * 4. Client-side leak: server-only data exposed in client/frontend code
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataFlowBoundaryCategory =
  | "unprotected-pii-in-response"
  | "sensitive-data-in-log"
  | "trust-boundary-skip"
  | "client-side-leak";

export interface DataFlowBoundaryIssue {
  /** Category of the issue */
  category: DataFlowBoundaryCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = trust-boundary-skip/sensitive-in-log, warning = unprotected-pii/client-leak */
  severity: "critical" | "warning";
}

export interface DataFlowBoundaryResult {
  /** All detected data flow boundary issues */
  issues: DataFlowBoundaryIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// PII field names
const PII_FIELDS_RE = /\b(?:ssn|socialSecurity|social_security|sin|nationalId|national_id|passport|passportNumber|passport_number|taxId|tax_id|ein|driverLicense|driver_license|dateOfBirth|date_of_birth|dob|birthDate|birth_date|gender|ethnicity|race|religion|sexualOrientation|sexual_orientation|disability|maidenName|maiden_name|biometric|fingerprint|faceId|irisScan)\b/i;

// Financial PII
const FINANCIAL_PII_RE = /\b(?:creditCard|credit_card|cardNumber|card_number|cvv|cvc|pin|pinNumber|pin_number|bankAccount|bank_account|routingNumber|routing_number|iban|swiftCode|swift_code|walletAddress|wallet_address)\b/i;

// Sensitive data that should never be logged
const SECRET_DATA_RE = /\b(?:password|passwd|secret|token|apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|privateKey|private_key|authCode|auth_code|credential|sessionId|session_id)\b/i;

// Log/console output patterns
const LOG_OUTPUT_RE = /\b(?:console\.(log|debug|info|warn|error|dir|table)|logger\.(log|debug|info|warn|error|trace|fatal)|log\.(log|debug|info|warn|error|trace|fatal)|winston\.\w+|bunyan\.\w+|pino\.\w+|logging\.\w+)\s*\(/;

// HTTP response patterns (data going outbound) — includes assignment forms like ctx.body =
const RESPONSE_RE = /\b(?:res\.(?:json|send|end|render|write)|response\.(?:json|send|end|render|write)|ctx\.(?:body|response)|reply\.(?:send|code|type)|ResponseBody|HttpResponse|sendResponse|returnResponse)\s*[\(.=]/;

// External API call patterns (data leaving the system)
const EXTERNAL_API_RE = /\b(?:fetch|axios|http\.(?:get|post|put|patch|delete|request)|request\(|\.send\(|httpClient|webhook|postMessage|sendMessage|publishEvent|emitEvent|trackEvent|identifyUser|analytics\.\w+)\s*[\(.]/;

// Database/auth source patterns (trusted sources)
const DB_SOURCE_RE = /\b(?:db\.\w+|database\.\w+|query|findOne|findById|findMany|execute|prisma\.\w+|knex|sequelize|typeorm|mongoose|redis\.get|cache\.get|session\.|auth\.|authenticate|getCredentials|getUser|getProfile)\s*[\(.]/;

// Sanitization/redaction patterns (if present, the flow is safe)
const SANITIZE_RE = /\b(?:sanitize|redact|mask|hash|encrypt|truncate|obfuscate|omit|strip|filter|exclude|remove)\s*[\(.]/;

// Lines to skip
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectUnprotectedPIIInResponse(file: DiffFile): DataFlowBoundaryIssue[] {
  const issues: DataFlowBoundaryIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Check if this line sends data in an HTTP response AND contains PII
    const hasResponse = RESPONSE_RE.test(change.content);
    if (!hasResponse) continue;

    // Check for PII fields in the same line
    const piiMatch = change.content.match(PII_FIELDS_RE);
    const financialMatch = change.content.match(FINANCIAL_PII_RE);

    // Check if sanitization is present
    const hasSanitize = SANITIZE_RE.test(change.content);

    if (piiMatch && !hasSanitize) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "unprotected-pii-in-response",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `PII field \`${piiMatch[0]}\` in HTTP response in \`${file.path}:${change.line}\` — sensitive PII returned without redaction/sanitization; redact or mask before sending to client`,
        severity: "warning",
      });
    }

    if (financialMatch && !hasSanitize) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "unprotected-pii-in-response",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Financial PII \`${financialMatch[0]}\` in HTTP response in \`${file.path}:${change.line}\` — financial data returned without redaction; PCI-DSS requires truncation/masking of card numbers`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectSensitiveDataInLog(file: DiffFile): DataFlowBoundaryIssue[] {
  const issues: DataFlowBoundaryIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Check if this line logs data AND contains sensitive data
    const hasLog = LOG_OUTPUT_RE.test(change.content);
    if (!hasLog) continue;

    // Check for secrets in log output
    const secretMatch = change.content.match(SECRET_DATA_RE);
    const piiMatch = change.content.match(PII_FIELDS_RE);
    const financialMatch = change.content.match(FINANCIAL_PII_RE);

    if (secretMatch) {
      const hasSanitize = SANITIZE_RE.test(change.content);
      if (!hasSanitize) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "sensitive-data-in-log",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Secret/credential \`${secretMatch[0]}\` in log output in \`${file.path}:${change.line}\` — credentials must never be logged; use redacted placeholder or structured logging with field exclusion`,
          severity: "critical",
        });
      }
    }

    if (piiMatch) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      const hasSanitize = SANITIZE_RE.test(change.content);
      if (!hasSanitize) {
        issues.push({
          category: "sensitive-data-in-log",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `PII field \`${piiMatch[0]}\` in log output in \`${file.path}:${change.line}\` — PII must not be logged per GDPR/HIPAA; log a redacted identifier instead`,
          severity: "critical",
        });
      }
    }

    if (financialMatch) {
      const hasSanitize = SANITIZE_RE.test(change.content);
      if (!hasSanitize) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "sensitive-data-in-log",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Financial PII \`${financialMatch[0]}\` in log output in \`${file.path}:${change.line}\` — PCI-DSS prohibits logging card/bank data; remove from log statement`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectTrustBoundarySkip(file: DiffFile): DataFlowBoundaryIssue[] {
  const issues: DataFlowBoundaryIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Check if data from a trusted source (DB/auth) flows directly to an external API
    const hasDbSource = DB_SOURCE_RE.test(change.content);
    const hasExternalApi = EXTERNAL_API_RE.test(change.content);

    if (hasDbSource && hasExternalApi) {
      const hasSanitize = SANITIZE_RE.test(change.content);
      if (!hasSanitize) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "trust-boundary-skip",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Data from trusted source sent directly to external API in \`${file.path}:${change.line}\` — data crossing trust boundaries should be validated/sanitized; add explicit consent check or data filter`,
          severity: "critical",
        });
      }
    }

    // Pattern: spread of entire DB record into external call (both orderings)
    const spreadToExternal = change.content.match(/(?:fetch|axios|http|webhook|publish|track|analytics|send).*?\.{2,}\s*(\w+)/i)
      || change.content.match(/\.{2,}\s*(\w+).*(?:fetch|axios|http|webhook|publish|track|analytics|send)/i);
    if (spreadToExternal) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      const hasSanitize = SANITIZE_RE.test(change.content);
      if (!hasSanitize) {
        issues.push({
          category: "trust-boundary-skip",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Spread of \`${spreadToExternal[1]}\` into external call in \`${file.path}:${change.line}\` — spreading entire objects may leak unintended fields; whitelist specific fields instead`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

function detectClientSideLeak(file: DiffFile): DataFlowBoundaryIssue[] {
  const issues: DataFlowBoundaryIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  // Skip test files — browser storage in tests is expected
  if (/\.test\.|\.spec\.|__tests__/.test(file.path)) return issues;

  // Check if file is in a client-side directory
  const isClientFile = /(?:client|frontend|browser|public|static|dist|src\/app|src\/pages|src\/components|src\/views)\//i.test(file.path);

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    // Pattern: server-only data stored in client storage
    const clientLeakMatch = change.content.match(/(?:localStorage|sessionStorage|indexedDB)\.setItem\s*\(\s*['"](\w+)['"]\s*,\s*(\w+)/i);
    if (clientLeakMatch) {
      const valueSource = clientLeakMatch[2];
      // Check if value is potentially sensitive
      const isSensitiveSource = /\b(?:password|token|secret|key|auth|credential|session|private)/i.test(valueSource);
      if (isSensitiveSource) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        issues.push({
          category: "client-side-leak",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Sensitive data \`${valueSource}\` stored in ${clientLeakMatch[0].split(".")[0]} in \`${file.path}:${change.line}\` — browser storage is accessible to XSS; use httpOnly cookies or server-side sessions instead`,
          severity: "critical",
        });
      }
    }

    // Pattern: server-side environment variables exposed to client (either ordering)
    const envLeak = change.content.match(/process\.env\.(\w+).*(?:window\.|document\.|localStorage|sessionStorage|props|state|store)/i)
      || change.content.match(/(?:window\.|document\.|localStorage|sessionStorage)[^;]*?process\.env\.(\w+)/i);
    if (envLeak) {
      const envName = envLeak[1] || envLeak[2];
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "client-side-leak",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Environment variable \`process.env.${envName}\` exposed to client in \`${file.path}:${change.line}\` — server env vars may contain secrets; use a dedicated public env prefix or API endpoint`,
        severity: "critical",
      });
    }

    // If file is in client directory, flag any PII/secret references
    if (isClientFile) {
      const secretMatch = change.content.match(SECRET_DATA_RE);
      if (secretMatch && !SANITIZE_RE.test(change.content)) {
        const trimmed = change.content.replace(/^\+/, "").trim();
        // Skip test files
        if (/\.test\.|\.spec\./.test(file.path)) continue;
        // Skip if it's a feature flag or UI label, not actual data
        if (/\b(?:label|placeholder|title|heading|description|tooltip|aria-|data-testid)\b/i.test(change.content)) continue;

        issues.push({
          category: "client-side-leak",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Sensitive reference \`${secretMatch[0]}\` in client-side code in \`${file.path}:${change.line}\` — credentials/secrets should not exist in client bundles; move to server-side API`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: DataFlowBoundaryIssue[]): DataFlowBoundaryIssue[] {
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

function buildDataFlowContext(result: DataFlowBoundaryResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Data Flow Boundary Violations (${result.issues.length})\n`;
  ctx += "This PR may expose sensitive data across trust boundaries:\n\n";

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

function buildDataFlowBodySummary(result: DataFlowBoundaryResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Data Flow Boundary Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Data flow boundary violations cause data breaches — PII in logs, credit cards in responses, secrets in client bundles.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run data flow boundary detection on diff files.
 * Zero LLM cost.
 */
export function detectDataFlowBoundaryViolations(diffFiles: DiffFile[]): DataFlowBoundaryResult {
  const allIssues: DataFlowBoundaryIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectUnprotectedPIIInResponse(file));
    allIssues.push(...detectSensitiveDataInLog(file));
    allIssues.push(...detectTrustBoundarySkip(file));
    allIssues.push(...detectClientSideLeak(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: DataFlowBoundaryResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildDataFlowContext(result);
  result.bodySummary = buildDataFlowBodySummary(result);

  if (issues.length > 0) {
    core.info(`Data flow boundary detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
