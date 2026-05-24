import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitizeSearchQuery, truncate } from "../agent.js";

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
    expect(sanitizeSearchQuery("hello   world")).toBe("hello world");
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
      expect(result).toContain("export function hello()");
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
  });
});
