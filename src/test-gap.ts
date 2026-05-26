/**
 * Test Gap Detector — detect untested changes in PRs.
 *
 * Competitive gap: No AI code reviewer checks whether changed production
 * code has corresponding test coverage. CodeCov measures line coverage
 * after-the-fact, but Mizumi can flag DURING review: "You added 3 new
 * functions in src/auth.ts but no tests in __tests__/auth.test.ts".
 *
 * Approach: Lightweight regex-based pairing of source files to test files.
 * Convention detection: jest/vitest patterns (__tests__/, *.test.ts,
 * *.spec.ts, test/ directory). If a changed .ts/.js file has no matching
 * test file, or if the test file wasn't modified in this PR, flag it.
 *
 * Zero LLM cost, zero external deps, runs on workspace + diff content.
 */
import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestGap {
  /** Production file that changed without test coverage */
  sourceFile: string;
  /** Expected test file path (convention-based) */
  expectedTestFile: string;
  /** Whether a test file exists at all in the workspace */
  testFileExists: boolean;
  /** Whether the test file was modified in this PR */
  testFileChanged: boolean;
  /** Number of functions/classes added in the source file (heuristic) */
  newSymbolsCount: number;
  /** Why this is flagged */
  reason: "no-test-file" | "test-file-not-changed";
}

export interface TestGapResult {
  /** Test gaps found */
  gaps: TestGap[];
  /** Total production files changed */
  productionFilesChanged: number;
  /** Production files with test coverage in this PR */
  coveredFiles: number;
  /** Coverage ratio (0-1) */
  coverageRatio: number;
  /** Context string for LLM injection */
  contextText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File patterns that are NOT production code (skip test gap detection) */
const NON_PRODUCTION_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /\.d\.ts$/,
  /__tests__\//,
  /__mocks__\//,
  /\/test\//,
  /\/tests\//,
  /\/spec\//,
  /\/fixtures\//,
  /\/e2e\//,
  /\.config\.[tj]s$/,
  /\.stories\.[tj]sx?$/,
  /\/types\//,
  /\/scripts\//,
  /\/migrations\//,
  /\/seeds\//,
  /\.yml$/,
  /\.yaml$/,
  /\.json$/,
  /\.md$/,
  /\.css$/,
  /\.scss$/,
  /\.html$/,
];

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx)$/;

/** Normalize path separators to forward slashes (POSIX) for consistent output. */
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/** Check if a file path looks like production code (not a test) */
function isProductionFile(filePath: string): boolean {
  if (!SOURCE_EXTENSIONS.test(filePath)) return false;
  for (const pattern of NON_PRODUCTION_PATTERNS) {
    if (pattern.test(filePath)) return false;
  }
  return true;
}

/**
 * Infer the expected test file path for a production source file.
 * Tries common conventions:
 * 1. src/foo/bar.ts → src/foo/__tests__/bar.test.ts
 * 2. src/foo/bar.ts → src/__tests__/foo/bar.test.ts
 * 3. src/foo/bar.ts → test/foo/bar.test.ts
 * 4. src/foo/bar.ts → tests/foo/bar.test.ts
 */
export function inferTestFilePath(sourceFile: string): string {
  const dir = path.dirname(sourceFile);
  const base = path.basename(sourceFile, path.extname(sourceFile));
  const ext = path.extname(sourceFile);

  // Convention 1: co-located __tests__ directory
  const coLocated = toPosix(path.join(dir, "__tests__", `${base}.test${ext}`));
  return coLocated; // Primary convention
}

/**
 * Get all possible test file paths for a source file.
 * Returns multiple conventions to check against workspace.
 */
export function getAllTestConventions(sourceFile: string): string[] {
  const dir = path.dirname(sourceFile);
  const base = path.basename(sourceFile, path.extname(sourceFile));
  const ext = path.extname(sourceFile);

  return [
    // Co-located __tests__
    toPosix(path.join(dir, "__tests__", `${base}.test${ext}`)),
    toPosix(path.join(dir, "__tests__", `${base}.spec${ext}`)),
    // Top-level __tests__ mirroring src/
    dir.startsWith("src/")
      ? toPosix(path.join("src", "__tests__", dir.slice(4), `${base}.test${ext}`))
      : toPosix(path.join("__tests__", dir, `${base}.test${ext}`)),
    // Separate test/ directories
    dir.startsWith("src/")
      ? toPosix(path.join("test", dir.slice(4), `${base}.test${ext}`))
      : toPosix(path.join("test", dir, `${base}.test${ext}`)),
    dir.startsWith("src/")
      ? toPosix(path.join("tests", dir.slice(4), `${base}.test${ext}`))
      : toPosix(path.join("tests", dir, `${base}.test${ext}`)),
    // Sibling test file (.test.ts / .spec.ts next to the source)
    toPosix(path.join(dir, `${base}.test${ext}`)),
    toPosix(path.join(dir, `${base}.spec${ext}`)),
  ];
}

/**
 * Count heuristic new symbols (functions, classes, exports) in diff additions.
 * Lightweight regex — not a full parser.
 */
