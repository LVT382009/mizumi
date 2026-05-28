/**
 * Hardcoded Configuration Detector — detect LLM-specific config embedding.
 *
 * LLMs frequently embed configuration values (URLs, ports, timeouts, limits,
 * feature flags, API endpoints) directly in production code instead of using
 * environment variables or config files. This is an LLM pathology because:
 *
 * 1. LLMs optimize for "working example" over "deployable code"
 * 2. LLMs grab obvious values (localhost:3000, 8080, 100) to make code run
 * 3. LLMs don't know project conventions for config management
 *
 * No existing code reviewer detects hardcoded configuration as a category.
 * SonarQube catches some hardcoded IPs and credentials, but misses:
 * - Hardcoded timeouts and retry limits
 * - Hardcoded feature flags and boolean toggles
 * - Hardcoded batch sizes, rate limits, concurrency limits
 * - Hardcoded URLs that aren't credentials
 * - Hardcoded port numbers in server code
 *
 * Categories:
 * 1. hardcoded-url: URLs/URIs embedded directly in code (not in constants)
 * 2. hardcoded-port: Port numbers in server/listen calls
 * 3. hardcoded-limit: Numeric limits (timeouts, retries, batch sizes, rate limits)
 * 4. hardcoded-toggle: Boolean feature flags embedded directly in logic
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HardcodedConfigCategory =
  | "hardcoded-url"
  | "hardcoded-port"
  | "hardcoded-limit"
  | "hardcoded-toggle";

export interface HardcodedConfigIssue {
  category: HardcodedConfigCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface HardcodedConfigResult {
  issues: HardcodedConfigIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Hardcoded URL patterns — http/https URLs in code (not in comments, strings that are constants, or test files)
const URL_IN_CODE_RE = /['"](?:https?:\/\/)[^'"]+['"]/;

// URL patterns that are legitimate (docs, licenses, package registries)
const LEGITIMATE_URL_RE = /(?:github\.com\/\w+\/\w+(?:\/(?:tree|blob|issues|pull|releases))?|npmjs\.com|registry\.npmjs|opensource\.org|mozilla\.org|w3\.org|schema\.org|json-schema\.org|example\.(?:com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0)/;

// Server listen patterns with hardcoded port
const LISTEN_PORT_RE = /\b(?:listen|bind|connect|createServer)\s*\(\s*(?:['"][^'"]*['"]\s*,?\s*)?(\d{2,5})\b/;

// Direct port assignment patterns
const PORT_ASSIGN_RE = /(?:port|PORT)\s*[:=]\s*(\d{2,5})\b/;

// Common well-known ports to skip (80, 443, 22, etc.)
const WELL_KNOWN_PORTS = new Set([21, 22, 23, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 3306, 5432, 6379, 8080, 8443, 27017]);

// Hardcoded limit patterns: timeouts, retries, batch sizes, rate limits, etc.
const LIMIT_PATTERNS_RE = /\b(?:(?:max|MIN|MAX|default|DEFAULT)_(?:retry|timeout|retries|attempts|batch|concurrency|connections|limit|size|count|items|per_page|per_request)|(?:retry|timeout|retries|attempts|batch|concurrency|connections|limit|rate)_limit|TIMEOUT_MS|MAX_RETRIES|BATCH_SIZE|RATE_LIMIT|MAX_CONNECTIONS|CONCURRENCY_LIMIT)\s*[:=]\s*(\d+)/;

// Generic number that looks like a config value
const SUSPICIOUS_NUMERIC_RE = /\b(?:timeout|retry|max|limit|batch|size|threshold|interval|delay|ttl|expiry|capacity|concurrency|rate|period|duration|backoff)\w*\s*[:=]\s*(\d+)\b/i;

// Hardcoded boolean toggle patterns
const TOGGLE_PATTERNS_RE = /\b(?:ENABLE_\w+|DISABLE_\w+|FEATURE_\w+|USE_\w+|ALLOW_\w+|REQUIRE_\w+|SKIP_\w+|FORCE_\w+|DEBUG|VERBOSE|DRY_RUN|MOCK|STUB|SIMULATE)\s*[:=]\s*(?:true|false)/i;

// Boolean toggle in config object
const CONFIG_TOGGLE_RE = /(?:enabled|disabled|active|verbose|debug|dryRun|dry_run|mock|stub|simulate|force|strict|safe|secure|use[A-Z]\w+|allow[A-Z]\w+|require[A-Z]\w+|skip[A-Z]\w+|enable[A-Z]\w+|disable[A-Z]\w+)\s*[:=]\s*(?:true|false)\s*[,;}]/i;

// Skip lines
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\}|case\s)/;

// Skip test files
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|\/test\/|\/tests\/|\.e2e\.)/;

// Skip config files themselves — they're supposed to have config values
const CONFIG_FILE_RE = /(?:\.env|config\.\w+$|settings\.\w+$|\.yml$|\.yaml$|\.json$|\.toml$)/;

// Skip lines inside string declarations that are clearly constants
const CONSTANT_DECL_RE = /^\+\s*(?:export\s+)?(?:const|let|var|readonly)\s+\w*(?:URL|URI|ENDPOINT|HOST|PORT|BASE|CONFIG)\w*\s*[:=]/i;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectHardcodedURLs(file: DiffFile): HardcodedConfigIssue[] {
  const issues: HardcodedConfigIssue[] = [];
  if (TEST_FILE_RE.test(file.path)) return issues;
  if (CONFIG_FILE_RE.test(file.path)) return issues;

  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip if this is a constant declaration (it's intentional)
    if (CONSTANT_DECL_RE.test(trimmed)) continue;

    if (URL_IN_CODE_RE.test(content)) {
      const urlMatch = content.match(URL_IN_CODE_RE);
      const url = urlMatch?.[0] || "";
      // Skip legitimate URLs
      if (LEGITIMATE_URL_RE.test(url)) continue;

      issues.push({
        category: "hardcoded-url",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Hardcoded URL \`${url.slice(1, -1)}\` in \`${file.path}:${change.line}\` — LLMs embed URLs directly in code; use environment variable or config file for service endpoints, API URLs, and webhook targets`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectHardcodedPorts(file: DiffFile): HardcodedConfigIssue[] {
  const issues: HardcodedConfigIssue[] = [];
  if (TEST_FILE_RE.test(file.path)) return issues;
  if (CONFIG_FILE_RE.test(file.path)) return issues;

  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip constant declarations
    if (CONSTANT_DECL_RE.test(trimmed)) continue;

    // Check listen/bind calls
    const listenMatch = content.match(LISTEN_PORT_RE);
    if (listenMatch) {
      const port = parseInt(listenMatch[1], 10);
      if (!WELL_KNOWN_PORTS.has(port) && port > 1 && port < 65536) {
        issues.push({
          category: "hardcoded-port",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Hardcoded port \`${port}\` in \`${file.path}:${change.line}\` — LLMs use common ports (3000, 8080) directly; use \`process.env.PORT\` or config file for deployable code`,
          severity: "warning",
        });
      }
    }

    // Check port assignment
    const portAssignMatch = content.match(PORT_ASSIGN_RE);
    if (portAssignMatch) {
      const port = parseInt(portAssignMatch[1], 10);
      if (!WELL_KNOWN_PORTS.has(port) && port > 1 && port < 65536) {
        // Skip if it's already reading from env
        if (content.includes("process.env")) continue;

        issues.push({
          category: "hardcoded-port",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Hardcoded port \`${port}\` in \`${file.path}:${change.line}\` — use environment variable (PORT) for configurable deployment`,
          severity: "warning",
        });
      }
    }
  }

  return issues;
}

function detectHardcodedLimits(file: DiffFile): HardcodedConfigIssue[] {
  const issues: HardcodedConfigIssue[] = [];
  if (TEST_FILE_RE.test(file.path)) return issues;
  if (CONFIG_FILE_RE.test(file.path)) return issues;

  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip constant declarations at module level
    if (CONSTANT_DECL_RE.test(trimmed)) continue;
    // Skip if already using env var
    if (content.includes("process.env")) continue;

    // Named limit patterns (MAX_RETRIES = 3, etc.)
    const limitMatch = content.match(LIMIT_PATTERNS_RE);
    if (limitMatch) {
      const value = limitMatch[1];
      issues.push({
        category: "hardcoded-limit",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Hardcoded limit value \`${value}\` in \`${file.path}:${change.line}\` — LLMs embed timeout/retry/batch values directly; move to config or environment variable for tunability`,
        severity: "warning",
      });
      continue;
    }

    // Suspicious numeric pattern (timeout = 5000, batchSize = 100, etc.)
    const suspectMatch = content.match(SUSPICIOUS_NUMERIC_RE);
    if (suspectMatch) {
      const value = suspectMatch[1];
      issues.push({
        category: "hardcoded-limit",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Hardcoded numeric config \`${value}\` in \`${file.path}:${change.line}\` — LLMs embed timeout/limit/batch values; use config for deployable code`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectHardcodedToggles(file: DiffFile): HardcodedConfigIssue[] {
  const issues: HardcodedConfigIssue[] = [];
  if (TEST_FILE_RE.test(file.path)) return issues;
  if (CONFIG_FILE_RE.test(file.path)) return issues;

  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip if this is a constant/enum declaration (intentional flag)
    if (CONSTANT_DECL_RE.test(trimmed)) continue;

    // Skip if already using env var
    if (content.includes("process.env")) continue;

    // Named toggle patterns (ENABLE_FEATURE = true, etc.)
    if (TOGGLE_PATTERNS_RE.test(content)) {
      const toggleMatch = content.match(TOGGLE_PATTERNS_RE)?.[0] || "toggle";
      issues.push({
        category: "hardcoded-toggle",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Hardcoded feature toggle \`${toggleMatch}\` in \`${file.path}:${change.line}\` — LLMs embed booleans directly in logic; use feature flag system or environment variable for runtime configuration`,
        severity: "warning",
      });
      continue;
    }

    // Config object toggle (enabled: true, debug: false, etc.)
    if (CONFIG_TOGGLE_RE.test(content)) {
      const toggleMatch = content.match(CONFIG_TOGGLE_RE)?.[0] || "toggle";
      issues.push({
        category: "hardcoded-toggle",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Hardcoded toggle \`${toggleMatch.replace(/[,;}]\s*$/, "")}\` in \`${file.path}:${change.line}\` — consider environment variable or config-driven toggle for production`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: HardcodedConfigIssue[]): HardcodedConfigIssue[] {
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

function buildHardcodedConfigContext(result: HardcodedConfigResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Hardcoded Configuration (${result.issues.length})\n`;
  ctx += "This PR may contain hardcoded config values — LLMs embed URLs, ports, timeouts, and toggles directly in code:\n\n";

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

function buildHardcodedConfigBodySummary(result: HardcodedConfigResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Hardcoded Configuration Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Hardcoded configuration is a common LLM pathology — AI agents optimize for "working example" over deployable code, embedding URLs, ports, timeouts, and feature flags directly instead of using config management.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run hardcoded configuration detection on diff files.
 * Zero LLM cost.
 */
export function detectHardcodedConfig(diffFiles: DiffFile[]): HardcodedConfigResult {
  const allIssues: HardcodedConfigIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectHardcodedURLs(file));
    allIssues.push(...detectHardcodedPorts(file));
    allIssues.push(...detectHardcodedLimits(file));
    allIssues.push(...detectHardcodedToggles(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: HardcodedConfigResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildHardcodedConfigContext(result);
  result.bodySummary = buildHardcodedConfigBodySummary(result);

  if (issues.length > 0) {
    core.info(`Hardcoded config detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
