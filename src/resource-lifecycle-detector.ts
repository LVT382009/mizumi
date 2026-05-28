/**
 * Resource Lifecycle Violation Detector — detect acquire-without-release
 * patterns in PR diffs.
 *
 * No AI code reviewer detects resource lifecycle violations at PR review time.
 * SonarQube S1068 covers only Java try-with-resources. CodeGuru (deprecated)
 * detected resource leaks for Java/Python only. CodeRabbit, Copilot, and
 * Sourcery all miss: unclosed file handles, unreleased connections,
 * unsubscribed event listeners, missing finally blocks, React missing cleanup.
 *
 * Resource leaks are the #1 cause of production connection pool exhaustion,
 * file descriptor exhaustion, and memory leaks. They are silent in dev
 * (GC masks them) and catastrophic under load.
 *
 * Mizumi scans added lines for 5 lifecycle violation categories:
 * 1. Unclosed resource: open/createReadStream without close/end/destroy
 * 2. Unreleased connection: connect/acquire without disconnect/release/quit
 * 3. Unsubscribed listener: on/addEventListener without off/removeEventListener
 * 4. Missing finally cleanup: try block with resource acquire but no finally
 * 5. React missing cleanup: useEffect with subscribe/on but no return cleanup
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceLifecycleCategory =
  | "unclosed-resource"
  | "unreleased-connection"
  | "unsubscribed-listener"
  | "missing-finally-cleanup"
  | "react-missing-cleanup";

export interface ResourceLifecycleIssue {
  /** Category of the issue */
  category: ResourceLifecycleCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The acquire/release code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = unclosed/unreleased/unsubscribed, warning = missing-finally/react-cleanup */
  severity: "critical" | "warning";
}

