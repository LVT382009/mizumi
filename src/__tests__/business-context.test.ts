import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractTicketRefs,
  parseMCPEndpoints,
  fetchBusinessContext,
} from "../business-context.js";
import type { MCPEndpoint } from "../business-context.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  getInput: vi.fn(() => ""),
}));

// ---------------------------------------------------------------------------
// extractTicketRefs
// ---------------------------------------------------------------------------

describe("extractTicketRefs", () => {
  it("extracts Jira-style keys from PR body", () => {
    const refs = extractTicketRefs("Fixes PAY-1234 and PAY-5678", "", []);
    expect(refs.jiraKeys).toContain("PAY-1234");
    expect(refs.jiraKeys).toContain("PAY-5678");
    expect(refs.jiraKeys).toHaveLength(2);
  });

  it("extracts Jira keys from PR title", () => {
    const refs = extractTicketRefs("", "[PAY-999] Fix login bug", []);
    expect(refs.jiraKeys).toContain("PAY-999");
  });

  it("extracts GitHub issue refs", () => {
    const refs = extractTicketRefs("Fixes #42 and closes #99", "", []);
    expect(refs.githubIds).toContain(42);
    expect(refs.githubIds).toContain(99);
  });

  it("handles both Jira and GitHub refs in same text", () => {
    const refs = extractTicketRefs("Fixes PAY-100 and closes #42", "", []);
    expect(refs.jiraKeys).toContain("PAY-100");
    expect(refs.githubIds).toContain(42);
  });

  it("deduplicates ticket keys", () => {
    const refs = extractTicketRefs("PAY-100 and PAY-100 again", "", []);
    expect(refs.jiraKeys).toHaveLength(1);
  });

  it("deduplicates GitHub refs", () => {
    const refs = extractTicketRefs("fixes #42 and also #42", "", []);
    expect(refs.githubIds).toHaveLength(1);
  });

  it("ignores lowercase project prefixes", () => {
    const refs = extractTicketRefs("fixes pay-1234", "", []);
    expect(refs.jiraKeys).toHaveLength(0);
  });

  it("extracts multi-letter project prefixes", () => {
    const refs = extractTicketRefs("Refs PROJ-42 and ENG-99", "", []);
    expect(refs.jiraKeys).toContain("PROJ-42");
    expect(refs.jiraKeys).toContain("ENG-99");
  });

  it("handles empty PR body and title", () => {
    const refs = extractTicketRefs("", "", []);
    expect(refs.jiraKeys).toHaveLength(0);
    expect(refs.githubIds).toHaveLength(0);
  });

  it("recognizes various GitHub ref verbs", () => {
    const body = "fixes #1, closes #2, resolves #3, ref #4, refs #5, see #6";
    const refs = extractTicketRefs(body, "", []);
    expect(refs.githubIds).toHaveLength(6);
  });

  it("does not extract from non-ref contexts (just # in text)", () => {
    const refs = extractTicketRefs("This is item #5 on our list", "", []);
    expect(refs.githubIds).toHaveLength(0);
  });

  it("extracts ticket from PR title only when body is empty", () => {
    const refs = extractTicketRefs("", "[CORE-456] Update API", []);
    expect(refs.jiraKeys).toContain("CORE-456");
  });
});

// ---------------------------------------------------------------------------
// parseMCPEndpoints
// ---------------------------------------------------------------------------

