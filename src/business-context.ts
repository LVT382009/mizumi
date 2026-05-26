/**
 * Business Context Integration — pull ticket context from Jira, Linear, etc.
 *
 * Competitive gap: CodeRabbit uses MCP servers for Jira/Confluence context.
 * Bito indexes Jira/Linear tickets. Macroscope has bidirectional Jira integration.
 * Mizumi's spec-compliance only checks GitHub Issues. Enterprise teams reference
 * Jira (PAY-1234) and Linear (ENG-567) tickets in PR bodies — this module
 * fetches those tickets and injects their context into the review prompt.
 *
 * Approach: Direct HTTP API calls (not MCP since we run in GitHub Actions).
 * Config: mcpEndpoints array in mizumi.yml or action inputs.
 * Supports: Jira (atlassian.net), Linear (linear.app), generic REST.
 */
import * as core from "@actions/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPEndpoint {
  type: "jira" | "linear" | "generic";
  baseUrl: string;
  token: string;
  projectPrefix?: string; // e.g. "PAY", "ENG" — used to match ticket refs
}

export interface TicketContext {
  key: string; // e.g. "PAY-1234"
  title: string;
  body: string;
  status: string;
  type: string; // e.g. "Bug", "Story", "Task"
  priority: string;
  url: string;
  source: string; // "jira" | "linear" | "generic"
}

export interface BusinessContextResult {
  tickets: TicketContext[];
  totalTickets: number;
  contextText: string;
}

// ---------------------------------------------------------------------------
// Ticket reference extraction from PR body
// ---------------------------------------------------------------------------

const JIRA_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;
const GITHUB_RE = /(?:close|closes|fix|fixes|resolve|resolves|ref|refs|see)\s+#(\d+)/gi;

/** Extract ticket references from PR body and title */
export function extractTicketRefs(
  prBody: string,
  prTitle: string,
  prefixes: string[]
): { jiraKeys: string[]; linearKeys: string[]; githubIds: number[] } {
  const text = `${prTitle} ${prBody}`;
  const jiraKeys: Set<string> = new Set();
  const linearKeys: Set<string> = new Set();
  const githubIds: Set<number> = new Set();

  // Extract Jira/Linear-style keys (PROJECT-NUMBER)
  const matches = text.matchAll(JIRA_RE);
  for (const match of matches) {
    const fullKey = `${match[1]}-${match[2]}`;
    const prefix = match[1];
    if (prefixes.includes(prefix)) {
      // If explicitly configured, respect the type
      jiraKeys.add(fullKey);
    } else {
      // Default: treat as Jira-style
      jiraKeys.add(fullKey);
    }
  }

  // Extract GitHub-style refs (#123)
  const ghMatches = text.matchAll(GITHUB_RE);
  for (const match of ghMatches) {
    githubIds.add(parseInt(match[1], 10));
  }

  return {
    jiraKeys: [...jiraKeys],
    linearKeys: [...linearKeys],
    githubIds: [...githubIds],
  };
}

// ---------------------------------------------------------------------------
// Ticket fetching (HTTP API)
// ---------------------------------------------------------------------------

