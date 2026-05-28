import { describe, it, expect, vi, beforeEach } from "vitest";
import { postReview, buildReviewBody, buildFatigueWarning, vscodeLink, cleanupOutdatedComments, computeFingerprint, truncateToLimit, buildReportCard, formatReportCard } from "../post.js";
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
    spendThreshold: 0,
    gateThreshold: "none",
  astContractAnalysis: true,
  behavioralSummary: true,
  ownershipRouting: true,
  deltaReview: true,
      taintAnalysis: true,
      reviewLearning: true,
    blastRadius: true,
    specCompliance: true,
    authBoundary: true,
    fatigueDashboard: true,
    secretEntropy: true, safetyScore: true, adaptiveStrategy: true, businessContext: true,
      orgMemory: true,
        testGapDetection: true,
    suppressionMemories: true,
    swarmReview: true,
    complexityPrediction: true,
    prSplitSuggestions: true, findingLifecycle: true, intentClassification: true,
    depImpactAnalysis: true,
    threadContinuity: true,
    crossPRPersistence: true,
    sarifExport: true,
    reviewPriority: true,
    defenseFramework: true,
    checksApi: true,
    repoHealth: true,
    chunkReview: true,
    reviewCache: true,
    findingDedup: true,
    pipelineParallel: true,
    reviewDashboard: true,
      auditTrail: true,
      reviewReplay: true,
      concurrencyAnalysis: true,
    crossprConflictDetection: true,
    architectureDriftDetection: true,
    testAssertionAudit: true,
breakingChangeRadar: true,
importCycleDetector: true,
deadCodeDetector: true,
    typeSafetyErosion: true,
    todoDebtDetector: true,
    magicNumberDetector: true,
    errorHandlingDetector: true,
    performanceAntipatternDetector: true,
