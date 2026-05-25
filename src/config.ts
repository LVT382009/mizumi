import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

export type Profile = "chill" | "assertive" | "followup";
export type Provider = "anthropic" | "openai" | "google" | "openrouter" | "nvidia" | "local" | "custom";

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
  autoPauseAfter: number;
  excludePatterns: string[];
  tierRouting: boolean;
  smallDiffThreshold: number;
  securityPaths: string[];
  complianceCheck: boolean;
  autoFix: boolean;
  confidenceCalibration: boolean;
  changeStack: boolean;
  improveEnabled: boolean;
  dryRun: boolean;
  linterScan: boolean;
  autoLabels: boolean;
  spendThreshold: number;
  gateThreshold: "none" | "critical" | "high" | "medium";
  ruleEngine: boolean;
  ciValidatedFix: boolean;
  ciFixTimeout: number;
  ciFixMaxRetries: number;
  ciFixRevertOnFailure: boolean;
  astContractAnalysis: boolean;
  behavioralSummary: boolean;
  ownershipRouting: boolean;
  deltaReview: boolean;
  taintAnalysis: boolean;
  reviewLearning: boolean;
  blastRadius: boolean;
  specCompliance: boolean;
  authBoundary: boolean;
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

const DEFAULT_SECURITY_PATHS = [
  "**/auth/**",
  "**/crypto/**",
  "**/sql/**",
  "**/secret*",
  "**/password*",
];

const VALID_PROVIDERS: Provider[] = ["anthropic", "openai", "google", "openrouter", "nvidia", "local", "custom"];
const VALID_PROFILES: Profile[] = ["chill", "assertive", "followup"];

