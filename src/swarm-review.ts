/**
 * Swarm Review — Parallel Multi-Perspective Agent Review.
 *
 * Competitive gap: Greptile v4 runs swarm agents that analyze each PR
 * simultaneously from distinct perspectives (security, performance, logic,
 * style), then aggregates findings. Reported 74% increase in addressed
 * comments per PR.
 *
 * Mizumi's implementation: spawns 3 focused specialist agents in parallel
 * (security, correctness, performance), each with a narrow system prompt
 * targeting their domain. Uses the light model (haiku) for each specialist
 * to keep cost low. Deduplicates findings by (file, line, category) key
 * before merging into the main review pipeline.
 *
 * Zero extra cost for users who disable it (default: off for light-tier PRs).
 */
import { generateObject } from "ai";
import * as core from "@actions/core";
import { z } from "zod";
import { MizumiConfig } from "./config.js";
import { createLightModel } from "./models.js";
import { DiffClassification } from "./router.js";
import { wrapDiff } from "./sanitize.js";
import { ReviewComment, type ReviewCommentType } from "./review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmPerspective {
  /** Perspective identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Category filter — this perspective only produces findings of this category */
  category: "security" | "bug" | "performance";
  /** Short system prompt supplement */
  prompt: string;
}

export interface SwarmResult {
  /** All findings from all perspectives */
  findings: ReviewCommentType[];
  /** Per-perspective counts */
  perspectiveCounts: Record<string, number>;
  /** Deduplication stats */
  duplicatesRemoved: number;
}

// ---------------------------------------------------------------------------
// Perspectives
// ---------------------------------------------------------------------------

const PERSPECTIVES: SwarmPerspective[] = [
  {
    id: "security",
    name: "Security Specialist",
    category: "security",
    prompt: `You are a security specialist reviewing this PR. Focus EXCLUSIVELY on:
- Injection vulnerabilities (SQL, XSS, command, LDAP, path traversal)
- Authentication/authorization bypass
- Sensitive data exposure (PII, secrets, tokens in logs/responses)
- Insecure crypto or random number generation
- SSRF, CSRF, open redirect, clickjacking
- Missing input validation or output encoding
- Unsafe deserialization or eval usage

Ignore all non-security issues. Rate security findings with high confidence only (80+).
Return findings with category "security".`,
  },
  {
    id: "correctness",
    name: "Correctness Specialist",
    category: "bug",
    prompt: `You are a correctness specialist reviewing this PR. Focus EXCLUSIVELY on:
- Logic errors and incorrect conditions
- Off-by-one errors, wrong operators
- Null/undefined dereference risks
- Race conditions and concurrency bugs
- Missing error handling (unhandled promises, empty catch blocks)
- Resource leaks (unclosed connections, file handles)
- Type mismatches and incorrect API usage
- Wrong return values or missing returns

Ignore style, performance, and security issues. Rate findings with high confidence only (80+).
Return findings with category "bug".`,
  },
  {
    id: "performance",
    name: "Performance Specialist",
    category: "performance",
    prompt: `You are a performance specialist reviewing this PR. Focus EXCLUSIVELY on:
- N+1 queries or unnecessary database calls
- O(n^2) or worse algorithms where O(n) suffices
- Memory leaks (unbounded caches, missing cleanup)
- Synchronous operations that should be async
- Redundant computations or unnecessary data copies
- Missing indexes or full table scans
- Large object allocations in hot paths
- Inefficient string concatenation or regex in loops

Ignore style, security, and correctness issues. Rate findings with high confidence only (80+).
Return findings with category "performance".`,
  },
];

// ---------------------------------------------------------------------------
// Schema for specialist output (subset of full review — comments only)
// ---------------------------------------------------------------------------

const SpecialistResponse = z.object({
  comments: z.array(ReviewComment).describe("Specialist findings"),
});

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Run a single specialist perspective review.
 * Uses the light model to minimize cost per specialist.
 */
