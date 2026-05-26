/**
 * PR Type-Adaptive Review Strategy — Qodo's "Mental Alignment" for Mizumi.
 *
 * Mizumi's classifier.ts already categorizes PRs into 6 types, but the
 * review prompt never uses that classification to change WHAT the LLM
 * focuses on. This module generates type-specific review instructions
 * that are injected into the system prompt, so a security PR gets
 * security-hardened scrutiny while a docs PR skips deep analysis.
 *
 * Competitive gap: Only Qodo (Mental Alignment pillar) and Macroscope
 * (risk-calibrated review depth) adapt review strategy per PR type.
 * Every other AI reviewer gives the same review regardless of PR type.
 */
import type { PRCategory } from "./classifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewStrategy {
  focusAreas: string[];
  skipAreas: string[];
  riskBias: number; // -2 to +2 adjustment to severity interpretation
  promptAddition: string;
}

// ---------------------------------------------------------------------------
// Strategy selection
// ---------------------------------------------------------------------------

const STRATEGIES: Record<PRCategory, ReviewStrategy> = {
  security: {
    focusAreas: ["authentication", "authorization", "input validation", "injection", "crypto", "secrets", "data exposure"],
    skipAreas: ["style", "naming", "documentation quality", "code organization"],
    riskBias: 1,
    promptAddition: `This PR touches security-sensitive code. Apply heightened scrutiny:
- Verify all user inputs are validated and sanitized
- Check for authentication/authorization bypass
- Look for injection vectors (SQL, XSS, command, path traversal)
- Ensure secrets are not hardcoded or leaked
- Verify crypto operations use safe defaults
- Flag any data exposure or privilege escalation risks
- Elevate severity of security findings by one level`,
  },
  logic: {
    focusAreas: ["bugs", "logic errors", "race conditions", "null pointers", "off-by-one", "error handling"],
    skipAreas: [],
    riskBias: 0,
    promptAddition: `This PR contains general logic changes. Apply standard review:
- Check for logic errors, incorrect conditions, and edge cases
- Verify error handling is comprehensive
- Look for race conditions and concurrency issues
- Ensure return values and error paths are handled correctly`,
  },
  docs: {
    focusAreas: ["accuracy", "broken links", "code examples"],
    skipAreas: ["runtime bugs", "security vulnerabilities", "performance"],
    riskBias: -2,
    promptAddition: `This PR is documentation-only. Apply lightweight review:
- Check for accuracy and completeness of documentation
- Verify code examples are correct and runnable
- Flag broken links or outdated references
- Do NOT flag style, runtime bugs, or performance issues
- Reduce severity of most findings to nitpick/low unless factually wrong`,
  },
  tests: {
    focusAreas: ["test correctness", "coverage gaps", "fixture validity"],
    skipAreas: ["style", "naming in test files"],
    riskBias: -1,
    promptAddition: `This PR adds or modifies tests. Apply test-focused review:
- Verify tests actually test what they claim to test
- Check for missing edge cases and coverage gaps
- Ensure test fixtures and mocks are reasonable
- Look for flaky test patterns (timing dependencies, shared state)
- Reduce severity for style issues in test files`,
  },
  config: {
    focusAreas: ["misconfigurations", "security settings", "breaking changes"],
    skipAreas: ["style", "documentation"],
    riskBias: 0,
    promptAddition: `This PR changes configuration files. Apply config-focused review:
- Check for misconfigurations that could break deployments
- Verify security settings are not accidentally weakened
- Look for typos in YAML/JSON that change semantics
- Flag any removal of security controls or logging
- Check that new settings have reasonable defaults`,
  },
  cosmetic: {
    focusAreas: ["visual consistency", "accessibility"],
    skipAreas: ["runtime bugs", "security", "performance"],
    riskBias: -2,
    promptAddition: `This PR is cosmetic (UI/styling changes). Apply lightweight review:
- Check for visual consistency and accessibility
- Do NOT flag runtime bugs, security, or performance issues
- Reduce severity of most findings to nitpick/low`,
  },
};

/** Get the adaptive review strategy for a PR category */
export function getReviewStrategy(category: PRCategory): ReviewStrategy {
  return STRATEGIES[category] || STRATEGIES.logic;
}

/** Build the adaptive strategy prompt section for injection into the review system prompt */
export function buildStrategyPrompt(category: PRCategory): string {
  const strategy = getReviewStrategy(category);

  let prompt = `\n## Adaptive Review Strategy (PR type: ${category})\n`;

  if (strategy.focusAreas.length > 0) {
    prompt += `Focus areas: ${strategy.focusAreas.join(", ")}\n`;
  }

  if (strategy.skipAreas.length > 0) {
    prompt += `Skip areas: ${strategy.skipAreas.join(", ")}\n`;
  }

  if (strategy.riskBias !== 0) {
    const direction = strategy.riskBias > 0 ? "elevate" : "reduce";
    prompt += `Risk bias: ${direction} severity by ${Math.abs(strategy.riskBias)} level(s)\n`;
  }

  prompt += `\n${strategy.promptAddition}\n`;

  return prompt;
}
