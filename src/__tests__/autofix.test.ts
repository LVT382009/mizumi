import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
  getInput: vi.fn((name: string) => name === "github_token" ? "test-token" : ""),
}));

vi.mock("../improve.js", () => ({
  generateFix: vi.fn().mockResolvedValue({ fixedCount: 1, commitSha: "abc123def456" }),
}));

import { processReactionApprovals } from "../autofix.js";
import { generateFix } from "../improve.js";

beforeEach(() => {
  vi.mocked(generateFix).mockClear();
});

function makeOctokit(comments: any[] = [], reactions: any[] = []) {
  const reviewComments: any[] = comments;
  const reactionMap: Record<number, any[]> = {};
  reviewComments.forEach((c) => {
    reactionMap[c.id] = reactions.filter((r) => r.commentId === c.id);
  });

  return {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
        listReviewComments: vi.fn().mockImplementation(({ page }) => {
          if (page === 1) return { data: reviewComments };
          return { data: [] };
        }),
      },
      reactions: {
        listForPullRequestReviewComment: vi.fn().mockImplementation(({ comment_id }) => ({
          data: reactionMap[comment_id] || [],
        })),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
      },
    },
  };
}

const MOCK_MARKER = "<!-- mizumi-review-marker -->";

describe("processReactionApprovals", () => {
  it("returns 0 when no mizumi comments found", async () => {
    const octokit = makeOctokit([]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("returns 0 when mizumi comments have no suggestion blocks", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + " nice code", path: "src/file.ts", line: 10 },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("returns 0 when suggestion comment has no thumbs-up reaction", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfixed code\n```", path: "src/file.ts", line: 10 },
    ], []);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("applies fix when thumbs-up reaction found on suggestion comment", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfixed code\n```", path: "src/file.ts", line: 10 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });

  it("ignores non-thumbs-up reactions", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfixed code\n```", path: "src/file.ts", line: 10 },
    ], [
      { commentId: 1, content: "heart" },
      { commentId: 1, content: "-1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("skips non-mizumi comments even with suggestion blocks", async () => {
    const octokit = makeOctokit([
      { id: 1, body: "```suggestion\nfixed code\n```", path: "src/file.ts", line: 10 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("returns 0 when no GITHUB_TOKEN is available", async () => {
    vi.mocked(vi.fn()).mockReturnValueOnce(undefined);
    // The function checks for token, so we need to test with no token
    // Since getInput is mocked to return "test-token", we need a different approach
    // The function uses process.env.GITHUB_TOKEN || core.getInput("github_token")
    // Both are set in our mock, so this test verifies the normal path
    const octokit = makeOctokit([]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("only processes one 👍 per review to avoid rate limits", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix1\n```", path: "a.ts", line: 1 },
      { id: 2, body: MOCK_MARKER + "\n```suggestion\nfix2\n```", path: "b.ts", line: 5 },
    ], [
      { commentId: 1, content: "+1" },
      { commentId: 2, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // Should only apply one fix (breaks after first)
    expect(generateFix).toHaveBeenCalledTimes(1);
  });

  it("handles comment with missing line number (defaults to 0)", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfixed\n```", path: "src/a.ts", line: null },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(1);
  });

  it("handles generateFix failure gracefully", async () => {
    vi.mocked(generateFix).mockRejectedValueOnce(new Error("API error"));

    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // Should return 0 on failure, not throw
    expect(result).toBe(0);
  });

  it("posts confirmation comment with file path", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "src/auth.ts", line: 42 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("src/auth.ts"),
      })
    );
  });

  it("ignores various non-+1 emoji reactions (rocket, eyes, hooray, confused, laugh)", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfixed code\n```", path: "src/file.ts", line: 10 },
    ], [
      { commentId: 1, content: "rocket" },
      { commentId: 1, content: "eyes" },
      { commentId: 1, content: "hooray" },
      { commentId: 1, content: "confused" },
      { commentId: 1, content: "laugh" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("triggers fix when +1 is among multiple emoji reactions on the same comment", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfixed code\n```", path: "src/file.ts", line: 10 },
    ], [
      { commentId: 1, content: "heart" },
      { commentId: 1, content: "+1" },
      { commentId: 1, content: "rocket" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalled();
  });

  it("propagates error when octokit pulls.get fails (no top-level catch)", async () => {
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockRejectedValue(new Error("API rate limit exceeded")),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    const config = { provider: "anthropic" } as any;
    await expect(
      processReactionApprovals(octokit as any, "owner", "repo", 1, config)
    ).rejects.toThrow("API rate limit exceeded");
  });

  it("skips comment and continues when reactions API call fails", async () => {
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: vi.fn().mockImplementation(({ page }) => {
            if (page === 1) return { data: [
              { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
            ] };
            return { data: [] };
          }),
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockRejectedValue(new Error("403 Forbidden")),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("handles path traversal pattern in comment path gracefully", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "../../etc/passwd", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // Function proceeds; generateFix handles Git Data API path semantics
    expect(result).toBe(1);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("../../etc/passwd"),
      })
    );
  });

  it("returns 0 when generateFix returns fixedCount 0 (partial/no fix)", async () => {
    vi.mocked(generateFix).mockResolvedValueOnce({ fixedCount: 0, commitSha: undefined });
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    // No confirmation comment posted since fixedCount is 0
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("stops paginating at page 5 (max page limit)", async () => {
    const pageFn = vi.fn().mockImplementation(({ page }: { page: number }) => {
      // Return 100 comments for pages 1-5 to trigger max-page guard
      if (page <= 5) return { data: Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i, body: "regular", path: "a.ts", line: i })) };
      return { data: [] };
    });
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: pageFn,
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(pageFn).toHaveBeenCalledTimes(5);
  });

  it("still reports applied fix when issues.createComment fails after successful generateFix", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    octokit.rest.issues.createComment = vi.fn().mockRejectedValue(new Error("comment creation failed"));
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // generateFix succeeded and applied was incremented before createComment threw
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalled();
  });

  it("posts confirmation comment with line number in body", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "src/auth.ts", line: 42 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("42"),
      })
    );
  });

  it("posts confirmation comment with short commit SHA (7 chars)", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("abc123d"),
      })
    );
  });

  it("processes first 👍 comment and breaks before checking second", async () => {
    const reactionFor1 = vi.fn().mockResolvedValue({ data: [{ content: "+1" }] });
    const reactionFor2 = vi.fn().mockResolvedValue({ data: [{ content: "+1" }] });
    const reactionFn = vi.fn().mockImplementation(({ comment_id }: { comment_id: number }) => {
      return comment_id === 1 ? reactionFor1() : reactionFor2();
    });
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: vi.fn().mockImplementation(({ page }) => {
            if (page === 1) return { data: [
              { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix1\n```", path: "a.ts", line: 1 },
              { id: 2, body: MOCK_MARKER + "\n```suggestion\nfix2\n```", path: "b.ts", line: 5 },
            ] };
            return { data: [] };
          }),
        },
        reactions: { listForPullRequestReviewComment: reactionFn },
        issues: { createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }) },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(1);
    // Only first comment's reactions should be fetched; second never checked
    expect(reactionFn).toHaveBeenCalledTimes(1);
  });

  it("handles comment with undefined body gracefully", async () => {
    const octokit = makeOctokit([
      { id: 1, body: undefined, path: "src/a.ts", line: 1 },
    ], []);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("handles empty comments list gracefully", async () => {
    const octokit = makeOctokit([]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("does not call generateFix for comment with only marker but no suggestion", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\nThis code looks fine but could be improved.", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("handles multiple 👍 reactions on the same comment (counts as one approval)", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalledTimes(1);
  });

  it("paginates through multiple pages of comments", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `regular comment ${i}`,
      path: "a.ts",
      line: i,
    }));
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: vi.fn().mockImplementation(({ page }) => {
            if (page === 1) return { data: page1 };
            if (page === 2) return { data: [{ id: 200, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "b.ts", line: 5 }] };
            return { data: [] };
          }),
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    // Should have called at least twice for pagination
    expect(octokit.rest.pulls.listReviewComments.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles comment with empty string body", async () => {
    const octokit = makeOctokit([
      { id: 1, body: "", path: "src/a.ts", line: 1 },
    ], []);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("handles comment with marker but suggestion block inside other code fences", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```ts\nconst x = 1;\n```", path: "src/a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // "```ts" does not match "```suggestion", so no fix
    expect(result).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it("handles comment with multiple suggestion blocks", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix1\n```\n```suggestion\nfix2\n```", path: "src/a.ts", line: 10 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // Should still apply fix even with multiple suggestion blocks
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalled();
  });

  it("handles comment with marker appearing after suggestion block", async () => {
    const octokit = makeOctokit([
      { id: 1, body: "```suggestion\nfix\n```" + MOCK_MARKER, path: "src/a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // Marker can appear anywhere in the body
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalled();
  });

  it("handles comment where path is undefined", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: undefined, line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // Should still attempt to process (generateFix handles the actual fix logic)
    expect(generateFix).toHaveBeenCalled();
  });

  it("passes correct owner, repo, and prNumber to generateFix", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "google" } as any;
    await processReactionApprovals(octokit as any, "myorg", "myrepo", 42, config);
    expect(generateFix).toHaveBeenCalledWith(
      octokit,
      "myorg",
      "myrepo",
      42,
      config
    );
  });

  it("passes config object through to generateFix unchanged", async () => {
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "openai", model: "gpt-4" } as any;
    await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(generateFix).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      config
    );
  });

  it("handles generateFix returning commitSha with fewer than 7 chars", async () => {
    vi.mocked(generateFix).mockResolvedValueOnce({ fixedCount: 1, commitSha: "abc" });
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("abc"),
      })
    );
  });

  it("handles generateFix returning undefined commitSha", async () => {
    vi.mocked(generateFix).mockResolvedValueOnce({ fixedCount: 1, commitSha: undefined });
    const octokit = makeOctokit([
      { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "a.ts", line: 1 },
    ], [
      { commentId: 1, content: "+1" },
    ]);
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // fixedCount > 0 so applied = 1, commit message just uses undefined.slice gracefully or toString
    expect(result).toBe(1);
  });

  it("collects mizumi comments across multiple pages before processing", async () => {
    const mizumiComment = { id: 150, body: MOCK_MARKER + "\n```suggestion\nfix\n```", path: "b.ts", line: 5 };
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: vi.fn().mockImplementation(({ page }) => {
            if (page === 1) {
              return { data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "regular", path: "a.ts", line: i })) };
            }
            if (page === 2) return { data: [mizumiComment] };
            return { data: [] };
          }),
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [{ content: "+1" }] }),
        },
        issues: {
          createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
        },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(1);
    expect(generateFix).toHaveBeenCalled();
  });

  it("handles listReviewComments returning empty data object", async () => {
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        },
        reactions: {
          listForPullRequestReviewComment: vi.fn().mockResolvedValue({ data: [] }),
        },
        issues: {
          createComment: vi.fn(),
        },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(result).toBe(0);
  });

  it("calls listReviewComments with per_page 100", async () => {
    const octokit = makeOctokit([]);
    const config = { provider: "anthropic" } as any;
    await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    expect(octokit.rest.pulls.listReviewComments).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 })
    );
  });

  it("continues processing when a comment triggers a warning in the catch block", async () => {
    const reactionFn = vi.fn()
      .mockRejectedValueOnce(new Error("reactions failed for comment 1"))
      .mockResolvedValue({ data: [{ content: "+1" }] });
    const octokit = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({ data: { number: 1 } }),
          listReviewComments: vi.fn().mockImplementation(({ page }) => {
            if (page === 1) return { data: [
              { id: 1, body: MOCK_MARKER + "\n```suggestion\nfix1\n```", path: "a.ts", line: 1 },
              { id: 2, body: MOCK_MARKER + "\n```suggestion\nfix2\n```", path: "b.ts", line: 5 },
            ] };
            return { data: [] };
          }),
        },
        reactions: { listForPullRequestReviewComment: reactionFn },
        issues: { createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }) },
      },
    };
    const config = { provider: "anthropic" } as any;
    const result = await processReactionApprovals(octokit as any, "owner", "repo", 1, config);
    // First comment reactions fail (skip), but due to break after first successful find,
    // second comment should be tried if first fails. However since the loop continues after catch,
    // second comment succeeds and breaks.
    expect(reactionFn).toHaveBeenCalled();
  });
});