async function runSpecialistReview(
  perspective: SwarmPerspective,
  diffContent: string,
  validPositions: string,
  config: MizumiConfig,
  classification?: DiffClassification,
): Promise<ReviewCommentType[]> {
  const model = classification?.tier === "light" ? createLightModel(config) : createLightModel(config);

  const systemPrompt = `You are Mizumi's ${perspective.name}.

${perspective.prompt}

## Output Format
Respond with JSON: { "comments": [ { file, line, severity, category, message, suggestion?, confidence } ] }

## Line Number Rules
You can ONLY comment on lines in the diff. Valid positions:
${validPositions}

If a finding doesn't map to a valid line, set line to the nearest valid line.
NEVER fabricate line numbers.`;

  const userPrompt = wrapDiff(diffContent);

  try {
    const result = await generateObject({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      schema: SpecialistResponse,
      maxOutputTokens: 2048,
    });

    // Force category to match the perspective's domain
    return result.object.comments.map((c) => ({
      ...c,
      category: perspective.category,
    }));
  } catch (e) {
    core.warning(`Swarm ${perspective.id} review failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Deduplicate findings by (file, line, category) key.
 * When duplicates exist, keep the one with higher confidence.
 */
export function deduplicateFindings(findings: ReviewCommentType[]): {
  unique: ReviewCommentType[];
  duplicatesRemoved: number;
} {
  const seen = new Map<string, ReviewCommentType>();

  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}:${finding.category}`;
    const existing = seen.get(key);
    if (!existing || finding.confidence > existing.confidence) {
      seen.set(key, finding);
    }
  }

  return {
    unique: [...seen.values()],
    duplicatesRemoved: findings.length - seen.size,
  };
}

/**
 * Run swarm review — all 3 specialist perspectives in parallel.
 * Returns deduplicated findings from all perspectives.
 */
export async function runSwarmReview(
  diffContent: string,
  validPositions: string,
  config: MizumiConfig,
  classification?: DiffClassification,
): Promise<SwarmResult> {
  const results = await Promise.all(
    PERSPECTIVES.map((p) => runSpecialistReview(p, diffContent, validPositions, config, classification))
  );

  // Merge all findings
  const allFindings = results.flat();
  const perspectiveCounts: Record<string, number> = {};
  for (let i = 0; i < PERSPECTIVES.length; i++) {
    perspectiveCounts[PERSPECTIVES[i].id] = results[i].length;
  }

  // Deduplicate
  const { unique, duplicatesRemoved } = deduplicateFindings(allFindings);

  core.info(
    `Swarm review: ${allFindings.length} findings from ${PERSPECTIVES.length} perspectives ` +
    `(${duplicatesRemoved} duplicates removed, ${unique.length} unique)`
  );

  return {
    findings: unique,
    perspectiveCounts,
    duplicatesRemoved,
  };
}

/**
 * Build context string describing swarm review results for injection into main review prompt.
 */
export function buildSwarmContext(result: SwarmResult): string {
  if (result.findings.length === 0) return "";

  let ctx = `## Swarm Review — Specialist Agent Findings\n`;
  ctx += "Three specialist agents reviewed this PR in parallel. Their findings are included below. ";
  ctx += "Integrate these with your own analysis but do not duplicate them:\n\n";

  for (const [id, count] of Object.entries(result.perspectiveCounts)) {
    if (count > 0) {
      const perspective = PERSPECTIVES.find((p) => p.id === id);
      ctx += `- **${perspective?.name ?? id}**: ${count} finding(s)\n`;
    }
  }

  ctx += `\n${result.duplicatesRemoved > 0 ? `(${result.duplicatesRemoved} duplicate(s) removed across perspectives)\n` : ""}`;

  for (const finding of result.findings) {
    ctx += `- **${finding.severity}** [${finding.category}] \`${finding.file}:${finding.line}\`: ${finding.message}`;
    if (finding.suggestion) ctx += ` → ${finding.suggestion}`;
    ctx += `\n`;
  }

  return ctx.trim();
}
