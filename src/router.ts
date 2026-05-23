import { minimatch } from "minimatch";
import { MizumiConfig } from "./config.js";

export interface DiffClassification {
  tier: "light" | "standard" | "thorough";
  reason: string;
}

/**
 * Classify diff into a review tier based on size and file sensitivity.
 * - thorough: security-sensitive files always get full review
 * - light: small diffs use a cheaper/faster model
 * - standard: everything else uses the configured model
 */
export function classifyDiff(
  totalLines: number,
  fileCount: number,
  changedFiles: string[],
  config: MizumiConfig
): DiffClassification {
  if (!config.tierRouting) {
    return { tier: "standard", reason: "tier routing disabled" };
  }

  if (matchesSecurityPath(changedFiles, config.securityPaths)) {
    return { tier: "thorough", reason: "security-sensitive files detected" };
  }

  if (totalLines < config.smallDiffThreshold && fileCount < 3) {
    return { tier: "light", reason: `small diff (${totalLines} lines, ${fileCount} files)` };
  }

  return { tier: "standard", reason: "normal diff" };
}

function matchesSecurityPath(files: string[], patterns: string[]): boolean {
  return files.some((f) => patterns.some((p) => minimatch(f, p)));
}
