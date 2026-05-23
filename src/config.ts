import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

export type Profile = "chill" | "assertive" | "followup";
export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "nvidia" | "local";

export interface MizumiConfig {
  provider: Provider;
  model: string;
  baseUrl: string;
  profile: Profile;
  maxComments: number;
  language: string;
  selfCritique: boolean;
  confidenceThreshold: number;
  autoReview: boolean;
  excludePatterns: string[];
}

const DEFAULT_EXCLUDE = [
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.min.js",
  "*.min.css",
  "dist/**",
  "vendor/**",
  "node_modules/**",
];

export function loadConfig(): MizumiConfig {
  const provider = (core.getInput("provider") || "anthropic") as Provider;
  const model = core.getInput("model") || "claude-sonnet-4-6";
  const baseUrl = core.getInput("base_url") || "";
  const profile = (core.getInput("profile") || "chill") as Profile;
  const maxComments = parseInt(core.getInput("max_comments") || "15", 10);
  const language = core.getInput("language") || "en-US";
  const selfCritique = core.getInput("self_critique") !== "false";
  const confidenceThreshold = parseInt(core.getInput("confidence_threshold") || "80", 10);
  const autoReview = core.getInput("auto_review") !== "false";

  const configPath = path.join(process.env.GITHUB_WORKSPACE || ".", ".github", "mizumi.yml");
  let excludePatterns = [...DEFAULT_EXCLUDE];
  let repoModel = model;
  let repoProfile = profile;
  let repoMaxComments = maxComments;
  let repoConfidence = confidenceThreshold;

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = parseSimpleYaml(raw);
      const llm = parsed.llm as Record<string, unknown> | undefined;
      const review = parsed.review as Record<string, unknown> | undefined;
      if (llm?.model) repoModel = String(llm.model);
      if (review?.profile) repoProfile = String(review.profile) as Profile;
      if (review?.max_comments) repoMaxComments = Number(review.max_comments);
      if (review?.confidence_threshold) repoConfidence = Number(review.confidence_threshold);
      if (Array.isArray(parsed.exclude)) excludePatterns = [...DEFAULT_EXCLUDE, ...parsed.exclude.map(String)];
    } catch {
      core.warning("Failed to parse .github/mizumi.yml, using defaults");
    }
  }

  return {
    provider,
    model: repoModel,
    baseUrl,
    profile: repoProfile,
    maxComments: repoMaxComments,
    language,
    selfCritique,
    confidenceThreshold: repoConfidence,
    autoReview,
    excludePatterns,
  };
}

/**
 * Minimal YAML parser for simple key:value + nested blocks.
 * Not a full YAML parser — sufficient for mizumi.yml structure.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
    { obj: result, indent: -1 },
  ];

  let currentKey = "";

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack on dedent
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const current = stack[stack.length - 1].obj;

    // Array item
    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
      if (currentKey && !Array.isArray(current[currentKey])) {
        current[currentKey] = [];
      }
      if (Array.isArray(current[currentKey])) {
        (current[currentKey] as string[]).push(item);
      }
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    currentKey = key;

    if (value === "") {
      // Nested block
      const nested: Record<string, unknown> = {};
      current[key] = nested;
      stack.push({ obj: nested, indent });
    } else if (value === "true") {
      current[key] = true;
    } else if (value === "false") {
      current[key] = false;
    } else if (value.startsWith('"') || value.startsWith("'")) {
      current[key] = value.slice(1, -1);
    } else if (!isNaN(Number(value))) {
      current[key] = Number(value);
    } else {
      current[key] = value;
    }
  }

  return result;
}

/**
 * Get API key for the selected provider from Action inputs or env vars.
 */
export function getApiKey(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return core.getInput("anthropic_api_key") || process.env.ANTHROPIC_API_KEY || "";
    case "openai":
      return core.getInput("openai_api_key") || process.env.OPENAI_API_KEY || "";
    case "google":
      return core.getInput("google_api_key") || process.env.GOOGLE_API_KEY || "";
    case "openrouter":
      return core.getInput("openrouter_api_key") || process.env.OPENROUTER_API_KEY || "";
    case "local":
      return core.getInput("local_api_key") || process.env.LOCAL_API_KEY || "dummy";
    case "nvidia":
      return core.getInput("nvidia_api_key") || process.env.NVIDIA_NIM_API_KEY || "";
  }
}
