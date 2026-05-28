/**
 * AI Code Pathology Detector — detect LLM-specific code mistakes in PR diffs.
 *
 * No code reviewer detects AI-generated code pathologies. As AI coding agents
 * (Cursor, Copilot, Claude, Devin) generate more PRs, they introduce
 * systematic mistakes that human reviewers miss because the code looks
 * plausible and compiles. Common LLM pathologies:
 *
 * 1. Hallucinated imports: importing from packages that don't exist
 *    or importing functions that aren't in the package's API
 * 2. Sycophantic stub: function body that always returns a plausible
 *    default rather than implementing real logic (return true, return [])
 * 3. Confident-wrong API: calling a method with wrong parameter order
 *    that happens to compile (Array.includes vs Set.has)
 * 4. Boilerplate expansion: AI adds excessive boilerplate that doesn't
 *    add functionality (empty try/catch, commented-out alternatives)
 *
 * These bugs are pernicious because code looks correct at a glance.
 * Human reviewers trust "code that compiles" — but LLM code often
 * compiles while being semantically wrong.
 *
 * Mizumi scans added lines for 4 AI pathology categories:
 * 1. Hallucinated import: imports from fictional packages or wrong subpaths
 * 2. Sycophantic stub: function returning trivial defaults
 * 3. Confident-wrong API: method calls with wrong but compilable signatures
 * 4. Boilerplate expansion: unnecessary scaffolding with no real logic
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AICodePathologyCategory =
  | "hallucinated-import"
  | "sycophantic-stub"
  | "confident-wrong-api"
  | "boilerplate-expansion";

export interface AICodePathologyIssue {
  /** Category of the issue */
  category: AICodePathologyCategory;
  /** File where the issue occurs */
  file: string;
  /** Line number (1-based) */
  line: number;
  /** The problematic code */
  code: string;
  /** Human-readable description */
  description: string;
  /** Severity: critical = hallucinated-import/confident-wrong, warning = sycophantic-stub/boilerplate */
  severity: "critical" | "warning";
}

export interface AICodePathologyResult {
  /** All detected AI pathology issues */
  issues: AICodePathologyIssue[];
  /** Context text for LLM prompt */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Known hallucinated package patterns — packages that are common LLM fabrications
const HALLUCINATED_PACKAGES_RE = /\b(?:lodash-es|ramda|date-fns-tz|@aws-sdk\/client-all|@google-cloud\/all|aws-sdk\/v3|@azure\/all|@types\/express-serve-static-core|node:util\/promisify|python|django|flask|tensorflow|torch|numpy|pandas|scipy|sklearn|matplotlib)\b/;

// Known wrong subpath patterns
const WRONG_SUBPATH_RE = /from\s+['"](?:@actions\/github\/lib\/|@octokit\/rest\/lib\/|express\/lib\/|lodash\/fp\/|@types\/node\/ts)/;

// Importing a function that doesn't exist in a known package
const HALLUCINATED_FUNCTION_RE = /import\s+\{[^}]*(?:QueryClient|useQuery|useMutation|DataProvider|AuthClient|StorageClient|CacheClient|EventClient)[^}]*\}\s+from\s+['"](?:@actions\/|@octokit\/|express|lodash|axios|dotenv)[^;]*;/;

// Sycophantic stub patterns: functions always returning trivial defaults
const STUB_RETURN_RE = /return\s+(?:true|false|null|undefined|0|''|""|\[\]|\{\}|new Map\(\)|new Set\(\));?\s*(?:\}|$)/;

// Function that just returns its input unchanged
const IDENTITY_RETURN_RE = /return\s+\w+;?\s*(?:\}|$)/;

// Confident-wrong API patterns
// Boilerplate expansion patterns
const EMPTY_TRY_CATCH_RE = /try\s*\{\s*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/;

// Commented-out alternative code (AI generates options, doesn't clean up)
const COMMENTED_ALTERNATIVE_RE = /^\+\s*\/\/\s*(?:alternative|option|or|instead|another way|could also|also:|FIXME|NOTE: alternative)/i;

// Multiple consecutive blank lines in added code (AI loves spacing)
const EXCESSIVE_BLANK_LINES_RE = /^\+\s*$/;

// Lines to skip
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s|export\s|interface\s|type\s|enum\s|\})/;

// Known non-stub function names (getters/accessors return trivial values legitimately)
const LEGITIMATE_TRIVIAL_RE = /^(?:isEmpty|isSet|isEnabled|isDisabled|isReady|isComplete|has[A-Z]|can[A-Z]|should[A-Z]|is[A-Z])/;

