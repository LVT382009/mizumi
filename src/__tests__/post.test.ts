import { describe, it, expect, vi, beforeEach } from "vitest";
import { postReview, buildReviewBody, buildFatigueWarning, vscodeLink, cleanupOutdatedComments, computeFingerprint, truncateToLimit } from "../post.js";
import type { ReviewCommentType, ReviewResponseType } from "../review.js";
import type { LineMap } from "../linemap.js";
import type { MizumiConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

vi.mock("../linemap.js", () => ({
  resolveLine: vi.fn(),
}));

vi.mock("../sanitize.js", () => ({
  screenOutput: vi.fn((text: string) => text),
}));

vi.mock("../fuzzy.js", () => ({
  deduplicateFindings: vi.fn((findings: any[]) => findings),
  findStaleComments: vi.fn(() => []),
}));

import { resolveLine } from "../linemap.js";
import { screenOutput } from "../sanitize.js";

const mockedResolveLine = vi.mocked(resolveLine);
const mockedScreenOutput = vi.mocked(screenOutput);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<MizumiConfig>): MizumiConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    baseUrl: "",
    profile: "assertive",
    maxComments: 50,
    language: "en",
    selfCritique: false,
    confidenceThreshold: 60,
    autoReview: false, autoPauseAfter: 5,
    excludePatterns: [],
    tierRouting: true,
    smallDiffThreshold: 50,
    securityPaths: ["**/auth/**", "**/crypto/**", "**/sql/**"],
    ...overrides,
  };
}

function makeLineMap(): LineMap {
  return new Map<string, Set<number>>();
}

function makeReview(overrides?: Partial<ReviewResponseType>): ReviewResponseType {
  return {
    summary: "Looks okay overall.",
    riskScore: 2,
    comments: [],
    decision: "comment",
    ...overrides,
  };
}

function makeComment(overrides?: Partial<ReviewCommentType>): ReviewCommentType {
  return {
    file: "src/app.ts",
    line: 10,
    severity: "high",
    category: "bug",
    message: "Potential null dereference",
    confidence: 90,
    ...overrides,
  };
}

function makeOctokit() {
  const createReview = vi.fn().mockResolvedValue({
    data: { id: 42 },
  });
  const listComments = vi.fn().mockResolvedValue({ data: [] });
  const updateComment = vi.fn().mockResolvedValue({});
  const createComment = vi.fn().mockResolvedValue({});
  const listReviewComments = vi.fn().mockResolvedValue({ data: [] });
  const deleteReviewComment = vi.fn().mockResolvedValue({});

  return {
    rest: {
      pulls: { createReview, listReviewComments, deleteReviewComment },
      issues: { listComments, updateComment, createComment },
    },
  } as any;
}

