/**
 * Partial Security Control Detector — detect incomplete security control pairs.
 *
 * When LLMs generate code, they implement partial security controls: authentication
 * without authorization, encryption without key derivation, input validation without
 * sanitization, rate counting without enforcement. The model addresses part of a
 * security requirement and stops, producing code that appears secure but misses
 * the critical second step.
 *
 * This is a new vulnerability class unique to AI-generated code. The CSA 2026
 * research reports privilege escalation paths up 322% in AI-assisted code.
 *
 * Categories:
 * 1. auth-without-authz: authenticate/login without checkRole/authorize
 * 2. encrypt-without-kdf: encrypt/hash without deriveKey/salt
 * 3. validate-without-sanitize: validate/check without sanitize/escape/encode
 * 4. rate-count-without-enforce: request counting without reject/throttle/block
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PartialSecurityCategory =
  | "auth-without-authz"
  | "encrypt-without-kdf"
  | "validate-without-sanitize"
  | "rate-count-without-enforce";

export interface PartialSecurityIssue {
  category: PartialSecurityCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface PartialSecurityResult {
  issues: PartialSecurityIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^\+/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// --- Auth without Authz ---
const AUTH_PATTERNS = [
  /\b(?:authenticate|verifyToken|verify_token|checkAuth|check_auth|isAuthenticated|is_authenticated|login|signIn|sign_in)\b/i,
  /\bverify\s*\(\s*(?:token|jwt|credential|session)\s*\)/i,
  /\b(?:jwt|token)\s*\.\s*verify\s*\(/i,
];

const AUTHZ_PATTERNS = [
  /\b(?:authorize|checkRole|check_role|hasRole|has_role|hasPermission|has_permission|checkPermission|check_permission|requireRole|require_role|requirePermission|require_permission|isAuthorized|is_authorized)\b/i,
  /\b(?:role|permission|scope|privilege)\s*(?:===|!==|includes|check|verify)\b/i,
];

// --- Encrypt without KDF ---
const ENCRYPT_PATTERNS = [
  /\b(?:encrypt|cipher|sign|hmac)\s*\(/i,
  /\bcrypto\s*\.\s*(?:createCipher|createSign|createHmac|publicEncrypt|privateEncrypt)\s*\(/i,
  /\bcrypto\s*\.\s*(?:createCipheriv|createDecipheriv)\s*\(/i,
  /\bhash\s*\(\s*(?:password|secret|key|credential)\s*\)/i,
];

const KDF_PATTERNS = [
  /\b(?:deriveKey|derive_key|keyDerive|key_derive|pbkdf|scrypt|argon|bcrypt|salt|deriveBits|derive_bits)\b/i,
  /\bcrypto\s*\.\s*(?:pbkdf2|scrypt|generateKeyPair|createSecretKey)\s*\(/i,
];

// --- Validate without Sanitize ---
const VALIDATE_PATTERNS = [
  /\b(?:validate|check|verify|assert|ensure)\s*(?:Input|Form|Data|Field|Param|Request|Payload|Body|Query)\s*\(/i,
  /\bvalidate\s*\(\s*(?:input|data|payload|body|param|request|form|field)\s*\)/i,
  /\bjoi\s*\.\s*(?:object|string|number|array)\s*\(\s*\)/i,
  /\bzod\s*\.\s*(?:object|string|number|array)\s*\(\s*\)/i,
  /\bschema\s*\.\s*validate\s*\(/i,
];

const SANITIZE_PATTERNS = [
  /\b(?:sanitize|escape|encode|purify|strip|clean|filter|scrub|normalize|defang|xss|htmlEscape|html_escape)\b/i,
  /\bDOMPurify\s*\.\s*sanitize\s*\(/i,
  /\b(?:encoder|sanitizer|purifier)\s*\.\s*(?:encode|sanitize|escape|purify)\s*\(/i,
];

// --- Rate count without enforce ---
const RATE_COUNT_PATTERNS = [
  /\b(?:rateLimiter|rate_limiter|RateLimiter|throttleQueue|requestCounter|request_counter)\b/i,
  /\b(?:requestCount|request_count|hitCount|hit_count|callCount|call_count)\s*(?:\+\+|\+=|==|>=)/i,
  /\b(?:increment|incr)\s*\(\s*(?:count|counter|hits|requests)\s*\)/i,
  /\b(?:window|bucket|token)\s*(?:Count|_count|Size|_size)\b/i,
];

const RATE_ENFORCE_PATTERNS = [
  /\b(?:reject|throttle|block|deny|drop|rejectWith|reject_with|limit|rateLimit|rate_limit|slowDown|slow_down|pause|queue)\b/i,
  /\b(?:429|too.?many|rate.?limit|rate.?exceeded)\b/i,
  /\b(?:throw|return)\s+.*(?:429|TooManyRequests|RateLimitError|RateLimitExceeded)\b/i,
];

// ---------------------------------------------------------------------------
// Detection per file
// ---------------------------------------------------------------------------

interface SecuritySignals {
  authFound: { line: number; code: string; match: string }[];
  authzFound: { line: number; code: string; match: string }[];
  encryptFound: { line: number; code: string; match: string }[];
  kdfFound: { line: number; code: string; match: string }[];
  validateFound: { line: number; code: string; match: string }[];
  sanitizeFound: { line: number; code: string; match: string }[];
  rateCountFound: { line: number; code: string; match: string }[];
  rateEnforceFound: { line: number; code: string; match: string }[];
}

function collectSignals(file: DiffFile): SecuritySignals {
  const signals: SecuritySignals = {
    authFound: [], authzFound: [],
    encryptFound: [], kdfFound: [],
    validateFound: [], sanitizeFound: [],
    rateCountFound: [], rateEnforceFound: [],
  };

  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    for (const re of AUTH_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.authFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of AUTHZ_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.authzFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of ENCRYPT_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.encryptFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of KDF_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.kdfFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of VALIDATE_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.validateFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of SANITIZE_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.sanitizeFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of RATE_COUNT_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.rateCountFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
    for (const re of RATE_ENFORCE_PATTERNS) {
      const m = trimmed.match(re);
      if (m) { signals.rateEnforceFound.push({ line: change.line, code: trimmed, match: m[0] }); break; }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Cross-file analysis
// ---------------------------------------------------------------------------

interface AggregatedSignals {
  authFiles: Map<string, { line: number; code: string; match: string }[]>;
  authzFiles: Map<string, { line: number; code: string; match: string }[]>;
  encryptFiles: Map<string, { line: number; code: string; match: string }[]>;
  kdfFiles: Map<string, { line: number; code: string; match: string }[]>;
  validateFiles: Map<string, { line: number; code: string; match: string }[]>;
  sanitizeFiles: Map<string, { line: number; code: string; match: string }[]>;
  rateCountFiles: Map<string, { line: number; code: string; match: string }[]>;
  rateEnforceFiles: Map<string, { line: number; code: string; match: string }[]>;
}

function aggregateSignals(diffFiles: DiffFile[]): AggregatedSignals {
  const agg: AggregatedSignals = {
    authFiles: new Map(), authzFiles: new Map(),
    encryptFiles: new Map(), kdfFiles: new Map(),
    validateFiles: new Map(), sanitizeFiles: new Map(),
    rateCountFiles: new Map(), rateEnforceFiles: new Map(),
  };

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const signals = collectSignals(file);

    if (signals.authFound.length > 0) agg.authFiles.set(file.path, signals.authFound);
    if (signals.authzFound.length > 0) agg.authzFiles.set(file.path, signals.authzFound);
    if (signals.encryptFound.length > 0) agg.encryptFiles.set(file.path, signals.encryptFound);
    if (signals.kdfFound.length > 0) agg.kdfFiles.set(file.path, signals.kdfFound);
    if (signals.validateFound.length > 0) agg.validateFiles.set(file.path, signals.validateFound);
    if (signals.sanitizeFound.length > 0) agg.sanitizeFiles.set(file.path, signals.sanitizeFound);
    if (signals.rateCountFound.length > 0) agg.rateCountFiles.set(file.path, signals.rateCountFound);
    if (signals.rateEnforceFound.length > 0) agg.rateEnforceFiles.set(file.path, signals.rateEnforceFound);
  }

  return agg;
}

// ---------------------------------------------------------------------------
// Issue generation
// ---------------------------------------------------------------------------

function checkSecurityPair(
  category: PartialSecurityCategory,
  firstLabel: string,
  secondLabel: string,
  firstFiles: Map<string, { line: number; code: string; match: string }[]>,
  secondFiles: Map<string, { line: number; code: string; match: string }[]>,
): PartialSecurityIssue[] {
  const issues: PartialSecurityIssue[] = [];

  // If any file has the first control but NO file has the second control
  if (firstFiles.size > 0 && secondFiles.size === 0) {
    for (const [filePath, entries] of firstFiles) {
      for (const entry of entries.slice(0, 2)) {
        issues.push({
          category,
          file: filePath,
          line: entry.line,
          code: entry.code,
          description: `${firstLabel} detected (\`${entry.match}\`) in \`${filePath}:${entry.line}\` but no ${secondLabel} found anywhere in the PR — LLMs implement partial security controls: they add authentication without authorization, creating privilege escalation paths; the CSA 2026 reports 322% surge in such paths from AI-generated code; add the corresponding ${secondLabel}`,
          severity: "critical",
        });
      }
    }
  }

  // Per-file check: file has first control but not second control
  // (even if second control exists in a different file)
  for (const [filePath, entries] of firstFiles) {
    if (!secondFiles.has(filePath)) {
      for (const entry of entries.slice(0, 1)) {
        // Avoid duplicate with the global check above
        if (secondFiles.size > 0) {
          issues.push({
            category,
            file: filePath,
            line: entry.line,
            code: entry.code,
            description: `${firstLabel} detected (\`${entry.match}\`) in \`${filePath}:${entry.line}\` but ${secondLabel} is in a different file — LLMs implement security controls in separate scopes; ensure authorization is checked at the same call site as authentication`,
            severity: "warning",
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: PartialSecurityIssue[]): PartialSecurityIssue[] {
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

function buildPartialSecurityContext(result: PartialSecurityResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Partial Security Control Detection (${result.issues.length})\n`;
  ctx += "This PR may contain incomplete security control pairs — LLMs implement partial controls:\n\n";

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

function buildPartialSecurityBodySummary(result: PartialSecurityResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Partial Security Control Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*When LLMs generate security code, they implement partial controls — authentication without authorization, encryption without key derivation, validation without sanitization. The CSA 2026 reports a 322% surge in privilege escalation paths from AI-generated code. Ensure security control pairs are always implemented together.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run partial security control detection on diff files. Zero LLM cost. */
export function detectPartialSecurityControls(diffFiles: DiffFile[]): PartialSecurityResult {
  const agg = aggregateSignals(diffFiles);
  const allIssues: PartialSecurityIssue[] = [];

  allIssues.push(...checkSecurityPair(
    "auth-without-authz", "Authentication", "authorization",
    agg.authFiles, agg.authzFiles,
  ));

  allIssues.push(...checkSecurityPair(
    "encrypt-without-kdf", "Encryption/hashing", "key derivation/salting",
    agg.encryptFiles, agg.kdfFiles,
  ));

  allIssues.push(...checkSecurityPair(
    "validate-without-sanitize", "Input validation", "sanitization/escaping",
    agg.validateFiles, agg.sanitizeFiles,
  ));

  allIssues.push(...checkSecurityPair(
    "rate-count-without-enforce", "Rate counting", "rate enforcement/rejection",
    agg.rateCountFiles, agg.rateEnforceFiles,
  ));

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: PartialSecurityResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildPartialSecurityContext(result);
  result.bodySummary = buildPartialSecurityBodySummary(result);

  if (issues.length > 0) {
    core.info(`Partial security control detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