// ---------------------------------------------------------------------------
// Detection functions
// ---------------------------------------------------------------------------

function detectHallucinatedImports(file: DiffFile): AICodePathologyIssue[] {
  const issues: AICodePathologyIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Skip non-import lines
    if (!trimmed.startsWith("import ")) continue;

    // Check for hallucinated packages
    if (HALLUCINATED_PACKAGES_RE.test(content)) {
      const pkgMatch = content.match(HALLUCINATED_PACKAGES_RE);
      issues.push({
        category: "hallucinated-import",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Possible hallucinated package \`${pkgMatch?.[0]}\` in \`${file.path}:${change.line}\` — verify this package exists and provides the imported symbols; LLMs frequently fabricate package names`,
        severity: "critical",
      });
    }

    // Check for wrong subpath imports
    if (WRONG_SUBPATH_RE.test(content)) {
      issues.push({
        category: "hallucinated-import",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Wrong import subpath in \`${file.path}:${change.line}\` — deep package subpaths are often hallucinated by LLMs; import from the package root instead`,
        severity: "critical",
      });
    }

    // Check for importing functions that don't exist in known packages
    if (HALLUCINATED_FUNCTION_RE.test(content)) {
      const funcMatch = content.match(/import\s+\{([^}]+)\}/)?.[1]?.trim();
      issues.push({
        category: "hallucinated-import",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Possible hallucinated function import \`${funcMatch}\` in \`${file.path}:${change.line}\` — verify these exports exist in the package; LLMs commonly import non-existent functions`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectSycophanticStubs(file: DiffFile): AICodePathologyIssue[] {
  const issues: AICodePathologyIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Check for stub return values in function bodies
    if (STUB_RETURN_RE.test(trimmed)) {
      // Check if this is in a named function (not a legitimate getter)
      const funcMatch = content.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)/);
      if (funcMatch) {
        const funcName = funcMatch[1] || funcMatch[2];
        // Skip if function name suggests it's legitimately trivial
        if (funcName && LEGITIMATE_TRIVIAL_RE.test(funcName)) continue;

        const returnMatch = trimmed.match(/return\s+(.+?);?\s*$/);
        const returnValue = returnMatch?.[1] || "trivial value";
        issues.push({
          category: "sycophantic-stub",
          file: file.path,
          line: change.line,
          code: trimmed,
          description: `Function \`${funcName}\` returns \`${returnValue}\` in \`${file.path}:${change.line}\` — looks like a stub implementation; LLMs often generate plausible but empty function bodies that need real logic`,
          severity: "warning",
        });
      }
    }

    // Check for identity function (returns input unchanged)
    if (IDENTITY_RETURN_RE.test(trimmed) && !/return\s+(?:this|self|result|output|response)/i.test(trimmed)) {
      const funcMatch = content.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)/);
      if (funcMatch) {
        const funcName = funcMatch[1] || funcMatch[2];
        if (funcName && LEGITIMATE_TRIVIAL_RE.test(funcName)) continue;
        const returnVar = trimmed.match(/return\s+(\w+)/)?.[1];
        // Only flag if the return variable matches a parameter name
        const paramMatch = content.match(/\((\w+)(?:,\s*\w+)*\)/);
        if (paramMatch && paramMatch[1] === returnVar) {
          issues.push({
            category: "sycophantic-stub",
            file: file.path,
            line: change.line,
            code: trimmed,
            description: `Function \`${funcName}\` appears to be an identity function (returns \`${returnVar}\` unchanged) in \`${file.path}:${change.line}\` — may be a stub; LLMs generate pass-through functions when unsure of logic`,
            severity: "warning",
          });
        }
      }
    }
  }

  return issues;
}

