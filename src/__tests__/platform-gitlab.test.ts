import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGitLabClient } from "../platform-gitlab.js";

// ---------------------------------------------------------------------------
// Mock global fetch for GitLab API calls
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mockFetch;
  mockFetch.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchResponse(data: unknown, status = 200): void {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  } as Response);
}

function mockFetchNoContent(): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 204,
    text: async () => "",
    json: async () => null,
  } as Response);
}

// ---------------------------------------------------------------------------
// Setup env vars for each test
// ---------------------------------------------------------------------------

const origEnv = process.env;

beforeEach(() => {
  process.env = { ...origEnv };
  process.env.GITLAB_TOKEN = "glpat-test-token";
  process.env.CI_PROJECT_ID = "42";
  process.env.CI_MERGE_REQUEST_IID = "7";
  delete process.env.CI_API_V4_URL;
});

afterEach(() => {
  process.env = origEnv;
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("GitLabPlatformClient constructor", () => {
  it("throws when GITLAB_TOKEN is missing", () => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.MIZUMI_GITLAB_TOKEN;
    expect(() => createGitLabClient()).toThrow("GITLAB_TOKEN");
  });

  it("throws when CI_PROJECT_ID is missing", () => {
    delete process.env.CI_PROJECT_ID;
    expect(() => createGitLabClient()).toThrow("CI_PROJECT_ID");
  });

  it("throws when CI_MERGE_REQUEST_IID is missing", () => {
    process.env.CI_MERGE_REQUEST_IID = "0";
    expect(() => createGitLabClient()).toThrow("CI_MERGE_REQUEST_IID");
  });

  it("accepts MIZUMI_GITLAB_TOKEN as fallback", () => {
    delete process.env.GITLAB_TOKEN;
    process.env.MIZUMI_GITLAB_TOKEN = "mizumi-token";
    expect(() => createGitLabClient()).not.toThrow();
  });

  it("uses CI_API_V4_URL when set", () => {
    process.env.CI_API_V4_URL = "https://gitlab.example.com/api/v4/";
    const client = createGitLabClient();
    expect(client.platform).toBe("gitlab");
  });
});

// ---------------------------------------------------------------------------
// getMR
// ---------------------------------------------------------------------------

describe("getMR", () => {
  it("fetches and maps MR data correctly", async () => {
    const client = createGitLabClient();
    mockFetchResponse({
      iid: 7,
      title: "Test MR",
      description: "Some description",
      sha: "abc123",
      source_branch: "feature",
      target_branch: "main",
      diff_refs: { base_sha: "base1", head_sha: "head1", start_sha: "start1" },
      author: { username: "dev" },
    });

    const mr = await client.getMR();
    expect(mr).toEqual({
      number: 7,
      title: "Test MR",
      body: "Some description",
      headSha: "abc123",
      headRef: "feature",
      baseRef: "main",
      baseSha: "base1",
      author: "dev",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/projects/42/merge_requests/7");
    expect(call[1].headers["PRIVATE-TOKEN"]).toBe("glpat-test-token");
  });

  it("handles missing optional fields", async () => {
    const client = createGitLabClient();
    mockFetchResponse({
      iid: 7,
      title: "",
      description: null,
      sha: "abc123",
      source_branch: "feat",
      target_branch: "main",
      diff_refs: null,
      author: null,
    });

    const mr = await client.getMR();
    expect(mr.body).toBe("");
    expect(mr.baseSha).toBe("");
    expect(mr.author).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// fetchDiff
// ---------------------------------------------------------------------------

describe("fetchDiff", () => {
  it("parses GitLab diff format correctly", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      {
        old_path: "src/app.ts",
        new_path: "src/app.ts",
        diff: "@@ -1,3 +1,5 @@\n line1\n+added1\n+added2\n line2\n-removed1\n line3",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("src/app.ts");
    expect(diff.files[0].status).toBe("modified");
    expect(diff.files[0].additions).toBe(2);
    expect(diff.files[0].deletions).toBe(1);
    expect(diff.totalAdditions).toBe(2);
    expect(diff.totalDeletions).toBe(1);
    expect(diff.rawDiff).toContain("@@ -1,3 +1,5 @@");
  });

  it("skips entries with empty diff", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      { old_path: "empty.ts", new_path: "empty.ts", diff: "", new_file: false, deleted_file: false, renamed_file: false },
      {
        old_path: "real.ts",
        new_path: "real.ts",
        diff: "@@ -1 +1 @@\n-old\n+new",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].path).toBe("real.ts");
  });

  it("detects added files", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      {
        old_path: "new.ts",
        new_path: "new.ts",
        diff: "@@ -0,0 +1 @@\n+content",
        new_file: true,
        deleted_file: false,
        renamed_file: false,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files[0].status).toBe("added");
  });

  it("detects deleted files", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      {
        old_path: "old.ts",
        new_path: "old.ts",
        diff: "@@ -1 +0,0 @@\n-content",
        new_file: false,
        deleted_file: true,
        renamed_file: false,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files[0].status).toBe("deleted");
  });

  it("detects renamed files", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      {
        old_path: "a.ts",
        new_path: "b.ts",
        diff: "@@ -1 +1 @@\n-same",
        new_file: false,
        deleted_file: false,
        renamed_file: true,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files[0].status).toBe("renamed");
  });
});

// ---------------------------------------------------------------------------
// postReview
// ---------------------------------------------------------------------------

describe("postReview", () => {
  it("posts positioned discussions for inline comments", async () => {
    const client = createGitLabClient();
    // Mock versions endpoint
    mockFetchResponse([
      { id: 1, base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" },
    ]);
    // Mock discussion post
    mockFetchResponse({ id: "disc1" });
    // Mock summary note
    mockFetchResponse({ id: "note1" });

    const result = await client.postReview(
      [{ path: "src/app.ts", line: 5, body: "Issue", severity: "high", confidence: 90, category: "bug" }],
      "Summary text",
      3,
    );

    expect(result.findingCount).toBe(1);
    expect(result.reviewId).toBe(7);

    // Check the discussion POST call
    const discCall = mockFetch.mock.calls[1];
    const body = JSON.parse(discCall[1].body);
    expect(body.position.new_line).toBe(5);
    expect(body.position.new_path).toBe("src/app.ts");
    expect(body.position.base_sha).toBe("base");
  });

  it("posts unpositioned discussion when line is 0", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      { id: 1, base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" },
    ]);
    mockFetchResponse({ id: "disc1" });
    mockFetchResponse({ id: "note1" });

    await client.postReview(
      [{ path: "src/app.ts", line: 0, body: "General note", severity: "low", confidence: 30, category: "style" }],
      "Summary",
      1,
    );

    const discCall = mockFetch.mock.calls[1];
    const body = JSON.parse(discCall[1].body);
    expect(body.position).toBeUndefined();
  });

  it("continues posting after a failure", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      { id: 1, base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" },
    ]);
    // First discussion fails
    mockFetchResponse({}, 500);
    // Second discussion succeeds
    mockFetchResponse({ id: "disc2" });
    mockFetchResponse({ id: "note1" });

    const result = await client.postReview(
      [
        { path: "a.ts", line: 1, body: "Fail", severity: "high", confidence: 90, category: "bug" },
        { path: "b.ts", line: 2, body: "Ok", severity: "low", confidence: 60, category: "style" },
      ],
      "Summary",
      2,
    );

    // One succeeded, one failed
    expect(result.findingCount).toBe(1);
  });

  it("skips summary note when empty", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      { id: 1, base_commit_sha: "base", head_commit_sha: "head", start_commit_sha: "start" },
    ]);

    const result = await client.postReview([], "", 0);
    expect(result.findingCount).toBe(0);
    // Only 1 fetch call (versions), no note post
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------

