import { describe, it, expect, vi, beforeEach } from "vitest";
import { countMizumiReviews, getLatestFindings, createOrUpdateSpendComment, SPEND_MARKER } from "../helpers.js";

const MARKER = "<!-- mizumi-review-marker -->";

function makeMockOctokit() {
  const listComments = vi.fn();
  const listReviews = vi.fn();
  const listReviewComments = vi.fn();
  const updateComment = vi.fn().mockResolvedValue({});
  const createComment = vi.fn().mockResolvedValue({});
  return {
    rest: {
      issues: { listComments, updateComment, createComment },
      pulls: { listReviews, listReviewComments },
    },
  } as any;
}

describe("countMizumiReviews", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 0 when no Mizumi comments exist", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(0);
  });

  it("counts Mizumi issue comments with marker", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { body: `${MARKER}\n## Mizumi Review` },
        { body: "Some other comment" },
        { body: `${MARKER}\n## Mizumi Review 2` },
      ],
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(2);
  });

  it("counts Mizumi PR reviews with marker", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        { body: `${MARKER}\nReview 1` },
        { body: `${MARKER}\nReview 2` },
      ],
    });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(2);
  });

  it("combines issue comments and PR reviews", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: `${MARKER}\nComment 1` }],
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [{ body: `${MARKER}\nReview 1` }],
    });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(2);
  });

  it("paginates through multiple pages of comments", async () => {
    const octokit = makeMockOctokit();
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      body: i % 3 === 0 ? `${MARKER}\nReview` : "other",
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      body: i % 5 === 0 ? `${MARKER}\nReview` : "other",
    }));
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBeGreaterThan(0);
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
  });

  it("caps at 10 pages to prevent runaway", async () => {
    const octokit = makeMockOctokit();
    // Return full pages forever
    octokit.rest.issues.listComments.mockResolvedValue({
      data: Array.from({ length: 100 }, () => ({ body: "comment" })),
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(octokit.rest.issues.listComments.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("skips comments with null body without error", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: null }, { body: undefined }, { body: `${MARKER}\nReview` }],
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(1);
  });

  it("skips reviews with null body without error", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [{ body: null }, { body: `${MARKER}\nReview 1` }, { body: undefined }],
    });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(1);
  });

  it("exact combined count across issue comments and reviews", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { body: `${MARKER}\nComment A` },
        { body: "regular" },
        { body: `${MARKER}\nComment B` },
      ],
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        { body: `${MARKER}\nReview C` },
        { body: "normal review" },
      ],
    });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(3);
  });

  it("propagates error when issues.listComments API fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockRejectedValue(new Error("API rate limit"));
    await expect(countMizumiReviews(octokit, "owner", "repo", 7)).rejects.toThrow("API rate limit");
  });
});

describe("getLatestFindings", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns empty array when no review comments", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: [] });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toEqual([]);
  });

  it("parses severity and category from inline comments", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**[HIGH] security**: SQL injection\n**Severity:** High\n**Category:** Security\n\`\`\`suggestion\nconst safe = db.escape(input)\n\`\`\``,
        path: "src/auth.ts",
        line: 42,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/auth.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("security");
  });

  it("extracts suggestion blocks", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**[MEDIUM] bug**: Null ref\n**Severity:** Medium\n**Category:** Bug\n\`\`\`suggestion\nif (x !== null) { x.method() }\n\`\`\``,
        path: "src/app.ts",
        line: 10,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].suggestion).toBe("if (x !== null) { x.method() }");
  });

  it("defaults to medium/bug when regex fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\nSome finding without standard format`,
        path: "src/util.ts",
        line: 5,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].category).toBe("bug");
  });

  it("limits to 20 most recent findings", async () => {
    const octokit = makeMockOctokit();
    const comments = Array.from({ length: 30 }, (_, i) => ({
      body: `${MARKER}\n**Severity:** Low\n**Category:** Style\nFinding ${i}`,
      path: `file${i}.ts`,
      line: i,
    }));
    octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: comments });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(20);
  });

  it("skips non-Mizumi comments", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [
        { body: "Regular reviewer comment", path: "a.ts", line: 1 },
        { body: `${MARKER}\n**Severity:** Low\n**Category:** Style\nStyle issue`, path: "b.ts", line: 2 },
      ],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("b.ts");
  });

  it("strips HTML tags from message", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** High\n**Category:** Security\n<details><summary>Click</summary>\nSQL injection in query\n</details>`,
        path: "src/db.ts",
        line: 15,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].message).not.toContain("<details>");
    expect(findings[0].message).not.toContain("</details>");
  });

  it("returns empty array when no comments match the marker", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [
        { body: "Generic review comment", path: "a.ts", line: 1 },
        { body: "LGTM", path: "b.ts", line: 2 },
      ],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toEqual([]);
  });

  it("defaults line to 0 when line field is null", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** High\n**Category:** Security\nFinding`,
        path: "src/x.ts",
        line: null,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].line).toBe(0);
  });

  it("truncates message to 200 characters", async () => {
    const octokit = makeMockOctokit();
    const longBody = `${MARKER}\n**Severity:** Low\n**Category:** Style\n` + "A".repeat(300);
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{ body: longBody, path: "src/long.ts", line: 1 }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].message.length).toBeLessThanOrEqual(200);
  });

  it("propagates error when pulls.listReviewComments API fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockRejectedValue(new Error("server error"));
    await expect(getLatestFindings(octokit, "owner", "repo", 7)).rejects.toThrow("server error");
  });
});

describe("createOrUpdateSpendComment", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("creates a new comment when no existing spend marker found", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "spend body");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: "spend body" })
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates existing comment when spend marker found", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 100, body: `Some comment\n${SPEND_MARKER}\nold spend data` },
      ],
    });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "new spend body");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 100, body: "new spend body" })
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("paginates to find spend marker across pages", async () => {
    const octokit = makeMockOctokit();
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i, body: "regular comment",
    }));
    const page2 = [
      { id: 200, body: `${SPEND_MARKER}\nold spend` },
    ];
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "updated spend");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 200 })
    );
  });

  it("stops pagination when comments < 100", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: Array.from({ length: 50 }, (_, i) => ({ id: i, body: "comment" })),
    });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "new spend");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(1);
  });

  it("finds existing comment to update among mixed comments", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 10, body: "some regular comment" },
        { id: 20, body: `${SPEND_MARKER}\nprevious spend data` },
        { id: 30, body: "another comment" },
      ],
    });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "updated spend");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 20, body: "updated spend" })
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("propagates error when issues.updateComment API fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 50, body: `${SPEND_MARKER}\nold` }],
    });
    octokit.rest.issues.updateComment.mockRejectedValue(new Error("update failed"));
    await expect(createOrUpdateSpendComment(octokit, "owner", "repo", 7, "body")).rejects.toThrow("update failed");
  });

  it("propagates error when issues.createComment API fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.createComment.mockRejectedValue(new Error("create failed"));
    await expect(createOrUpdateSpendComment(octokit, "owner", "repo", 7, "body")).rejects.toThrow("create failed");
  });
});

describe("SPEND_MARKER", () => {
  it("is a valid HTML comment marker", () => {
    expect(SPEND_MARKER).toBe("<!-- mizumi-spend-marker -->");
  });
});
