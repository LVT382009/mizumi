/**
 * Illusory Validation Detector — detect security-shaped code that doesn't
 * actually protect. LLMs generate validation/checks/sanitization that
 * appears correct by pattern-matching training examples but is semantically
 * void.
 *
 * The IEEE-ISTAS (arxiv 2506.11022) paper found a 37.6% increase in
 * critical vulnerabilities after 5 LLM iterations, with code that
 * "appeared more sophisticated." AppSecSanta 2026 found 86% XSS failure
 * rate and 88% log injection failure rate — LLMs write code that
 * *contains* validation but fails to actually prevent the attack.
 * Veracode 2025: 45% of AI-generated code introduces OWASP Top 10
 * vulnerabilities despite security-shaped code being present.
 *
 * Categories:
 * 1. dead-validation: check that doesn't gate the dangerous operation
 * 2. sanitizer-sink-mismatch: wrong sanitization type for the sink
 * 3. crypto-voided-parameters: correct algorithm with insecure params
 * 4. decorative-security-import: security package imported but not wired
 *
 * Zero LLM cost — pattern + control-flow analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IllusoryValidationCategory =
  | "dead-validation"
  | "sanitizer-sink-mismatch"
  | "crypto-voided-parameters"
  | "decorative-security-import";

export interface IllusoryValidationIssue {
  category: IllusoryValidationCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface IllusoryValidationResult {
  issues: IllusoryValidationIssue[];
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

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// Category 1: Dead validation
// Check-then-proceed: condition is checked but doesn't gate the dangerous op
// Pattern: if (!valid) { log/warn } then dangerous operation follows regardless
const DEAD_VALIDATION_PATTERNS = [
  // if (!isSomething) { warn/log } then dangerous op — same-line pattern
  /\bif\s*\(\s*!\s*\w+\s*\)\s*\{?\s*(?:console|logger|log)\.(?:log|warn|error|info)\s*\([^)]*\)\s*;?\s*\}?\s*(?:process|execute|run|handle|perform|call|fetch|send|write|query|insert|update|delete|remove|render|redirect)\w*\s*\(/i,
  // Auth check with warn/log then continues to response
  /\bif\s*\(\s*!?\s*\w*(?:auth|login|session|token|credential|permission|verified)\w*\s*\)\s*\{[^}]*?(?:console|logger|log)\.\w+\s*\([^)]*\)\s*;\s*\}\s*(?:return\s+\w+\.json|render|send|execute|query|process|redirect)\s*\(/i,
  // Check-then-proceed: validate/check that is non-gating
  /\b(?:validate|check|verify)\w*\s*\([^)]*\)\s*;[\s;]*(?:process|execute|run|handle|query|send|write|insert|update|delete)\w*\s*\(/i,
];

// Category 2: Sanitizer-sink mismatch
// Sanitization applied for one attack vector but data flows to different sink
// Match on same line: sanitizer call + semicolon + sink call
const SANITIZER_SINK_MISMATCH = [
  // HTML escaping near SQL query
  /(?:escapeHtml|sanitizeHtml|htmlEncode|htmlspecialchars|DOMPurify\.sanitize)\s*\([^)]*\).*(?:query|execute|sql|statement|cursor)\s*\(/i,
  // SQL escaping near HTML output
  /(?:escapeSql|mysqlRealEscape|pgEscape|escapeSqlString)\s*\([^)]*\).*(?:innerHTML|\.html\(|document\.write|\.render\b)/i,
  // HTML escaping near shell command
  /(?:escapeHtml|sanitizeHtml|htmlEncode|htmlspecialchars)\s*\([^)]*\).*(?:exec|spawn|system|shell|popen|subprocess)\s*\(/i,
];

// Category 3: Crypto with voided parameters
const CRYPTO_VOIDED_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // bcrypt with cost factor below 10
  { re: /bcrypt\s*\([^)]*cost\s*[:=]\s*[1-9]\b(?!0)/i, label: "bcrypt with cost factor below 10" },
  { re: /bcrypt\s*\(\s*\w+\s*,\s*[1-9]\b(?!0)/i, label: "bcrypt with cost factor below 10" },
  { re: /genSalt\s*\(\s*[1-9]\b(?!0)/i, label: "bcrypt genSalt with rounds below 10" },
  // AES ECB mode
  { re: /AES\.MODE_ECB/i, label: "AES ECB mode destroys semantic security" },
  { re: /MODE\s*[:=]\s*['"]?ECB['"]?/i, label: "ECB encryption mode — identical plaintext blocks produce identical ciphertext" },
  { re: /aes[_-].*ecb/i, label: "AES ECB mode — identical plaintext blocks produce identical ciphertext" },
  // MD5/SHA1 for password hashing
  { re: /(?:createHash|hash|digest)\s*\(\s*['"](?:md5|sha1|sha-1)['"]\s*\)[^;]*(?:password|passwd|secret|key|token)/i, label: "MD5/SHA1 used for password hashing" },
  { re: /(?:password|passwd|secret)\w*\s*[\+\-*/|&^]*=\s*(?:crypto\.createHash|hashlib\.md5|hashlib\.sha1|MD5|SHA1)\b/i, label: "MD5/SHA1 used for password/key derivation" },
  // HMAC with MD5/SHA1
  { re: /hmac\s*\([^)]*(?:md5|sha1|sha-1)[^)]*\)/i, label: "HMAC with MD5/SHA1 — cryptographic degradation" },
  { re: /createHmac\s*\(\s*['"](?:md5|sha1|sha-1)['"]/i, label: "HMAC with MD5/SHA1 — cryptographic degradation" },
  // JWT with none algorithm or short secret
  { re: /jwt\.encode\s*\([^)]*algorithm\s*[:=]\s*['"]none['"]/i, label: "JWT with 'none' algorithm — no signature verification" },
  { re: /jwt\.encode\s*\([^)]*['"](?!none)[^'"]{0,15}['"]\s*,\s*algorithm/i, label: "JWT with short/predictable secret" },
  // DES/RC4/Blowfish
  { re: /\b(?:DES|RC4|Blowfish|RC2)\s*\.\s*(?:new|create|encrypt|init)/i, label: "deprecated cipher (DES/RC4/Blowfish/RC2) — use AES-256-GCM instead" },
  // Key derivation with insufficient iterations
  { re: /pbkdf2\s*\([^)]*(?:iterations|iter|rounds)\s*[:=]\s*\d{1,4}\b/i, label: "PBKDF2 with insufficient iterations" },
];

// Category 4: Decorative security import
// Security package imported but not wired into the application
const DECORATIVE_IMPORT_PATTERNS = [
  // Flask CORS imported but not initialized
  { importRe: /from\s+flask_cors\s+import\s+CORS/, initRe: /CORS\s*\(\s*\w+\s*\)/, label: "flask_cors imported but CORS(app) not called" },
  // helmet imported but not used
  { importRe: /import\s+helmet\b/, initRe: /helmet\s*\(\s*\)/, label: "helmet imported but app.use(helmet()) not called" },
  { importRe: /require\s*\(\s*['"]helmet['"]\s*\)/, initRe: /helmet\s*\(\s*\)/, label: "helmet imported but app.use(helmet()) not called" },
  // express-rate-limit imported but not used
  { importRe: /import\s+rateLimit\s+from\s+['"]express-rate-limit['"]/, initRe: /rateLimit\s*\(\s*\{/, label: "express-rate-limit imported but rateLimit() not configured" },
  // csurf imported but not used
  { importRe: /import\s+csurf\s+from\s+['"]csurf['"]/, initRe: /csurf\s*\(\s*\{/, label: "csurf imported but csrfProtection not configured" },
  // express-validator imported but not used as middleware
  { importRe: /from\s+['"]express-validator['"]/, initRe: /(?:check|body|param|query|validationResult)\s*\(/, label: "express-validator imported but validation middleware not applied" },
];

// ---------------------------------------------------------------------------
// Detection: dead-validation
// ---------------------------------------------------------------------------

function detectDeadValidation(file: DiffFile): IllusoryValidationIssue[] {
  const issues: IllusoryValidationIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of DEAD_VALIDATION_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "dead-validation",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Dead validation in \`${file.path}:${change.line}\` — validation check doesn't gate the dangerous operation; both branches reach the same sink; LLMs generate security-shaped code that logs but doesn't block; IEEE-ISTAS found 37.6% critical vuln increase after 5 LLM iterations; ensure the check uses return/throw/break to prevent the dangerous operation on failure`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: sanitizer-sink-mismatch
// ---------------------------------------------------------------------------

function detectSanitizerSinkMismatch(file: DiffFile): IllusoryValidationIssue[] {
  const issues: IllusoryValidationIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const re of SANITIZER_SINK_MISMATCH) {
      if (re.test(trimmed)) {
        issues.push({
          category: "sanitizer-sink-mismatch",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Sanitizer-sink mismatch in \`${file.path}:${change.line}\` — sanitization applied for one attack vector but data flows to a different sink requiring different sanitization; AppSecSanta 2026 found 86% XSS failure rate as LLMs place "a" sanitization "near" the data but don't match the type to the actual sink; ensure sanitization type matches the consumer`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: crypto-voided-parameters
// ---------------------------------------------------------------------------

function detectCryptoVoidedParameters(file: DiffFile): IllusoryValidationIssue[] {
  const issues: IllusoryValidationIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const { re, label } of CRYPTO_VOIDED_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "crypto-voided-parameters",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Voided crypto in \`${file.path}:${change.line}\`: ${label} — LLMs use correct algorithm names with insecure parameters that nullify the security guarantee; Veracode 2025 found 45% of AI-generated code introduces vulnerabilities despite security-shaped code; IEEE-ISTAS: "the LLM frequently replaced standard library calls with custom implementations or used cryptographic libraries incorrectly"`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: decorative-security-import
// ---------------------------------------------------------------------------

function detectDecorativeSecurityImport(file: DiffFile): IllusoryValidationIssue[] {
  const issues: IllusoryValidationIssue[] = [];
  const added = getAddedChanges(file);
  const allLines = added.map((c) => stripPrefix(c.content));

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    for (const { importRe, initRe, label } of DECORATIVE_IMPORT_PATTERNS) {
      if (importRe.test(trimmed)) {
        // Check if the initialization exists in the same file's added lines
        const hasInit = allLines.some((line) => initRe.test(line));
        if (!hasInit) {
          issues.push({
            category: "decorative-security-import",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Decorative security import in \`${file.path}:${change.line}\`: ${label} — security package imported but never wired into the application; CSA 2026: 80% of developers wrongly believe AI generates more secure code; ByteArmor: "GenAI models choose the insecure path 45% of the time"; call the initialization function to activate the protection`,
            severity: "warning",
          });
        }
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: IllusoryValidationIssue[]): IllusoryValidationIssue[] {
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

function buildIllusoryValidationContext(result: IllusoryValidationResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Illusory Validation Detection (${result.issues.length})\n`;
  ctx += "This PR contains security-shaped code that doesn't actually protect — LLMs generate validation that looks correct but is semantically void:\n\n";

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

function buildIllusoryValidationBodySummary(result: IllusoryValidationResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Illusory Validation Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLMs generate security-shaped code that doesn't actually protect — 86% XSS failure rate (AppSecSanta 2026), 45% OWASP Top 10 in AI code (Veracode 2025), 37.6% critical vuln increase after 5 iterations (IEEE-ISTAS). Dead validation, sanitizer-sink mismatches, voided crypto parameters, and decorative imports generate false confidence. Ensure validation gates dangerous operations, sanitization matches the sink, crypto uses secure parameters, and security packages are properly initialized.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run illusory validation detection on diff files. Zero LLM cost. */
export function detectIllusoryValidation(diffFiles: DiffFile[]): IllusoryValidationResult {
  const allIssues: IllusoryValidationIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectDeadValidation(file));
    allIssues.push(...detectSanitizerSinkMismatch(file));
    allIssues.push(...detectCryptoVoidedParameters(file));
    allIssues.push(...detectDecorativeSecurityImport(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: IllusoryValidationResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildIllusoryValidationContext(result);
  result.bodySummary = buildIllusoryValidationBodySummary(result);

  if (issues.length > 0) {
    core.info(`Illusory validation detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
