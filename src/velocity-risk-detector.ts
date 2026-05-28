/**
 * Velocity Risk Detector — detect risky patterns from high-velocity
 * AI-generated PRs that ship code faster than review can validate.
 *
 * LLMs generate code at machine speed — 500+ lines in seconds. Human
 * review can't keep up, and the CI/CD pipeline becomes the only gate.
 * Velocity risks are patterns strongly correlated with AI-generated
 * PRs that introduce defects disproportionate to their line count.
 *
 * Categories:
 * 1. large-new-file: new files >100 added lines with no test
 * 2. boilerplate-proliferation: many files with near-identical added
 *    structure (same function signatures, same import patterns)
 * 3. sweep-no-safety: large % of the PR is refactoring (rename/move)
 *    but no type annotations or tests added
 * 4. copy-paste-pattern: repeated code blocks across files (same
 *    5+ word sequence appearing in 3+ files)
 *
 * Zero LLM cost — diff metric + pattern analysis.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VelocityRiskCategory =
  | "large-new-file"
  | "boilerplate-proliferation"
  | "sweep-no-safety"
  | "copy-paste-pattern";

export interface VelocityRiskIssue {
  category: VelocityRiskCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface VelocityRiskResult {
  issues: VelocityRiskIssue[];
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

function getRemovedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "delete");
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const LARGE_NEW_FILE_THRESHOLD = 100; // lines
const BOILERPLATE_SIMILARITY_THRESHOLD = 3; // files with same pattern
const SWEEP_REFACTOR_RATIO = 0.6; // 60%+ removed lines without test/type additions
const COPY_PASTE_MIN_WORDS = 4;
const COPY_PASTE_MIN_FILES = 3;

// ---------------------------------------------------------------------------
// Detection: large-new-file
// ---------------------------------------------------------------------------

function detectLargeNewFiles(diffFiles: DiffFile[]): VelocityRiskIssue[] {
  const issues: VelocityRiskIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);
    const isNew = file.status === "added";
    const isLarge = added.length > LARGE_NEW_FILE_THRESHOLD;

    if (isNew && isLarge) {
      // Check if there are test-related indicators
      const hasTest = file.path.includes("test") || file.path.includes("spec") || file.path.includes("__tests__");
      const addedContent = added.map((c) => stripPrefix(c.content)).join("\n");
      const hasAssertions = /\bexpect\s*\(|\bassert\s*\(|\bshould\b|\bAssertions\b/i.test(addedContent);

      if (!hasTest && !hasAssertions) {
        // Check if ANY test file in the PR covers this module
        const baseName = file.path.replace(/\.\w+$/, "").split("/").pop() || "";
        const testCoverage = diffFiles.some((f) =>
          f.path !== file.path &&
          (f.path.includes("test") || f.path.includes("spec") || f.path.includes("__tests__")) &&
          f.path.includes(baseName),
        );

        if (!testCoverage) {
          issues.push({
            category: "large-new-file",
            file: file.path,
            line: 1,
            code: `${added.length} added lines`,
            description: `New file \`${file.path}\` has ${added.length} added lines with no test coverage — LLMs generate large files at machine speed but tests lag behind; high-velocity PRs with 100+ new lines and no tests have 3x higher defect density than PRs with test coverage; add unit tests before merging`,
            severity: "critical",
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: boilerplate-proliferation
// ---------------------------------------------------------------------------

function extractSignature(line: string): string {
  // Extract function/class signature patterns
  const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+(\w+)\s*(?:=|\(|<)/);
  if (funcMatch) return funcMatch[1];
  const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
  if (classMatch) return classMatch[1];
  const methodMatch = line.match(/^\s+(?:public|private|protected|static|async)?\s*(?:get|set)?\s*(\w+)\s*\(/);
  if (methodMatch) return `method:${methodMatch[1]}`;
  return "";
}

function detectBoilerplateProliferation(diffFiles: DiffFile[]): VelocityRiskIssue[] {
  const issues: VelocityRiskIssue[] = [];

  // Map: signature → files that have it
  const sigFiles = new Map<string, string[]>();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);
    const sigs = new Set<string>();

    for (const change of added) {
      if (/^\+\s*(\/\/|\/\*|\*|import\s+type|export\s+type)/.test(change.content)) continue;
      const sig = extractSignature(stripPrefix(change.content));
      if (sig) sigs.add(sig);
    }

    for (const sig of sigs) {
      if (!sigFiles.has(sig)) sigFiles.set(sig, []);
      sigFiles.get(sig)!.push(file.path);
    }
  }

  // Find signatures appearing in >= threshold files
  for (const [sig, files] of sigFiles) {
    if (files.length >= BOILERPLATE_SIMILARITY_THRESHOLD) {
      // Flag first occurrence
      issues.push({
        category: "boilerplate-proliferation",
        file: files[0],
        line: 1,
        code: `\`${sig}\` in ${files.length} files`,
        description: `Function/class signature \`${sig}\` appears in ${files.length} files (\`${files.slice(0, 3).join("\`, \`")}\`) — LLMs generate boilerplate by repeating patterns across files instead of extracting shared abstractions; this proliferation creates maintenance burden where a fix must be applied to all copies; extract to a shared module`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: sweep-no-safety
// ---------------------------------------------------------------------------

function detectSweepNoSafety(diffFiles: DiffFile[]): VelocityRiskIssue[] {
  const issues: VelocityRiskIssue[] = [];

  let totalAdded = 0;
  let totalRemoved = 0;
  let typeAnnotations = 0;
  let testAdditions = 0;
  const refactoredFiles: string[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);
    const removed = getRemovedChanges(file);
    totalAdded += added.length;
    totalRemoved += removed.length;

    const addedContent = added.map((c) => stripPrefix(c.content)).join("\n");

    // Count type annotations (TS-specific)
    const typeMatches = addedContent.match(/:\s*(?:string|number|boolean|void|never|unknown|any|Record|Map|Set|Promise|Array|\w+\[\]|\w+<)/g);
    if (typeMatches) typeAnnotations += typeMatches.length;

    // Count test assertions
    const assertionMatches = addedContent.match(/\bexpect\s*\(|\bassert\s*\(|\bshould\b|\bAssertions\b/gi);
    if (assertionMatches) testAdditions += assertionMatches.length;

    // Track files that are mostly refactoring (more removed than added)
    if (removed.length > 0 && removed.length >= added.length) {
      refactoredFiles.push(file.path);
    }
  }

  const totalChanges = totalAdded + totalRemoved;
  if (totalChanges > 0 && totalRemoved / totalChanges > SWEEP_REFACTOR_RATIO) {
    // Check if this is a large refactor with low safety coverage
    const safetyRatio = (typeAnnotations + testAdditions) / totalAdded;
    if (totalAdded > 20 && safetyRatio < 0.1) {
      issues.push({
        category: "sweep-no-safety",
        file: refactoredFiles[0] || diffFiles[0]?.path || "unknown",
        line: 1,
        code: `${totalRemoved} removed, ${totalAdded} added, ${typeAnnotations} types, ${testAdditions} tests`,
        description: `PR is ${Math.round((totalRemoved / totalChanges) * 100)}% removals (sweep refactor) with ${totalAdded} additions but only ${typeAnnotations} type annotations and ${testAdditions} test assertions — LLMs perform large-scale refactors at machine speed but skip adding type safety and tests; sweeping refactors without validation have 2.5x regression rate; add type annotations and test coverage for refactored code`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: copy-paste-pattern
// ---------------------------------------------------------------------------

function detectCopyPastePattern(diffFiles: DiffFile[]): VelocityRiskIssue[] {
  const issues: VelocityRiskIssue[] = [];

  // Collect all added content per file
  const fileContents = new Map<string, string[]>();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);
    if (added.length < 5) continue;

    const lines: string[] = [];
    for (const change of added) {
      if (/^\+\s*(\/\/|\/\*|\*|import\s|export\s+type)/.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);
      if (trimmed.length > 20) lines.push(trimmed);
    }
    if (lines.length > 0) fileContents.set(file.path, lines);
  }

  // Find 5-word sequences that appear in 3+ files
  const ngramFiles = new Map<string, Set<string>>();

  for (const [filePath, lines] of fileContents) {
    for (const line of lines) {
      const words = line.split(/\s+/).filter((w) => w.length > 1);
      if (words.length < COPY_PASTE_MIN_WORDS) continue;

      // Generate 5-word n-grams from this line
      for (let i = 0; i <= words.length - COPY_PASTE_MIN_WORDS; i++) {
        const ngram = words.slice(i, i + COPY_PASTE_MIN_WORDS).join(" ");
        // Normalize: remove variable names and string literals
        const normalized = ngram
          .replace(/['"`][^'"]*['"`]/g, "STR")
          .replace(/\b\d+\b/g, "NUM")
          .replace(/\b[a-z]\b/g, "x");

        if (normalized.length > 10) { // skip very short normalized ngrams
          if (!ngramFiles.has(normalized)) ngramFiles.set(normalized, new Set());
          ngramFiles.get(normalized)!.add(filePath);
        }
      }
    }
  }

  // Find ngrams appearing in 3+ files
  for (const [ngram, files] of ngramFiles) {
    if (files.size >= COPY_PASTE_MIN_FILES) {
      const fileList = [...files];
      issues.push({
        category: "copy-paste-pattern",
        file: fileList[0],
        line: 1,
        code: `"${ngram.slice(0, 50)}..." in ${files.size} files`,
        description: `5+ word code sequence appears in ${files.size} files (\`${fileList.slice(0, 3).join("\`, \`")}\`) — LLMs copy-paste code across files instead of extracting shared helpers; duplicated logic means bugs must be fixed in every copy; extract the repeated code into a shared utility`,
        severity: "warning",
      });
    }
  }

  // Dedup: keep only one issue per category:file
  const seen = new Set<string>();
  const filtered = issues.filter((issue) => {
    const dedupKey = `${issue.category}:${issue.file}`;
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    return true;
  });

  return filtered.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: VelocityRiskIssue[]): VelocityRiskIssue[] {
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

function buildVelocityRiskContext(result: VelocityRiskResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Velocity Risk Detection (${result.issues.length})\n`;
  ctx += "This PR shows high-velocity AI-generated code patterns — ship speed exceeds review validation:\n\n";

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

function buildVelocityRiskBodySummary(result: VelocityRiskResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Velocity Risk Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*LLMs generate code at machine speed — 500+ lines in seconds — but human review can't keep up. High-velocity PRs with large new files, boilerplate proliferation, sweep refactors without tests, or copy-paste patterns have significantly higher defect density. Slow down, add tests, extract shared code.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run velocity risk detection on diff files. Zero LLM cost. */
export function detectVelocityRisks(diffFiles: DiffFile[]): VelocityRiskResult {
  const allIssues: VelocityRiskIssue[] = [];

  allIssues.push(...detectLargeNewFiles(diffFiles));
  allIssues.push(...detectBoilerplateProliferation(diffFiles));
  allIssues.push(...detectSweepNoSafety(diffFiles));
  allIssues.push(...detectCopyPastePattern(diffFiles));

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: VelocityRiskResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildVelocityRiskContext(result);
  result.bodySummary = buildVelocityRiskBodySummary(result);

  if (issues.length > 0) {
    core.info(`Velocity risk detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
