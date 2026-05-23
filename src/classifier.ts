/**
 * Heuristic PR classifier — categorizes a diff by file patterns and change stats.
 * Zero LLM calls. Used to adjust review focus before the full review pass.
 */

export type PRCategory = "cosmetic" | "docs" | "logic" | "security" | "config" | "tests";

export interface ClassificationResult {
  category: PRCategory;
  confidence: number; // 0-100 heuristic
  reason: string;
}

export interface ClassifiedFile {
  from: string;
  additions: number;
  deletions: number;
}

const DOCS_RE = /^(\.md|\.txt|\.rst|docs\/)/i;
const DOCS_EXT_RE = /\.(md|txt|rst)$/i;
const TEST_FILE_RE = /(\.(test|spec)\.|^[\\/](test|tests|__tests__)[\\/])/i;
const TEST_PATH_RE = /^(test|tests|__tests__)[\\/]/i;
const CONFIG_RE = /\.(ya?ml|json)$/i;
const CONFIG_PATH_RE = /^(\.[^/]*|\.github[\\/]|Dockerfile)/i;
const SECURITY_RE = /(auth|crypto|sql|secret|password|permission|token)/i;
const COSMETIC_RE = /\.(css|scss|html|svg|png|jpg|gif|webp|ico)$/i;

export function classifyPR(
  changedFiles: ClassifiedFile[],
  totalAdditions: number,
  totalDeletions: number,
  _prTitle?: string,
  _prBody?: string,
): ClassificationResult {
  if (changedFiles.length === 0) {
    return { category: "logic", confidence: 30, reason: "no files to classify" };
  }

  const paths = changedFiles.map((f) => f.from);

  // docs: ALL files are documentation
  if (paths.every((p) => DOCS_EXT_RE.test(p) || DOCS_RE.test(p))) {
    return { category: "docs", confidence: 95, reason: "all files are documentation" };
  }

  // tests: ONLY additions and only in test files
  const allAdditions = changedFiles.every((f) => f.deletions === 0);
  const allTestFiles = paths.every((p) => TEST_FILE_RE.test(p) || TEST_PATH_RE.test(p));
  if (allAdditions && allTestFiles) {
    return { category: "tests", confidence: 90, reason: "only additions in test files" };
  }

  // config: ALL files match config patterns
  if (paths.every((p) => CONFIG_RE.test(p) || CONFIG_PATH_RE.test(p))) {
    return { category: "config", confidence: 90, reason: "all files are configuration" };
  }

  // security: ANY file touches security-sensitive areas
  const securityFile = paths.find((p) => SECURITY_RE.test(p));
  if (securityFile) {
    return {
      category: "security",
      confidence: 75,
      reason: `security-sensitive file: ${securityFile}`,
    };
  }

  // cosmetic: high add/del ratio in style/image files
  const allCosmetic = paths.every((p) => COSMETIC_RE.test(p));
  if (
    allCosmetic &&
    totalDeletions > 0 &&
    totalAdditions / totalDeletions > 5
  ) {
    return { category: "cosmetic", confidence: 80, reason: "high add/rm ratio in style/image files" };
  }

  return { category: "logic", confidence: 60, reason: "general code changes" };
}
