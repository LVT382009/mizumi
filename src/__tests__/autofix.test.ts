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
});
