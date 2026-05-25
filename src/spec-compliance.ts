/**
 * Spec-to-Diff Compliance — verify PR implements acceptance criteria from linked issues.
 *
 * Competitive gap: Only Atlassian Code Reviewer checks acceptance criteria,
 * and only for Jira. No GitHub-native AI reviewer extracts AC from issue bodies
 * and cross-references each item against the diff.
 *
 * Algorithm:
 * 1. Extract issue refs from PR body/title (closes #X, fixes #Y)
 * 2. Fetch issue bodies via GitHub API
 * 3. Parse acceptance criteria from issue body:
 *    - Task lists: - [ ] / - [x] items
 *    - Heading sections: "Acceptance Criteria:", "AC:", "Definition of Done:"
 *    - Numbered/bulleted lists under those headings
 *    - Fallback: use LLM to extract criteria from free text
 * 4. For each criterion, check against diff content:
 *    - Keyword matching: extract identifiers from criterion, grep diff for them
 *    - Unmatched items fall through to LLM semantic check
 * 5. Classify each criterion: met / partially-met / unaddressed / non-code
 * 6. Return structured results for injection into review context
 *
 * Hybrid approach: keyword matching first (cheap, fast), LLM fallback for
 * unmatched items (higher recall). Non-code items (deploy, manual steps)
 * are flagged as "needs manual check" — not false-positived.
 */
import * as core from "@actions/core";
import { generateObject } from "ai";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { MizumiConfig, requireApiKey } from "./config.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { sanitizeInput } from "./sanitize.js";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CriterionStatus = "met" | "partially-met" | "unaddressed" | "non-code";

export interface AcceptanceCriterion {
  /** The criterion text from the issue */
  text: string;
  /** Whether it was a task list item */
  isTaskList: boolean;
  /** Whether it was checked off in the issue */
  isChecked: boolean;
  /** Assessment result */
  status: CriterionStatus;
  /** Evidence from the diff (file path or matched keyword) */
  evidence: string;
}

export interface SpecComplianceResult {
  /** Issue number */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** Parsed acceptance criteria */
  criteria: AcceptanceCriterion[];
  /** Summary: X/Y criteria met */
  summary: string;
  /** Overall coverage percentage (0-100) */
  coverage: number;
}

// ---------------------------------------------------------------------------
// AC extraction patterns
// ---------------------------------------------------------------------------

/** Task list item: - [ ] or - [x] */
const TASK_LIST_RE = /^[\s]*[-*]\s*\[([ xX])\]\s*(.+)/gm;

/** Heading that signals AC section */
const AC_HEADING_RE = /^#{1,3}\s*(?:acceptance\s+criteria|ac|definition\s+of\s+done|doD|criteria|requirements?):?\s*$/gim;

/** Numbered list item: 1. text or 1) text */
const NUMBERED_LIST_RE = /^[\s]*(\d+)[.)]\s+(.+)/gm;

/** Bulleted list item: - text or * text (but not task list) */
const BULLET_LIST_RE = /^[\s]*[-*]\s+(?!\[[ xX]\])(.+)/gm;

/** Identifier patterns: path-like (most specific first), kebab-case, UPPER_SNAKE, camelCase */
const IDENTIFIER_RE = /\b([a-zA-Z][a-zA-Z0-9]*[-\/.][a-zA-Z0-9_.\-\/]+|[a-z][a-z0-9]+(?:-[a-z0-9]+)+|[A-Z][A-Z0-9_]{2,}|[a-z][a-zA-Z0-9]{2,})\b/g;

// ---------------------------------------------------------------------------
// AC parsing from issue body
// ---------------------------------------------------------------------------

/**
 * Parse acceptance criteria from an issue body.
 * Priority: task lists > AC heading sections > numbered lists > bullet lists > LLM fallback
 */
