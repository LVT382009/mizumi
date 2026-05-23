import { describe, it, expect, vi, beforeEach } from "vitest";
import { postReview } from "../post.js";
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
    severity: "medium",
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

  return {
    rest: {
      pulls: { createReview },
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
    expect(body).toContain("Additional findings");
    expect(body).toContain("Unresolved finding");
  });

  it("includes overflow entries in a markdown table with file, line, severity, category, message", async () => {
    mockedResolveLine.mockReturnValue(null);
    const review = makeReview({
      comments: [
        makeComment({
          file: "src/util.ts",
          line: 50,
          severity: "high",
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
    expect(body).toContain("high");
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
    expect(body).toContain("Additional findings");
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
});