describe("parseMCPEndpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any env vars
    delete process.env.MIZUMI_JIRA_BASE_URL;
    delete process.env.MIZUMI_JIRA_API_TOKEN;
    delete process.env.MIZUMI_LINEAR_API_TOKEN;
  });

  it("returns empty when no inputs configured", () => {
    const endpoints = parseMCPEndpoints();
    expect(endpoints).toHaveLength(0);
  });

  it("creates Jira endpoint from env vars", () => {
    process.env.MIZUMI_JIRA_BASE_URL = "https://myorg.atlassian.net";
    process.env.MIZUMI_JIRA_API_TOKEN = "jira-token-123";
    try {
      const endpoints = parseMCPEndpoints();
      const jira = endpoints.find((e) => e.type === "jira");
      expect(jira).toBeDefined();
      expect(jira!.baseUrl).toBe("https://myorg.atlassian.net");
      expect(jira!.token).toBe("jira-token-123");
    } finally {
      delete process.env.MIZUMI_JIRA_BASE_URL;
      delete process.env.MIZUMI_JIRA_API_TOKEN;
    }
  });

  it("creates Linear endpoint from env var", () => {
    process.env.MIZUMI_LINEAR_API_TOKEN = "lin_api_token";
    try {
      const endpoints = parseMCPEndpoints();
      const linear = endpoints.find((e) => e.type === "linear");
      expect(linear).toBeDefined();
      expect(linear!.token).toBe("lin_api_token");
    } finally {
      delete process.env.MIZUMI_LINEAR_API_TOKEN;
    }
  });

  it("requires both URL and token for Jira", () => {
    process.env.MIZUMI_JIRA_BASE_URL = "https://test.atlassian.net";
    // No token
    try {
      const endpoints = parseMCPEndpoints();
      expect(endpoints.filter((e) => e.type === "jira")).toHaveLength(0);
    } finally {
      delete process.env.MIZUMI_JIRA_BASE_URL;
    }
  });

  it("sets project prefix when configured", () => {
    process.env.MIZUMI_JIRA_BASE_URL = "https://test.atlassian.net";
    process.env.MIZUMI_JIRA_API_TOKEN = "token";
    process.env.MIZUMI_JIRA_PROJECT_PREFIX = "PAY";
    try {
      const endpoints = parseMCPEndpoints();
      const jira = endpoints.find((e) => e.type === "jira");
      expect(jira?.projectPrefix).toBe("PAY");
    } finally {
      delete process.env.MIZUMI_JIRA_BASE_URL;
      delete process.env.MIZUMI_JIRA_API_TOKEN;
      delete process.env.MIZUMI_JIRA_PROJECT_PREFIX;
    }
  });
});

// ---------------------------------------------------------------------------
// fetchBusinessContext
// ---------------------------------------------------------------------------

