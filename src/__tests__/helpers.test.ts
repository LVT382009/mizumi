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
});

describe("SPEND_MARKER", () => {
  it("is a valid HTML comment marker", () => {
    expect(SPEND_MARKER).toBe("<!-- mizumi-spend-marker -->");
  });
});
