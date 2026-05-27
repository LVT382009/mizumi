/**
 * Confidence calibration — dual-model voting on borderline findings.
 * Phase 2.19: If both models agree → High confidence. If only one flags → Low.
 * Visual badges: High=green, Medium=yellow, Low=gray.
 *
 * With pipelineParallel enabled, borderline findings are verified
 * concurrently (bounded concurrency=3) instead of sequentially —
 * reducing calibration time by up to 3x.
 */
import * as core from "@actions/core";
import { generateObject } from "ai";
import { z } from "zod";
import { ReviewCommentType, ReviewResponseType } from "./review.js";
import { MizumiConfig, getApiKey, Provider } from "./config.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { mapConcurrent } from "./pipeline-parallel.js";

const BORDERLINE_MIN = 60;
const BORDERLINE_MAX = 80;

const VerificationSchema = z.object({
  confirmed: z.enum(["yes", "no"]).describe("Is this issue real and actionable?"),
});

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
    return [
      ...result,
      ...borderline.map((c) => ({
        ...c,
        calibratedConfidence: "medium" as const,
      })),
    ];
  }

  // Use mapConcurrent for parallel verification when pipelineParallel is on
  const concurrency = config.pipelineParallel ? 3 : 1;
  const calibrated = await mapConcurrent(
    borderline,
    async (finding) => {
      try {
        const { object } = await generateObject({
          model: secondModel,
          prompt: `You are verifying a code review finding. Is this a real issue?

File: ${finding.file}, Line: ${finding.line}
Severity: ${finding.severity}, Category: ${finding.category}
Message: ${finding.message}
${finding.suggestion ? `Suggested fix: ${finding.suggestion}` : ""}

Is this issue real and actionable?`,
          schema: VerificationSchema,
          maxOutputTokens: 32,
        });

        const isConfirmed = object.confirmed === "yes";
        return {
          ...finding,
          calibratedConfidence: isConfirmed ? "high" as const : "low" as const,
          confidence: isConfirmed ? Math.min(finding.confidence + 15, 100) : Math.max(finding.confidence - 20, 0),
        };
      } catch (e) {
        core.warning(`Calibration failed for ${finding.file}:${finding.line}: ${e instanceof Error ? e.message : String(e)}`);
        return { ...finding, calibratedConfidence: "medium" as const };
      }
    },
    concurrency,
  );
  result.push(...calibrated);

  const highCount = result.filter((c) => c.calibratedConfidence === "high").length;
  const lowCount = result.filter((c) => c.calibratedConfidence === "low").length;
  core.info(`Confidence calibration: ${highCount} high, ${result.length - highCount - lowCount} medium, ${lowCount} low`);

  return result;
}

/** Provider fallback order for calibration cross-check */
const CALIBRATION_FALLBACKS: { provider: Provider; model: string; minApiKeyName: string }[] = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", minApiKeyName: "anthropic" },
  { provider: "openai", model: "gpt-4.1-mini", minApiKeyName: "openai" },
  { provider: "google", model: "gemini-2.5-flash", minApiKeyName: "google" },
];

/**
 * Get a second model for confidence calibration.
 * Tries a different provider than the main review model for cross-validation.
 */
function getSecondModel(config: MizumiConfig) {
  for (const fallback of CALIBRATION_FALLBACKS) {
    const key = getApiKey(fallback.provider);
    if (!key) continue;

    if (fallback.provider !== config.provider) {
      if (fallback.provider === "anthropic") return createAnthropic({ apiKey: key })(fallback.model);
      if (fallback.provider === "openai") return createOpenAI({ apiKey: key })(fallback.model);
      if (fallback.provider === "google") {
        const { createGoogleGenerativeAI } = require("@ai-sdk/google") as typeof import("@ai-sdk/google");
        return createGoogleGenerativeAI({ apiKey: key })(fallback.model);
      }
    }
  }

  // Same-provider fallback (different model)
  for (const fallback of CALIBRATION_FALLBACKS) {
    if (fallback.provider === config.provider) {
      const key = getApiKey(fallback.provider);
      if (!key) continue;
      if (fallback.provider === "anthropic") return createAnthropic({ apiKey: key })(fallback.model);
      if (fallback.provider === "openai") return createOpenAI({ apiKey: key })(fallback.model);
    }
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