function detectConfidentWrongAPI(file: DiffFile): AICodePathologyIssue[] {
  const issues: AICodePathologyIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    if (SKIP_LINE_RE.test(change.content)) continue;

    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // .includes() called on a Set (should use .has())
    // Simpler: look for variable named *Set* using .includes
    const setIncludes = content.match(/(\w*[Ss]et\w*)\.includes\s*\(/);
    if (setIncludes) {
      issues.push({
        category: "confident-wrong-api",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Set using \`.includes()\` instead of \`.has()\` in \`${file.path}:${change.line}\` — Set.has() is the correct API; .includes() is an Array method and will throw TypeError on Sets`,
        severity: "critical",
      });
    }

    // .has() on an Array (should use .includes())
    const arrHas = content.match(/(\w*(?:list|items|array|arr|data|collection)\w*)\.has\s*\(/i);
    if (arrHas) {
      issues.push({
        category: "confident-wrong-api",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Array using \`.has()\` instead of \`.includes()\` in \`${file.path}:${change.line}\` — Arrays use .includes(), not .has(); .has() is a Map/Set method`,
        severity: "critical",
      });
    }

    // .size on Array (should use .length)
    const arrSize = content.match(/(\w*(?:list|items|array|arr|data|collection)\w*)\.size\b/i);
    if (arrSize && !content.includes("Map") && !content.includes("Set")) {
      issues.push({
        category: "confident-wrong-api",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Array using \`.size\` instead of \`.length\` in \`${file.path}:${change.line}\` — Arrays use .length, not .size; .size is for Map/Set`,
        severity: "critical",
      });
    }

    // .length on Map or Set (should use .size)
    const mapLength = content.match(/(\w*(?:map|set|dict|hash)\w*)\.length\b/i);
    if (mapLength) {
      issues.push({
        category: "confident-wrong-api",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Map/Set using \`.length\` instead of \`.size\` in \`${file.path}:${change.line}\` — Map/Set use .size, not .length; .length is for Arrays/strings`,
        severity: "critical",
      });
    }
  }

  return issues;
}

function detectBoilerplateExpansion(file: DiffFile): AICodePathologyIssue[] {
  const issues: AICodePathologyIssue[] = [];
  const changes = file.hunks.flatMap((h) => h.changes);
  const addedChanges = changes.filter((c) => c.type === "add");

  for (const change of addedChanges) {
    const content = change.content;
    const trimmed = content.replace(/^\+/, "").trim();

    // Empty try/catch — does nothing
    if (EMPTY_TRY_CATCH_RE.test(content)) {
      issues.push({
        category: "boilerplate-expansion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Empty try/catch block in \`${file.path}:${change.line}\` — catches errors but does nothing with them; LLMs add empty try/catch as boilerplate; add error handling or remove the try/catch`,
        severity: "warning",
      });
    }

    // Commented-out alternative — AI leaving its "drafts" visible
    if (COMMENTED_ALTERNATIVE_RE.test(content)) {
      issues.push({
        category: "boilerplate-expansion",
        file: file.path,
        line: change.line,
        code: trimmed,
        description: `Commented-out alternative approach in \`${file.path}:${change.line}\` — LLMs leave multiple implementation options as comments; remove alternatives and keep only the chosen approach`,
        severity: "warning",
      });
    }
  }

  // Detect excessive blank lines (3+ consecutive) — AI loves padding
  let consecutiveBlanks = 0;
  for (const change of addedChanges) {
    if (EXCESSIVE_BLANK_LINES_RE.test(change.content)) {
      consecutiveBlanks++;
      if (consecutiveBlanks === 3) {
        issues.push({
          category: "boilerplate-expansion",
          file: file.path,
          line: change.line,
          code: "",
          description: `3+ consecutive blank lines in \`${file.path}:${change.line}\` — excessive blank lines are common in AI-generated code; reduce to 1 blank line between sections`,
          severity: "warning",
        });
        break; // Only flag once per file
      }
    } else {
      consecutiveBlanks = 0;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: AICodePathologyIssue[]): AICodePathologyIssue[] {
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

function buildAIPathologyContext(result: AICodePathologyResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## AI-Generated Code Pathologies (${result.issues.length})\n`;
  ctx += "This PR may contain LLM-specific code mistakes:\n\n";

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

function buildAIPathologyBodySummary(result: AICodePathologyResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>AI Code Pathology Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*AI-generated code pathologies compile without error but are semantically wrong — hallucinated imports, sycophantic stubs, wrong API methods, unnecessary boilerplate.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run AI code pathology detection on diff files.
 * Zero LLM cost.
 */
export function detectAICodePathologies(diffFiles: DiffFile[]): AICodePathologyResult {
  const allIssues: AICodePathologyIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectHallucinatedImports(file));
    allIssues.push(...detectSycophanticStubs(file));
    allIssues.push(...detectConfidentWrongAPI(file));
    allIssues.push(...detectBoilerplateExpansion(file));
  }

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: AICodePathologyResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildAIPathologyContext(result);
  result.bodySummary = buildAIPathologyBodySummary(result);

  if (issues.length > 0) {
    core.info(`AI code pathology detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
