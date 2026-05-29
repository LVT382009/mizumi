/**
 * Security Paradox Detector — detect when security prompting DEGRADES security.
 *
 * The IEEE-ISTAS paper (arxiv 2506.11022v2, Section IV-C) and pinklime 2026
 * OWASP analysis document three paradox patterns where LLMs asked to
 * "improve security" actually make things WORSE:
 *
 * 1. custom-crypto: Custom encryption/obfuscation replacing standard library
 *    calls (crypto.createCipher → hand-rolled XOR, SubtleCrypto → custom RSA)
 * 2. overengineered-encryption: Multi-layer encryption introducing subtle flaws
 *    (double-encrypt, encrypt-then-sign-then-encrypt, nested AES chains)
 * 3. training-era-drift: Drift toward outdated crypto from training data
 *    (MD5, SHA1, DES, ECB mode, Math.random() for tokens, PBKDF1)
 *
 * The paradox: models trained on pre-2023 code default to deprecated primitives
 * when asked to "secure" or "encrypt" — the security intent signal triggers
 * the wrong training-era pattern. SAST catches individual misuse but misses
 * the causal link between security prompting and worse outcomes.
 *
 * Zero LLM cost — pattern analysis on added diff lines + PR title/body.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecurityParadoxCategory =
  | "custom-crypto"
  | "overengineered-encryption"
  | "training-era-drift";

export interface SecurityParadoxlIssue {
  category: SecurityParadoxCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface SecurityParadoxResult {
  issues: SecurityParadoxlIssue[];
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

// Security-intent signals in PR title or nearby comments
const SECURITY_INTENT_RE = /\b(?:secur|encrypt|auth|crypt|hash|protect|safeguard|harden|fortif|defend|cipher|sign|token|privat|secret|credential)\w*\b/i;

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Category 1: Custom crypto replacing standard library calls
const CUSTOM_CRYPTO_PATTERNS = [
  // Hand-rolled XOR "encryption"
  /\b(?:encrypt|decrypt|cipher)\w*\s*\([^)]*\bxor\b/i,
  /\bxor\s*[\^=]\s*0x/i,
  /\bcharcode\b.*?\bxor\b/i,
  /\b\w+\s*\^\s*\w+.*(?:encrypt|key|secret|cipher)/i,
 /\bdata\s*\^\s*\w+/i,
  // Custom RSA/EC implementation
  /\bmodpow\b/i,
  /\bmodexp\b/i,
  /\binversemod\b/i,
  /(?:implement|custom|hand-rolled|own|manual|write|build)\s+(?:rsa|aes|ec|ed25519|curve25519|chacha|salsa)/i,
 /\b(?:implement|custom)(?:RSA|AES|EC|Ed25519|Curve25519|ChaCha|Salsa)\w*\b/i,
  // SubtleCrypto replaced with custom implementation
  /\bcrypto\.subtle\b.*?(?:replac|remove|delet)/i,
  // Node crypto replaced with manual operations
  /\bcrypto\.create(?:Cipher|Decipher|Sign|Verify)\b.*?(?:replac|remove|delet)/i,
  // Custom key derivation
  /\bfunction\s+(?:deriveKey|expandKey|generateKey)\b/i,
  // Custom MAC/HMAC
  /\bfunction\s+(?:computeMac|calculateMac|customMac)\b/i,
  // Custom PRNG for security purposes (Math.random near security keyword, either order)
  /\bMath\.random\b.*(?:token|key|secret|nonce|iv|salt|password|otp)/i,
  /\b(?:token|key|secret|nonce|iv|salt|password|otp)\w*\s*=.*\bMath\.random\b/i,
  // "Encryption" using base64/rot13 as if it were crypto
  /\bbtoa\b.*(?:encrypt|cipher|secure|protect)/i,
  /\batob\b.*(?:decrypt|cipher)/i,
  /\brot13\b/i,
  /\bbuffer\.from\s*\([^)]*\)\.toString\s*\(\s*['"]base64['"]\s*\).*(?:encrypt|cipher|secure)/i,
];

// Category 2: Overengineered multi-layer encryption
const OVERENGINEERED_PATTERNS = [
  // Double/nested encryption
  /\bencrypt\b.*\bencrypt\b/i,
  /\bcipher\b.*\bcipher\b/i,
  // Encrypt-then-sign-then-encrypt or similar chains
  /\bsign\s*\([^)]*\).*\bencrypt\s*\([^)]*\).*\bsign/i,
  /\bencrypt\s*\([^)]*\).*\bsign\s*\([^)]*\).*\bencrypt/i,
  // Nested AES/RSA chains
  /\baes\b.*\baes\b/i,
  /\baes\b.*\brsa\b.*\baes\b/i,
  // Multiple key wrapping layers
  /\bwrap(?:Key|ped)\b.*\bwrap(?:Key|ped)\b/i,
  /\bkey\s*encrypting\s+key\b/i,
  /\bKeyEncryptingKey\b/i,
  // Superfluous encryption layers
  /\badditional\s+(?:encrypt|cipher|security)\s*layer\b/i,
  /\bextra\s+(?:encrypt|cipher)\s*(?:round|pass|layer)\b/i,
  /\bdouble\s*(?:encrypt|cipher|aes|rsa)\b/i,
  // Unnecessary re-encryption
  /\bre-?encrypt\b/i,
];

// Category 3: Training-era drift toward deprecated crypto
const TRAINING_ERA_DRIFT_PATTERNS = [
  // MD5 usage (not in test/mock contexts)
  /\bmd5\b/i,
  /\bMD5(?:Init|Update|Final)?\b/i,
  /\bcreateHash\s*\(\s*['"]md5['"]\s*\)/i,
  // SHA1 usage
  /\bsha-?1\b/i,
  /\bcreateHash\s*\(\s*['"]sha1['"]\s*\)/i,
  /\bSHA1(?:Init|Update|Final)?\b/i,
  // DES/3DES usage
  /\bdes(?:-?ede3?-?cbc)?\b/i,
  /\bcreate(?:Cipher|Decipher)\s*\(\s*['"]des/i,
  // ECB mode
  /\becb\b/i,
  /\bcreateCipher.*\becb\b/i,
  // RC4
  /\brc4\b/i,
  /\barcfour\b/i,
  // Blowfish
  /\bblowfish\b/i,
  // PBKDF1 (superseded by PBKDF2)
  /\bpbkdf1\b/i,
  // RSA without OAEP/PSS (PKCS#1 v1.5)
  /\brsa.*pkcs1.*v?1\.?5/i,
  /\brsa.*(?:nopadding|pkcs1padding)\b/i,
  // Math.random() for security tokens
  /\bMath\.random\s*\(\s*\)/i,
  // Hardcoded IV/nonce
  /\biv\s*[:=]\s*['"][^'"]{4,}['"]/i,
  /\bnonce\s*[:=]\s*['"][^'"]{4,}['"]/i,
  // Hardcoded salt
  /\bsalt\s*[:=]\s*['"][^'"]{4,}['"]/i,
];

// Whitelist: lines that are NOT security paradox even if they match patterns
const WHITELIST_LINE_RE = [
  /\b(?:test|spec|mock|stub|fixture|fake)\b/i,
  /\bdeprecated\b/i, // explicitly acknowledged
  /\b(?:migration|upgrade|migrate)\b.*\b(?:from|remove|replace)\b/i, // migration away from bad crypto
  /\breplace\s+(?:md5|sha1|des|ecb)\b/i, // replacing deprecated, not introducing
  /\b(?:[\/][\/]|\/\*|#).*(?:deprecated|legacy|todo|fixme)/i, // comments marking deprecated
];

// ---------------------------------------------------------------------------
// Detection: custom-crypto
// ---------------------------------------------------------------------------

function detectCustomCrypto(file: DiffFile, _hasSecurityIntent: boolean): SecurityParadoxlIssue[] {
  const issues: SecurityParadoxlIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (TEST_PATH_RE.test(file.path)) continue;

    // Check whitelist
    if (WHITELIST_LINE_RE.some((re) => re.test(trimmed))) continue;

    for (const re of CUSTOM_CRYPTO_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "custom-crypto",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Custom crypto in \`${file.path}:${change.line}\` — LLM replaces standard library crypto with hand-rolled implementations; IEEE-ISTAS Section IV-C: "security prompting paradox" where models trained on pre-2023 code substitute outdated patterns when asked to "secure"; use established crypto libraries (WebCrypto, Node crypto, libsodium) instead`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: overengineered-encryption
// ---------------------------------------------------------------------------

function detectOverengineeredEncryption(file: DiffFile, _hasSecurityIntent: boolean): SecurityParadoxlIssue[] {
  const issues: SecurityParadoxlIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (TEST_PATH_RE.test(file.path)) continue;

    if (WHITELIST_LINE_RE.some((re) => re.test(trimmed))) continue;

    for (const re of OVERENGINEERED_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "overengineered-encryption",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Overengineered encryption in \`${file.path}:${change.line}\` — multi-layer encryption introduces subtle flaws rather than improving security; pinklime OWASP 2026: "overengineered multi-layer encryption is a common LLM security paradox"; single standard encryption with proper mode (AES-GCM, ChaCha20-Poly1305) is more secure than cascaded ciphers`,
          severity: "warning",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: training-era-drift
// ---------------------------------------------------------------------------

function detectTrainingEraDrift(file: DiffFile, _hasSecurityIntent: boolean): SecurityParadoxlIssue[] {
  const issues: SecurityParadoxlIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (TEST_PATH_RE.test(file.path)) continue;

    if (WHITELIST_LINE_RE.some((re) => re.test(trimmed))) continue;

    for (const re of TRAINING_ERA_DRIFT_PATTERNS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "training-era-drift",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Training-era crypto drift in \`${file.path}:${change.line}\` — deprecated cryptographic primitive from LLM training data; IEEE-ISTAS: "models default to MD5/SHA1/DES/ECB from pre-2023 training era when prompted to secure"; CSA 2026: architectural design flaws rose 153% in AI-iterated code; use current best-practice alternatives (SHA-256+, AES-GCM, ChaCha20, PBKDF2/argon2)`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: SecurityParadoxlIssue[]): SecurityParadoxlIssue[] {
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

function buildSecurityParadoxContext(result: SecurityParadoxResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Security Paradox Detection (${result.issues.length})\n`;
  ctx += "This PR exhibits security prompting paradox — LLM security intent produced worse outcomes:\n\n";

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

function buildSecurityParadoxBodySummary(result: SecurityParadoxResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Security Paradox Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLM security prompting paradox — asking to "secure" triggers outdated training-era patterns (MD5, SHA1, DES, ECB, custom crypto) or overengineered multi-layer encryption. IEEE-ISTAS Section IV-C: security prompting paradox. CSA 2026: design flaws +153%. Use standard libraries (WebCrypto, Node crypto, libsodium) with current best practices (SHA-256+, AES-GCM, ChaCha20-Poly1305).*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run security paradox detection on diff files. Zero LLM cost. */
export function detectSecurityParadox(
  diffFiles: DiffFile[],
  prTitle?: string,
  prBody?: string,
): SecurityParadoxResult {
  const allIssues: SecurityParadoxlIssue[] = [];

  // Check if PR has security intent signals
  const prText = `${prTitle || ""} ${prBody || ""}`;
  const hasSecurityIntent = SECURITY_INTENT_RE.test(prText);

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectCustomCrypto(file, hasSecurityIntent));
    allIssues.push(...detectOverengineeredEncryption(file, hasSecurityIntent));
    allIssues.push(...detectTrainingEraDrift(file, hasSecurityIntent));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: SecurityParadoxResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildSecurityParadoxContext(result);
  result.bodySummary = buildSecurityParadoxBodySummary(result);

  if (issues.length > 0) {
    core.info(`Security paradox detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical, security_intent=${hasSecurityIntent})`);
  }

  return result;
}
