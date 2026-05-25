/**
 * Entropy-based Secret Detection — catch secrets that regex patterns miss.
 *
 * Competitive gap: Every AI code reviewer uses regex patterns for secrets
 * (we do too in rules.ts). But regex only finds NAMED secrets (api_key=,
 * password=, etc.). It completely misses:
 * - High-entropy strings assigned to innocuous variable names
 * - Base64-encoded credentials
 * - Hex-encoded tokens (AWS-style, custom formats)
 * - Private key fragments in code
 *
 * This module uses Shannon entropy analysis on string literals in added
 * lines to flag suspiciously random values. Pattern-matching whitelist
 * prevents false positives on imports, URLs, hashes, test fixtures.
 *
 * Signals:
 * - String literal with Shannon entropy > threshold (4.5 for 20+ chars)
 * - Hex strings of 32+ chars with entropy > 3.0
 * - Base64 strings of 24+ chars with reasonable entropy
 * - Context clues: assigned to variable, used as argument, returned
 *
 * Whitelist (NOT flagged):
 * - Import/require paths
 * - URLs (http://, https://)
 * - SHA/commit hashes (in comments, constant names with "hash"/"commit")
 * - UUIDs (well-known format, low false positive rate)
 * - File paths (containing / or \ separators)
 * - Test fixtures (in __tests__ or .test. files)
 * - Known non-secret patterns (CSS classes, HTML IDs, etc.)
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntropyFinding {
  file: string;
  line: number;
  entropy: number;
  length: number;
  snippet: string;
  reason: string;
  severity: "high" | "medium";
}

export interface EntropyResult {
  findings: EntropyFinding[];
  stringsAnalyzed: number;
}

// ---------------------------------------------------------------------------
// Entropy computation
// ---------------------------------------------------------------------------

/** Shannon entropy of a string — measures randomness in bits per character */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ---------------------------------------------------------------------------
// String extraction
// ---------------------------------------------------------------------------

