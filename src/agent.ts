/**
 * Agent tools — read_file, search_code, find_usages for the LLM agent.
 * AI SDK 6 tool definitions with closure-based context injection.
 *
 * Phase 2.3: Tool-using agent explores codebase before commenting.
 * Based on fro0m/AI-code-reviewer-free and Shippie patterns.
 */
import { tool, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { MizumiConfig } from "./config.js";
import { createLightModel, createModel } from "./models.js";
import { DiffClassification } from "./router.js";

/**
 * Create agent tools scoped to a specific repo and commit.
 * Uses closures to inject Octokit + repo context without global state.
 */

/** Strip GitHub search operators from a user-provided query to prevent injection */
export function sanitizeSearchQuery(query: string): string {
  return query
    .replace(/\b(repo|org|user|owner|language|filename|path|extension|size|fork|in|is|type|state|label|status|head|base|merged|sort|order|access|review|checks|commit)\s*:\s*\S*/gi, "")
    .replace(/[+\-~*"|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Paths the agent should never read — secret files, private keys, credentials */
const BLOCKED_PATHS = [
  /^\.env/i,
  /^\.?env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials/i,
  /secret/i,
  /\.npmrc$/i,
  /\.pypirc$/i,
  /\.netrc$/i,
  /\/\.ssh\//i,
  /github_token/i,
  /oauth/i,
];

/** Check if a path should be blocked from agent file reads */
export function isBlockedPath(filePath: string): boolean {
  return BLOCKED_PATHS.some((pattern) => pattern.test(filePath));
}

/** Simple rate-limiter for search API calls (GitHub allows ~30 req/min for search) */
let lastSearchTime = 0;
const SEARCH_INTERVAL_MS = 2500; // 2.5s between searches to avoid 429

async function rateLimitedSearch(fn: () => Promise<any>): Promise<any> {
  const now = Date.now();
  const elapsed = now - lastSearchTime;
  if (elapsed < SEARCH_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, SEARCH_INTERVAL_MS - elapsed));
  }
  lastSearchTime = Date.now();
  return fn();
}

export function createAgentTools(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string
) {
  const read_file = tool({
    description: `Read the contents of a file from the repository at the PR branch version. Use this to understand the full context around a code change. Do NOT read files that are not in the diff - focus on changed files and their imports/dependencies.`,
    inputSchema: z.object({
      path: z.string().describe("File path relative to repo root, e.g. 'src/auth/login.ts'"),
    }),
    execute: async ({ path }) => {
      if (isBlockedPath(path)) {
        core.warning(`Agent read_file blocked: ${path} matches secret file pattern`);
        return `Access denied: ${path} is a protected file (secrets/credentials)`;
      }
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref: headSha,
          headers: { accept: "application/vnd.github.raw+json" },
        });
        if (typeof data === "string") {
          return truncate(data, 5000);
        }
        // If response is an object with content, decode it
        if ("content" in data && typeof (data as any).content === "string") {
          const decoded = Buffer.from((data as any).content, "base64").toString("utf-8");
          return truncate(decoded, 5000);
        }
        return `File: ${path} - could not read content`;
      } catch {
        return `File not found or inaccessible: ${path}`;
      }
    },
  });

  const search_code = tool({
    description: `Search for code patterns in the repository. Returns matching file paths. Searches the default branch only. Useful for finding how a function/class is used across the codebase.`,
    inputSchema: z.object({
      query: z.string().describe("Search query, e.g. 'authenticate' or 'class UserService'"),
    }),
    execute: async ({ query }) => {
      try {
        const safeQuery = sanitizeSearchQuery(query);
        const { data } = await rateLimitedSearch(() =>
          octokit.rest.search.code({
            q: `${safeQuery} repo:${owner}/${repo}`,
            per_page: 10,
          })
        );
        const results = data.items.slice(0, 10).map((item: any) => `**${item.path}**`);
        return results.length > 0
          ? results.join("\n")
          : `No results for "${query}"`;
      } catch {
        return `Search failed for "${query}"`;
      }
    },
  });

  const find_usages = tool({
    description: `Find references to a symbol (function, class, variable) across the repository. Returns file paths where the symbol is used. Useful for understanding the blast radius of a change.`,
    inputSchema: z.object({
      symbol: z.string().describe("Symbol name to search for, e.g. 'authenticate' or 'UserService'"),
    }),
    execute: async ({ symbol }) => {
      try {
        const safeSymbol = sanitizeSearchQuery(symbol);
        const { data } = await rateLimitedSearch(() =>
          octokit.rest.search.code({
            q: `"${safeSymbol}" repo:${owner}/${repo}`,
            per_page: 15,
          })
        );
        const usages = data.items.slice(0, 15).map((item: any) => `- \`${item.path}\``);
        return usages.length > 0
          ? `**${usages.length} references to "${symbol}":**\n\n${usages.join("\n")}`
          : `No usages found for "${symbol}"`;
      } catch {
        return `Usage search failed for "${symbol}"`;
      }
    },
  });

  return { read_file, search_code, find_usages };
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n... [truncated]";
}

/**
 * Run agent context-gathering step before the main review.
 * The agent explores the codebase using tools, then returns
 * supplementary context to inject into the review prompt.
 *
 * This is a READ-ONLY exploration — no write tools.
 * Returns a summary string of cross-file context findings.
 */
export async function runAgentContextGathering(
  diffContent: string,
  config: MizumiConfig,
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  classification?: DiffClassification
): Promise<string> {
  const tools = createAgentTools(octokit, owner, repo, headSha);

  // Use lightweight model for agent context gathering
  const model = (classification && classification.tier === "light")
    ? createLightModel(config)
    : createModel(config);

  const agentPrompt = `You are a code context assistant. Your job is to explore the codebase and gather relevant context for a PR review.

Given this diff, use your tools to:
1. Read files that are changed or imported by changed files
2. Search for how changed functions/classes are used elsewhere
3. Find callers/callees that might be affected by the changes

IMPORTANT: Space out your search calls. Do NOT call search multiple times in quick succession - wait between searches.

Return a concise summary (max 2000 chars) of cross-file context that would help a reviewer understand the blast radius and integration points. Focus on:
- Functions/classes that are called from many places
- Missing error handling that could cascade
- Security-sensitive paths (auth, crypto, SQL)
- API contract changes that break callers

Diff:
${diffContent.slice(0, 15000)}`;

  try {
    const { text } = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(6),
      prompt: agentPrompt,
      maxOutputTokens: 2048,
    });

    if (text) {
      core.info(`Agent context: gathered ${text.length} chars of cross-file context`);
      return truncate(text, 2000);
    }
    return "";
  } catch (e) {
    core.warning(`Agent context gathering failed: ${e instanceof Error ? e.message : String(e)} - continuing without agent context`);
    return "";
  }
}