export interface ResourceLifecycleResult {
  /** All detected resource lifecycle issues */
  issues: ResourceLifecycleIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Resource acquire patterns (file handles)
const RESOURCE_ACQUIRE_RE = /\.(?:open|createReadStream|createWriteStream|readFile|writeFile|fopen|openSync)\s*\(/;
const RESOURCE_RELEASE_RE = /\.(?:close|end|destroy|fclose|closeSync)\s*\(/;
// fs.open / fs.openSync acquire — requires fs.close / fs.closeSync
const FS_OPEN_RE = /(?:^|[^.])\b(?:open|openSync)\s*\(/;
const FS_CLOSE_RE = /(?:^|[^.])\b(?:close|closeSync)\s*\(/;

// Connection acquire patterns
const CONNECTION_ACQUIRE_RE = /\.(?:connect|createConnection|createPool|acquire|getClient|socket)\s*\(/;
const CONNECTION_RELEASE_RE = /\.(?:disconnect|end|release|quit|destroy|close|endConnection)\s*\(/;
// Standalone connect/got connect
const STANDALONE_CONNECT_RE = /(?:^|[^.])\b(?:connect|mysql\.createConnection|redis\.createClient|pg\.Pool|mongoose\.connect|amqp\.connect)\s*\(/;
const STANDALONE_DISCONNECT_RE = /(?:^|[^.])\b(?:disconnect|end|quit|close)\s*\(/;

// Listener subscribe patterns
const LISTENER_SUBSCRIBE_RE = /\.(?:on|addEventListener|addListener|subscribe)\s*\(/;
const LISTENER_UNSUBSCRIBE_RE = /\.(?:off|removeEventListener|removeListener|unsubscribe|removeAllListeners)\s*\(/;

// React useEffect pattern
const USE_EFFECT_RE = /useEffect\s*\(/;
const RETURN_CLEANUP_RE = /return\s+(?:\(\s*\)|function|\()/;
const SUBSCRIBE_IN_EFFECT_RE = /\.(?:on|addEventListener|addListener|subscribe)\s*\(/;

// Finally block check
const TRY_RE = /^\+\s*try\s*\{/;
const FINALLY_RE = /^\+\s*\}\s*finally\s*\{/;

// Lines to skip (comments, imports, type declarations)
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectUnclosedResources(file: DiffFile): ResourceLifecycleIssue[] {
  const issues: ResourceLifecycleIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedContent = changes.filter((c) => c.type === "add").map((c) => c.content);
  const hasRelease = (re: RegExp) => addedContent.some((line) => re.test(line));

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      // Check resource acquire patterns
      let acquired = false;
      if (RESOURCE_ACQUIRE_RE.test(content)) {
        acquired = true;
        if (!hasRelease(RESOURCE_RELEASE_RE) && !hasRelease(FS_CLOSE_RE)) {
          issues.push({
            category: "unclosed-resource",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Unclosed resource in \`${file.path}:${change.line}\` — openReadStream/createWriteStream without matching close/end/destroy; use finally or try-with-resources pattern`,
            severity: "critical",
          });
        }
      }

      if (!acquired && FS_OPEN_RE.test(content)) {
        if (!hasRelease(FS_CLOSE_RE) && !hasRelease(RESOURCE_RELEASE_RE)) {
          issues.push({
            category: "unclosed-resource",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Unclosed file handle in \`${file.path}:${change.line}\` — open/openSync without matching close/closeSync; always close handles in a finally block`,
            severity: "critical",
          });
        }
      }
    }
  }

  return issues;
}

function detectUnreleasedConnections(file: DiffFile): ResourceLifecycleIssue[] {
  const issues: ResourceLifecycleIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedContent = changes.filter((c) => c.type === "add").map((c) => c.content);
  const hasRelease = (re: RegExp) => addedContent.some((line) => re.test(line));

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      if (CONNECTION_ACQUIRE_RE.test(content) || STANDALONE_CONNECT_RE.test(content)) {
        if (!hasRelease(CONNECTION_RELEASE_RE) && !hasRelease(STANDALONE_DISCONNECT_RE)) {
          issues.push({
            category: "unreleased-connection",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Unreleased connection in \`${file.path}:${change.line}\` — connect/createConnection without matching disconnect/end/release; connections must be released to avoid pool exhaustion`,
            severity: "critical",
          });
        }
      }
    }
  }

  return issues;
}

function detectUnsubscribedListeners(file: DiffFile): ResourceLifecycleIssue[] {
  const issues: ResourceLifecycleIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedContent = changes.filter((c) => c.type === "add").map((c) => c.content);
  const hasUnsubscribe = (re: RegExp) => addedContent.some((line) => re.test(line));

  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      if (SKIP_LINE_RE.test(change.content)) continue;

      const content = change.content;
      const trimmed = content.replace(/^\+/, "").trim();

      if (LISTENER_SUBSCRIBE_RE.test(content)) {
        if (!hasUnsubscribe(LISTENER_UNSUBSCRIBE_RE)) {
          issues.push({
            category: "unsubscribed-listener",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Unsubscribed listener in \`${file.path}:${change.line}\` — on/addEventListener without matching off/removeEventListener; listeners must be removed to prevent memory leaks`,
            severity: "critical",
          });
        }
      }
    }
  }

  return issues;
}

function detectMissingFinally(file: DiffFile): ResourceLifecycleIssue[] {
  const issues: ResourceLifecycleIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (!TRY_RE.test(change.content)) continue;

    // Found a try block — check if any resource acquire follows
    let hasAcquire = false;
    let hasFinally = false;

    for (let j = i + 1; j < Math.min(i + 20, addedChanges.length); j++) {
      const next = addedChanges[j];
      if (FINALLY_RE.test(next.content)) {
        hasFinally = true;
        break;
      }
      if (RESOURCE_ACQUIRE_RE.test(next.content) || CONNECTION_ACQUIRE_RE.test(next.content)) {
        hasAcquire = true;
      }
    }

    if (hasAcquire && !hasFinally) {
      const trimmed = change.content.replace(/^\+/, "").trim();
      issues.push({
        category: "missing-finally-cleanup",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `try block with resource acquire but no finally in \`${file.path}:${change.line}\` — resources should be released in a finally block to guarantee cleanup on error`,
        severity: "warning",
      });
    }
  }

  return issues;
}

function detectReactMissingCleanup(file: DiffFile): ResourceLifecycleIssue[] {
  const issues: ResourceLifecycleIssue[] = [];

  // Only run on React files
  if (!/\.(tsx|jsx|ts|js)$/.test(file.path)) return issues;

  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (let i = 0; i < addedChanges.length; i++) {
    const change = addedChanges[i];
    if (!USE_EFFECT_RE.test(change.content)) continue;

    // Found useEffect — look ahead for subscribe/on without return cleanup
    let hasSubscribe = false;
    let hasReturnCleanup = false;
    let subscribeLine = 0;
    let subscribeCode = "";

    for (let j = i + 1; j < Math.min(i + 15, addedChanges.length); j++) {
      const next = addedChanges[j];
      const nextContent = next.content;

      if (RETURN_CLEANUP_RE.test(nextContent)) {
        hasReturnCleanup = true;
        break;
      }
      // If we hit another useEffect or a closing that ends the block, stop
      if (/^\+\s*\}\s*,\s*\[/.test(nextContent) || USE_EFFECT_RE.test(nextContent)) break;

      if (SUBSCRIBE_IN_EFFECT_RE.test(nextContent) || LISTENER_SUBSCRIBE_RE.test(nextContent)) {
        hasSubscribe = true;
        subscribeLine = next.line;
        subscribeCode = nextContent.replace(/^\+/, "").trim();
      }
    }

    if (hasSubscribe && !hasReturnCleanup) {
      issues.push({
        category: "react-missing-cleanup",
        file: file.path,
        line: subscribeLine || change.line,
        code: subscribeCode || change.content.replace(/^\+/, "").trim(),
        description: `useEffect with subscription but no cleanup in \`${file.path}:${subscribeLine || change.line}\` — return a cleanup function from useEffect to unsubscribe/removeListener on unmount`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: ResourceLifecycleIssue[]): ResourceLifecycleIssue[] {
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

function buildResourceLifecycleContext(result: ResourceLifecycleResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Resource Lifecycle Violations (${result.issues.length})\n`;
  ctx += "This PR may introduce resource lifecycle violations:\n\n";

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

function buildResourceLifecycleBodySummary(result: ResourceLifecycleResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Resource Lifecycle Violations</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Unclosed resources cause connection pool exhaustion and file descriptor leaks. Always release in finally blocks.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run resource lifecycle violation detection on diff files.
 * Zero LLM cost.
 */
export function detectResourceLifecycleViolations(diffFiles: DiffFile[]): ResourceLifecycleResult {
  const allIssues: ResourceLifecycleIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectUnclosedResources(file));
    allIssues.push(...detectUnreleasedConnections(file));
    allIssues.push(...detectUnsubscribedListeners(file));
    allIssues.push(...detectMissingFinally(file));
    allIssues.push(...detectReactMissingCleanup(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: ResourceLifecycleResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildResourceLifecycleContext(result);
  result.bodySummary = buildResourceLifecycleBodySummary(result);

  if (issues.length > 0) {
    core.info(`Resource lifecycle detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