/** Extract quoted string literals from a line of code */
export function extractStringLiterals(line: string): Array<{ value: string; startCol: number }> {
  const results: Array<{ value: string; startCol: number }> = [];
  // Match single-quoted, double-quoted, and backtick strings
  const re = /['"`]([^'"`\n\\]{6,}?)['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    results.push({ value: match[1], startCol: match.index });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Whitelist — patterns that are NOT secrets
// ---------------------------------------------------------------------------

const NOT_SECRET_PATTERNS = [
  /^https?:\/\//i,                           // URLs
  /^\/[a-zA-Z0-9_./-]+$/,                    // File paths
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDs
  /^data:[a-z]+\/[a-z]+;base64,/i,          // Data URLs
  /^\.{0,2}\//,                              // Relative paths
  /^[a-z][a-z0-9_-]*\.[a-z]{1,4}$/i,        // Simple file extensions
  /^#[0-9a-f]{3,8}$/i,                       // CSS color codes
  /^import\s/m,                              // Import statements
  /^require\s*\(/,                           // Require calls
  /^[A-Z_]+$/,                               // Constant names (no mixed char types)
];

const NOT_SECRET_CONTEXT = [
  /\bimport\b.*from\s*['"`]/,                // ES import
  /\brequire\s*\(\s*['"`]/,                  // CommonJS require
  /\bpath\s*[:=]\s*['"`]/,                   // Path assignment
  /\bclassName\s*[:=]\s*['"`]/,              // React className
  /\bid\s*[:=]\s*['"`]/,                     // HTML ID
  /\.(join|resolve|normalize)\s*\(/,         // Path operations
  /\.test\s*\(|describe\s*\(|it\s*\(/,      // Test context
  /\bconsole\.\w+\s*\(/,                    // Console logging
  /\.(style|className|id|type)\s*[:=]\s*['"`]/, // DOM props
  /(?:^|[\s=({,]|.)(?:md5|sha\d*|[Hh]ash|[Cc]ommit|[Dd]igest|[Cc]hecksum|[Ee]tag)/, // Hash context in variable name
];

const HEX_PATTERN = /^[0-9a-f]+$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/;

const ENTROPY_THRESHOLDS = {
  /** General high-entropy string: 20+ chars, entropy > 4.5 */
  general: { minLen: 20, minEntropy: 4.5 },
  /** Hex string: 32+ chars, entropy > 3.0 (AWS keys, etc.) */
  hex: { minLen: 32, minEntropy: 3.0 },
  /** Base64 string: 24+ chars, entropy > 4.0 */
  base64: { minLen: 24, minEntropy: 4.0 },
};

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

/** Check if a string looks like a secret based on entropy + context */
export function isLikelySecret(
  value: string,
  lineContent: string,
): { likely: boolean; reason: string } {
  // Whitelist check — context around the string
  for (const pat of NOT_SECRET_CONTEXT) {
    if (pat.test(lineContent)) return { likely: false, reason: "" };
  }

  // Whitelist check — the string value itself
  for (const pat of NOT_SECRET_PATTERNS) {
    if (pat.test(value)) return { likely: false, reason: "" };
  }

  const len = value.length;
  const entropy = shannonEntropy(value);

  // Hex strings (AWS-style keys, random hex tokens)
  if (HEX_PATTERN.test(value) && len >= ENTROPY_THRESHOLDS.hex.minLen && entropy >= ENTROPY_THRESHOLDS.hex.minEntropy) {
    return { likely: true, reason: `hex string (entropy=${entropy.toFixed(1)}, len=${len})` };
  }

  // Base64 strings (JWT-like, encoded credentials)
  if (BASE64_PATTERN.test(value) && len >= ENTROPY_THRESHOLDS.base64.minLen && entropy >= ENTROPY_THRESHOLDS.base64.minEntropy) {
    return { likely: true, reason: `base64 string (entropy=${entropy.toFixed(1)}, len=${len})` };
  }

  // General high-entropy string
  if (len >= ENTROPY_THRESHOLDS.general.minLen && entropy >= ENTROPY_THRESHOLDS.general.minEntropy) {
    // Extra check: mixed character types suggest randomness
    const hasLower = /[a-z]/.test(value);
    const hasUpper = /[A-Z]/.test(value);
    const hasDigit = /[0-9]/.test(value);
    const hasSpecial = /[^a-zA-Z0-9]/.test(value);
    const typeCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

    if (typeCount >= 2) {
      return { likely: true, reason: `high-entropy string (entropy=${entropy.toFixed(1)}, len=${len}, ${typeCount} char types)` };
    }
  }

  return { likely: false, reason: "" };
}

/** Run entropy analysis on diff files */
export function runEntropyAnalysis(files: DiffFile[]): EntropyResult {
  const findings: EntropyFinding[] = [];
  let stringsAnalyzed = 0;

  for (const file of files) {
    const isTestFile = /(__tests__|\.test\.|\.spec\.|_test\.|_spec\.)/.test(file.path);

    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;

        const literals = extractStringLiterals(change.content);
        for (const lit of literals) {
          stringsAnalyzed++;
          // Skip test files — they often have fixture secrets
          if (isTestFile) continue;

          const { likely, reason } = isLikelySecret(lit.value, change.content);
          if (!likely) continue;

          // Truncate snippet for safety — never echo full secret
          const snippet = lit.value.length > 20
            ? lit.value.slice(0, 8) + "..." + lit.value.slice(-4)
            : lit.value.slice(0, 3) + "...";

          findings.push({
            file: file.path,
            line: change.line,
            entropy: shannonEntropy(lit.value),
            length: lit.value.length,
            snippet,
            reason,
            severity: "high",
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    core.info(`Entropy analysis: ${findings.length} suspicious strings in ${files.length} files (${stringsAnalyzed} strings analyzed)`);
  }

  return { findings, stringsAnalyzed };
}

/** Build entropy context for LLM prompt injection */
export function buildEntropyContext(result: EntropyResult): string {
  if (result.findings.length === 0) return "";

  let ctx = `## Entropy-Based Secret Detection (${result.findings.length})\n`;
  ctx += "The following high-entropy strings may be hardcoded secrets missed by pattern-based rules:\n\n";

  for (const f of result.findings.slice(0, 12)) {
    ctx += `- \`${f.file}:${f.line}\` — ${f.reason} (snippet: \`${f.snippet}\`)\n`;
  }

  if (result.findings.length > 12) {
    ctx += `- ... and ${result.findings.length - 12} more\n`;
  }

  ctx += `\n**Strings analyzed:** ${result.stringsAnalyzed}\n`;

  return ctx.trim();
}
