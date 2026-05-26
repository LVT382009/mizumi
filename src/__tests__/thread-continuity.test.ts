import { describe, it, expect, vi } from "vitest";
import {
  classifyDismissal,
  fetchReviewThreadReplies,
  analyzeThreadContinuity,
} from "../thread-continuity.js";

// ---------------------------------------------------------------------------
// classifyDismissal
// ---------------------------------------------------------------------------

describe("classifyDismissal", () => {
  it("detects intentional dismissal", () => {
    const result = classifyDismissal("This is intentional behavior");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("intentional");
  });

  it("detects 'by design' as intentional", () => {
    const result = classifyDismissal("This is by design per the spec");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("intentional");
  });

  it("detects will-fix-later dismissal", () => {
    const result = classifyDismissal("Will fix in a follow-up PR");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("will-fix-later");
  });

  it("detects tracked in issue as will-fix-later", () => {
    const result = classifyDismissal("Tracked in issue #123");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("will-fix-later");
  });

  it("detects disagree dismissal", () => {
    const result = classifyDismissal("I disagree with this suggestion");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("disagree");
  });

  it("detects not applicable as disagree", () => {
    const result = classifyDismissal("Not applicable here");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("disagree");
  });

  it("detects already-known dismissal", () => {
    const result = classifyDismissal("This is a known issue in legacy code");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("already-known");
  });

  it("detects false positive dismissal", () => {
    const result = classifyDismissal("False positive — not a bug");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("false-positive");
  });

  it("detects won't fix as false positive", () => {
    const result = classifyDismissal("Won't fix this, n/a here");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("false-positive");
  });

  it("returns no dismissal for normal reply", () => {
    const result = classifyDismissal("Good catch, I'll fix this now");
    expect(result.isDismissal).toBe(false);
    expect(result.kind).toBeNull();
  });

  it("returns no dismissal for empty string", () => {
    const result = classifyDismissal("");
    expect(result.isDismissal).toBe(false);
  });

  it("returns no dismissal for question reply", () => {
    const result = classifyDismissal("Can you explain why this matters?");
    expect(result.isDismissal).toBe(false);
  });

  it("detects 'working as intended' as intentional", () => {
    const result = classifyDismissal("This is working as intended");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("intentional");
  });

  it("detects 'expected behavior' as intentional", () => {
    const result = classifyDismissal("This is expected behavior");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("intentional");
  });

  it("detects JIRA reference as will-fix-later", () => {
    const result = classifyDismissal("Tracked in JIRA PROJ-456");
    expect(result.isDismissal).toBe(true);
    expect(result.kind).toBe("will-fix-later");
  });
});

// ---------------------------------------------------------------------------
// fetchReviewThreadReplies
// ---------------------------------------------------------------------------

