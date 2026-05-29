/**
 * Credential Exposure Accelerator Detector — detect AI-specific patterns
 * where LLMs scaffold authentication/SDK boilerplate with hardcoded
 * credentials that devs forget to replace.
 *
 * The CSA 2026 report found AI-assisted developers expose Azure Service
 * Principals and Storage Access Keys at nearly twice the rate of non-AI
 * devs. Escape.tech found 400+ leaked secrets and 175 instances of
 * exposed PII across 1,400 vibe-coded apps.
 *
 * This detector extends Mizumi's secret-entropy.ts with AI-scaffold
 * context awareness — detecting credentials in clearly templated
 * contexts where the LLM provided "example" values.
 *
 * Categories:
 * 1. scaffold-with-inline-secret: env var with inline fallback
 * 2. config-object-literal-secret: config/options objects with literal keys
 * 3. constructor-hardcoded-credential: SDK client constructors with inline credentials
 * 4. example-placeholder-secret: "replace with your" comments near literal secrets
 *
 * Zero LLM cost — pattern + entropy analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CredentialExposureCategory =
  | "scaffold-with-inline-secret"
  | "config-object-literal-secret"
  | "constructor-hardcoded-credential"
  | "example-placeholder-secret";

export interface CredentialExposureIssue {
  category: CredentialExposureCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface CredentialExposureResult {
  issues: CredentialExposureIssue[];
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
// Shannon entropy calculation
// ---------------------------------------------------------------------------

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Thresholds
const HIGH_ENTROPY_THRESHOLD = 4.5;
const MIN_SECRET_LENGTH = 20;
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// ---------------------------------------------------------------------------
// Secret detection patterns
// ---------------------------------------------------------------------------

// Cloud provider key prefixes (high-confidence secret indicators)
const CLOUD_KEY_PREFIXES = [
  /\bAKIA[0-9A-Z]{16}\b/,     // AWS access key
  /\bASI[A-Z0-9]{16}\b/,     // AWS secret access key prefix
  /\bAGPA[A-Z0-9]{16}\b/,    // AWS IAM role
  /\bAIDA[A-Z0-9]{16}\b/,    // AWS IAM user
  /\bAROA[A-Z0-9]{16}\b/,    // AWS IAM role
  /\byo\d{30}\b/,             // GCP service account key
];

// API key patterns
const API_KEY_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}/,       // OpenAI-style API key
  /\bsk_live_[a-zA-Z0-9]{20,}/,  // Stripe live key
  /\bsk_test_[a-zA-Z0-9]{20,}/,  // Stripe test key
  /\bkey_[a-zA-Z0-9]{20,}/,      // Generic API key
  /\btoken_[a-zA-Z0-9]{20,}/,    // Generic token
  /\bBearer\s+[A-Za-z0-9+/._-]{20,}/, // Bearer tokens
  /\bghp_[a-zA-Z0-9]{36}\b/,     // GitHub PAT
  /\bgho_[a-zA-Z0-9]{36}\b/,     // GitHub OAuth
  /\bgithub_pat_[a-zA-Z0-9_]{20,}/, // GitHub fine-grained PAT
  /\bglpat-[a-zA-Z0-9\-]{20,}/, // GitLab PAT
  /\bxox[bpar]-[a-zA-Z0-9-]{20,}/, // Slack tokens
];

function isHighEntropySecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false;
  const entropy = shannonEntropy(value);
  return entropy >= HIGH_ENTROPY_THRESHOLD;
}

function matchCloudKeyPrefix(value: string): boolean {
  return CLOUD_KEY_PREFIXES.some((re) => re.test(value));
}

function matchAPIKeyPattern(value: string): boolean {
  return API_KEY_PATTERNS.some((re) => re.test(value));
}

// ---------------------------------------------------------------------------
// Category 1: scaffold-with-inline-secret
// env var with inline string fallback that is high-entropy
// ---------------------------------------------------------------------------

const ENV_INLINE_FALLBACK_RE = /process\.env\.(\w+)\s*\|\|\s*["']([^"']+)["']/g;

function detectScaffoldWithInlineSecret(file: DiffFile): CredentialExposureIssue[] {
  const issues: CredentialExposureIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    ENV_INLINE_FALLBACK_RE.lastIndex = 0;
    let match;
    while ((match = ENV_INLINE_FALLBACK_RE.exec(trimmed)) !== null) {
      const varName = match[1];
      const fallback = match[2];
      if (isHighEntropySecret(fallback) || matchAPIKeyPattern(fallback) || matchCloudKeyPrefix(fallback)) {
        issues.push({
          category: "scaffold-with-inline-secret",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Scaffold secret in \`${file.path}:${change.line}\`: env var \`${varName}\` has high-entropy inline fallback — LLMs scaffold config with example credentials that devs forget to replace; CSA 2026 reports 2x secret exposure rate for AI-assisted devs; remove the inline fallback and use proper secrets management`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Category 2: config-object-literal-secret
// config/options/cred objects with literal high-entropy values
// ---------------------------------------------------------------------------

const CONFIG_KEY_RE = /(?:apiKey|api_key|secretKey|secret_key|accessKey|access_key|password|passwd|token|authToken|auth_token|privateKey|private_key|credentials|connectionString|connection_string)\s*[:=]\s*["']([^"']+)["']/gi;

function detectConfigObjectLiteralSecret(file: DiffFile): CredentialExposureIssue[] {
  const issues: CredentialExposureIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    CONFIG_KEY_RE.lastIndex = 0;
    const match = CONFIG_KEY_RE.exec(trimmed);
    if (match) {
      const value = match[1];
      if (isHighEntropySecret(value) || matchAPIKeyPattern(value) || matchCloudKeyPrefix(value)) {
        issues.push({
          category: "config-object-literal-secret",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Config literal secret in \`${file.path}:${change.line}\`: config object has high-entropy key value — LLMs scaffold SDK connections with inline credentials; Escape.tech found 400+ leaked secrets in AI-coded apps; use env vars or secrets manager instead`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Category 3: constructor-hardcoded-credential
// SDK client constructors with inline credentials
// ---------------------------------------------------------------------------

const CONSTRUCTOR_CRED_RE = /new\s+(?:Client|SDK|Service|Connection|Provider)\s*\(\s*\{[^}]*(?:key|token|secret|password|credential)\s*:\s*["']([^"']+)["']/gis;

function detectConstructorHardcodedCredential(file: DiffFile): CredentialExposureIssue[] {
  const issues: CredentialExposureIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    CONSTRUCTOR_CRED_RE.lastIndex = 0;
    const match = CONSTRUCTOR_CRED_RE.exec(trimmed);
    if (match) {
      const value = match[1];
      if (isHighEntropySecret(value) || matchAPIKeyPattern(value) || matchCloudKeyPrefix(value)) {
        issues.push({
          category: "constructor-hardcoded-credential",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Constructor secret in \`${file.path}:${change.line}\`: SDK client instantiated with inline credential — LLMs provide example credentials in constructors that reach production; use env vars or secrets manager for initialization`,
          severity: "critical",
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Category 4: example-placeholder-secret
// "replace with your" comments near literal secret values
// ---------------------------------------------------------------------------

const PLACEHOLDER_COMMENT_RE = /\/\/.*(?:replace|update|insert|fill|change|add)\s+(?:with\s+)?(?:your|the|actual|real|valid)/i;
const NEARBY_STRING_LITERAL_RE = /["']([A-Za-z0-9+/=_-]{8,})["']/g;

function detectExamplePlaceholderSecret(file: DiffFile): CredentialExposureIssue[] {
  const issues: CredentialExposureIssue[] = [];
  const added = getAddedChanges(file);

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);
    if (file.path.includes("test") || file.path.includes("__tests__")) continue;

    if (PLACEHOLDER_COMMENT_RE.test(trimmed)) {
      // Check if there's a nearby string literal with high entropy
      NEARBY_STRING_LITERAL_RE.lastIndex = 0;
      let match;
      while ((match = NEARBY_STRING_LITERAL_RE.exec(trimmed)) !== null) {
        const value = match[1];
        if (isHighEntropySecret(value) || matchAPIKeyPattern(value) || matchCloudKeyPrefix(value)) {
          issues.push({
            category: "example-placeholder-secret",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Placeholder secret in \`${file.path}:${change.line}\`: "replace with your" comment near hardcoded secret — LLMs add placeholder comments but devs often miss them; remove the hardcoded value and use env vars`,
            severity: "warning",
          });
          break;
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: CredentialExposureIssue[]): CredentialExposureIssue[] {
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

function buildCredentialExposureContext(result: CredentialExposureResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Credential Exposure Accelerator Detection (${result.issues.length})\n`;
  ctx += "This PR contains AI-scaffolded credential patterns — CSA 2026 reports 2x secret exposure rate for AI-assisted devs:\n\n";

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

function buildCredentialExposureBodySummary(result: CredentialExposureResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Credential Exposure Accelerator Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*AI-assisted devs expose secrets at 2x the rate of non-AI devs (CSA 2026). LLMs scaffold config with example credentials — inline env var fallbacks, config object literals, SDK constructor credentials, placeholder comments near hardcoded values. Remove all inline secrets and use env vars or secrets management.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run credential exposure accelerator detection on diff files. Zero LLM cost. */
export function detectCredentialExposure(diffFiles: DiffFile[]): CredentialExposureResult {
  const allIssues: CredentialExposureIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;

    allIssues.push(...detectScaffoldWithInlineSecret(file));
    allIssues.push(...detectConfigObjectLiteralSecret(file));
    allIssues.push(...detectConstructorHardcodedCredential(file));
    allIssues.push(...detectExamplePlaceholderSecret(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: CredentialExposureResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildCredentialExposureContext(result);
  result.bodySummary = buildCredentialExposureBodySummary(result);

  if (issues.length > 0) {
    core.info(`Credential exposure detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
