/**
 * Two-pass self-critique — obra "subterfuge" pattern.
 * First pass generates review, second pass critically evaluates each finding.
 * Uses cheaper model (haiku) for critique pass.
 */
import * as core from "@actions/core";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { ReviewResponseType, ReviewResponse } from "./review.js";
import { MizumiConfig, getApiKey } from "./config.js";

const CRITIQUE_MODEL = "gpt-4.1-mini";

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

  const openaiKey = getApiKey("openai");
  const anthropicKey = getApiKey("anthropic");
  let model;
  if (openaiKey) {
    model = createOpenAI({ apiKey: openaiKey })(CRITIQUE_MODEL);
  } else if (anthropicKey) {
    model = createAnthropic({ apiKey: anthropicKey })("claude-haiku-4-5");
  } else {
    const configKey = getApiKey(config.provider);
    if (!configKey && config.provider !== "local" && config.provider !== "custom") {
      core.warning("No API key available for critique — skipping self-critique");
      return filterByConfidence(review, config.confidenceThreshold);
    }
    switch (config.provider) {
      case "anthropic": model = createAnthropic({ apiKey: configKey })(config.model); break;
      case "openai": model = createOpenAI({ apiKey: configKey })(config.model); break;
      case "google": {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        model = createGoogleGenerativeAI({ apiKey: configKey })(config.model); break;
      }
      default: {
        model = createOpenAI({
          baseURL: config.baseUrl || (config.provider === "local" ? "http://localhost:11434/v1" : ""),
          apiKey: configKey || "dummy",
          name: config.provider,
        }).chat(config.model); break;
      }
    }
  }

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

Return the filtered list with the same schema.`;

  try {
    const { object } = await generateObject({
      model,
      prompt: critiquePrompt,
      schema: ReviewResponse,
      maxOutputTokens: 4096,
    });

    return filterByConfidence(object, config.confidenceThreshold);
  } catch (e) {
    core.warning(`Critique LLM call failed: ${e instanceof Error ? e.message : String(e)} — falling back to confidence filter`);
    return filterByConfidence(review, config.confidenceThreshold);
  }
}

/** @deprecated Kept for test compatibility — generateObject replaces manual JSON parsing */
export function parseCritiqueOutput(text: string, original: ReviewResponseType): ReviewResponseType {
  try {
    let jsonStr = text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const parsed = JSON.parse(jsonStr);
    return ReviewResponse.parse(parsed);
  } catch {
    return original;
  }
}

export function filterByConfidence(review: ReviewResponseType, threshold: number): ReviewResponseType {
  const filtered = review.comments.filter((c) => c.confidence >= threshold);
  return {
    ...review,
    comments: filtered,
    decision: filtered.some((c) => c.severity === "critical" || c.severity === "high")
      ? review.decision
      : filtered.length > 0
        ? "comment"
        : "approve",
  };
}