export function countNewSymbols(diffFile: DiffFile): number {
  let count = 0;
  for (const hunk of diffFile.hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "add") continue;
      const line = change.content;
      // Function declarations
      if (/export\s+(async\s+)?function\s+\w+/.test(line)) count++;
      // Class declarations
      if (/export\s+(default\s+)?class\s+\w+/.test(line)) count++;
      // Arrow function exports
      if (/export\s+(const|let)\s+\w+\s*=\s*(async\s*)?\(/.test(line)) count++;
      // Method definitions (inside classes)
      if (/^\s*(async\s+)?(public|private|protected)?\s*(static\s+)?\w+\s*\(/.test(line) && !/^\s*(if|for|while|switch|catch|return|throw)/.test(line)) {
        // Only count if it looks like a method (indented, not a keyword)
        if (/^\s{2,}/.test(line)) count++;
      }
    }
  }
  return count;
}

/**
 * Find a test file for a source file by checking workspace.
 * Returns the first matching test file path, or null.
 */
function findExistingTestFile(
  sourceFile: string,
  workspace: string
): string | null {
  const conventions = getAllTestConventions(sourceFile);
  for (const testPath of conventions) {
    const fullPath = path.join(workspace, testPath);
    if (fs.existsSync(fullPath)) return testPath;
  }
  return null;
}

/**
 * Check if any changed file in the diff is a test file for the given source.
 */
function isTestFileInDiff(sourceFile: string, changedFiles: string[]): boolean {
  const base = path.basename(sourceFile, path.extname(sourceFile));
  for (const changed of changedFiles) {
    if (!isProductionFile(changed) && changed.includes(base)) return true;
    // Also check if the __tests__ directory for this file was modified
    const dir = path.dirname(sourceFile);
    if (changed.includes("__tests__") && changed.includes(dir.split("/").pop() || "")) {
      return true;
    }
  }
  return false;
}

/**
 * Run test gap detection on the diff files.
 * @param diffFiles Files changed in this PR
 * @param workspace GitHub Actions workspace path
 */
export function runTestGapDetection(
  diffFiles: DiffFile[],
  workspace: string
): TestGapResult {
  const productionFiles = diffFiles.filter((f) => isProductionFile(f.path));
  if (productionFiles.length === 0) {
    return { gaps: [], productionFilesChanged: 0, coveredFiles: 0, coverageRatio: 1, contextText: "" };
  }

  const allChangedPaths = diffFiles.map((f) => f.path);
  const gaps: TestGap[] = [];
  let coveredFiles = 0;

  for (const file of productionFiles) {
    const existingTest = findExistingTestFile(file.path, workspace);
    const testChanged = isTestFileInDiff(file.path, allChangedPaths);
    const newSymbols = countNewSymbols(file);

    // Skip files with only trivial changes (no new symbols)
    if (newSymbols === 0) {
      coveredFiles++; // No new code to test
      continue;
    }

    if (!existingTest) {
      gaps.push({
        sourceFile: file.path,
        expectedTestFile: inferTestFilePath(file.path),
        testFileExists: false,
        testFileChanged: false,
        newSymbolsCount: newSymbols,
        reason: "no-test-file",
      });
    } else if (!testChanged) {
      gaps.push({
        sourceFile: file.path,
        expectedTestFile: existingTest,
        testFileExists: true,
        testFileChanged: false,
        newSymbolsCount: newSymbols,
        reason: "test-file-not-changed",
      });
    } else {
      coveredFiles++;
    }
  }

  const totalProd = productionFiles.length;
  const coverageRatio = totalProd > 0 ? coveredFiles / totalProd : 1;

  const result: TestGapResult = { gaps, productionFilesChanged: totalProd, coveredFiles, coverageRatio, contextText: "" };
  const contextText = buildTestGapContext(result);

  if (gaps.length > 0) {
    core.info(`Test gaps: ${gaps.length} untested change(s) (${Math.round(coverageRatio * 100)}% coverage ratio)`);
  }

  return { gaps, productionFilesChanged: totalProd, coveredFiles, coverageRatio, contextText };
}

/**
 * Build test gap context for LLM injection.
 * Tells the reviewer which files lack test coverage.
 */
export function buildTestGapContext(result: TestGapResult): string {
  if (result.gaps.length === 0) return "";

  let ctx = `## Test Gap Detection (${result.gaps.length} gap(s), ${Math.round(result.coverageRatio * 100)}% test coverage ratio)\n`;
  ctx += "The following production files were changed but lack corresponding test changes. ";
  ctx += "Consider suggesting test additions for these files:\n\n";

  for (const gap of result.gaps) {
    if (gap.reason === "no-test-file") {
      ctx += `- **${gap.sourceFile}**: No test file found (expected: \`${gap.expectedTestFile}\`). ${gap.newSymbolsCount} new symbol(s) added.\n`;
    } else {
      ctx += `- **${gap.sourceFile}**: Test file exists (\`${gap.expectedTestFile}\`) but was NOT modified in this PR. ${gap.newSymbolsCount} new symbol(s) added.\n`;
    }
  }

  return ctx.trim();
}
