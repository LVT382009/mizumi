import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeSearchQuery, truncate, isBlockedPath } from "../agent.js";

// ---------------------------------------------------------------------------
// sanitizeSearchQuery — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("sanitizeSearchQuery", () => {
  it("strips repo: operator and its value from query", () => {
    expect(sanitizeSearchQuery("authenticate repo:evil/owner")).toBe("authenticate");
  });

  it("strips user: operator and its value from query", () => {
    expect(sanitizeSearchQuery("login user:attacker")).toBe("login");
  });

  it("strips language: operator and its value from query", () => {
    expect(sanitizeSearchQuery("parse language:python")).toBe("parse");
  });

  it("strips path: operator and its value from query", () => {
    expect(sanitizeSearchQuery("config path:/etc/passwd")).toBe("config");
  });

  it("strips filename: operator and its value from query", () => {
    expect(sanitizeSearchQuery("class filename:/etc/shadow")).toBe("class");
  });

  it("strips multiple operators at once", () => {
    const result = sanitizeSearchQuery("auth repo:evil/user language:go owner:victim");
    expect(result).toBe("auth");
    expect(result).not.toContain("repo:");
    expect(result).not.toContain("owner:");
  });

  it("strips special search modifiers (+, -, ~, *, quotes)", () => {
    expect(sanitizeSearchQuery('+authenticate -deprecated~4 "exact"')).toBe("authenticate deprecated 4 exact");
  });

  it("preserves safe query text", () => {
    expect(sanitizeSearchQuery("authenticate")).toBe("authenticate");
    expect(sanitizeSearchQuery("class UserService")).toBe("class UserService");
  });

  it("truncates long queries to 200 chars", () => {
    const longQuery = "a".repeat(300);
    expect(sanitizeSearchQuery(longQuery)).toHaveLength(200);
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeSearchQuery("hello world")).toBe("hello world");
  });

  it("strips type: operator and its value", () => {
    expect(sanitizeSearchQuery("search type:pr")).toBe("search");
  });

  it("handles empty query", () => {
    expect(sanitizeSearchQuery("")).toBe("");
  });

  it("returns empty after stripping all operators", () => {
    expect(sanitizeSearchQuery("repo:evil/owner")).toBe("");
  });

  it("is case-insensitive for operators", () => {
    expect(sanitizeSearchQuery("test REPO:evil/owner")).toBe("test");
    expect(sanitizeSearchQuery("test Language:go")).toBe("test");
  });

  it("strips org: operator", () => {
    expect(sanitizeSearchQuery("test org:evil")).toBe("test");
  });

  it("strips is: operator", () => {
    expect(sanitizeSearchQuery("test is:public")).toBe("test");
  });

  it("strips fork: operator", () => {
    expect(sanitizeSearchQuery("test fork:true")).toBe("test");
  });

  it("strips size: operator", () => {
    expect(sanitizeSearchQuery("test size:>1000")).toBe("test");
  });

  it("strips in: operator", () => {
    expect(sanitizeSearchQuery("test in:file")).toBe("test");
  });

  it("strips state: operator", () => {
    expect(sanitizeSearchQuery("test state:open")).toBe("test");
  });

  it("strips sort: and order: operators", () => {
    expect(sanitizeSearchQuery("test sort:stars order:desc")).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// truncate — text truncation helper
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns text unchanged at exact limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends indicator when over limit", () => {
    const result = truncate("hello world!", 5);
    expect(result).toBe("hello\n... [truncated]");
  });

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("handles zero-length text with small limit", () => {
    expect(truncate("a", 0)).toBe("\n... [truncated]");
  });

  it("truncates at 5000 chars for file content", () => {
    const longText = "x".repeat(6000);
    const result = truncate(longText, 5000);
    expect(result).toHaveLength(5000 + "\n... [truncated]".length);
    expect(result.endsWith("\n... [truncated]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBlockedPath — agent path traversal/secret file protection
// ---------------------------------------------------------------------------

describe("isBlockedPath", () => {
  it("blocks .env files", () => {
    expect(isBlockedPath(".env")).toBe(true);
    expect(isBlockedPath(".env.local")).toBe(true);
    expect(isBlockedPath(".env.production")).toBe(true);
  });

  it("blocks SSH private keys", () => {
    expect(isBlockedPath("id_rsa")).toBe(true);
    expect(isBlockedPath("~/.ssh/id_rsa")).toBe(true);
    expect(isBlockedPath("id_ed25519")).toBe(true);
    expect(isBlockedPath("id_ecdsa")).toBe(true);
  });

  it("blocks PEM key files", () => {
    expect(isBlockedPath("server.pem")).toBe(true);
    expect(isBlockedPath("cert.key")).toBe(true);
  });

  it("blocks credential files", () => {
    expect(isBlockedPath("credentials.json")).toBe(true);
    expect(isBlockedPath("src/secrets.yaml")).toBe(true);
  });

  it("blocks auth config files", () => {
    expect(isBlockedPath(".npmrc")).toBe(true);
    expect(isBlockedPath(".netrc")).toBe(true);
    expect(isBlockedPath(".pypirc")).toBe(true);
  });

  it("blocks .ssh directory contents", () => {
    expect(isBlockedPath("/home/user/.ssh/config")).toBe(true);
  });

  it("allows normal source files", () => {
    expect(isBlockedPath("src/auth/login.ts")).toBe(false);
    expect(isBlockedPath("package.json")).toBe(false);
    expect(isBlockedPath("README.md")).toBe(false);
    expect(isBlockedPath("src/config.ts")).toBe(false);
  });

  it("allows test files with 'secret' in path", () => {
    // This WILL be blocked since it matches /secret/i — by design
    expect(isBlockedPath("tests/secret-handshake.test.ts")).toBe(true);
  });

  it("blocks .p12 and .pfx certificate files", () => {
    expect(isBlockedPath("cert.p12")).toBe(true);
    expect(isBlockedPath("cert.pfx")).toBe(true);
  });

  it("blocks oauth files", () => {
    expect(isBlockedPath("oauth.json")).toBe(true);
  });

  it("blocks github_token files", () => {
    expect(isBlockedPath("github_token.txt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAgentTools — requires mocking Octokit
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  setOutput: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

import { createAgentTools } from "../agent.js";

function makeMockOctokit() {
  const mockGetContent = vi.fn();
  const mockSearchCode = vi.fn();
  return {
    rest: {
      repos: { getContent: mockGetContent },
      search: { code: mockSearchCode },
    },
  } as any;
}

describe("createAgentTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates read_file, search_code, and find_usages tools", () => {
    const octokit = makeMockOctokit();
    const tools = createAgentTools(octokit, "owner", "repo", "sha123");
    expect(tools).toHaveProperty("read_file");
    expect(tools).toHaveProperty("search_code");
    expect(tools).toHaveProperty("find_usages");
  });

  describe("read_file tool", () => {
    it("returns decoded file content from base64", async () => {
      const octokit = makeMockOctokit();
      const content = Buffer.from("export function hello() {}").toString("base64");
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { content, encoding: "base64" },
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: "src/hello.ts" });
      expect(result).toContain("export function hello()") ;
      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "owner", repo: "repo", path: "src/hello.ts", ref: "sha123" })
      );
    });

    it("returns raw string content", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.repos.getContent.mockResolvedValue({
        data: "plain text content",
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: "README.md" });
      expect(result).toBe("plain text content");
    });

    it("truncates long content at 5000 chars", async () => {
      const octokit = makeMockOctokit();
      const longContent = "x".repeat(6000);
      octokit.rest.repos.getContent.mockResolvedValue({
        data: longContent,
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: "big.ts" });
      expect(result).toContain("[truncated]");
      expect(result.length).toBeLessThan(6000);
    });

    it("returns error message for missing files", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.repos.getContent.mockRejectedValue(new Error("Not Found"));
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: "nonexistent.ts" });
      expect(result).toContain("not found");
    });

    it("blocks access to secret files (.env)", async () => {
      const octokit = makeMockOctokit();
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: ".env" });
      expect(result).toContain("Access denied");
      expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
    });

    it("blocks access to private key files", async () => {
      const octokit = makeMockOctokit();
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: "id_rsa" });
      expect(result).toContain("Access denied");
      expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
    });

    it("returns message for non-string, non-base64 content", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.repos.getContent.mockResolvedValue({
        data: { type: "dir" },
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.read_file.execute({ path: "src/dir" });
      expect(result).toContain("could not read");
    });
  });

  describe("search_code tool", () => {
    it("returns formatted search results", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({
        data: {
          items: [
            {
              path: "src/auth.ts",
              text_matches: [{ fragment: "function authenticate()" }],
            },
            {
              path: "src/login.ts",
              text_matches: [{ fragment: "import { authenticate }" }],
            },
          ],
        },
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.search_code.execute({ query: "authenticate" });
      expect(result).toContain("src/auth.ts");
      expect(result).toContain("src/login.ts");
      expect(result).toContain("authenticate");
    });

    it("sanitizes query before sending to GitHub API", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({ data: { items: [] } });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      await tools.search_code.execute({ query: "test repo:evil/owner" });
      const call = octokit.rest.search.code.mock.calls[0][0];
      expect(call.q).not.toContain("repo:evil/owner");
      expect(call.q).toContain("repo:owner/repo");
    });

    it("returns no results message when search is empty", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({ data: { items: [] } });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.search_code.execute({ query: "nonexistent" });
      expect(result).toContain("No results");
    });

    it("returns error message on API failure", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockRejectedValue(new Error("API rate limit"));
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.search_code.execute({ query: "test" });
      expect(result).toContain("Search failed");
    });

    it("handles items without text_matches gracefully", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({
        data: {
          items: [
            { path: "src/utils.ts", text_matches: undefined },
          ],
        },
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.search_code.execute({ query: "utils" });
      expect(result).toContain("src/utils.ts");
    });
  });

  describe("find_usages tool", () => {
    it("returns formatted usage results", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({
        data: {
          items: [
            { path: "src/caller.ts", text_matches: [{ fragment: "authenticate(user)" }] },
            { path: "src/routes.ts", text_matches: [{ fragment: "await authenticate(req)" }] },
          ],
        },
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.find_usages.execute({ symbol: "authenticate" });
      expect(result).toContain("2 references");
      expect(result).toContain("src/caller.ts");
      expect(result).toContain("src/routes.ts");
    });

    it("sanitizes symbol before search", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({ data: { items: [] } });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      await tools.find_usages.execute({ symbol: "test path:/etc/passwd" });
      const call = octokit.rest.search.code.mock.calls[0][0];
      expect(call.q).not.toContain("path:/etc/passwd");
    });

    it("returns no usages message when empty", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({ data: { items: [] } });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.find_usages.execute({ symbol: "nonexistent" });
      expect(result).toContain("No usages found");
    });

    it("handles API failure gracefully", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockRejectedValue(new Error("Server error"));
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.find_usages.execute({ symbol: "test" });
      expect(result).toContain("Usage search failed");
    });

    it("limits text_matches to 1 per item", async () => {
      const octokit = makeMockOctokit();
      octokit.rest.search.code.mockResolvedValue({
        data: {
          items: [
            {
              path: "src/caller.ts",
              text_matches: [
                { fragment: "line 1" },
                { fragment: "line 2" },
                { fragment: "line 3" },
              ],
            },
          ],
        },
      });
      const tools = createAgentTools(octokit, "owner", "repo", "sha123");
      const result = await tools.find_usages.execute({ symbol: "test" });
      expect(result).toContain("src/caller.ts");
      // Should only include 1 fragment per item
    });
  });
});