describe("fetchBusinessContext", () => {
  it("returns empty result when no endpoints configured", async () => {
    const result = await fetchBusinessContext("Fixes PAY-100", "", []);
    expect(result.tickets).toHaveLength(0);
    expect(result.contextText).toBe("");
    expect(result.totalTickets).toBe(0);
  });

  it("extracts refs but fetches nothing without endpoints", async () => {
    const result = await fetchBusinessContext("Fixes PAY-100 and closes #42", "", []);
    expect(result.tickets).toHaveLength(0);
  });

  it("builds context text from fetched tickets", async () => {
    // Mock fetch to return a Jira ticket
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fields: {
          summary: "Fix payment bug",
          description: "The payment flow crashes when amount is 0",
          status: { name: "In Progress" },
          issuetype: { name: "Bug" },
          priority: { name: "High" },
        },
      }),
    }) as any;

    try {
      const endpoints: MCPEndpoint[] = [{
        type: "jira",
        baseUrl: "https://test.atlassian.net",
        token: "test-token",
      }];
      const result = await fetchBusinessContext("Fixes PAY-100", "", endpoints);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].key).toBe("PAY-100");
      expect(result.tickets[0].title).toBe("Fix payment bug");
      expect(result.tickets[0].source).toBe("jira");
      expect(result.contextText).toContain("Business Context");
      expect(result.contextText).toContain("PAY-100");
      expect(result.contextText).toContain("High");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles fetch failure gracefully", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    try {
      const endpoints: MCPEndpoint[] = [{
        type: "jira",
        baseUrl: "https://test.atlassian.net",
        token: "test-token",
      }];
      const result = await fetchBusinessContext("Fixes PAY-404", "", endpoints);
      expect(result.tickets).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles network error gracefully", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as any;

    try {
      const endpoints: MCPEndpoint[] = [{
        type: "jira",
        baseUrl: "https://test.atlassian.net",
        token: "test-token",
      }];
      const result = await fetchBusinessContext("Fixes PAY-500", "", endpoints);
      expect(result.tickets).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("strips HTML from Jira description", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fields: {
          summary: "Test",
          description: "<p>Hello <b>world</b></p><script>alert(1)</script>",
          status: { name: "Open" },
          issuetype: { name: "Story" },
          priority: { name: "Medium" },
        },
      }),
    }) as any;

    try {
      const endpoints: MCPEndpoint[] = [{
        type: "jira",
        baseUrl: "https://test.atlassian.net",
        token: "test-token",
      }];
      const result = await fetchBusinessContext("Fixes PAY-101", "", endpoints);
      expect(result.tickets[0].body).not.toContain("<p>");
      expect(result.tickets[0].body).not.toContain("<script>");
      expect(result.tickets[0].body).toContain("Hello world");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("truncates long descriptions to 2000 chars", async () => {
    const originalFetch = global.fetch;
    const longDesc = "x".repeat(5000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fields: {
          summary: "Long desc",
          description: longDesc,
          status: { name: "Open" },
          issuetype: { name: "Task" },
          priority: { name: "Low" },
        },
      }),
    }) as any;

    try {
      const endpoints: MCPEndpoint[] = [{
        type: "jira",
        baseUrl: "https://test.atlassian.net",
        token: "test-token",
      }];
      const result = await fetchBusinessContext("Fixes PAY-200", "", endpoints);
      expect(result.tickets[0].body.length).toBeLessThanOrEqual(2000);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("includes ticket URL in context text", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        fields: {
          summary: "Test",
          description: "",
          status: { name: "Open" },
          issuetype: { name: "Bug" },
          priority: { name: "High" },
        },
      }),
    }) as any;

    try {
      const endpoints: MCPEndpoint[] = [{
        type: "jira",
        baseUrl: "https://myorg.atlassian.net",
        token: "test-token",
      }];
      const result = await fetchBusinessContext("Fixes PAY-300", "", endpoints);
      expect(result.contextText).toContain("atlassian.net/browse/PAY-300");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Additional extractTicketRefs edge cases
// ---------------------------------------------------------------------------

describe("extractTicketRefs additional edge cases", () => {
  it("extracts from various positions in text", () => {
    const refs = extractTicketRefs("Before PAY-111 middle PAY-222 end", "", []);
    expect(refs.jiraKeys).toContain("PAY-111");
    expect(refs.jiraKeys).toContain("PAY-222");
  });

  it("handles project prefix with numbers", () => {
    const refs = extractTicketRefs("Ref PROJ2-42", "", []);
    expect(refs.jiraKeys).toContain("PROJ2-42");
  });

  it("handles single-char ticket numbers", () => {
    const refs = extractTicketRefs("Fixes PAY-1", "", []);
    expect(refs.jiraKeys).toContain("PAY-1");
  });

  it("handles large ticket numbers", () => {
    const refs = extractTicketRefs("See PAY-999999", "", []);
    expect(refs.jiraKeys).toContain("PAY-999999");
  });
});

// ---------------------------------------------------------------------------
// Additional fetchBusinessContext edge cases
// ---------------------------------------------------------------------------

describe("fetchBusinessContext additional edge cases", () => {
  it("handles multiple Jira keys", async () => {
    const originalFetch = global.fetch;
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          fields: { summary: `Ticket ${callCount}`, description: "", status: { name: "Open" }, issuetype: { name: "Bug" }, priority: { name: "Medium" } },
        }),
      });
    }) as any;

    try {
      const endpoints = [{ type: "jira", baseUrl: "https://test.atlassian.net", token: "t" }];
      const result = await fetchBusinessContext("Fixes PAY-100 and PAY-200", "", endpoints);
      expect(result.tickets).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns empty result for text without any refs", async () => {
    const result = await fetchBusinessContext("Just a regular PR description with no ticket refs.", "", []);
    expect(result.tickets).toHaveLength(0);
    expect(result.contextText).toBe("");
  });

  it("handles partial Jira API response", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}), // No fields key
    }) as any;

    try {
      const endpoints = [{ type: "jira", baseUrl: "https://test.atlassian.net", token: "t" }];
      const result = await fetchBusinessContext("Fixes PAY-300", "", endpoints);
      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0].title).toBe("PAY-300"); // Falls back to key
    } finally {
      global.fetch = originalFetch;
    }
  });
});