export function parseAcceptanceCriteria(body: string): string[] {
  if (!body) return [];

  const criteria: string[] = [];
  const seen = new Set<string>();

  // 1. Extract task list items
  let match: RegExpExecArray | null;
  TASK_LIST_RE.lastIndex = 0;
  while ((match = TASK_LIST_RE.exec(body)) !== null) {
    const text = match[2].trim();
    if (text && !seen.has(text.toLowerCase())) {
      criteria.push(text);
      seen.add(text.toLowerCase());
    }
  }

  // 2. If we found task list items, those ARE the AC — return them
  if (criteria.length > 0) return criteria;

  // 3. Look for AC heading sections
  AC_HEADING_RE.lastIndex = 0;
  const headingMatch = AC_HEADING_RE.exec(body);
  if (headingMatch) {
    const afterHeading = body.slice(headingMatch.index + headingMatch[0].length);
    // Take content until the next heading or end of body
    const nextHeading = afterHeading.search(/^#{1,3}\s+/m);
    const section = nextHeading > 0 ? afterHeading.slice(0, nextHeading) : afterHeading;

    // Extract numbered items from this section
    NUMBERED_LIST_RE.lastIndex = 0;
    while ((match = NUMBERED_LIST_RE.exec(section)) !== null) {
      const text = match[2].trim();
      if (text && !seen.has(text.toLowerCase())) {
        criteria.push(text);
        seen.add(text.toLowerCase());
      }
    }

    // Extract bullet items from this section
    BULLET_LIST_RE.lastIndex = 0;
    while ((match = BULLET_LIST_RE.exec(section)) !== null) {
      const text = match[1].trim();
      if (text && !seen.has(text.toLowerCase())) {
        criteria.push(text);
        seen.add(text.toLowerCase());
      }
    }

    if (criteria.length > 0) return criteria;
  }

  // 4. Fall back to numbered/bullet lists in the entire body
  NUMBERED_LIST_RE.lastIndex = 0;
  while ((match = NUMBERED_LIST_RE.exec(body)) !== null) {
    const text = match[2].trim();
    if (text.length > 5 && !seen.has(text.toLowerCase())) {
      criteria.push(text);
      seen.add(text.toLowerCase());
    }
  }

  if (criteria.length > 0) return criteria;

  BULLET_LIST_RE.lastIndex = 0;
  while ((match = BULLET_LIST_RE.exec(body)) !== null) {
    const text = match[1].trim();
    if (text.length > 5 && !seen.has(text.toLowerCase())) {
      criteria.push(text);
      seen.add(text.toLowerCase());
    }
  }

  return criteria;
}

/** Parse task list items with checked/unchecked status */
export function parseTaskListStatus(body: string): Array<{ text: string; checked: boolean }> {
  if (!body) return [];

  const items: Array<{ text: string; checked: boolean }> = [];
  const seen = new Set<string>();

  TASK_LIST_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TASK_LIST_RE.exec(body)) !== null) {
    const text = match[2].trim();
    const checked = match[1].toLowerCase() === "x";
    if (text && !seen.has(text.toLowerCase())) {
      items.push({ text, checked });
      seen.add(text.toLowerCase());
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Keyword-based matching
// ---------------------------------------------------------------------------

/** Extract identifiers from criterion text for grepping the diff */
export function extractKeywords(criterion: string): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();

  IDENTIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_RE.exec(criterion)) !== null) {
    const kw = match[1];
    // Skip very short keywords and common stop words
    if (kw.length < 3) continue;
    if (/^(the|and|for|not|but|are|has|can|all|any|use|new|old|get|set|add|put|let|run|key|way|may|via)\b/i.test(kw)) continue;
    if (!seen.has(kw.toLowerCase())) {
      keywords.push(kw);
      seen.add(kw.toLowerCase());
    }
  }

  return keywords;
}