describe("fetchReviewThreadReplies", () => {
  it("finds author replies to Mizumi comments", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/auth.ts",
                line: 15,
                body: "<!-- mizumi-review-marker -->\n## Security\nMissing auth check here.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 2,
                path: "src/auth.ts",
                line: 15,
                body: "This is intentional — the endpoint is public.",
                user: { login: "pr-author" },
                in_reply_to_id: 1,
              },
            ],
          }),
        },
      },
    } as any;

    const replies = await fetchReviewThreadReplies(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(replies).toHaveLength(1);
    expect(replies[0].file).toBe("src/auth.ts");
    expect(replies[0].line).toBe(15);
    expect(replies[0].replyAuthor).toBe("pr-author");
    expect(replies[0].isDismissal).toBe(true);
    expect(replies[0].dismissalKind).toBe("intentional");
  });

  it("ignores comments without Mizumi marker", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/index.ts",
                line: 1,
                body: "Looks good to me",
                user: { login: "other-reviewer" },
                in_reply_to_id: null,
              },
            ],
          }),
        },
      },
    } as any;

    const replies = await fetchReviewThreadReplies(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(replies).toHaveLength(0);
  });

  it("ignores replies from non-authors", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/auth.ts",
                line: 10,
                body: "<!-- mizumi-review-marker -->\nMissing validation.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 2,
                path: "src/auth.ts",
                line: 10,
                body: "Agreed, this should be fixed.",
                user: { login: "other-dev" },
                in_reply_to_id: 1,
              },
            ],
          }),
        },
      },
    } as any;

    const replies = await fetchReviewThreadReplies(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(replies).toHaveLength(0);
  });

  it("handles API errors gracefully", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockRejectedValue(new Error("API error")),
        },
      },
    } as any;

    const replies = await fetchReviewThreadReplies(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(replies).toHaveLength(0);
  });

  it("handles empty comments list", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as any;

    const replies = await fetchReviewThreadReplies(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(replies).toHaveLength(0);
  });

  it("finds multiple author replies across different threads", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/a.ts",
                line: 10,
                body: "<!-- mizumi-review-marker -->\nBug in handler.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 2,
                path: "src/a.ts",
                line: 10,
                body: "Will fix in a follow-up",
                user: { login: "pr-author" },
                in_reply_to_id: 1,
              },
              {
                id: 3,
                path: "src/b.ts",
                line: 20,
                body: "<!-- mizumi-review-marker -->\nSecurity issue.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 4,
                path: "src/b.ts",
                line: 20,
                body: "I disagree, this is fine.",
                user: { login: "pr-author" },
                in_reply_to_id: 3,
              },
            ],
          }),
        },
      },
    } as any;

    const replies = await fetchReviewThreadReplies(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(replies).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// analyzeThreadContinuity (integration)
// ---------------------------------------------------------------------------

describe("analyzeThreadContinuity", () => {
  it("returns structured result with dismissals", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/auth.ts",
                line: 10,
                body: "<!-- mizumi-review-marker -->\nMissing auth.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 2,
                path: "src/auth.ts",
                line: 10,
                body: "This is intentional.",
                user: { login: "pr-author" },
                in_reply_to_id: 1,
              },
            ],
          }),
        },
      },
    } as any;

    const result = await analyzeThreadContinuity(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(result.threadReplies).toHaveLength(1);
    expect(result.dismissalCount).toBe(1);
    expect(result.contextText).toContain("Author Dismissals");
    expect(result.contextText).toContain("intentional");
    expect(result.bodySummary).toContain("Thread Continuity");
  });

  it("returns empty for no thread replies", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as any;

    const result = await analyzeThreadContinuity(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(result.threadReplies).toHaveLength(0);
    expect(result.dismissalCount).toBe(0);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("does not inject context for non-dismissal replies", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/auth.ts",
                line: 10,
                body: "<!-- mizumi-review-marker -->\nPlease add test.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 2,
                path: "src/auth.ts",
                line: 10,
                body: "Good catch, adding it now!",
                user: { login: "pr-author" },
                in_reply_to_id: 1,
              },
            ],
          }),
        },
      },
    } as any;

    const result = await analyzeThreadContinuity(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(result.threadReplies).toHaveLength(1);
    expect(result.dismissalCount).toBe(0);
    expect(result.contextText).toBe(""); // No dismissals = no context injection
    expect(result.bodySummary).toContain("Thread Continuity"); // Body still shows replies
  });

  it("body summary shows dismissal table", async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {
                id: 1,
                path: "src/a.ts",
                line: 5,
                body: "<!-- mizumi-review-marker -->\nIssue here.",
                user: { login: "mizumi-bot" },
                in_reply_to_id: null,
              },
              {
                id: 2,
                path: "src/a.ts",
                line: 5,
                body: "Won't fix — legacy code.",
                user: { login: "pr-author" },
                in_reply_to_id: 1,
              },
            ],
          }),
        },
      },
    } as any;

    const result = await analyzeThreadContinuity(mockOctokit, "owner", "repo", 42, "pr-author");
    expect(result.bodySummary).toContain("<details>");
    expect(result.bodySummary).toContain("src/a.ts:5");
    expect(result.bodySummary).toContain("</details>");
  });
});