describe("postComment", () => {
  it("posts a note to the MR", async () => {
    const client = createGitLabClient();
    mockFetchResponse({ id: 99 });

    await client.postComment("Hello world");

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/notes");
    const body = JSON.parse(call[1].body);
    expect(body.body).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
// listBotComments / deleteComment
// ---------------------------------------------------------------------------

describe("listBotComments", () => {
  it("filters notes containing the marker", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      { id: 1, body: "<!-- mizumi-review-marker -->\nReview finding", created_at: "2025-01-01" },
      { id: 2, body: "Regular user comment", created_at: "2025-01-02" },
      { id: 3, body: "<!-- mizumi-review-marker -->\nAnother finding", created_at: "2025-01-03" },
    ]);

    const comments = await client.listBotComments();
    expect(comments).toHaveLength(2);
    expect(comments[0].id).toBe(1);
    expect(comments[1].id).toBe(3);
  });
});

describe("deleteComment", () => {
  it("sends DELETE request for the note", async () => {
    const client = createGitLabClient();
    mockFetchNoContent();

    await client.deleteComment(42);

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/notes/42");
    expect(call[1].method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// getCIStatus
// ---------------------------------------------------------------------------

describe("getCIStatus", () => {
  it("returns passed when pipeline succeeds", async () => {
    const client = createGitLabClient();
    mockFetchResponse([{ status: "success" }]);

    const status = await client.getCIStatus("sha1");
    expect(status).toBe("passed");
  });

  it("returns failed when pipeline fails", async () => {
    const client = createGitLabClient();
    mockFetchResponse([{ status: "failed" }]);

    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("returns failed for canceled pipelines", async () => {
    const client = createGitLabClient();
    mockFetchResponse([{ status: "canceled" }]);

    const status = await client.getCIStatus("sha1");
    expect(status).toBe("failed");
  });

  it("returns pending for running pipeline", async () => {
    const client = createGitLabClient();
    mockFetchResponse([{ status: "running" }]);

    const status = await client.getCIStatus("sha1");
    expect(status).toBe("pending");
  });

  it("returns no_checks when no pipelines exist", async () => {
    const client = createGitLabClient();
    mockFetchResponse([]);

    const status = await client.getCIStatus("sha1");
    expect(status).toBe("no_checks");
  });

  it("returns no_checks on API error", async () => {
    const client = createGitLabClient();
    mockFetchResponse({ message: "Unauthorized" }, 401);

    const status = await client.getCIStatus("sha1");
    expect(status).toBe("no_checks");
  });
});

// ---------------------------------------------------------------------------
// getProjectId
// ---------------------------------------------------------------------------

describe("getProjectId", () => {
  it("returns CI_PROJECT_ID", () => {
    const client = createGitLabClient();
    expect(client.getProjectId()).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// Diff parsing internals (via fetchDiff integration)
// ---------------------------------------------------------------------------

describe("diff parsing edge cases", () => {
  it("handles multi-hunk diffs", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      {
        old_path: "multi.ts",
        new_path: "multi.ts",
        diff: "@@ -1,3 +1,4 @@\n ctx1\n+new1\n ctx2\n ctx3\n@@ -10,3 +11,2 @@\n ctx10\n-removed10\n ctx11",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files[0].hunks).toHaveLength(2);
    expect(diff.files[0].additions).toBe(1);
    expect(diff.files[0].deletions).toBe(1);
  });

  it("handles context-only lines in hunk", async () => {
    const client = createGitLabClient();
    mockFetchResponse([
      {
        old_path: "ctx.ts",
        new_path: "ctx.ts",
        diff: "@@ -1,3 +1,3 @@\n unchanged1\n unchanged2\n unchanged3",
        new_file: false,
        deleted_file: false,
        renamed_file: false,
      },
    ]);

    const diff = await client.fetchDiff();
    expect(diff.files[0].additions).toBe(0);
    expect(diff.files[0].deletions).toBe(0);
    expect(diff.files[0].hunks[0].changes).toHaveLength(3);
    expect(diff.files[0].hunks[0].changes[0].type).toBe("normal");
  });
});