/** Fetch a Jira ticket via REST API */
async function fetchJiraTicket(
  key: string,
  baseUrl: string,
  token: string
): Promise<TicketContext | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/rest/api/2/issue/${key}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      core.debug(`Jira fetch ${key}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as Record<string, any>;
    const fields = data.fields || {};
    return {
      key,
      title: fields.summary || key,
      body: (fields.description || "").replace(/<[^>]*>/g, "").slice(0, 2000),
      status: fields.status?.name || "Unknown",
      type: fields.issuetype?.name || "Task",
      priority: fields.priority?.name || "None",
      url: `${baseUrl.replace(/\/$/, "")}/browse/${key}`,
      source: "jira",
    };
  } catch (e) {
    core.debug(`Jira fetch ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Fetch a Linear ticket via GraphQL API */
async function fetchLinearTicket(
  key: string,
  token: string
): Promise<TicketContext | null> {
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query { issue(id: "${key}") { title description state { name } team { key } priority label { name } url } }`,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, any>;
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      key,
      title: issue.title || key,
      body: (issue.description || "").slice(0, 2000),
      status: issue.state?.name || "Unknown",
      type: "Issue",
      priority: issue.priority?.toString() || "None",
      url: issue.url || "",
      source: "linear",
    };
  } catch (e) {
    core.debug(`Linear fetch ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Fetch business context from configured ticket systems */
export async function fetchBusinessContext(
  prBody: string,
  prTitle: string,
  endpoints: MCPEndpoint[],
  _githubIds?: number[],
  _octokit?: any,
  _owner?: string,
  _repo?: string
): Promise<BusinessContextResult> {
  const prefixes = endpoints
    .filter((e) => e.projectPrefix)
    .map((e) => e.projectPrefix!.toUpperCase());

  const refs = extractTicketRefs(prBody, prTitle, prefixes);

  const tickets: TicketContext[] = [];

  // Fetch Jira tickets
  const jiraEndpoints = endpoints.filter((e) => e.type === "jira");
  for (const key of refs.jiraKeys) {
    for (const ep of jiraEndpoints) {
      const ticket = await fetchJiraTicket(key, ep.baseUrl, ep.token);
      if (ticket) {
        tickets.push(ticket);
        break; // Use first matching endpoint
      }
    }
  }

  // Fetch Linear tickets
  const linearEndpoints = endpoints.filter((e) => e.type === "linear");
  for (const key of refs.jiraKeys) {
    // Linear uses same key format as Jira
    for (const ep of linearEndpoints) {
      const ticket = await fetchLinearTicket(key, ep.token || "");
      if (ticket) {
        tickets.push(ticket);
        break;
      }
    }
  }

  // Build context text
  let contextText = "";
  if (tickets.length > 0) {
    contextText = "## Business Context (External Tickets)\n\n";
    for (const t of tickets) {
      contextText += `### ${t.key}: ${t.title}\n`;
      contextText += `- **Status:** ${t.status}\n`;
      contextText += `- **Type:** ${t.type}\n`;
      contextText += `- **Priority:** ${t.priority}\n`;
      if (t.url) contextText += `- **Link:** ${t.url}\n`;
      if (t.body) contextText += `\n${t.body.slice(0, 1000)}\n`;
      contextText += "\n";
    }
  }

  return {
    tickets,
    totalTickets: tickets.length,
    contextText,
  };
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/** Parse MCP endpoint config from action inputs */
export function parseMCPEndpoints(): MCPEndpoint[] {
  const endpoints: MCPEndpoint[] = [];

  // Jira: single endpoint from inputs
  const jiraUrl = core.getInput("jira_base_url") || process.env.MIZUMI_JIRA_BASE_URL || "";
  const jiraToken = core.getInput("jira_api_token") || process.env.MIZUMI_JIRA_API_TOKEN || "";
  const jiraPrefix = core.getInput("jira_project_prefix") || process.env.MIZUMI_JIRA_PROJECT_PREFIX || "";
  if (jiraUrl && jiraToken) {
    endpoints.push({
      type: "jira",
      baseUrl: jiraUrl,
      token: jiraToken,
      projectPrefix: jiraPrefix || undefined,
    });
  }

  // Linear: single endpoint from inputs
  const linearToken = core.getInput("linear_api_token") || process.env.MIZUMI_LINEAR_API_TOKEN || "";
  const linearPrefix = core.getInput("linear_project_prefix") || process.env.MIZUMI_LINEAR_PROJECT_PREFIX || "";
  if (linearToken) {
    endpoints.push({
      type: "linear",
      baseUrl: "https://api.linear.app",
      token: linearToken,
      projectPrefix: linearPrefix || undefined,
    });
  }

  return endpoints;
}