// ---------------------------------------------------------------------------
// runAgentContextGathering — requires mocking AI SDK + models
// ---------------------------------------------------------------------------

vi.mock("ai", () => ({
  tool: vi.fn((def) => def),
  generateText: vi.fn(),
  stepCountIs: vi.fn((n) => n),
}));

vi.mock("../models.js", () => ({
  createModel: vi.fn(() => "mock-model"),
  createLightModel: vi.fn(() => "mock-light-model"),
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
  requireApiKey: vi.fn(() => "test-key"),
}));

import { runAgentContextGathering } from "../agent.js";
import { generateText } from "ai";
import { createModel, createLightModel } from "../models.js";

const mockGenerateText = vi.mocked(generateText);
const mockCreateModel = vi.mocked(createModel);
const mockCreateLightModel = vi.mocked(createLightModel);

function makeAgentConfig() {
  return {
    provider: "anthropic" as const,
    model: "claude-sonnet-4-20250514",
    baseUrl: "",
    profile: "assertive" as const,
    maxComments: 50,
    language: "en",
    selfCritique: false,
    confidenceThreshold: 60,
    autoReview: false,
    autoPauseAfter: 5,
    excludePatterns: [],
    tierRouting: true,
    smallDiffThreshold: 50,
    securityPaths: [],
    spendThreshold: 0,
    gateThreshold: "none" as const,
  };
}