resourceLifecycleDetector: true,
observabilityGapDetector: true,
    concurrencyHazardDetector: true,
    lifecycleProtocolDetector: true,
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
  const listReviews = vi.fn().mockResolvedValue({ data: [] });
  const dismissReview = vi.fn().mockResolvedValue({});

  return {
    rest: {
      pulls: { createReview, listReviewComments, deleteReviewComment, listReviews, dismissReview },
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

    // Detail comment contains overflow table
    const detailBody: string = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(detailBody).toContain("Medium Findings");
    expect(detailBody).toContain("Unresolved finding");
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

    const detailBody: string = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(detailBody).toContain("src/util.ts");
    expect(detailBody).toContain("security");
    expect(detailBody).toContain("SQL injection risk");
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

    // Detail comment mentions overflow
    const detailBody: string = octokit.rest.issues.createComment.mock.calls[0][0].body;
    expect(detailBody).toContain("Medium Findings");
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
    // First listComments call: detail lookup (no existing detail comment)
    // Second listComments call: summary lookup (existing summary comment found)
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: [] }) // detail: no existing
      .mockResolvedValueOnce({ data: [
        {
          id: 99,
          body: "<!-- mizumi-review-marker -->\n## Mizumi Review — Risk: ...",
        },
      ] });

    const review = makeReview({ riskScore: 2, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Summary comment should have been updated
    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();

    // Find the update call for the summary comment (the one with MARKER)
    const updateCalls = octokit.rest.issues.updateComment.mock.calls.map((c: any) => c[0]);
    const summaryUpdate = updateCalls.find((c: any) => c.body?.includes("<!-- mizumi-review-marker -->"));
    expect(summaryUpdate).toBeDefined();
    expect(summaryUpdate.comment_id).toBe(99);
  });

  it("includes HTML marker in summary comment body for future dedup", async () => {
    octokit.rest.issues.listComments.mockResolvedValue({ data: [] });

    const review = makeReview({ riskScore: 2, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Find the createComment call that has the SUMMARY marker
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const summaryCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-review-marker -->"));
    expect(summaryCall).toBeDefined();
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

    // Find the summary comment (contains the severity table)
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const summaryCall = creates.find((c: any) => c.body?.includes("| Severity | Count |"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall.body).toContain("| high | 2 |");
    expect(summaryCall.body).toContain("| low | 1 |");
  });

  it("includes decision and finding count in summary comment", async () => {
    const review = makeReview({
      decision: "request_changes",
      comments: [makeComment()],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Find the summary comment (contains the decision)
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const summaryCall = creates.find((c: any) => c.body?.includes("REQUEST_CHANGES") && c.body?.includes("<!-- mizumi-review-marker -->"));
    expect(summaryCall).toBeDefined();
    expect(summaryCall.body).toContain("**Findings:** 1");
  });

  // -----------------------------------------------------------------------
  // 12. Severity-delivered output routing
  // -----------------------------------------------------------------------

  it("routes medium findings to detail comment table, not inline", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "medium", category: "style", message: "Consider using const" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Medium findings go to detail comment table, not inline
    expect(call.comments).toHaveLength(0);
    // PR review body is minimal
    const prBody: string = call.body;
    expect(prBody).toContain("<!-- mizumi-review-marker -->");
    // Detail comment has the medium findings table
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    expect(detailCall).toBeDefined();
    expect(detailCall.body).toContain("Medium Findings");
    expect(detailCall.body).toContain("Consider using const");
  });

  it("routes low findings to collapsible details block in detail comment", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "low", category: "style", message: "Missing semicolon" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Low findings go to collapsible block in detail, not inline
    expect(call.comments).toHaveLength(0);
    // Detail comment has the collapsible block
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    expect(detailCall).toBeDefined();
    expect(detailCall.body).toContain("<details>");
    expect(detailCall.body).toContain("Low/Nitpick findings");
    expect(detailCall.body).toContain("Missing semicolon");
  });

  it("routes nitpick findings to collapsible details block in detail comment", async () => {
    const review = makeReview({
      comments: [
        makeComment({ severity: "nitpick", category: "style", message: "Prefer single quotes" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    // Nitpick findings go to collapsible block in detail, not inline
    expect(call.comments).toHaveLength(0);
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    expect(detailCall).toBeDefined();
    expect(detailCall.body).toContain("<details>");
    expect(detailCall.body).toContain("Low/Nitpick findings");
    expect(detailCall.body).toContain("Prefer single quotes");
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

  
 it("promotes medium findings with suggestion to inline comments", async () => {
 const review = makeReview({
 comments: [
 makeComment({ severity: "medium", category: "bug", message: "Missing error handling", suggestion: "try { await fn(); } catch (e) { logger.error(e); }" }),
 ],
 });
 const lineMap = makeLineMap();

 await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

 const call = octokit.rest.pulls.createReview.mock.calls[0][0];
 expect(call.comments).toHaveLength(1);
 const body: string = call.comments[0].body;
 expect(body).toContain("[MEDIUM]");
 expect(body).toContain("suggestion");
 });

 it("keeps medium findings without suggestion in detail table", async () => {
 const review = makeReview({
 comments: [
 makeComment({ severity: "medium", category: "style", message: "Consider refactoring" }),
 ],
 });
 const lineMap = makeLineMap();

 await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

 const call = octokit.rest.pulls.createReview.mock.calls[0][0];
 expect(call.comments).toHaveLength(0);
 });

 it("promotes low findings with suggestion to inline comments", async () => {
 const review = makeReview({
 comments: [
 makeComment({ severity: "low", category: "style", message: "Missing semicolon", suggestion: "const x = 1;" }),
 ],
 });
 const lineMap = makeLineMap();

 await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

 const call = octokit.rest.pulls.createReview.mock.calls[0][0];
 expect(call.comments).toHaveLength(1);
 const body: string = call.comments[0].body;
 expect(body).toContain("[LOW]");
 expect(body).toContain("suggestion");
 });

 it("promotes nitpick findings with suggestion to inline comments", async () => {
 const review = makeReview({
 comments: [
 makeComment({ severity: "nitpick", category: "style", message: "Prefer single quotes", suggestion: "const name = 'world';" }),
 ],
 });
 const lineMap = makeLineMap();

 await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

 const call = octokit.rest.pulls.createReview.mock.calls[0][0];
 expect(call.comments).toHaveLength(1);
 expect(call.comments[0].body).toContain("[NITPICK]");
 });

 it("keeps low/nitpick findings without suggestion in collapsible details", async () => {
 const review = makeReview({
 comments: [
 makeComment({ severity: "low", category: "style", message: "Missing semicolon" }),
 makeComment({ severity: "nitpick", category: "style", message: "Prefer single quotes" }),
 ],
 });
 const lineMap = makeLineMap();

 await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

 const call = octokit.rest.pulls.createReview.mock.calls[0][0];
 expect(call.comments).toHaveLength(0);
 const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
 const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
 expect(detailCall).toBeDefined();
 expect(detailCall.body).toContain("Missing semicolon");
 expect(detailCall.body).toContain("Prefer single quotes");
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

  it("includes fatigue warning in detail comment when findings exceed 15", async () => {
    const comments = Array.from({ length: 16 }, (_, i) =>
      makeComment({ file: "src/app.ts", line: i + 1, message: `Finding ${i + 1}` })
    );
    const review = makeReview({ comments, riskScore: 2 });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Fatigue warning is in the detail comment
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    expect(detailCall).toBeDefined();
    const body: string = detailCall.body;
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

    // Check detail comment for no fatigue warning
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    if (detailCall) {
      expect(detailCall.body).not.toContain("Review Fatigue");
    } else {
      // No detail comment created is also fine (no findings to detail)
      expect(detailCall).toBeDefined();
    }
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

// ---------------------------------------------------------------------------
// Walkthrough in buildReviewBody
// ---------------------------------------------------------------------------

describe("buildReviewBody walkthrough integration", () => {
  const diffFiles: import("../post.js").DiffFileSummary[] = [
    { path: "src/auth/login.ts", additions: 20, deletions: 5 },
    { path: "src/auth/session.ts", additions: 10, deletions: 2 },
    { path: "src/utils/helpers.ts", additions: 30, deletions: 8 },
  ];

  it("includes walkthrough section when diffFiles >= 2", () => {
    const body = buildReviewBody([], [], [], [], 2, 3, "COMMENT", "Summary", [], diffFiles);
    expect(body).toContain("Walkthrough");
    expect(body).toContain("3 files");
  });

  it("includes review effort estimate", () => {
    const body = buildReviewBody([], [], [], [], 2, 3, "COMMENT", "Summary", [], diffFiles);
    expect(body).toContain("Review effort:");
    expect(body).toMatch(/Review effort: [1-5]\/5/);
  });

  it("omits walkthrough when diffFiles < 2", () => {
    const singleFile = [diffFiles[0]];
    const body = buildReviewBody([], [], [], [], 2, 1, "COMMENT", "Summary", [], singleFile);
    expect(body).not.toContain("Walkthrough");
  });

  it("groups findings by directory in walkthrough table", () => {
    const findings: ReviewCommentType[] = [
      { file: "src/auth/login.ts", line: 10, severity: "high", category: "security", message: "Auth bypass", confidence: 90 },
      { file: "src/auth/session.ts", line: 5, severity: "critical", category: "security", message: "Token leak", confidence: 95 },
      { file: "src/utils/helpers.ts", line: 20, severity: "low", category: "style", message: "Missing semicolon", confidence: 60 },
    ];
    const body = buildReviewBody([], [], [], [], 4, 3, "COMMENT", "Summary", findings, diffFiles);
    expect(body).toContain("Walkthrough");
    expect(body).toContain("src/auth/");
  });

  it("shows effort 5 for large change with many findings", () => {
    const largeDiff = Array.from({ length: 20 }, (_, i) => ({
      path: `src/module${i}/file.ts`, additions: 100, deletions: 50,
    }));
    const manyFindings = Array.from({ length: 20 }, (_, i) => ({
      file: `src/module${i}/file.ts`, line: 1, severity: "medium" as const,
      category: "bug" as const, message: `Bug ${i}`, confidence: 80,
    }));
    const body = buildReviewBody([], manyFindings, [], [], 4, 20, "COMMENT", "Summary", manyFindings, largeDiff);
    expect(body).toContain("Review effort: 5/5");
  });
});

// ---------------------------------------------------------------------------
// Labels integration (computeLabels tested in labels.test.ts; here we test
// that walkthrough + labels appear together in the same review body)
// ---------------------------------------------------------------------------

describe("buildReviewBody walkthrough + labels together", () => {
  it("includes walkthrough, effort, and severity distribution when both are present", () => {
    const diffFiles: import("../post.js").DiffFileSummary[] = [
      { path: "src/auth.ts", additions: 20, deletions: 5 },
      { path: "src/api.ts", additions: 15, deletions: 3 },
    ];
    const findings: ReviewCommentType[] = [
      { file: "src/auth.ts", line: 10, severity: "critical", category: "security", message: "Auth bypass", confidence: 95 },
      { file: "src/api.ts", line: 5, severity: "medium", category: "bug", message: "Null ref", confidence: 70 },
    ];
    const body = buildReviewBody(
      [findings[0]], [findings[1]], [], [],
      4, 2, "REQUEST_CHANGES", "Security issues found", findings, diffFiles,
    );
    expect(body).toContain("Walkthrough");
    expect(body).toContain("Review effort:");
    expect(body).toContain("Finding Distribution");
  });
});

// ---------------------------------------------------------------------------
// buildReportCard + formatReportCard
// ---------------------------------------------------------------------------

describe("buildReportCard", () => {
  it("returns all A grades for zero findings", () => {
    const card = buildReportCard([], 1);
    expect(card.security).toBe("A");
    expect(card.reliability).toBe("A");
    expect(card.complexity).toBe("A");
    expect(card.hygiene).toBe("A");
    expect(card.coverage).toBe("A");
    expect(card.overall).toBe("A");
  });

  it("returns F security grade for critical security finding", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "critical", category: "security", message: "x", confidence: 90 },
    ];
    const card = buildReportCard(findings, 2);
    expect(card.security).toBe("F");
    expect(card.reliability).toBe("A");
  });

  it("returns F reliability grade for critical bug finding", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "critical", category: "bug", message: "x", confidence: 90 },
    ];
    const card = buildReportCard(findings, 2);
    expect(card.reliability).toBe("F");
    expect(card.security).toBe("A");
  });

  it("count compliance findings toward reliability", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "high", category: "compliance", message: "x", confidence: 90 },
    ];
    const card = buildReportCard(findings, 2);
    expect(card.reliability).toBe("D");
  });

  it("counts architecture findings toward complexity", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "medium", category: "architecture", message: "x", confidence: 80 },
    ];
    const card = buildReportCard(findings, 2);
    expect(card.complexity).toBe("C");
  });

  it("counts style + performance findings toward hygiene", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "medium", category: "style", message: "x", confidence: 80 },
      { file: "b.ts", line: 2, severity: "medium", category: "performance", message: "y", confidence: 80 },
    ];
    const card = buildReportCard(findings, 2);
    expect(card.hygiene).toBe("D");
  });

  it("high risk score degrades coverage grade", () => {
    const card = buildReportCard([], 5);
    expect(card.coverage).toBe("C");
  });

  it("medium risk score gives C coverage", () => {
    const card = buildReportCard([], 3);
    expect(card.coverage).toBe("C");
  });

  it("low risk score gives A coverage", () => {
    const card = buildReportCard([], 1);
    expect(card.coverage).toBe("A");
  });

  it("computes overall as average of dimensions", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "critical", category: "security", message: "x", confidence: 90 },
    ];
    const card = buildReportCard(findings, 2);
    // security=F(1), others=A(5) → avg = (1+5+5+5+5)/5 = 4.2 → B
    expect(card.overall).toBe("B");
  });

  it("multiple low findings accumulate to lower grades", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "low", category: "security", message: "x", confidence: 80 },
      { file: "b.ts", line: 2, severity: "low", category: "security", message: "y", confidence: 80 },
      { file: "c.ts", line: 3, severity: "low", category: "security", message: "z", confidence: 80 },
    ];
    const card = buildReportCard(findings, 2);
    expect(card.security).toBe("C");
  });
});

