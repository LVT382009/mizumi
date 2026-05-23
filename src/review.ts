/**
 * LLM review — structured output via Vercel AI SDK 6.
 * BYOK from day 1: any provider, same code path.
 */
import { generateText, Output } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { MizumiConfig, requireApiKey } from "./config.js";
import { DiffClassification } from "./router.js";
import { wrapDiff } from "./sanitize.js";

export const ReviewComment = z.object({
  file: z.string().describe("File path relative to repo root"),
  line: z.number().describe("Line number in the new version of the file"),
  endLine: z.number().optional().describe("End line for multi-line findings"),
  severity: z.enum(["critical", "high", "medium", "low", "nitpick"]),
  category: z.enum(["bug", "security", "performance", "style", "architecture", "compliance"]),
  message: z.string().describe("Clear explanation of the issue"),
  suggestion: z.string().optional().describe("Code fix suggestion if applicable"),
  confidence: z.number().min(0).max(100).describe("Confidence score 0-100"),
});

export const ReviewResponse = z.object({
  summary: z.string().describe("Overall PR summary and verdict"),
  riskScore: z.number().min(1).max(5).describe("Risk score 1 (safe) to 5 (dangerous)"),
  comments: z.array(ReviewComment).describe("Review findings"),
  decision: z.enum(["approve", "comment", "request_changes"]),
});

export type ReviewCommentType = z.infer<typeof ReviewComment>;
export type ReviewResponseType = z.infer<typeof ReviewResponse>;

function createModel(config: MizumiConfig) {
  const apiKey = requireApiKey(config.provider);

  switch (config.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(config.model);
    case "openai":
      return createOpenAI({ apiKey })(config.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(config.model);
    case "openrouter":
      return createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        name: "openrouter",
      }).chat(config.model);
    case "local":
      // Defaults to Ollama (11434). Override base_url for llama.cpp (8081) or LM Studio (1234)
      return createOpenAI({
        baseURL: config.baseUrl || process.env.MIZUMI_BASE_URL || "http://localhost:11434/v1",
        apiKey,
        name: "local",
      }).chat(config.model);
    case "custom":
      return createOpenAI({
        baseURL: config.baseUrl || process.env.CUSTOM_BASE_URL || "",
        apiKey,
        name: "custom",
      }).chat(config.model);
    case "nvidia":
      return createOpenAI({
        baseURL: "https://integrate.api.nvidia.com/v1",
        apiKey,
        name: "nvidia",
      }).chat(config.model);
  }
}

/**
 * Select model based on diff classification tier.
 * Light tier → cheaper model (haiku for anthropic), else configured model.
 */
export function selectModel(config: MizumiConfig, classification: DiffClassification): ReturnType<typeof createModel> {
  if (classification.tier === "light" && config.provider === "anthropic") {
    return createAnthropic({ apiKey: requireApiKey("anthropic") })("claude-haiku-4-5-20251001");
  }
  return createModel(config);
}

function getProfileInstructions(profile: MizumiConfig["profile"]): string {
  switch (profile) {
    case "chill":
      return `Focus ONLY on: bugs, security vulnerabilities, logic errors, and performance issues.
Do NOT comment on: style, naming, documentation, formatting, or preferences.
Be conservative — only flag issues you are confident about.`;
    case "assertive":
      return `Review for: bugs, security, performance, logic errors, AND style/naming/documentation.
Be thorough but fair. Distinguish between real issues and preferences.`;
    case "followup":
      return `Review for all issues AND check if previous review comments have been addressed.
Cross-reference with any prior bot comments on this PR.`;
  }
}

function buildSystemPrompt(validPositions: string, config: MizumiConfig): string {
  return `You are Mizumi, a self-learning PR review agent. Your job is to find real issues in code changes.

## Review Rules
${getProfileInstructions(config.profile)}

## Output Format
You MUST respond with structured JSON matching the schema:
- summary: overall assessment
- riskScore: 1-5 (1=safe docs, 5=security critical changes)
- comments: array of findings, each with file, line, severity, category, message, suggestion, confidence
- decision: "approve" (no issues), "comment" (minor issues), "request_changes" (critical issues)

## Line Number Rules (CRITICAL)
You can ONLY comment on lines that appear in the diff. Valid comment positions:
${validPositions}

If a finding doesn't map to a valid diff line, set line to the nearest valid line or omit it entirely.
NEVER make up line numbers — only use lines from the valid positions list.

## Severity Guidelines
- critical: security vulnerabilities, data loss, auth bypass
- high: bugs that will cause incorrect behavior, race conditions
- medium: performance issues, missing error handling
- low: code smells, minor improvements
- nitpick: style preferences, naming suggestions

## What Makes a Good Review
- Focus on what's WRONG, not what's different
- Every finding must be actionable — "this is wrong because X, fix by doing Y"
- Show diagnosis first, collapse fix suggestions
- Never approve your own PR — this is a review, not a rubber stamp
- If the diff looks fine, return empty comments and "approve" decision

## Automation Bias Mitigation
- Report findings as observations, not commands
- Use "Consider..." language, not "You must..."
- If uncertain, set confidence below 80 and it will be filtered
- Never say "always" or "never" — allow for context you might not see`;
}

export async function runReview(
  diffContent: string,
  validPositions: string,
  memoryContent: string,
  rulesContent: string,
  ghostContent: string,
  config: MizumiConfig,
  classification?: DiffClassification
): Promise<{ output: ReviewResponseType; usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }> {
  const model = classification ? selectModel(config, classification) : createModel(config);
  const systemPrompt = buildSystemPrompt(validPositions, config);

  let userPrompt = wrapDiff(diffContent);

  if (memoryContent) {
    userPrompt += `\n\n## Project Memory (past review patterns for this repo)\n${memoryContent}`;
  }

  if (rulesContent) {
    userPrompt += `\n\n## Project Rules (coding standards)\n${rulesContent}`;
  }

  if (ghostContent) {
    userPrompt += `\n\n${ghostContent}`;
  }

  // Build user message — Anthropic gets prompt caching via providerOptions
  const anthropicCacheOptions = config.provider === "anthropic"
    ? { anthropic: { cacheControl: { type: "ephemeral" as const } } }
    : undefined;

  const userMessage = anthropicCacheOptions
    ? {
        role: "user" as const,
        content: [{ type: "text" as const, text: userPrompt }],
        providerOptions: anthropicCacheOptions,
      }
    : { role: "user" as const, content: userPrompt };

  const { output, usage } = await generateText({
    model,
    system: systemPrompt,
    messages: [userMessage],
    output: Output.object({ schema: ReviewResponse }),
    maxOutputTokens: 4096,
  });

  return { output, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0 } };
}
