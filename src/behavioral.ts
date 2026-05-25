/**
 * Behavioral diff summary — competitive gap #6.
 *
 * Unlike file-oriented walkthroughs (which list directories and finding counts),
 * a behavioral summary describes WHAT THE CODE DOES differently:
 * "Adds OAuth2 PKCE flow, replaces session auth with token auth, removes legacy cookie path."
 *
 * No current AI reviewer does this — CodeRabbit anchors on file groups,
 * Copilot generates flat prose, CodeGuru has no summary at all.
 *
 * Implementation: lightweight LLM call with structured output, ~100ms per review.
 * Only runs for non-trivial diffs (3+ files or 100+ lines changed).
 */
import { generateObject } from "ai";
import { z } from "zod";
import { MizumiConfig } from "./config.js";
import { createModel } from "./models.js";
import { sanitizeInput } from "./sanitize.js";
import { DiffFile } from "./diff.js";

const BehavioralChange = z.object({
  type: z.enum(["added", "removed", "replaced", "modified", "refactored"]).describe(
    "Type of behavioral change: added=new capability, removed=deleted capability, replaced=swap old→new, modified=existing behavior changed, refactored=same behavior different implementation"
  ),
  area: z.string().describe("Functional area affected (e.g., 'authentication', 'error handling', 'data export')"),
  description: z.string().describe("What the system now does differently, in plain language"),
  impact: z.enum(["high", "medium", "low"]).describe("How much this changes system behavior"),
  files: z.array(z.string()).describe("Files involved in this change"),
});

const BehavioralSummarySchema = z.object({
  headline: z.string().describe("One-sentence behavioral headline: 'This PR [does X] by [doing Y]'"),
  changes: z.array(BehavioralChange).describe("Behavioral changes ordered by impact (high first)"),
  riskAreas: z.array(z.string()).describe("Areas most likely to contain regressions from these behavioral changes"),
  testingFocus: z.string().describe("What a reviewer should focus on when testing these behavioral changes"),
});

export type BehavioralChangeType = z.infer<typeof BehavioralChange>;
export type BehavioralSummaryType = z.infer<typeof BehavioralSummarySchema>;

export async function generateBehavioralSummary(
  diffText: string,
  diffFiles: DiffFile[],
  config: MizumiConfig,
): Promise<BehavioralSummaryType> {
  const model = createModel(config);
  const safeDiff = sanitizeInput(diffText.slice(0, 40000));
  const fileSummary = diffFiles
    .map((f) => `${f.path}: +${f.additions}/-${f.deletions} (${f.status})`)
    .join("\n");

  const { object: output } = await generateObject({
    model,
    system: `You are a senior engineer writing a behavioral diff summary. Focus on WHAT THE SYSTEM DOES differently, not which files changed. Group related file changes into behavioral operations. Think in terms of system capabilities, not code locations.

Rules:
- Use plain language a non-engineer could understand
- Group cross-file changes into single behavioral operations
- Never list files or directories as the primary description
- "replaced" means an old behavior was swapped for a new one (most interesting)
- "added" means an entirely new capability
- "removed" means a capability was deleted
- "modified" means an existing behavior changed in place
- "refactored" means same behavior, different implementation`,
    prompt: `Analyze this diff and describe the behavioral changes — what the system DOES differently now.

File summary:
${fileSummary}

Diff:
${safeDiff}

Output a behavioral summary with 1-5 behavioral changes, ordered by impact.`,
    schema: BehavioralSummarySchema,
    maxOutputTokens: 1536,
  });

  return output as BehavioralSummaryType;
}

/** Format the behavioral summary as Markdown for the review body */
export function formatBehavioralSummary(summary: BehavioralSummaryType): string {
  let body = `<details><summary><strong>Behavioral Summary</strong> — ${summary.headline}</summary>\n\n`;

  for (const change of summary.changes) {
    const emoji = change.type === "added" ? "🟢" : change.type === "removed" ? "🔴" : change.type === "replaced" ? "🟡" : "⚪";
    const impactBadge = change.impact === "high" ? "⚠️" : change.impact === "medium" ? "📋" : "✏️";
    const label = change.type.charAt(0).toUpperCase() + change.type.slice(1);
    body += `${emoji} **${label}** ${impactBadge} *${change.area}*\n`;
    body += `> ${change.description}\n`;
    body += `\n<sup>${change.files.map((f) => `\`${f}\``).join(", ")}</sup>\n\n`;
  }

  if (summary.riskAreas.length > 0) {
    body += `**Risk Areas:** ${summary.riskAreas.join(", ")}\n\n`;
  }

  body += `**Testing Focus:** ${summary.testingFocus}\n`;
  body += `\n</details>\n`;

  return body;
}

/** Check if a diff is substantial enough to warrant behavioral analysis */
export function shouldRunBehavioralAnalysis(diffFiles: DiffFile[]): boolean {
  if (diffFiles.length < 3) return false;
  const totalLines = diffFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  return totalLines >= 50;
}