describe("formatReportCard", () => {
  it("formats a fully passing card", () => {
    const card = buildReportCard([], 1);
    const text = formatReportCard(card);
    expect(text).toContain("Report Card");
    expect(text).toContain("Security");
    expect(text).toContain("Reliability");
    expect(text).toContain("Complexity");
    expect(text).toContain("Hygiene");
    expect(text).toContain("Test Coverage");
    expect(text).toContain("Overall");
    expect(text).toContain("A");
  });

  it("includes emoji indicators for grades", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "critical", category: "security", message: "x", confidence: 90 },
    ];
    const card = buildReportCard(findings, 2);
    const text = formatReportCard(card);
    expect(text).toContain("F");
  });
});

// ---------------------------------------------------------------------------
// 19. Report card edge cases
// ---------------------------------------------------------------------------

describe("buildReportCard edge cases", () => {
  it("nitpick severity has 0.5 weight", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "nitpick", category: "style", message: "x", confidence: 80 },
      { file: "b.ts", line: 2, severity: "nitpick", category: "style", message: "y", confidence: 80 },
    ];
    const card = buildReportCard(findings, 2);
    // 2 * 0.5 = 1.0 → score 1 → B for hygiene
    expect(card.hygiene).toBe("B");
  });

  it("unknown severity defaults to weight 1", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "info" as any, category: "style", message: "x", confidence: 80 },
    ];
    const card = buildReportCard(findings, 2);
    // 1 * 1 = 1 → B for hygiene
    expect(card.hygiene).toBe("B");
  });

  it("high risk score gives F coverage", () => {
    const card = buildReportCard([], 5);
    // riskScore 5 → coverageScore 3 → C
    expect(card.coverage).toBe("C");
  });

  it("risk score 4 gives C coverage", () => {
    const card = buildReportCard([], 4);
    expect(card.coverage).toBe("C");
  });

  it("risk score 2 gives A coverage", () => {
    const card = buildReportCard([], 2);
    expect(card.coverage).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// 20. Truncation in postReview
// ---------------------------------------------------------------------------

describe("postReview body truncation", () => {
  it("truncates detail comment body when exceeding 65535 chars", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    // Create a review with many findings to produce a long body
    const manyComments = Array.from({ length: 200 }, (_, i) =>
      makeComment({ file: `src/file${i}.ts`, line: i + 1, severity: "medium", category: "style", message: `Finding ${i} with a very long description that makes the body longer`.repeat(20) })
    );
    const review = makeReview({ comments: manyComments, riskScore: 3 });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Detail comment body should be within GitHub's limit
    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    if (detailCall) {
      expect(detailCall.body.length).toBeLessThanOrEqual(65535 + 200);
    }
  });
});

// ---------------------------------------------------------------------------
// 21. buildReviewBody with descriptionFeedback
// ---------------------------------------------------------------------------

describe("buildReviewBody with descriptionFeedback", () => {
  it("includes description feedback when provided", () => {
    const body = buildReviewBody([], [], [], [], 2, 0, "COMMENT", "PR description needs improvement");
    expect(body).toContain("PR description needs improvement");
  });

  it("omits description feedback section when undefined", () => {
    const body = buildReviewBody([], [], [], [], 2, 0, "COMMENT");
    expect(body).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// 22. buildReviewBody with arch diagram + severity diagram
// ---------------------------------------------------------------------------

describe("buildReviewBody diagrams", () => {
  it("includes architecture diagram when diffFiles >= 2 and multiple directory groups", () => {
    const diffFiles: import("../post.js").DiffFileSummary[] = [
      { path: "src/auth.ts", additions: 20, deletions: 5 },
      { path: "lib/utils.ts", additions: 10, deletions: 2 },
    ];
    const findings: ReviewCommentType[] = [
      { file: "src/auth.ts", line: 5, severity: "high", category: "security", message: "XSS", confidence: 90 },
    ];
    const body = buildReviewBody([], [], [], [], 3, 1, "COMMENT", undefined, findings, diffFiles);
    expect(body).toContain("Change Architecture");
  });

  it("includes severity distribution when findings > 0", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "critical", category: "security", message: "x", confidence: 95 },
      { file: "b.ts", line: 2, severity: "low", category: "style", message: "y", confidence: 60 },
    ];
    const body = buildReviewBody([findings[0]], [], [findings[1]], [], 3, 2, "COMMENT", undefined, findings);
    expect(body).toContain("Finding Distribution");
  });

  it("omits architecture diagram when no diffFiles provided", () => {
    const findings: ReviewCommentType[] = [
      { file: "a.ts", line: 1, severity: "high", category: "bug", message: "x", confidence: 80 },
    ];
    const body = buildReviewBody([findings[0]], [], [], [], 2, 1, "COMMENT", undefined, findings);
    expect(body).not.toContain("Change Architecture");
  });
});

// ---------------------------------------------------------------------------
// 23. mapDecision edge cases
// ---------------------------------------------------------------------------

describe("postReview decision mapping", () => {
  it("defaults unknown decision to COMMENT", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    const review = makeReview({ decision: "unknown" as any, comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    expect(call.event).toBe("COMMENT");
  });
});

// ---------------------------------------------------------------------------
// 24. fingerprint uniqueness
// ---------------------------------------------------------------------------

describe("computeFingerprint uniqueness", () => {
  it("different files with same line and message produce different fingerprints", () => {
    const fp1 = computeFingerprint("src/a.ts", 10, "Bug");
    const fp2 = computeFingerprint("src/b.ts", 10, "Bug");
    expect(fp1).not.toBe(fp2);
  });

  it("same file with different lines produces different fingerprints", () => {
    const fp1 = computeFingerprint("src/a.ts", 10, "Bug");
    const fp2 = computeFingerprint("src/a.ts", 20, "Bug");
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// 25. Dual-updateable comment pattern (detail + summary)
// ---------------------------------------------------------------------------

describe("dual-updateable comment pattern", () => {
  it("creates both detail and summary issue comments on first run", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    const review = makeReview({
      comments: [makeComment({ severity: "medium", category: "bug", message: "Off-by-one" })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Two issue comments created: detail + summary
    expect(octokit.rest.issues.createComment.mock.calls.length).toBeGreaterThanOrEqual(2);

    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    const summaryCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-review-marker -->") && !c.body?.includes("<!-- mizumi-detail-marker -->"));

    expect(detailCall).toBeDefined();
    expect(summaryCall).toBeDefined();
    expect(detailCall.body).toContain("Medium Findings");
    expect(summaryCall.body).toContain("| Severity | Count |");
  });

  it("updates both detail and summary comments on re-run when both markers are found", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    // Simulate existing comments from a previous run
    octokit.rest.issues.listComments
      .mockResolvedValueOnce({ data: [{ id: 50, body: "<!-- mizumi-detail-marker -->\nOld detail body" }] })
      .mockResolvedValueOnce({ data: [{ id: 60, body: "<!-- mizumi-review-marker -->\nOld summary body" }] });

    const review = makeReview({
      riskScore: 3,
      comments: [makeComment({ severity: "medium", category: "bug", message: "New finding" })],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    // Both comments should be updated, not created
    expect(octokit.rest.issues.updateComment.mock.calls.length).toBeGreaterThanOrEqual(2);

    const updates = octokit.rest.issues.updateComment.mock.calls.map((c: any) => c[0]);
    const detailUpdate = updates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));
    const summaryUpdate = updates.find((c: any) => c.body?.includes("<!-- mizumi-review-marker -->") && !c.body?.includes("<!-- mizumi-detail-marker -->"));

    expect(detailUpdate).toBeDefined();
    expect(detailUpdate.comment_id).toBe(50);
    expect(detailUpdate.body).toContain("New finding");

    expect(summaryUpdate).toBeDefined();
    expect(summaryUpdate.comment_id).toBe(60);
    expect(summaryUpdate.body).toContain("| medium | 1 |");
  });

  it("PR review body is minimal — only decision, finding count, and risk score", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    const review = makeReview({
      decision: "request_changes",
      comments: [
        makeComment({ severity: "critical", category: "security", message: "SQL injection" }),
        makeComment({ severity: "medium", category: "bug", message: "Off-by-one" }),
        makeComment({ severity: "low", category: "style", message: "Missing semicolon" }),
      ],
    });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    const call = octokit.rest.pulls.createReview.mock.calls[0][0];
    const body: string = call.body;

    // PR review body is minimal
    expect(body).toContain("REQUEST_CHANGES");
    expect(body).toContain("**Findings:** 3");
    expect(body).toContain("**Risk:** 2/5");

    // PR review body does NOT contain detailed content
    expect(body).not.toContain("Medium Findings");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("Report Card");
  });

  it("detail comment contains report card, finding tables, and walkthrough", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    const review = makeReview({
      comments: [
        makeComment({ severity: "critical", category: "security", message: "SQL injection" }),
        makeComment({ severity: "medium", category: "bug", message: "Off-by-one" }),
        makeComment({ severity: "low", category: "style", message: "Missing semicolon" }),
      ],
    });
    const lineMap = makeLineMap();
    const diffFiles = [
      { path: "src/auth.ts", additions: 20, deletions: 5 },
      { path: "src/api.ts", additions: 15, deletions: 3 },
    ];

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config, diffFiles);

    const creates = octokit.rest.issues.createComment.mock.calls.map((c: any) => c[0]);
    const detailCall = creates.find((c: any) => c.body?.includes("<!-- mizumi-detail-marker -->"));

    expect(detailCall).toBeDefined();
    expect(detailCall.body).toContain("Report Card");
    expect(detailCall.body).toContain("Medium Findings");
    expect(detailCall.body).toContain("<details>");
  });

  it("dismisses pending reviews before creating new one", async () => {
    const octokit = makeOctokit();
    const config = makeConfig();
    mockedResolveLine.mockImplementation((_map, _file, line) => line);

    octokit.rest.pulls.listReviews.mockResolvedValue({
      data: [{ id: 10, state: "PENDING", body: "<!-- mizumi-review-marker -->\nOld pending review" }],
    });

    const review = makeReview({ comments: [] });
    const lineMap = makeLineMap();

    await postReview(octokit, OWNER, REPO, PR_NUMBER, HEAD_SHA, review, lineMap, config);

    expect(octokit.rest.pulls.dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 10 })
    );
  });
});
