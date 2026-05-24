/**
 * Confidence calibration — dual-model voting on borderline findings.
 * Phase 2.19: If both models agree → High confidence. If only one flags → Low.
 * Visual badges: High=green, Medium=yellow, Low=gray.
 *
 * Uses AI SDK generateText with a lightweight verification prompt.
 */
import * as core from "@actions/core";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { ReviewCommentType, ReviewResponseType } from "./review.js";
import { MizumiConfig, getApiKey } from "./config.js";

const BORDERLINE_MIN = 60;
const BORDERLINE_MAX = 80;

export interface CalibratedComment extends ReviewCommentType {
  calibratedConfidence: "high" | "medium" | "low";
}

/**
 * Calibrate confidence on borderline findings using a second model vote.
 * Findings with confidence 60-80 are re-evaluated by a different model.
 * If the second model agrees → boost to "high" confidence.
 * If the second model disagrees → lower to "low" confidence.
 * Non-borderline findings keep their original confidence level.
 */
export async function calibrateConfidence(
  review: ReviewResponseType,
  config: MizumiConfig
): Promise<CalibratedComment[]> {
  const borderline = review.comments.filter(
    (c) => c.confidence >= BORDERLINE_MIN && c.confidence <= BORDERLINE_MAX
  );
  const nonBorderline = review.comments.filter(
    (c) => c.confidence < BORDERLINE_MIN || c.confidence > BORDERLINE_MAX
  );

  // Map non-borderline findings directly
  const result: CalibratedComment[] = nonBorderline.map((c) => ({
    ...c,
    calibratedConfidence: c.confidence > 80 ? "high" : c.confidence > 50 ? "medium" : "low",
  }));

  if (borderline.length === 0) return result;

  // Get a second model for verification
  const secondModel = getSecondModel(config);
  if (!secondModel) {
    // No second model available — keep original confidence with medium badge
    return [
      ...result,
      ...borderline.map((c) => ({
        ...c,
        calibratedConfidence: "medium" as const,
      })),
    ];
  }

  // Verify borderline findings one by one (or batch if few)
  for (const finding of borderline) {
    try {
      const { text } = await generateText({
        model: secondModel,
        prompt: `You are verifying a code review finding. Is this a real issue?

File: ${finding.file}, Line: ${finding.line}
Severity: ${finding.severity}, Category: ${finding.category}
Message: ${finding.message}
${finding.suggestion ? `Suggested fix: ${finding.suggestion}` : ""}

Is this issue real and actionable? Answer ONLY "yes" or "no".`,
        maxOutputTokens: 10,
      });

      const isConfirmed = text.trim().toLowerCase().startsWith("yes");
      result.push({
        ...finding,
        calibratedConfidence: isConfirmed ? "high" : "low",
        confidence: isConfirmed ? Math.min(finding.confidence + 15, 100) : Math.max(finding.confidence - 20, 0),
      });
    } catch (e) {
      core.warning(`Calibration failed for ${finding.file}:${finding.line}: ${e instanceof Error ? e.message : String(e)}`);
      result.push({ ...finding, calibratedConfidence: "medium" });
    }
  }

  const highCount = result.filter((c) => c.calibratedConfidence === "high").length;
  const lowCount = result.filter((c) => c.calibratedConfidence === "low").length;
  core.info(`Confidence calibration: ${highCount} high, ${result.length - highCount - lowCount} medium, ${lowCount} low`);

  return result;
}

/**
 * Get a second model for confidence calibration.
 * Tries a different provider than the main review model.
 */
function getSecondModel(config: MizumiConfig) {
  // Try Anthropic if main was OpenAI, and vice versa
  const anthropicKey = getApiKey("anthropic");
  const openaiKey = getApiKey("openai");

  if (config.provider !== "anthropic" && anthropicKey) {
    return createAnthropic({ apiKey: anthropicKey })("claude-haiku-4-5-20251001");
  }
  if (config.provider !== "openai" && openaiKey) {
    return createOpenAI({ apiKey: openaiKey })("gpt-4.1-mini");
  }
  // If only one provider available, use a different model on the same provider
  if (config.provider === "anthropic" && anthropicKey) {
    return createAnthropic({ apiKey: anthropicKey })("claude-haiku-4-5-20251001");
  }
  if (config.provider === "openai" && openaiKey) {
    return createOpenAI({ apiKey: openaiKey })("gpt-4.1-mini");
  }

  return null;
}

/**
 * Format confidence badge for a finding.
 * High=green, Medium=yellow, Low=gray.
 */
export function confidenceBadge(level: "high" | "medium" | "low"): string {
  switch (level) {
    case "high": return "![High](https://img.shields.io/badge/confidence-high-green)";
    case "medium": return "![Medium](https://img.shields.io/badge/confidence-medium-yellow)";
    case "low": return "![Low](https://img.shields.io/badge/confidence-low-lightgray)";
  }
}
