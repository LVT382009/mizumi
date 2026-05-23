/**
 * PR description quality check — score on completeness.
 * Encourages: why explanation, linked issues, test plan, breaking change notes.
 */

export interface DescriptionQuality {
  score: number; // 0-4
  missing: string[];
}

export function scorePRDescription(title: string, body: string): DescriptionQuality {
  if (!body && !title) {
    return { score: 0, missing: ["PR description", "explanation of why", "linked issues", "test plan"] };
  }

  const text = `${title} ${body}`.toLowerCase();
  const missing: string[] = [];

  // Check for "why" explanation — look for causal language
  const hasWhy = /\b(because|since|reason|why|motivat|purpose|goal|fix|resolv|address)\b/.test(text)
    || body.length > 100; // Long descriptions likely explain why
  if (!hasWhy) missing.push("explanation of why this change is needed");

  // Check for linked issues (#123, closes #, fixes #, relates #)
  const hasLinkedIssue = /(?:closes?|fixes?|resolves?|addresses?|relates?|refs?|see)\s+#\d+|#\d+/.test(text);
  if (!hasLinkedIssue) missing.push("linked issue or ticket reference");

  // Check for test plan
  const hasTestPlan = /\b(test\s*plan|how\s+to\s+test|test\s+steps|verified|testing)\b/i.test(text);
  if (!hasTestPlan) missing.push("test plan or verification steps");

  // Check for breaking change notes
  const hasBreakingNote = /\b(breaking\s+change|breaking\s+api|incompatible|migration|upgrade\s+guide|deprecat)\b/i.test(text);
  // Only flag if the diff seems significant (large changes without breaking notes)
  // We don't have diff size here, so just note it as optional
  if (!hasBreakingNote && body.length > 0) {
    missing.push("breaking change notes (if applicable)");
  }

  const score = 4 - missing.length;
  return { score: Math.max(0, score), missing };
}

/**
 * Format description quality as prompt context for the LLM.
 */
export function formatDescriptionFeedback(quality: DescriptionQuality): string {
  if (quality.score >= 3) return ""; // Good enough, don't clutter

  return `## PR Description Quality (${quality.score}/4)\nThis PR description is missing:\n${quality.missing.map((m) => `- ${m}`).join("\n")}\nConsider suggesting the author improve the PR description.`;
}
