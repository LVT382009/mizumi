import { minimatch } from "minimatch";
import { MizumiConfig } from "./config.js";

export interface DiffClassification {
  tier: "light" | "standard" | "thorough";
  reason: string;
}

/**
 * Classify diff into a review tier based on size and file sensitivity.
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

/**
 * Estimate token count from text length.
 * ~4 chars per token is a reliable heuristic for code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Context limits per provider (conservative estimates, leaving room for system prompt) */
const CONTEXT_LIMITS: Record<string, number> = {
  anthropic: 180000,
  openai: 120000,
  google: 1000000,
  openrouter: 120000,
  nvidia: 120000,
  local: 32000,
};

/**
 * Check if diff text fits within the model's context window.
 * Returns truncated text if needed, or the original if it fits.
 */
export function guardContextWindow(
  diffText: string,
  provider: string,
  systemPromptTokens: number = 2000
): { text: string; truncated: boolean; estimatedTokens: number } {
  const tokens = estimateTokens(diffText);
  const limit = CONTEXT_LIMITS[provider] || 120000;
  const available = limit - systemPromptTokens - 2000; // reserve for output

  if (tokens <= available) {
    return { text: diffText, truncated: false, estimatedTokens: tokens };
  }

  // Truncate: keep beginning (file headers + first hunks) and end (latest changes)
  const charLimit = available * 4;
  const headChars = Math.floor(charLimit * 0.7);
  const tailChars = charLimit - headChars;

  const truncated =
    diffText.slice(0, headChars) +
    "\n\n... [MIZUMI: diff truncated to fit context window] ...\n\n" +
    diffText.slice(-tailChars);

  return { text: truncated, truncated: true, estimatedTokens: estimateTokens(truncated) };
}