export function loadConfig(): MizumiConfig {
  const rawProvider = core.getInput("provider") || "anthropic";
  const provider = (VALID_PROVIDERS.includes(rawProvider as Provider) ? rawProvider : "anthropic") as Provider;
  const model = core.getInput("model") || "claude-sonnet-4-6";
  const baseUrl = core.getInput("base_url") || "";
  const rawProfile = core.getInput("profile") || "chill";
  const profile = (VALID_PROFILES.includes(rawProfile as Profile) ? rawProfile : "chill") as Profile;
  const maxComments = parseInt(core.getInput("max_comments") || "15", 10) || 15;
  const language = core.getInput("language") || "en-US";
  const selfCritique = core.getInput("self_critique") !== "false";
  const confidenceThreshold = parseInt(core.getInput("confidence_threshold") || "80", 10) || 80;
  const autoReview = core.getInput("auto_review") !== "false";
  const autoPauseAfter = parseInt(core.getInput("auto_pause_after") || "5", 10) || 5;

  const tierRouting = core.getInput("tier_routing") !== "false";
  const smallDiffThreshold = parseInt(core.getInput("small_diff_threshold") || "50", 10) || 50;
  const complianceCheck = core.getInput("compliance_check") !== "false";
  const autoFix = core.getInput("auto_fix") === "true";
  const confidenceCalibration = core.getInput("confidence_calibration") !== "false";
  const changeStack = core.getInput("change_stack") !== "false";
  const improveEnabled = core.getInput("improve_enabled") === "true";
const dryRun = core.getInput("dry_run") === "true";
const linterScan = core.getInput("linter_scan") !== "false"; // default true
const autoLabels = core.getInput("auto_labels") !== "false"; // default true
const spendThreshold = parseInt(core.getInput("spend_threshold") || "0", 10) || 0; // 0 = disabled
const VALID_GATE: MizumiConfig["gateThreshold"][] = ["none", "critical", "high", "medium"];
const rawGate = core.getInput("gate_threshold") || "none";
const gateThreshold = (VALID_GATE.includes(rawGate as MizumiConfig["gateThreshold"]) ? rawGate : "none") as MizumiConfig["gateThreshold"];
  const ruleEngine = core.getInput("rule_engine") !== "false"; // default true
const ciValidatedFix = core.getInput("ci_validated_fix") === "true"; // default false
const ciFixTimeout = parseInt(core.getInput("ci_fix_timeout") || "600", 10) || 600;
const ciFixMaxRetries = parseInt(core.getInput("ci_fix_max_retries") || "3", 10) || 3;
const ciFixRevertOnFailure = core.getInput("ci_fix_revert_on_failure") !== "false"; // default true
const astContractAnalysis = core.getInput("ast_contract_analysis") !== "false"; // default true
const behavioralSummary = core.getInput("behavioral_summary") !== "false"; // default true
const ownershipRouting = core.getInput("ownership_routing") !== "false"; // default true
const deltaReview = core.getInput("delta_review") !== "false"; // default true
const taintAnalysis = core.getInput("taint_analysis") !== "false"; // default true
const reviewLearning = core.getInput("review_learning") !== "false"; // default true
const blastRadius = core.getInput("blast_radius") !== "false"; // default true
const specCompliance = core.getInput("spec_compliance") !== "false"; // default true
const authBoundary = core.getInput("auth_boundary") !== "false"; // default true
let securityPaths = [...DEFAULT_SECURITY_PATHS];

  const configPath = path.join(process.env.GITHUB_WORKSPACE || ".", ".github", "mizumi.yml");
  let excludePatterns = [...DEFAULT_EXCLUDE];
  let repoModel = model;
  let repoBaseUrl = baseUrl;
  let repoProfile = profile;
  let repoMaxComments = maxComments;
  let repoConfidence = confidenceThreshold;
  let repoTierRouting = tierRouting;
  let repoSmallDiffThreshold = smallDiffThreshold;

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = parseSimpleYaml(raw);
      const llm = parsed.llm as Record<string, unknown> | undefined;
      const review = parsed.review as Record<string, unknown> | undefined;
      if (llm?.model) repoModel = String(llm.model);
      if (llm?.base_url) repoBaseUrl = String(llm.base_url);
      if (review?.profile) { const p = String(review.profile); if (VALID_PROFILES.includes(p as Profile)) repoProfile = p as Profile; }
      if (review?.max_comments) repoMaxComments = Number(review.max_comments);
      if (review?.confidence_threshold) repoConfidence = Number(review.confidence_threshold);
      if (review?.tier_routing === false) repoTierRouting = false;
      if (review?.small_diff_threshold) repoSmallDiffThreshold = Number(review.small_diff_threshold);
      // security_paths from yml
      const sp = parsed.security_paths as Record<string, unknown> | undefined;
      const spInner = sp?.security_paths;
      if (Array.isArray(spInner)) {
        securityPaths = spInner.map(String);
      } else if (Array.isArray(parsed.security_paths)) {
        securityPaths = (parsed.security_paths as unknown[]).map(String);
      }
      if (Array.isArray(parsed.exclude)) {
        excludePatterns = [...DEFAULT_EXCLUDE, ...parsed.exclude.map(String)];
      } else if (parsed.exclude && typeof parsed.exclude === "object") {
        // parseSimpleYaml nests arrays: { exclude: { exclude: [...] } }
        const inner = (parsed.exclude as Record<string, unknown>).exclude;
        if (Array.isArray(inner)) {
          excludePatterns = [...DEFAULT_EXCLUDE, ...inner.map(String)];
        }
      }
    } catch {
      core.warning("Failed to parse .github/mizumi.yml, using defaults");
    }
  }

  return {
    provider,
    model: repoModel,
    baseUrl: repoBaseUrl,
    profile: repoProfile,
    maxComments: repoMaxComments,
    language,
    selfCritique,
    confidenceThreshold: repoConfidence,
    autoReview,
    autoPauseAfter,
    excludePatterns,
    tierRouting: repoTierRouting,
    smallDiffThreshold: repoSmallDiffThreshold,
    securityPaths,
    complianceCheck,
    autoFix,
    confidenceCalibration,
    changeStack,
    improveEnabled,
    dryRun,
    linterScan,
    autoLabels,
    spendThreshold,
    gateThreshold,
    ruleEngine,
    ciValidatedFix,
    ciFixTimeout,
    ciFixMaxRetries,
    ciFixRevertOnFailure,
    astContractAnalysis,
  behavioralSummary,
  ownershipRouting,
  deltaReview,
  taintAnalysis,
  reviewLearning,
    blastRadius,
    specCompliance,
  authBoundary,
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
    case "custom":
      return core.getInput("custom_api_key") || process.env.CUSTOM_API_KEY || "";
    case "nvidia":
      return core.getInput("nvidia_api_key") || process.env.NVIDIA_NIM_API_KEY || "";
  }
}

/** Get API key, throwing an actionable error if missing for non-local providers. */
export function requireApiKey(provider: Provider): string {
  const key = getApiKey(provider);
  if (!key && provider !== "local") {
    const envVar = `${provider.toUpperCase()}_API_KEY`;
    throw new Error(`API key for ${provider} is required. Set ${envVar} or the ${provider}_api_key action input.`);
  }
  return key || "dummy";
}
