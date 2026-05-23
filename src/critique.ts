/**
 * Two-pass self-critique — obra "subterfuge" pattern.
 * First pass generates review, second pass critically evaluates each finding.
 * Uses cheaper model (haiku) for critique pass.
 */
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { ReviewResponseType, ReviewResponse } from "./review.js";
import { MizumiConfig, getApiKey } from "./config.js";

const CRITIQUE_MODEL = "gpt-4.1-mini"; // Cheap model for critique pass

/**
 * Run self-critique: re-evaluate review findings with a "subterfuge" framing.
 * Returns filtered findings that pass the confidence threshold.
 */
export async function runCritique(
  review: ReviewResponseType,
  config: MizumiConfig
): Promise<ReviewResponseType> {
  if (!config.selfCritique || review.comments.length === 0) {
    return filterByConfidence(review, config.confidenceThreshold);
  }

  // Use a cheap model for critique — reframe as "external reviewer to critically evaluate"
  const apiKey = getApiKey("openai"); // Use OpenAI for critique (cheaper)
  const model = apiKey
    ? createOpenAI({ apiKey })(CRITIQUE_MODEL)
    : createAnthropic({ apiKey: getApiKey("anthropic") })("claude-haiku-4-5");

  const critiquePrompt = `An external AI reviewer made these findings about a PR:

${JSON.stringify(review.comments, null, 2)}

Critically evaluate each finding. For each one:
1. Is the issue real or could it be intentional/pre-existing?
2. Could the suggestion introduce new bugs?
3. Is the finding overly pedantic or stylistic?
4. Does the referenced line match the described issue?

Remove any finding where:
- The issue might be intentional or pre-existing
- The suggestion could introduce new bugs
- The finding is overly pedantic or stylistic
- The confidence should be below ${config.confidenceThreshold}

Return the filtered list as JSON with the same schema.`;

  try {
    const { text } = await generateText({
      model,
      prompt: critiquePrompt,
      maxOutputTokens: 4096,
    });

    const filtered = parseCritiqueOutput(text, review);
    return filterByConfidence(filtered, config.confidenceThreshold);
  } catch {
    // Critique failure is non-fatal — fall back to confidence filter only
    return filterByConfidence(review, config.confidenceThreshold);
  }
}

export function parseCritiqueOutput(text: string, original: ReviewResponseType): ReviewResponseType {
  try {
    let jsonStr = text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const parsed = JSON.parse(jsonStr);
    return ReviewResponse.parse(parsed);
  } catch {
    // If critique output can't be parsed, return original filtered by confidence
    return original;
  }
}

export function filterByConfidence(review: ReviewResponseType, threshold: number): ReviewResponseType {
  const filtered = review.comments.filter((c) => c.confidence >= threshold);
  return {
    ...review,
    comments: filtered,
    // Adjust decision if all critical/high findings were filtered
    decision: filtered.some((c) => c.severity === "critical" || c.severity === "high")
      ? review.decision
      : filtered.length > 0
        ? "comment"
        : "approve",
  };
}