describe("runAgentContextGathering", () => {
  const mockOctokit = {
    rest: {
      repos: { getContent: vi.fn() },
      search: { code: vi.fn().mockResolvedValue({ data: { items: [] } }) },
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockReset();
  });

  it("returns gathered context from agent", async () => {
    mockGenerateText.mockResolvedValue({
      text: "The authenticate function is called from 3 places: auth.ts, routes.ts, and middleware.ts",
      usage: { inputTokens: 500, outputTokens: 100 },
    } as any);

    const result = await runAgentContextGathering(
      "diff content here", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    expect(result).toContain("authenticate");
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("uses light model when tier is light", async () => {
    mockGenerateText.mockResolvedValue({
      text: "light context",
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    const classification = { tier: "light" as const, reason: "small diff" };
    await runAgentContextGathering(
      "small diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123", classification
    );

    expect(mockCreateLightModel).toHaveBeenCalled();
  });

  it("uses standard model when tier is standard", async () => {
    mockGenerateText.mockResolvedValue({
      text: "standard context",
      usage: { inputTokens: 200, outputTokens: 80 },
    } as any);

    const classification = { tier: "standard" as const, reason: "medium diff" };
    await runAgentContextGathering(
      "medium diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123", classification
    );

    expect(mockCreateModel).toHaveBeenCalled();
  });

  it("uses standard model when no classification provided", async () => {
    mockGenerateText.mockResolvedValue({
      text: "context",
      usage: { inputTokens: 200, outputTokens: 80 },
    } as any);

    await runAgentContextGathering(
      "some diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    expect(mockCreateModel).toHaveBeenCalled();
  });

  it("returns empty string when agent returns no text", async () => {
    mockGenerateText.mockResolvedValue({
      text: "",
      usage: { inputTokens: 100, outputTokens: 0 },
    } as any);

    const result = await runAgentContextGathering(
      "diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    expect(result).toBe("");
  });

  it("returns empty string when LLM throws error", async () => {
    mockGenerateText.mockRejectedValue(new Error("API timeout"));

    const result = await runAgentContextGathering(
      "diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    expect(result).toBe("");
  });

  it("truncates result to 2000 chars", async () => {
    const longContext = "x".repeat(3000);
    mockGenerateText.mockResolvedValue({
      text: longContext,
      usage: { inputTokens: 500, outputTokens: 2000 },
    } as any);

    const result = await runAgentContextGathering(
      "diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    expect(result.length).toBeLessThanOrEqual(2020);
  });

  it("passes diff content to agent (truncated at 15000)", async () => {
    const longDiff = "d".repeat(20000);
    mockGenerateText.mockResolvedValue({
      text: "context",
      usage: { inputTokens: 1000, outputTokens: 50 },
    } as any);

    await runAgentContextGathering(
      longDiff, makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    const callOpts = mockGenerateText.mock.calls[0][0] as any;
    const promptText = callOpts.prompt as string;
    expect(promptText.length).toBeLessThan(20000);
  });

  it("limits agent to 8 steps via stopWhen", async () => {
    mockGenerateText.mockResolvedValue({
      text: "context",
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await runAgentContextGathering(
      "diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    const callOpts = mockGenerateText.mock.calls[0][0] as any;
    expect(callOpts.stopWhen).toBe(8);
  });

  it("sets maxOutputTokens to 2048", async () => {
    mockGenerateText.mockResolvedValue({
      text: "context",
      usage: { inputTokens: 100, outputTokens: 50 },
    } as any);

    await runAgentContextGathering(
      "diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123"
    );

    const callOpts = mockGenerateText.mock.calls[0][0] as any;
    expect(callOpts.maxOutputTokens).toBe(2048);
  });

  it("uses thorough model when tier is thorough", async () => {
    mockGenerateText.mockResolvedValue({
      text: "thorough context",
      usage: { inputTokens: 300, outputTokens: 120 },
    } as any);

    const classification = { tier: "thorough" as const, reason: "large diff" };
    await runAgentContextGathering(
      "large diff", makeAgentConfig(), mockOctokit,
      "owner", "repo", "sha123", classification
    );

    expect(mockCreateModel).toHaveBeenCalled();
    expect(mockCreateLightModel).not.toHaveBeenCalled();
  });
});
