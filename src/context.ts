/**
 * Build review context — diff + file contents + MEMORY.md + rules + ghost + description quality.
 * Assembles everything the LLM needs for a thorough review.
 */
import { Octokit } from "@octokit/rest";
import { DiffFile, ParsedDiff } from "./diff.js";
import { readMemory, readRules, ghostWarnings, buildLearningPrompt } from "./memory.js";
import { stripPatchPII } from "./diff.js";
import { ClassificationResult } from "./classifier.js";
import { scorePRDescription, formatDescriptionFeedback } from "./description.js";
import stripAnsi from "strip-ansi";

export interface ReviewContext {
  diffText: string;
  files: DiffFile[];
  memoryContent: string;
  rulesContent: string;
  ghostContent: string;
  learningContent: string;
  descriptionFeedback: string;
  prTitle: string;
  prDescription: string;
  changedFiles: string[];
  classification?: ClassificationResult;
}

/**
 * Build the full review context for the LLM.
 */
export interface LearningData {
  learningWeights: Record<string, "demote" | "promote" | "neutral">;
  acceptanceRates: Record<string, { helpful: number; unhelpful: number; rate: number }>;
}

export async function buildContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  diff: ParsedDiff,
  workspace: string,
  classification?: ClassificationResult,
  learning?: LearningData,
): Promise<ReviewContext> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });

  // Build diff text (PII-stripped, ANSI-cleaned)
  let diffText = "";
  for (const file of diff.files) {
    diffText += `\n--- ${file.path} (${file.status}, +${file.additions}/-${file.deletions}) ---\n`;
    for (const hunk of file.hunks) {
      diffText += hunk.content + "\n";
      for (const change of hunk.changes) {
        const prefix = change.type === "add" ? "+" : change.type === "delete" ? "-" : " ";
        diffText += `${prefix}${change.content}\n`;
      }
    }
  }

  diffText = stripPatchPII(stripAnsi(diffText));

  if (classification) {
    diffText += `\n\n## PR Classification\nThis PR appears to be primarily about: ${classification.category} (${classification.reason})\nAdjust review focus accordingly.`;
  }

  // Read memory + rules
  const memoryContent = readMemory(workspace);
  const rulesContent = readRules(workspace);
  const learningContent = buildLearningPrompt(
    learning?.learningWeights ?? {},
    learning?.acceptanceRates ?? {},
  );

  // Review Ghost
  const changedFiles = diff.files.map((f: DiffFile) => f.path);
  const warnings = ghostWarnings(memoryContent, changedFiles);
  let ghostContent = "";
  if (warnings.length > 0) {
    ghostContent = `## Past Issues in These Files (Review Ghost)\nThe following issues were found in previous reviews of these files:\n${warnings.map((w) => `- ${w}`).join("\n")}\nPay extra attention to whether these issues have reappeared.`;
  }

  // PR description quality feedback
  const descQuality = scorePRDescription(pr.title || "", pr.body || "");
  const descriptionFeedback = formatDescriptionFeedback(descQuality);

  return {
    diffText,
    files: diff.files,
    memoryContent,
    rulesContent,
    ghostContent,
    learningContent,
    descriptionFeedback,
    prTitle: pr.title || "",
    prDescription: pr.body || "",
    changedFiles,
    classification,
  };
}