const OWNER = "test-owner";
const REPO = "test-repo";
const PR_NUMBER = 7;
const HEAD_SHA = "abc123";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("postReview", () => {
  let octokit: ReturnType<typeof makeOctokit>;
  let config: MizumiConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    octokit = makeOctokit();
    config = makeConfig();
    // Default: resolveLine returns the line unchanged
    mockedResolveLine.mockImplementation((_map, _file, line) => line);
    // Default: screenOutput is passthrough (real impl tested separately)
    mockedScreenOutput.mockImplementation((text: string) => text);
  });

  // -----------------------------------------------------------------------
  // 1. Inline comments use line/side format, NOT position
  // -----------------------------------------------------------------------

  it("posts inline comments with line and side fields, not position", async () => {
    const review = makeReview({
      comments: [makeComment({ file: "src/app.ts", line: 15 })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const inlineComments = call.comments;

    expect(inlineComments).toHaveLength(1);
    const c = inlineComments[0];
    // Must have line + side (new-style params)
    expect(c).toHaveProperty("line");
    expect(c).toHaveProperty("side", "RIGHT");
    // Must NOT have deprecated position param
    expect(c).not.toHaveProperty("position");
  });

  it("passes the resolved line number to inline comments", async () => {
    mockedResolveLine.mockReturnValue(22);
    const review = makeReview({
      comments: [makeComment({ file: "src/app.ts", line: 20 })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(call.comments[0].line).toBe(22);
  });

  // -----------------------------------------------------------------------
  // 2. Overflow comments go to review body table
  // -----------------------------------------------------------------------

  it("sends comments that fail line resolution to overflow table", async () => {
    mockedResolveLine.mockReturnValue(null);
    const review = makeReview({
      comments: [
        makeComment({ file: "src/app.ts", line: 999, message: "Unresolved finding" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // No inline comments (all overflow)
    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(call.comments).toHaveLength(0);

    // Review body contains overflow table
    const body: string = call.body;
    expect(body).toContain("Medium Findings");
    expect(body).toContain("Unresolved finding");
  });

  it("includes overflow entries in a markdown table with file, line, category, message", async () => {
    mockedResolveLine.mockReturnValue(null);
    const review = makeReview({
      comments: [
        makeComment({
          file: "src/util.ts",
          line: 50,
          category: "security",
          message: "SQL injection risk",
        }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.body;
    expect(body).toContain("src/util.ts");
    expect(body).toContain("security");
    expect(body).toContain("SQL injection risk");
  });

  it("overflows comments beyond the 30-comment limit to the review body", async () => {
    // Generate 35 comments — 30 inline, 5 overflow
    const comments = Array.from({ length: 35 }, (_, i) =>
      makeComment({ file: "src/app.ts", line: i + 1, message: `Finding ${i + 1}` })
    );
    const review = makeReview({ comments });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Only 30 inline comments posted
    expect(call.comments).toHaveLength(30);

    // Review body mentions overflow
    const body: string = call.body;
    expect(body).toContain("Medium Findings");
  });

  // -----------------------------------------------------------------------
  // 3. 422 fallback creates summary comment instead
  // -----------------------------------------------------------------------

  it("falls back to summary-only comment on 422 from createReview", async () => {
    const error422 = Object.assign(new Error("Unprocessable"), { status: 422 });
    octokit.rest.pulls.createReview.mockRejectedValue(error422);

    const review = makeReview({
      comments: [makeComment()],
      riskScore: 3,
    });
    const lineMap = makeLineMap();

    const result = await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // reviewId is 0 on fallback
    expect(result.reviewId).toBe(0);
    expect(result.findingCount).toBe(1);
    expect(result.riskScore).toBe(3);

    // Summary comment should have been created (not update — no existing comment)
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
    const commentCall = octokit.rest.issues.createComment.mock.calls[0][0];
    expect(commentCall.body).toContain("Mizumi Review");
  });

  it("does not rethrow on 422 — handles gracefully", async () => {
    const error422 = Object.assign(new Error("Unprocessable"), { status: 422 });
    octokit.rest.pulls.createReview.mockRejectedValue(error422);

    const review = makeReview({ comments: [makeComment()] });
    const lineMap = makeLineMap();

    // Should not throw
    await expect(
      postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config)
    ).resolves.toBeDefined();
  });

  it("rethrows non-422 errors from createReview", async () => {
    const error500 = Object.assign(new Error("Internal Server Error"), { status: 500 });
    octokit.rest.pulls.createReview.mockRejectedValue(error500);

    const review = makeReview({ comments: [makeComment()] });
    const lineMap = makeLineMap();

    await expect(
      postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config)
    ).rejects.toThrow("Internal Server Error");
  });

  // -----------------------------------------------------------------------
  // 4. Summary comment uses HTML marker for dedup (update-in-place)
  // -----------------------------------------------------------------------

  it("creates a new summary comment when no existing marker is found", async () => {
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });

    const review = makeReview({ riskScore: 1, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("updates existing summary comment in-place when marker is found", async () => {
    octokit.rest.issues.listComments.mockResolvedValue({
      data: [
        {
          id: 99,
          body: "<!-- mizumi-review-marker -->\n## Mizumi Review — Risk: ...",
        },
      ],
    });

    const review = makeReview({ riskScore: 2, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();

    const updateCall = octokit.rest.issues.updateComment.mock.calls[0][0];
    expect(updateCall.comment_id).toBe(99);
    expect(updateCall.body).toContain("<!-- mizumi-review-marker -->");
  });

  it("includes HTML marker in summary comment body for future dedup", async () => {
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });

    const review = makeReview({ riskScore: 2, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.issues.createComment.mock.calls[0][0];
    expect(call.body).toContain("<!-- mizumi-review-marker -->");
  });

  // -----------------------------------------------------------------------
  // 5. screenOutput is called on all posted content
  // -----------------------------------------------------------------------

  it("calls screenOutput on inline comment bodies", async () => {
    const review = makeReview({
      comments: [makeComment({ message: "Bug here", suggestion: "Fix it" })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // screenOutput should have been called at least for the comment body
    const calls = mockedScreenOutput.mock.calls.map((c) => c[0]);
    const hasCommentBody = calls.some(
      (text) => typeof text === "string" && text.includes("Bug here")
    );
    expect(hasCommentBody).toBe(true);
  });

  it("calls screenOutput on review body (summary + overflow)", async () => {
    const review = makeReview({
      summary: "PR summary text",
      comments: [makeComment()],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const calls = mockedScreenOutput.mock.calls.map((c) => c[0]);
    const hasSummary = calls.some(
      (text) => typeof text === "string" && text.includes("PR summary text")
    );
    expect(hasSummary).toBe(true);
  });

  it("calls screenOutput on summary comment body", async () => {
    const review = makeReview({
      summary: "Summary for comment",
      comments: [],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // The summary comment is created via issues.createComment
    // Its body is the result of buildSummaryComment which calls screenOutput on the summary
    const screenCalls = mockedScreenOutput.mock.calls.map((c) => c[0]);
    const hasSummaryContent = screenCalls.some(
      (text) => typeof text === "string" && text.includes("Summary for comment")
    );
    expect(hasSummaryContent).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. Risk score display (circles)
  // -----------------------------------------------------------------------

  it("renders risk score 1 as one red circle and four white circles", async () => {
    const review = makeReview({ riskScore: 1, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.issues.createComment.mock.calls[0][0];
    // Risk: 🔴⚪⚪⚪⚪ (1/5)
    expect(call.body).toContain("🔴⚪⚪⚪⚪");
    expect(call.body).toContain("1/5");
  });

  it("renders risk score 3 as three red circles and two white circles", async () => {
    const review = makeReview({ riskScore: 3, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.issues.createComment.mock.calls[0][0];
    expect(call.body).toContain("🔴🔴🔴⚪⚪");
    expect(call.body).toContain("3/5");
  });

  it("renders risk score 5 as five red circles and zero white circles", async () => {
    const review = makeReview({ riskScore: 5, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.issues.createComment.mock.calls[0][0];
    expect(call.body).toContain("🔴🔴🔴🔴🔴");
    expect(call.body).not.toContain("⚪");
    expect(call.body).toContain("5/5");
  });

  // -----------------------------------------------------------------------
  // 7. Multi-line comment formatting
  // -----------------------------------------------------------------------

  it("formats multi-line comments with start_line and start_side", async () => {
    // resolveLine returns exact line for start, and endLine + 2 for end
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    const review = makeReview({
      comments: [makeComment({ line: 10, endLine: 15 })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const inline = call.comments[0];
    expect(inline.start_line).toBe(10);
    expect(inline.line).toBe(15);
    expect(inline.start_side).toBe("RIGHT");
    expect(inline.side).toBe("RIGHT");
  });

  it("does not set start_line when endLine is not greater than line", async () => {
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    const review = makeReview({
      comments: [makeComment({ line: 10, endLine: 10 })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const inline = call.comments[0];
    expect(inline.start_line).toBeUndefined();
    expect(inline.start_side).toBeUndefined();
  });

  it("does not set start_line when resolveLine returns null for endLine", async () => {
    mockedResolveLine.mockImplementation((_map, _file, line) => {
      if (line >= 30) return null;
      return line;
    });

    const review = makeReview({
      comments: [makeComment({ line: 10, endLine: 35 })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const inline = call.comments[0];
    expect(inline.start_line).toBeUndefined();
    expect(inline.start_side).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 8. Decision mapping
  // -----------------------------------------------------------------------

  it("maps approve decision to APPROVE event", async () => {
    const review = makeReview({ decision: "approve", comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(call.event).toBe("APPROVE");
  });

  it("maps request_changes decision to REQUEST_CHANGES event", async () => {
    const review = makeReview({ decision: "request_changes", comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(call.event).toBe("REQUEST_CHANGES");
  });

  it("maps comment decision to COMMENT event", async () => {
    const review = makeReview({ decision: "comment", comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(call.event).toBe("COMMENT");
  });

  // -----------------------------------------------------------------------
  // 9. Return value and outputs
  // -----------------------------------------------------------------------

  it("returns correct PostResult with reviewId, findingCount, and riskScore", async () => {
    const review = makeReview({
      riskScore: 4,
      comments: [makeComment(), makeComment({ file: "src/other.ts", line: 5 })],
      decision: "request_changes",
    });
    const lineMap = makeLineMap();

    const result = await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    expect(result).toEqual({
      reviewId: 42,
      findingCount: 2,
      riskScore: 4,
    });
  });

  it("respects maxComments config to limit review comments", async () => {
    const config10 = makeConfig({ maxComments: 2 });
    const comments = [
      makeComment({ line: 1, message: "First" }),
      makeComment({ line: 2, message: "Second" }),
      makeComment({ line: 3, message: "Third (should be excluded)" }),
    ];
    const review = makeReview({ comments });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config10);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Only 2 inline comments (maxComments=2, also under 30 limit)
    expect(call.comments).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // 10. Inline comment body formatting
  // -----------------------------------------------------------------------

  it("formats inline comment body with severity, category, and message", async () => {
    const review = makeReview({
      comments: [makeComment({ severity: "high", category: "security", message: "XSS vulnerability" })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.comments[0].body;
    expect(body).toContain("[HIGH]");
    expect(body).toContain("security");
    expect(body).toContain("XSS vulnerability");
  });

  it("places suggestion at top-level for Commit suggestion button", async () => {
    const review = makeReview({
      comments: [makeComment({
        message: "Use const",
        suggestion: "const x = 1;",
      })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.comments[0].body;
    expect(body).not.toContain("<details>");
    expect(body).toContain("```suggestion");
    expect(body).toContain("const x = 1;");
  });

  it("omits suggestion block when suggestion is undefined", async () => {
    const review = makeReview({
      comments: [makeComment({ message: "Fix this", suggestion: undefined })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.comments[0].body;
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("```suggestion");
  });

  // -----------------------------------------------------------------------
  // 11. Summary comment content
  // -----------------------------------------------------------------------

  it("includes severity counts table in summary comment", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "high", category: "bug" }),
        makeComment({ severity: "high", category: "bug" }),
        makeComment({ severity: "low", category: "style" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.issues.createComment.mock.calls[0][0];
    const body: string = call.body;
    expect(body).toContain("| Severity | Count |");
    expect(body).toContain("| high | 2 |");
    expect(body).toContain("| low | 1 |");
  });

  it("includes decision and finding count in summary comment", async () => {
    const review = makeReview({
      decision: "request_changes",
      comments: [makeComment()],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.issues.createComment.mock.calls[0][0];
    const body: string = call.body;
    expect(body).toContain("REQUEST_CHANGES");
    expect(body).toContain("**Findings:** 1");
  });

  // -----------------------------------------------------------------------
  // 12. Severity-delivered output routing
  // -----------------------------------------------------------------------

  it("routes medium findings to review body table, not inline", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "medium", category: "style", message: "Consider using const" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Medium findings go to body table, not inline
    expect(call.comments).toHaveLength(0);
    const body: string = call.body;
    expect(body).toContain("Medium Findings");
    expect(body).toContain("Consider using const");
  });

  it("routes low findings to collapsible details block", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "low", category: "style", message: "Missing semicolon" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Low findings go to collapsible block, not inline
    expect(call.comments).toHaveLength(0);
    const body: string = call.body;
    expect(body).toContain("<details>");
    expect(body).toContain("Low/Nitpick findings");
    expect(body).toContain("Missing semicolon");
  });

  it("routes nitpick findings to collapsible details block", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "nitpick", category: "style", message: "Prefer single quotes" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Nitpick findings go to collapsible block, not inline
    expect(call.comments).toHaveLength(0);
    const body: string = call.body;
    expect(body).toContain("<details>");
    expect(body).toContain("Low/Nitpick findings");
    expect(body).toContain("Prefer single quotes");
  });

  it("routes critical findings as inline comments", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "critical", category: "security", message: "SQL injection risk" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Critical findings still go inline
    expect(call.comments).toHaveLength(1);
    const body: string = call.comments[0].body;
    expect(body).toContain("[CRITICAL]");
    expect(body).toContain("SQL injection risk");
  });

  // -----------------------------------------------------------------------
  // 13. Review fatigue detection
  // -----------------------------------------------------------------------

  describe("buildFatigueWarning", () => {
    it("returns empty string when findingCount is 15 or below", () => {
      expect(buildFatigueWarning(0)).toBe("");
      expect(buildFatigueWarning(1)).toBe("");
      expect(buildFatigueWarning(15)).toBe("");
    });

    it("returns warning when findingCount exceeds 15", () => {
      const warning = buildFatigueWarning(20);
      expect(warning).toContain("Review Fatigue");
      expect(warning).toContain("20");
      expect(warning).toContain("splitting this PR");
      expect(warning).toMatch(/^>/);
    });

    it("formats as a GitHub blockquote with finding count", () => {
      const warning = buildFatigueWarning(30);
      expect(warning).toBe(
        "> ⚠️ **Review Fatigue**: This review found 30 findings. Consider splitting this PR into smaller, focused changes for better review quality."
      );
    });
  });

  it("includes fatigue warning at the top of review body when findings exceed 15", async () => {
    const comments = Array.from({ length: 16 }, (_, i) =>
      makeComment({ file: "src/app.ts", line: i + 1, message: `Finding ${i + 1}` })
    );
    const review = makeReview({ comments, riskScore: 2 });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.body;
    expect(body).toContain("Review Fatigue");
    expect(body).toContain("16 findings");
    // Fatigue warning appears before the risk score section
    const fatigueIndex = body.indexOf("Review Fatigue");
    const riskIndex = body.indexOf("## Mizumi Review — Risk:");
    expect(fatigueIndex).toBeLessThan(riskIndex);
  });

  it("does not include fatigue warning when findings are 15 or fewer", async () => {
    const review = makeReview({ comments: [makeComment()], riskScore: 1 });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.body;
    expect(body).not.toContain("Review Fatigue");
  });

  it("includes VS Code deep link in inline comment bodies", async () => {
    const review = makeReview({
      comments: [makeComment({ file: "src/auth.ts", line: 10, severity: "high" })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const comment = call.comments[0];
    expect(comment.body).toContain("vscode://file/src/auth.ts:10");
  });

});

// -----------------------------------------------------------------------
// 14. VS Code deep links
// -----------------------------------------------------------------------

describe("vscodeLink", () => {
  it("generates a vscode:// deep link", () => {
    const link = vscodeLink("src/auth.ts", 42);
    expect(link).toContain("vscode://file/src/auth.ts:42");
    expect(link).toContain("Open in VS Code");
  });

  it("handles paths with spaces", () => {
    const link = vscodeLink("src/my file.ts", 10);
    expect(link).toContain("vscode://file/src/my file.ts:10");
  });
});

// -----------------------------------------------------------------------
// 15. Outdated comment cleanup (reviewdog stale-cleanup pattern)
// -----------------------------------------------------------------------

describe("cleanupOutdatedComments", () => {
  const FP_PREFIX = '<!-- mizumi-fp:';

  function fpComment(id, file, line, message, replies?) {
    const fp = computeFingerprint(file, line, message);
    return {
      id,
      path: file,
      line,
      body: FP_PREFIX + fp + '-->' + message,
      replies: replies || [],
    };
  }

  function makeCleanupOctokit(reviewComments: any[]) {
    const listReviewComments = vi.fn().mockResolvedValue({ data: reviewComments });
    const deleteReviewComment = vi.fn().mockResolvedValue({});
    return {
      rest: {
        pulls: { listReviewComments, deleteReviewComment },
      },
    } as any;
  }

  it("returns 0 when there are no outdated comments", async () => {
    const octokit = makeCleanupOctokit([
      fpComment(1, "src/app.ts", 10, "Finding A"),
    ]);
    const currentFindings = [{ file: "src/app.ts", line: 10, message: "Finding A" }];

    const deleted = await cleanupOutdatedComments(octokit, OWNER, REPO, PR_NUMBER, currentFindings);

    expect(deleted).toBe(0);
    expect(octokit.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
  });

  it("deletes comments whose fingerprint is not in current findings", async () => {
    const octokit = makeCleanupOctokit([
      fpComment(1, "src/app.ts", 10, "Still here"),
      fpComment(2, "src/app.ts", 20, "Old finding"),
    ]);
    const currentFindings = [{ file: "src/app.ts", line: 10, message: "Still here" }];

    const deleted = await cleanupOutdatedComments(octokit, OWNER, REPO, PR_NUMBER, currentFindings);

    expect(deleted).toBe(1);
    expect(octokit.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 2 })
    );
  });

  it("does not delete comments without the fingerprint marker", async () => {
    const octokit = makeCleanupOctokit([
      { id: 1, path: "src/app.ts", line: 10, body: "Human review comment" },
    ]);
    const currentFindings: Array<{ file: string; line: number; message: string }> = [];

    const deleted = await cleanupOutdatedComments(octokit, OWNER, REPO, PR_NUMBER, currentFindings);

    expect(deleted).toBe(0);
    expect(octokit.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
  });

  it("does not throw when deletion fails — skips gracefully", async () => {
    const octokit = makeCleanupOctokit([
      fpComment(1, "src/app.ts", 10, "Stale"),
    ]);
    octokit.rest.pulls.deleteReviewComment.mockRejectedValue(new Error("GitHub API error"));
    const currentFindings: Array<{ file: string; line: number; message: string }> = [];

    const deleted = await cleanupOutdatedComments(octokit, OWNER, REPO, PR_NUMBER, currentFindings);

    expect(deleted).toBe(0);
  });

  it("keeps comments that match a current finding by fingerprint", async () => {
    const octokit = makeCleanupOctokit([
      fpComment(1, "src/app.ts", 10, "Still valid"),
      fpComment(2, "src/util.ts", 5, "Also valid"),
    ]);
    const currentFindings = [
      { file: "src/app.ts", line: 10, message: "Still valid" },
      { file: "src/util.ts", line: 5, message: "Also valid" },
    ];

    const deleted = await cleanupOutdatedComments(octokit, OWNER, REPO, PR_NUMBER, currentFindings);

    expect(deleted).toBe(0);
    expect(octokit.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
  });

  it("does not delete comments that have human replies", async () => {
    const octokit = makeCleanupOctokit([
      fpComment(1, "src/app.ts", 10, "Outdated but replied", [{ id: 100, body: "I disagree" }]),
    ]);
    const currentFindings: Array<{ file: string; line: number; message: string }> = [];

    const deleted = await cleanupOutdatedComments(octokit, OWNER, REPO, PR_NUMBER, currentFindings);

    expect(deleted).toBe(0);
    expect(octokit.rest.pulls.deleteReviewComment).not.toHaveBeenCalled();
  });
});

// 16. riskScore clamping in buildReviewBody
// -----------------------------------------------------------------------

describe("buildReviewBody riskScore clamping", () => {
  it("clamps riskScore 0 to 1 — renders one red circle", () => {
    const body = buildReviewBody([], [], [], [], 0, 0, "COMMENT");
    expect(body).toContain("🔴⚪⚪⚪⚪");
    expect(body).toContain("(1/5)");
  });

  it("clamps riskScore 6 to 5 — renders five red circles", () => {
    const body = buildReviewBody([], [], [], [], 6, 0, "COMMENT");
    expect(body).toContain("🔴🔴🔴🔴🔴");
    expect(body).not.toContain("⚪");
    expect(body).toContain("(5/5)");
  });

  it("clamps negative riskScore -1 to 1 — renders one red circle", () => {
    const body = buildReviewBody([], [], [], [], -1, 0, "COMMENT");
    expect(body).toContain("🔴⚪⚪⚪⚪");
    expect(body).toContain("(1/5)");
  });

  it("keeps valid riskScore 3 unchanged", () => {
    const body = buildReviewBody([], [], [], [], 3, 0, "COMMENT");
    expect(body).toContain("🔴🔴🔴⚪⚪");
    expect(body).toContain("(3/5)");
  });
});




// -----------------------------------------------------------------------
// 17. Fingerprint computation
// -----------------------------------------------------------------------

describe("computeFingerprint", () => {
  it("returns deterministic 8-char hex for same input", () => {
    const fp1 = computeFingerprint("src/app.ts", 10, "Null deref");
    const fp2 = computeFingerprint("src/app.ts", 10, "Null deref");
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns different fingerprints for different inputs", () => {
    const fp1 = computeFingerprint("src/a.ts", 1, "Bug A");
    const fp2 = computeFingerprint("src/b.ts", 2, "Bug B");
    expect(fp1).not.toBe(fp2);
  });

  it("produces different fingerprint when message changes but file/line same", () => {
    const fp1 = computeFingerprint("src/app.ts", 10, "Old message");
    const fp2 = computeFingerprint("src/app.ts", 10, "New message");
    expect(fp1).not.toBe(fp2);
  });
});

// -----------------------------------------------------------------------
// 18. truncateToLimit
// -----------------------------------------------------------------------

describe("truncateToLimit", () => {
  it("returns body unchanged when under limit", () => {
    expect(truncateToLimit("short", 100)).toBe("short");
  });

  it("truncates and appends notice when over limit", () => {
    const long = "a".repeat(200);
    const result = truncateToLimit(long, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain("Too many findings");
  });

  it("uses default limit of 65535", () => {
    const body = "x".repeat(65536);
    const result = truncateToLimit(body);
    expect(result.length).toBeLessThanOrEqual(65535);
    expect(result).toContain("Too many findings");
  });
});

// ---------------------------------------------------------------------------
// Confidence badges in review body
// ---------------------------------------------------------------------------

describe("confidence badges in review body", () => {
  it("includes confidence badge in medium findings table", () => {
    const findings: ReviewCommentType[] = [
      { file: "src/a.ts", line: 10, severity: "medium", category: "bug", message: "Off-by-one", confidence: 70 },
    ];
    const review: ReviewResponseType = { summary: "S", riskScore: 3, comments: findings, decision: "comment" };
    const body = buildReviewBody([], findings, [], [], 3, 1, "COMMENT", undefined, findings);
    expect(body).toContain("Badge");
    expect(body).toContain("img.shields.io/badge/confidence");
  });

  it("includes confidence badge in low findings details", () => {
    const findings: ReviewCommentType[] = [
      { file: "src/a.ts", line: 5, severity: "low", category: "style", message: "Missing semicolon", confidence: 40 },
    ];
    const body = buildReviewBody([], [], findings, [], 2, 1, "COMMENT", undefined, findings);
    expect(body).toContain("img.shields.io/badge/confidence");
  });

  it("shows high badge for confidence > 80", () => {
    const findings: ReviewCommentType[] = [
      { file: "src/a.ts", line: 1, severity: "medium", category: "bug", message: "Bug", confidence: 95 },
    ];
    const body = buildReviewBody([], findings, [], [], 2, 1, "COMMENT", undefined, findings);
    expect(body).toContain("confidence-high-green");
  });

  it("shows low badge for confidence <= 50", () => {
    const findings: ReviewCommentType[] = [
      { file: "src/a.ts", line: 1, severity: "medium", category: "bug", message: "Bug", confidence: 30 },
    ];
    const body = buildReviewBody([], findings, [], [], 2, 1, "COMMENT", undefined, findings);
    expect(body).toContain("confidence-low-lightgray");
  });
});
