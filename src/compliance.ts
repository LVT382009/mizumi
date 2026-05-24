/**
 * Ticket-to-code compliance — checks if PR changes match the referenced issue.
 * Phase 2.22: If PR references a GitHub Issue (#123), evaluate whether
 * the changes actually implement what the issue describes.
 * 3-tier scoring: Fully / Partially / Not compliant (Qodo pattern).
 */
import * as core from "@actions/core";
import { generateText } from "ai";
import { Octokit } from "@octokit/rest";
import { MizumiConfig, requireApiKey } from "./config.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const ISSUE_REFS = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:erence)?|see|part\s+of|related\s+to)\s*#\d+/gi;
const BARE_REF = /#(\d+)/g;

export type ComplianceLevel = "fully" | "partially" | "not" | "none";

export interface ComplianceResult {
  issueNumber: number;
  issueTitle: string;
  compliance: ComplianceLevel;
  summary: string;
}

/**
 * Check ticket-to-code compliance for a PR.
 * Extracts issue references from the PR body/title, fetches the issue,
 * and evaluates whether the PR changes implement the issue requirements.
 */
export async function checkCompliance(
  octokit: Octokit,
  owner: string,
  repo: string,
  _prNumber: number,
  prBody: string,
  prTitle: string,
  diffSummary: string,
  config: MizumiConfig
): Promise<ComplianceResult[]> {
  const issueRefs = extractIssueRefs(prBody + " " + prTitle);
  if (issueRefs.length === 0) return [];

  const results: ComplianceResult[] = [];

  for (const issueNum of issueRefs.slice(0, 3)) { // Max 3 issues to check
    try {
      const { data: issue } = await octokit.rest.issues.get({
        owner, repo, issue_number: issueNum,
      });

      if (issue.pull_request) continue; // Skip if it's a PR, not an issue

      const compliance = await evaluateCompliance(
        issue.title || "",
        issue.body || "",
        diffSummary,
        config
      );

      results.push({
        issueNumber: issueNum,
        issueTitle: issue.title || "",
        compliance: compliance.level,
        summary: compliance.summary,
      });

      core.info(`Compliance: #${issueNum} → ${compliance.level} — ${compliance.summary}`);
    } catch {
      core.warning(`Failed to fetch issue #${issueNum} for compliance check`);
    }
  }

  return results;
}

function extractIssueRefs(text: string): number[] {
  const refs = new Set<number>();

  // Match "closes #123", "fixes #456", etc.
  const explicitRefs = text.matchAll(ISSUE_REFS);
  for (const match of explicitRefs) {
    const numMatch = match[0].match(/#(\d+)/);
    if (numMatch) refs.add(parseInt(numMatch[1], 10));
  }

  // Also match bare #123 refs
  const bareRefs = text.matchAll(BARE_REF);
  for (const match of bareRefs) {
    refs.add(parseInt(match[1], 10));
  }

  return [...refs].slice(0, 5);
}

async function evaluateCompliance(
  issueTitle: string,
  issueBody: string,
  diffSummary: string,
  config: MizumiConfig
): Promise<{ level: ComplianceLevel; summary: string }> {
  let model;
  try {
    switch (config.provider) {
      case "anthropic":
        model = createAnthropic({ apiKey: requireApiKey("anthropic") })("claude-haiku-4-5-20251001");
        break;
      default:
        model = createOpenAI({ apiKey: requireApiKey(config.provider) })(config.model);
    }
  } catch {
    return { level: "none", summary: "No API key available for compliance check" };
  }

  const prompt = `You are evaluating whether a pull request actually implements what a GitHub issue describes.

## Issue #${issueTitle}
${issueBody.slice(0, 2000)}

## PR Changes Summary
${diffSummary.slice(0, 3000)}

Does this PR implement the issue requirements? Answer with:
- "fully" — all requirements from the issue are addressed
- "partially" — some requirements are addressed but not all
- "not" — the PR does not address the issue requirements

Then provide a one-sentence summary explaining your assessment.

Format: LEVEL|summary (e.g. "partially|Adds auth check but missing rate limiting")`;

  try {
    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 200,
    });

    const normalized = text.trim().toLowerCase();
    if (normalized.startsWith("fully")) {
      return { level: "fully", summary: extractSummary(text, "fully") };
    } else if (normalized.startsWith("partially")) {
      return { level: "partially", summary: extractSummary(text, "partially") };
    } else if (normalized.startsWith("not")) {
      return { level: "not", summary: extractSummary(text, "not") };
    }
    return { level: "none", summary: text.trim().slice(0, 100) };
  } catch (e) {
    core.warning(`Compliance evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
    return { level: "none", summary: "Compliance check failed" };
  }
}

function extractSummary(text: string, level: string): string {
  const pipeIdx = text.indexOf("|");
  if (pipeIdx > -1) return text.slice(pipeIdx + 1).trim().slice(0, 200);
  // Fallback: remove the level word
  return text.replace(new RegExp(`^${level}`, "i"), "").trim().slice(0, 200) || `${level} compliant`;
}

/**
 * Format compliance results for inclusion in review body.
 */
export function formatCompliance(results: ComplianceResult[]): string {
  if (results.length === 0) return "";

  const emoji: Record<ComplianceLevel, string> = {
    fully: "[PASS]",
    partially: "[WARN]",
    not: "[FAIL]",
    none: "",
  };

  const color: Record<ComplianceLevel, string> = {
    fully: "green",
    partially: "yellow",
    not: "red",
    none: "gray",
  };

  let body = "### Issue Compliance\n\n";
  for (const r of results) {
    const badge = r.compliance !== "none"
      ? `![${r.compliance}](https://img.shields.io/badge/compliance-${r.compliance}-${color[r.compliance]})`
      : "";
    body += `- #${r.issueNumber} ${emoji[r.compliance]} ${r.issueTitle} ${badge}\n  ${r.summary}\n`;
  }

  return body;
}
