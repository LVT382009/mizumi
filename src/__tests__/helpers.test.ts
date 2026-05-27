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

  it("returns empty array when pulls.listReviewComments API fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockRejectedValue(new Error("server error"));
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toEqual([]);
  });

  it("falls back to issue comments when no inline review comments", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n## Mizumi Review\n| Severity | Count |\n|----------|-------|\n| high | 2 |\n| low | 1 |\n`,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(3);
    expect(findings.filter((f) => f.severity === "high")).toHaveLength(2);
    expect(findings.filter((f) => f.severity === "low")).toHaveLength(1);
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

describe("countMizumiReviews — additional edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("propagates error when pulls.listReviews API fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.pulls.listReviews.mockRejectedValue(new Error("reviews API down"));
    await expect(countMizumiReviews(octokit, "owner", "repo", 7)).rejects.toThrow("reviews API down");
  });

  it("counts 0 when all issue comments and reviews have null bodies", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: null }, { body: null }],
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [{ body: null }],
    });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(0);
  });

  it("handles a single Mizumi comment among many non-Mizumi comments", async () => {
    const octokit = makeMockOctokit();
    const comments = Array.from({ length: 50 }, (_, i) => ({
      body: i === 25 ? `${MARKER}\nFound one` : `regular comment ${i}`,
    }));
    octokit.rest.issues.listComments.mockResolvedValue({ data: comments });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(1);
  });

  it("counts multiple Mizumi reviews from PR review API", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [
        { body: `${MARKER}\nReview A` },
        { body: "Normal review" },
        { body: `${MARKER}\nReview B` },
        { body: `${MARKER}\nReview C` },
      ],
    });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(3);
  });

  it("paginates exactly 2 pages when first page has 100 and second has fewer", async () => {
    const octokit = makeMockOctokit();
    const page1 = Array.from({ length: 100 }, () => ({ body: "comment" }));
    const page2 = Array.from({ length: 30 }, () => ({ body: "comment" }));
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
  });

  it("passes correct per_page (100) and page params", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    await countMizumiReviews(octokit, "owner", "repo", 42);
    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, per_page: 100, page: 1 })
    );
  });

  it("counts Markers embedded in longer comment bodies", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ body: `Some prefix ${MARKER} Some suffix` }],
    });
    octokit.rest.pulls.listReviews.mockResolvedValue({ data: [] });
    const count = await countMizumiReviews(octokit, "owner", "repo", 7);
    expect(count).toBe(1);
  });
});

describe("getLatestFindings — additional edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("parses critical severity from inline comment", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** Critical\n**Category:** Security\nRCE found`,
        path: "src/handler.ts",
        line: 99,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("parses nitpick severity from inline comment", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** Nitpick\n**Category:** Style\nExtra semicolon`,
        path: "src/style.ts",
        line: 3,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].severity).toBe("nitpick");
  });

  it("handles inline comment with no suggestion block", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** High\n**Category:** Bug\nNo fix provided`,
        path: "src/bug.ts",
        line: 10,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].suggestion).toBeUndefined();
  });

  it("handles inline comment with empty suggestion block", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** Low\n**Category:** Style\n\`\`\`suggestion\n\`\`\``,
        path: "src/empty-sug.ts",
        line: 5,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].suggestion).toBe("");
  });

  it("ignores inline comments without the marker", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [
        { body: "Regular code review comment", path: "a.ts", line: 1 },
        { body: "Another comment without marker", path: "b.ts", line: 2 },
      ],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toEqual([]);
  });

  it("prefers inline findings over summary fallback", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** High\n**Category:** Bug\nReal finding`,
        path: "src/real.ts",
        line: 42,
      }],
    });
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n| Severity | Count |\n|----------|-------|\n| high | 5 |`,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe("src/real.ts");
  });

  it("parses all severity types from summary table", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n## Summary\n| Severity | Count |\n|----------|-------|\n| critical | 1 |\n| high | 2 |\n| medium | 3 |\n| low | 4 |\n| nitpick | 5 |\n`,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toHaveLength(15);
    expect(findings.filter((f) => f.severity === "critical")).toHaveLength(1);
    expect(findings.filter((f) => f.severity === "high")).toHaveLength(2);
    expect(findings.filter((f) => f.severity === "medium")).toHaveLength(3);
    expect(findings.filter((f) => f.severity === "low")).toHaveLength(4);
    expect(findings.filter((f) => f.severity === "nitpick")).toHaveLength(5);
  });

  it("uses most recent summary comment when multiple summaries exist", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { body: `${MARKER}\n| Severity | Count |\n|----------|-------|\n| high | 10 |\n` },
        { body: `${MARKER}\n| Severity | Count |\n|----------|-------|\n| low | 1 |\n` },
      ],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    // Should use first matching summary (iterates and breaks on first match)
    expect(findings).toHaveLength(10);
  });

  it("summary fallback findings have file=unknown and line=0", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({ data: [] });
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n| Severity | Count |\n|----------|-------|\n| high | 1 |\n`,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].file).toBe("unknown");
    expect(findings[0].line).toBe(0);
    expect(findings[0].category).toBe("bug");
  });

  it("returns empty array when issue comments API also fails", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockRejectedValue(new Error("inline fail"));
    octokit.rest.issues.listComments.mockRejectedValue(new Error("summary fail"));
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings).toEqual([]);
  });

  it("handles inline comment with whitespace in severity field", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:**  High  \n**Category:**  Bug  \nWhitespace severity`,
        path: "src/ws.ts",
        line: 8,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    // \s* consumes leading spaces, \w+ captures "High" — trailing spaces are not captured
    expect(findings[0].severity).toBe("high");
  });

  it("strips suggestion trailing newline", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** Medium\n**Category:** Bug\n\`\`\`suggestion\nconst x = 1;\n\`\`\``,
        path: "src/sug.ts",
        line: 12,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].suggestion).toBe("const x = 1;");
    expect(findings[0].suggestion).not.toMatch(/\n$/);
  });

  it("handles message with HTML tags and truncation together", async () => {
    const octokit = makeMockOctokit();
    const longHtml = "<details><summary>" + "X".repeat(300) + "</summary>content</details>";
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** Low\n**Category:** Style\n${longHtml}`,
        path: "src/html.ts",
        line: 5,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].message).not.toContain("<details>");
    expect(findings[0].message.length).toBeLessThanOrEqual(200);
  });

  it("falls back to medium when severity is unrecognized value", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** UnknownLevel\n**Category:** Test\nUnusual severity`,
        path: "src/unusual.ts",
        line: 1,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    // "UnknownLevel" would be captured by regex and toLowerCase becomes "unknownlevel"
    expect(findings[0].severity).toBe("unknownlevel");
  });

  it("falls back to bug when category is missing", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.pulls.listReviewComments.mockResolvedValue({
      data: [{
        body: `${MARKER}\n**Severity:** High\nNo category line at all`,
        path: "src/no-cat.ts",
        line: 7,
      }],
    });
    const findings = await getLatestFindings(octokit, "owner", "repo", 7);
    expect(findings[0].category).toBe("bug");
  });
});