/** Check if a keyword appears in any added line of the diff */
export function keywordInDiff(keyword: string, files: DiffFile[]): { found: boolean; file?: string } {
  const kwLower = keyword.toLowerCase();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;
        if (change.content.toLowerCase().includes(kwLower)) {
          return { found: true, file: file.path };
        }
      }
    }
  }
  return { found: false };
}

/** Non-code criterion detector — deploy, manual, staging, etc. */
const NON_CODE_PATTERNS = /\b(deploy|staging|production|prod|manual|review|approve|sign.?off|sla|uptime|monitoring|monitor|alert|dashboard|documentation|readme|changelog)\b/i;

/** Check if criterion is a non-code item (needs manual verification) */
export function isNonCodeCriterion(text: string): boolean {
  return NON_CODE_PATTERNS.test(text);
}

// ---------------------------------------------------------------------------
// LLM-based semantic matching (fallback for keyword-unmatched criteria)
// ---------------------------------------------------------------------------

const SpecCheckSchema = z.object({
  status: z.enum(["met", "partially-met", "unaddressed"]).describe("Assessment of this criterion"),
  evidence: z.string().describe("Brief evidence from the diff, or 'no evidence found'"),
});

async function llmCheckCriterion(
  criterion: string,
  diffText: string,
  config: MizumiConfig
): Promise<{ status: CriterionStatus; evidence: string }> {
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
    return { status: "unaddressed", evidence: "API key unavailable" };
  }

  const safeCriterion = sanitizeInput(criterion);
  const safeDiff = sanitizeInput(diffText.slice(0, 4000));

  try {
    const { object } = await generateObject({
      model,
      prompt: `You are verifying whether a pull request implements a specific acceptance criterion.

## Acceptance Criterion
${safeCriterion}

## PR Changes (diff)
${safeDiff}

Does this PR implement the criterion? If partially, some aspects are covered but not all. If there is no evidence, mark as unaddressed.`,
      schema: SpecCheckSchema,
      maxOutputTokens: 256,
    });

    return { status: object.status, evidence: object.evidence };
  } catch (e) {
    core.warning(`Spec compliance LLM check failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: "unaddressed", evidence: "LLM check failed" };
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/** Build a textual diff summary for LLM context (paths + added lines) */
function buildDiffText(files: DiffFile[]): string {
  const parts: string[] = [];
  for (const file of files.slice(0, 30)) {
    const addedLines: string[] = [];
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "add") addedLines.push(change.content);
      }
    }
    if (addedLines.length > 0) {
      parts.push(`--- ${file.path} ---\n${addedLines.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Check spec-to-diff compliance for a PR.
 * Fetches linked issues, parses AC, matches against diff.
 */
export async function checkSpecCompliance(
  octokit: Octokit,
  owner: string,
  repo: string,
  prBody: string,
  prTitle: string,
  diffFiles: DiffFile[],
  config: MizumiConfig
): Promise<SpecComplianceResult[]> {
  const issueRefs = extractIssueRefsSimple(prBody + " " + prTitle);
  if (issueRefs.length === 0) return [];

  const results: SpecComplianceResult[] = [];
  const diffText = buildDiffText(diffFiles);

  for (const issueNum of issueRefs.slice(0, 3)) {
    try {
      const { data: issue } = await octokit.rest.issues.get({
        owner, repo, issue_number: issueNum,
      });

      if (issue.pull_request) continue; // Skip PRs

      const body = issue.body || "";
      const taskListItems = parseTaskListStatus(body);
      const criteriaTexts = parseAcceptanceCriteria(body);

      if (criteriaTexts.length === 0) continue; // No AC to check

      const criteria: AcceptanceCriterion[] = [];
      const unmatchedForLLM: Array<{ index: number; text: string }> = [];

      for (let i = 0; i < criteriaTexts.length; i++) {
        const text = criteriaTexts[i];
        const taskItem = taskListItems.find((t) => t.text === text);

        // Check if it's a non-code criterion
        if (isNonCodeCriterion(text)) {
          criteria.push({
            text,
            isTaskList: !!taskItem,
            isChecked: taskItem?.checked ?? false,
            status: "non-code",
            evidence: "Manual verification needed",
          });
          continue;
        }

        // Keyword matching first
        const keywords = extractKeywords(text);
        let matched = false;
        let matchFile = "";

        for (const kw of keywords.slice(0, 5)) {
          const result = keywordInDiff(kw, diffFiles);
          if (result.found) {
            matched = true;
            matchFile = result.file || "";
            break;
          }
        }

        if (matched) {
          criteria.push({
            text,
            isTaskList: !!taskItem,
            isChecked: taskItem?.checked ?? false,
            status: "met",
            evidence: matchFile ? `Keyword found in ${matchFile}` : "Keyword matched",
          });
        } else {
          // Queue for LLM check
          unmatchedForLLM.push({ index: i, text });
          criteria.push({
            text,
            isTaskList: !!taskItem,
            isChecked: taskItem?.checked ?? false,
            status: "unaddressed", // Will be updated by LLM
            evidence: "",
          });
        }
      }

      // LLM fallback for unmatched criteria (batch of 1 LLM call per issue)
      if (unmatchedForLLM.length > 0 && unmatchedForLLM.length <= 5) {
        for (const { index, text } of unmatchedForLLM) {
          const llmResult = await llmCheckCriterion(text, diffText, config);
          criteria[index] = {
            ...criteria[index],
            status: llmResult.status,
            evidence: llmResult.evidence,
          };
        }
      }

      // Compute coverage
      const met = criteria.filter((c) => c.status === "met" || c.status === "partially-met").length;
      const codeCriteria = criteria.filter((c) => c.status !== "non-code").length;
      const coverage = codeCriteria > 0 ? Math.round((met / codeCriteria) * 100) : 0;

      results.push({
        issueNumber: issueNum,
        issueTitle: issue.title || "",
        criteria,
        summary: `${met}/${codeCriteria} criteria met${criteria.some((c) => c.status === "non-code") ? ` (+${criteria.filter((c) => c.status === "non-code").length} non-code)` : ""}`,
        coverage,
      });

      core.info(`Spec compliance: #${issueNum} → ${coverage}% (${met}/${codeCriteria})`);
    } catch {
      core.warning(`Failed to fetch issue #${issueNum} for spec compliance`);
    }
  }

  return results;
}

/** Simple issue reference extraction (reuses compliance.ts pattern) */
const ISSUE_REF_SIMPLE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)|#(\d+)/gi;

function extractIssueRefsSimple(text: string): number[] {
  const refs = new Set<number>();
  let match: RegExpExecArray | null;
  ISSUE_REF_SIMPLE.lastIndex = 0;
  while ((match = ISSUE_REF_SIMPLE.exec(text)) !== null) {
    const num = match[1] || match[2];
    if (num) refs.add(parseInt(num, 10));
  }
  return [...refs].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Context formatting for LLM prompt injection
// ---------------------------------------------------------------------------

/** Build spec compliance context string for the LLM review prompt */
export function buildSpecComplianceContext(results: SpecComplianceResult[]): string {
  if (results.length === 0) return "";

  let ctx = `## Spec Compliance — Acceptance Criteria Coverage\n`;
  ctx += "The PR references issues with acceptance criteria. Check whether the changes address each criterion:\n\n";

  for (const result of results) {
    ctx += `### Issue #${result.issueNumber}: ${result.issueTitle} (${result.coverage}% coverage)\n`;
    for (const c of result.criteria) {
      const icon = c.status === "met" ? "[PASS]" :
        c.status === "partially-met" ? "[WARN]" :
        c.status === "non-code" ? "[SKIP]" : "[FAIL]";
      ctx += `- ${icon} ${c.text}`;
      if (c.evidence) ctx += ` — ${c.evidence}`;
      ctx += "\n";
    }
    ctx += "\n";
  }

  return ctx.trim();
}
