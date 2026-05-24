/**
 * Shared model factory — creates AI SDK model instances for all 7 providers.
 * Used by review.ts, agent.ts, critique.ts, calibrate.ts, etc.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { MizumiConfig, requireApiKey } from "./config.js";

/** Create an AI SDK model instance from config */
export function createModel(config: MizumiConfig) {
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
      return createOpenAI({
        baseURL: config.baseUrl || process.env.MIZUMI_BASE_URL || "http://localhost:11434/v1",
        apiKey,
        name: "local",
      }).chat(config.model);
    case "custom": {
      const customBase = config.baseUrl || process.env.CUSTOM_BASE_URL;
      if (!customBase) {
        throw new Error("Custom provider requires base_url input or CUSTOM_BASE_URL env var");
      }
      return createOpenAI({
        baseURL: customBase,
        apiKey,
        name: "custom",
      }).chat(config.model);
    }
    case "nvidia":
      return createOpenAI({
        baseURL: "https://integrate.api.nvidia.com/v1",
        apiKey,
        name: "nvidia",
      }).chat(config.model);
  }
}

/** Create a lightweight/cheap model for agent context + critique */
export function createLightModel(config: MizumiConfig) {
  if (config.provider === "anthropic") {
    return createAnthropic({ apiKey: requireApiKey("anthropic") })("claude-haiku-4-5-20251001");
  }
  // For all OpenAI-compatible providers, use the configured model
  // (cheaper model selection is the user's responsibility via config)
  return createModel(config);
}