describe("createOrUpdateSpendComment — additional edge cases", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("paginates through 3 pages of comments", async () => {
    const octokit = makeMockOctokit();
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "comment" }));
    const page2 = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, body: "comment" }));
    const page3 = [{ id: 300, body: `${SPEND_MARKER}\nfound it` }];
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 })
      .mockResolvedValueOnce({ data: page3 });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "updated");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(3);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 300 })
    );
  });

  it("skips comments with null body during search", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 1, body: null },
        { id: 2, body: undefined },
        { id: 3, body: "regular comment" },
      ],
    });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "new body");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "new body" })
    );
  });

  it("finds spend marker when it appears in the middle of a comment body", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 55, body: `Some prefix text ${SPEND_MARKER} Some suffix text` }],
    });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "updated");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 55 })
    );
  });

  it("passes correct owner and repo to all API calls", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    await createOrUpdateSpendComment(octokit, "acme", "project", 99, "spend data");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "project", issue_number: 99 })
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "project", issue_number: 99 })
    );
  });

  it("passes correct owner and repo when updating", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 88, body: `${SPEND_MARKER}\nold` }],
    });
    await createOrUpdateSpendComment(octokit, "acme", "project", 99, "new spend");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "project", comment_id: 88 })
    );
  });

  it("creates comment with the exact body provided", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    const specificBody = `${SPEND_MARKER}\n## Spend Report\nTokens: 5000\nCost: $0.25`;
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, specificBody);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: specificBody })
    );
  });

  it("handles empty body string when creating comment", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: "" })
    );
  });

  it("finds first spend marker when multiple comments have it", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        { id: 10, body: `${SPEND_MARKER}\nfirst match` },
        { id: 20, body: `${SPEND_MARKER}\nsecond match` },
      ],
    });
    await createOrUpdateSpendComment(octokit, "owner", "repo", 7, "updated");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 10 })
    );
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
  });

  it("propagates error from listComments API failure", async () => {
    const octokit = makeMockOctokit();
    octokit.rest.issues.listComments.mockRejectedValue(new Error("list error"));
    await expect(createOrUpdateSpendComment(octokit, "owner", "repo", 7, "body")).rejects.toThrow("list error");
  });
});

describe("SPEND_MARKER", () => {
  it("is a valid HTML comment marker", () => {
    expect(SPEND_MARKER).toBe("<!-- mizumi-spend-marker -->");
  });

  it("is distinct from the review marker", () => {
    expect(SPEND_MARKER).not.toBe(MARKER);
  });

  it("contains the string mizumi-spend-marker", () => {
    expect(SPEND_MARKER).toContain("mizumi-spend-marker");
  });
});
