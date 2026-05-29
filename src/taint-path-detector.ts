/**
 * Cross-File Taint Path Detector — detect data flow from untrusted
 * sources to dangerous sinks within a single PR.
 *
 * Arxiv 2601.17548: 73% of AI platforms fail to enforce at least one
 * trust boundary. The Microsoft RCE research (May 2026) documented
 * CVE-2026-25592 where AI-controlled localFilePath parameter reached
 * child_process without path validation.
 *
 * Traditional taint analysis requires full AST and data flow graphs.
 * This detector uses a practical heuristic: it identifies source-sink
 * patterns where PR-added code introduces untrusted data paths without
 * validation guards, focusing on the most dangerous combinations.
 *
 * Patterns detected:
 * 1. pr-content-to-exec: PR title/body or user input flows to
 *    command execution without sanitization
 * 2. unvalidated-redirect: User-controlled URL parameters used in
 *    HTTP requests or redirects without allowlisting
 * 3. taint-across-files: Variable assigned from untrusted source in
 *    one file, used in dangerous operation in another
 *
 * Zero LLM cost — pattern analysis on added diff lines across files.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaintPathCategory =
  | "pr-content-to-exec"
  | "unvalidated-redirect"
  | "taint-across-files";

export interface TaintPathIssue {
  category: TaintPathCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface TaintPathResult {
  issues: TaintPathIssue[];
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

const SKIP_LINE_RE = /^[-+]\s*(?:[\/][\/]|\/\*|\*|import\s+type\s|export\s+type\s)/;

const TEST_PATH_RE = /(?:__tests__|\.test\.|\.spec\.|_test\.|_spec\.|tests?\/)/;

// ---------------------------------------------------------------------------
// Taint source patterns — untrusted inputs
// ---------------------------------------------------------------------------

const TAINT_SOURCES = [
  // PR content
  /\bpr\.title\b/i, /\bpr\.body\b/i, /\bprTitle\b/i, /\bprBody\b/i,
  // HTTP request objects
  /\breq\.(?:body|query|params|headers|cookies)\b/i,
  /\brequest\.(?:body|query|params|headers)\b/i,
  /\bctx\.(?:request|body|query|params)\b/i,
  // User input
  /\buser(?:Input|Data|Content|Text|Message)\b/i,
  /\binput(?:Data|Value|Text|Content)?\b/i,
  // Agent/LLM output
  /\b(?:llm|agent|model|completion|response|output|result|generated|chat)\w*\b/i,
  // Environment/config from external
  /\bprocess\.env\b/,
];

// ---------------------------------------------------------------------------
// Dangerous sink patterns
// ---------------------------------------------------------------------------

const EXEC_SINKS = [
  { re: /\bexec\s*\(/i, sink: "exec" },
  { re: /\beval\s*\(/i, sink: "eval" },
  { re: /\bspawn\s*\(/i, sink: "spawn" },
  { re: /\bnew\s+Function\s*\(/i, sink: "Function constructor" },
  { re: /\bchild_process/i, sink: "child_process" },
  { re: /\bos\.command/i, sink: "os.command" },
  { re: /\bsubprocess\./i, sink: "subprocess" },
  { re: /\brunCommand/i, sink: "runCommand" },
  { re: /\bexecuteCommand/i, sink: "executeCommand" },
];

const REDIRECT_SINKS = [
  { re: /\b(?:fetch|axios|http\.get|https\.get|request)\s*\(\s*(?:`|\$\{|req|request|ctx|input|url|endpoint)/i, sink: "HTTP request" },
  { re: /\bredirect\s*\(\s*(?:`|\$\{|req|request|ctx|input|url|endpoint)/i, sink: "redirect" },
  { re: /\bwindow\.location\s*=/i, sink: "window.location" },
  { re: /\blocation\.href\s*=/i, sink: "location.href" },
  { re: /\bresponse\.redirect/i, sink: "response.redirect" },
];

const FILE_SINKS = [
  { re: /\bfs\.(?:write|append|createWriteStream)\s*\(/i, sink: "fs write" },
  { re: /\bwriteFile\s*\(/i, sink: "writeFile" },
  { re: /\bcreateWriteStream\s*\(/i, sink: "createWriteStream" },
];

// ---------------------------------------------------------------------------
// Validation guard patterns — if present, the taint path is safe
// ---------------------------------------------------------------------------

const VALIDATION_GUARD_RE = [
  /(?:sanitize|validate|check|verify|restrict|allowlist|whitelist|escape)\w*\s*\(/i,
  /(?:ALLOWED|SAFE|VALID|WHITELIST)_(?:URLS|PATHS|COMMANDS|DOMAINS)/i,
  /(?:startsWith|includes|indexOf|match|test)\s*\(/i,
  /(?:encodeURIComponent|encodeURI|escape)\s*\(/i,
  /(?:path\.normalize|path\.resolve|path\.basename)\s*\(/i,
  /\bDOMPurify\b/i,
  /\bvalidator\b/i,
  /\bsanitize-html\b/i,
];

// ---------------------------------------------------------------------------
// Detection: pr-content-to-exec
// ---------------------------------------------------------------------------

function detectPRContentToExec(file: DiffFile): TaintPathIssue[] {
  const issues: TaintPathIssue[] = [];
  if (TEST_PATH_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    // Check if this line has both a taint source AND an exec sink
    const hasSource = TAINT_SOURCES.some((re) => re.test(trimmed));
    if (!hasSource) continue;

    // Check if validation guard is present
    if (VALIDATION_GUARD_RE.some((re) => re.test(trimmed))) continue;

    for (const { re, sink } of EXEC_SINKS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "pr-content-to-exec",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Taint path in \`${file.path}:${change.line}\`: untrusted input reaches ${sink} without validation; arxiv 2601.17548: 73% of AI platforms fail to enforce trust boundaries; Microsoft CVE-2026-25592: AI-controlled parameters crossed container boundaries without path validation; add input validation/sanitization before this dangerous operation`,
          severity: "critical",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: unvalidated-redirect
// ---------------------------------------------------------------------------

function detectUnvalidatedRedirect(file: DiffFile): TaintPathIssue[] {
  const issues: TaintPathIssue[] = [];
  if (TEST_PATH_RE.test(file.path)) return issues;

  const added = getAddedChanges(file);
  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    if (VALIDATION_GUARD_RE.some((re) => re.test(trimmed))) continue;

    for (const { re, sink } of REDIRECT_SINKS) {
      if (re.test(trimmed)) {
        issues.push({
          category: "unvalidated-redirect",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Unvalidated redirect in \`${file.path}:${change.line}\`: user-controlled URL reaches ${sink} without allowlisting; OWASP URL redirect abuse: open redirect vulnerabilities allow phishing and SSRF; add domain allowlist validation before this request`,
          severity: "warning",
        });
        break;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: taint-across-files
// ---------------------------------------------------------------------------

function detectTaintAcrossFiles(diffFiles: DiffFile[]): TaintPathIssue[] {
  const issues: TaintPathIssue[] = [];

  // Collect taint source variables from all files
  const taintVariables = new Map<string, Array<{ file: string; line: number; varName: string }>>();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (TEST_PATH_RE.test(file.path)) continue;

    const added = getAddedChanges(file);
    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      // Look for assignment from taint source: const x = req.body.y
      const assignMatch = /(?:const|let|var)\s+(\w+)\s*=\s*(?:req|request|ctx|pr|input|params)\b/i.exec(trimmed);
      if (assignMatch) {
        const varName = assignMatch[1];
        if (!taintVariables.has(varName)) {
          taintVariables.set(varName, []);
        }
        taintVariables.get(varName)!.push({ file: file.path, line: change.line, varName });
      }
    }
  }

  // Now check if any taint variables are used in dangerous operations in different files
  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    if (TEST_PATH_RE.test(file.path)) continue;

    const added = getAddedChanges(file);
    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      if (VALIDATION_GUARD_RE.some((re) => re.test(trimmed))) continue;

      // Check all sinks
      const allSinks = [...EXEC_SINKS, ...FILE_SINKS];
      for (const { re, sink } of allSinks) {
        if (!re.test(trimmed)) continue;

        // Check if any taint variable appears in this line
        for (const [varName, sources] of taintVariables) {
          const varRe = new RegExp(`\\b${varName}\\b`, 'i');
          if (!varRe.test(trimmed)) continue;

          // Check if the variable comes from a DIFFERENT file
          const externalSources = sources.filter((s) => s.file !== file.path);
          if (externalSources.length === 0) continue;

          issues.push({
            category: "taint-across-files",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Cross-file taint path in \`${file.path}:${change.line}\`: variable \`${varName}\` (from ${externalSources[0].file}:${externalSources[0].line}) reaches ${sink}; arxiv 2601.17548: skills define tool types but not targets — no mechanism restricts which files a tool can access; add validation at the sink site or use bounded interfaces`,
            severity: "critical",
          });
          break;
        }
        break; // one sink per line
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: TaintPathIssue[]): TaintPathIssue[] {
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

function buildTaintPathContext(result: TaintPathResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Cross-File Taint Path Detection (${result.issues.length})\n`;
  ctx += "This PR introduces taint paths — untrusted data reaches dangerous operations without validation:\n\n";

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

function buildTaintPathBodySummary(result: TaintPathResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Cross-File Taint Path Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*Cross-file taint paths — arxiv 2601.17548: 73% of AI platforms fail to enforce trust boundaries. Microsoft CVE-2026-25592: AI-controlled parameters reach dangerous sinks without validation. Untrusted data must be validated at trust boundaries, not assumed safe.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run cross-file taint path detection on diff files. Zero LLM cost. */
export function detectTaintPaths(diffFiles: DiffFile[]): TaintPathResult {
  const allIssues: TaintPathIssue[] = [];

  // Categories 1 & 2: per-file analysis
  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectPRContentToExec(file));
    allIssues.push(...detectUnvalidatedRedirect(file));
  }

  // Category 3: cross-file analysis
  allIssues.push(...detectTaintAcrossFiles(diffFiles));

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: TaintPathResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildTaintPathContext(result);
  result.bodySummary = buildTaintPathBodySummary(result);

  if (issues.length > 0) {
    core.info(`Taint path detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
