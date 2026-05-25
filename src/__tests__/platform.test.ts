import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { detectPlatform, isCI, getWorkspace, createPlatformClient } from "../platform.js";
import type { PlatformType, InlineComment, PlatformMR, PlatformComment, PlatformReviewResult, PlatformClient } from "../platform.js";

// ---------------------------------------------------------------------------
// detectPlatform
// ---------------------------------------------------------------------------

describe("detectPlatform", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns github when GITHUB_ACTION is set", () => {
    process.env.GITHUB_ACTION = "true";
    expect(detectPlatform()).toBe("github");
  });

  it("returns gitlab when GITLAB_CI is set", () => {
    process.env.GITLAB_CI = "true";
    expect(detectPlatform()).toBe("gitlab");
  });

  it("prefers github when both env vars are set", () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITLAB_CI = "true";
    expect(detectPlatform()).toBe("github");
  });

  it("defaults to github when neither env var is set", () => {
    expect(detectPlatform()).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// isCI
// ---------------------------------------------------------------------------

describe("isCI", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns true in GitHub Actions", () => {
    process.env.GITHUB_ACTION = "true";
    expect(isCI()).toBe(true);
  });

  it("returns true in GitLab CI", () => {
    process.env.GITLAB_CI = "true";
    expect(isCI()).toBe(true);
  });

  it("returns false outside CI", () => {
    expect(isCI()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getWorkspace
// ---------------------------------------------------------------------------

describe("getWorkspace", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_WORKSPACE;
    delete process.env.CI_PROJECT_DIR;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns GITHUB_WORKSPACE when set", () => {
    process.env.GITHUB_WORKSPACE = "/home/runner/work/repo";
    expect(getWorkspace()).toBe("/home/runner/work/repo");
  });

  it("returns CI_PROJECT_DIR when GITHUB_WORKSPACE is not set", () => {
    process.env.CI_PROJECT_DIR = "/builds/project";
    expect(getWorkspace()).toBe("/builds/project");
  });

  it("prefers GITHUB_WORKSPACE over CI_PROJECT_DIR", () => {
    process.env.GITHUB_WORKSPACE = "/gh/workspace";
    process.env.CI_PROJECT_DIR = "/gl/workspace";
    expect(getWorkspace()).toBe("/gh/workspace");
  });

  it("defaults to current directory", () => {
    expect(getWorkspace()).toBe(".");
  });
});

// ---------------------------------------------------------------------------
// createPlatformClient (integration — env-based routing)
// ---------------------------------------------------------------------------

describe("createPlatformClient", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
    delete process.env.GITLAB_TOKEN;
    delete process.env.MIZUMI_GITLAB_TOKEN;
    delete process.env.CI_PROJECT_ID;
    delete process.env.CI_MERGE_REQUEST_IID;
    delete process.env.GITHUB_TOKEN;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("throws when GitLab env vars are missing", async () => {
    process.env.GITLAB_CI = "true";
    const { createPlatformClient } = await import("../platform.js");
    await expect(createPlatformClient()).rejects.toThrow("GITLAB_TOKEN");
  });

  it("creates gitlab client with valid env vars", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_PROJECT_ID = "123";
    process.env.CI_MERGE_REQUEST_IID = "456";
    const { createPlatformClient } = await import("../platform.js");
    const client = await createPlatformClient();
    expect(client.platform).toBe("gitlab");
  });

  it("creates github client by default", async () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITHUB_TOKEN = "ghp-test";
    process.env.GITHUB_REPOSITORY = "test-owner/test-repo";
    process.env.GITHUB_EVENT_PATH = "/dev/null";
    process.env.GITHUB_SHA = "abc123";
    const { createPlatformClient } = await import("../platform.js");
    const client = await createPlatformClient();
    expect(client.platform).toBe("github");
  });

  it("gitlab client throws when CI_PROJECT_ID is missing", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_MERGE_REQUEST_IID = "456";
    delete process.env.CI_PROJECT_ID;
    const { createPlatformClient } = await import("../platform.js");
    await expect(createPlatformClient()).rejects.toThrow();
  });

  it("gitlab client throws when CI_MERGE_REQUEST_IID is missing", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_PROJECT_ID = "123";
    delete process.env.CI_MERGE_REQUEST_IID;
    const { createPlatformClient } = await import("../platform.js");
    await expect(createPlatformClient()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// detectPlatform edge cases
// ---------------------------------------------------------------------------

describe("detectPlatform additional cases", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns github for GITHUB_ACTION=1", () => {
    process.env.GITHUB_ACTION = "1";
    expect(detectPlatform()).toBe("github");
  });

  it("returns gitlab for GITLAB_CI=true (string)", () => {
    process.env.GITLAB_CI = "true";
    expect(detectPlatform()).toBe("gitlab");
  });

  it("returns gitlab for GITLAB_CI=1", () => {
    process.env.GITLAB_CI = "1";
    expect(detectPlatform()).toBe("gitlab");
  });

  it("returns github for empty GITHUB_ACTION string", () => {
    // Even empty string is truthy in Node for env var detection
    process.env.GITHUB_ACTION = "";
    // Empty string is falsy, so it falls through
    expect(detectPlatform()).toBe("github");
  });

  it("ignores unrelated env vars", () => {
    process.env.CI = "true";
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
    expect(detectPlatform()).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// isCI edge cases
// ---------------------------------------------------------------------------

describe("isCI additional cases", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns false with only CI=true (neither platform)", () => {
    process.env.CI = "true";
    expect(isCI()).toBe(false);
  });

  it("returns true for GITHUB_ACTION with any value", () => {
    process.env.GITHUB_ACTION = "1";
    expect(isCI()).toBe(true);
  });

  it("returns true for GITLAB_CI with any value", () => {
    process.env.GITLAB_CI = "1";
    expect(isCI()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getWorkspace edge cases
// ---------------------------------------------------------------------------

describe("getWorkspace additional cases", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_WORKSPACE;
    delete process.env.CI_PROJECT_DIR;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns empty GITHUB_WORKSPACE as falsy, falls to CI_PROJECT_DIR", () => {
    process.env.GITHUB_WORKSPACE = "";
    process.env.CI_PROJECT_DIR = "/fallback";
    // Empty string is falsy in the || chain
    expect(getWorkspace()).toBe("/fallback");
  });

  it("handles paths with spaces", () => {
    process.env.GITHUB_WORKSPACE = "/home/user/my project";
    expect(getWorkspace()).toBe("/home/user/my project");
  });

  it("handles Windows-style paths", () => {
    process.env.GITHUB_WORKSPACE = "C:\\Users\\runner\\work\\repo";
    expect(getWorkspace()).toBe("C:\\Users\\runner\\work\\repo");
  });
});

// ---------------------------------------------------------------------------
// PlatformClient interface compliance tests
// ---------------------------------------------------------------------------

describe("PlatformClient interface", () => {
  it("GitHub client exposes all required methods", async () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITHUB_TOKEN = "ghp-test";
    process.env.GITHUB_REPOSITORY = "test/repo";
    process.env.GITHUB_EVENT_PATH = "/dev/null";
    process.env.GITHUB_SHA = "abc123";
    try {
      const client = await createPlatformClient();
      expect(client.platform).toBe("github");
      expect(typeof client.getMR).toBe("function");
      expect(typeof client.fetchDiff).toBe("function");
      expect(typeof client.postReview).toBe("function");
      expect(typeof client.postComment).toBe("function");
      expect(typeof client.listBotComments).toBe("function");
      expect(typeof client.deleteComment).toBe("function");
      expect(typeof client.createStatus).toBe("function");
      expect(typeof client.getCIStatus).toBe("function");
      expect(typeof client.getProjectId).toBe("function");
    } finally {
      delete process.env.GITHUB_ACTION;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.GITHUB_SHA;
    }
  });

  it("GitLab client exposes all required methods", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_PROJECT_ID = "123";
    process.env.CI_MERGE_REQUEST_IID = "456";
    try {
      const client = await createPlatformClient();
      expect(client.platform).toBe("gitlab");
      expect(typeof client.getMR).toBe("function");
      expect(typeof client.fetchDiff).toBe("function");
      expect(typeof client.postReview).toBe("function");
      expect(typeof client.postComment).toBe("function");
      expect(typeof client.listBotComments).toBe("function");
      expect(typeof client.deleteComment).toBe("function");
      expect(typeof client.createStatus).toBe("function");
      expect(typeof client.getCIStatus).toBe("function");
      expect(typeof client.getProjectId).toBe("function");
    } finally {
      delete process.env.GITLAB_CI;
      delete process.env.GITLAB_TOKEN;
      delete process.env.CI_PROJECT_ID;
      delete process.env.CI_MERGE_REQUEST_IID;
    }
  });

  it("GitHub getProjectId returns owner/repo format", async () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITHUB_TOKEN = "ghp-test";
    process.env.GITHUB_REPOSITORY = "acme/widget";
    process.env.GITHUB_EVENT_PATH = "/dev/null";
    process.env.GITHUB_SHA = "abc123";
    try {
      const client = await createPlatformClient();
      expect(client.getProjectId()).toContain("/");
    } finally {
      delete process.env.GITHUB_ACTION;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.GITHUB_SHA;
    }
  });

  it("GitLab getProjectId returns CI_PROJECT_ID", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_PROJECT_ID = "42";
    process.env.CI_MERGE_REQUEST_IID = "99";
    try {
      const client = await createPlatformClient();
      expect(client.getProjectId()).toBe("42");
    } finally {
      delete process.env.GITLAB_CI;
      delete process.env.GITLAB_TOKEN;
      delete process.env.CI_PROJECT_ID;
      delete process.env.CI_MERGE_REQUEST_IID;
    }
  });
});

// ---------------------------------------------------------------------------
// InlineComment type compliance
// ---------------------------------------------------------------------------

describe("InlineComment type", () => {
  it("creates valid InlineComment with all fields", () => {
    const comment: InlineComment = {
      path: "src/foo.ts",
      line: 42,
      body: "Consider using const instead of let",
      severity: "medium",
      confidence: 85,
      category: "style",
      suggestion: "const x = 1;",
    };
    expect(comment.path).toBe("src/foo.ts");
    expect(comment.line).toBe(42);
    expect(comment.suggestion).toBe("const x = 1;");
  });

  it("creates InlineComment without optional suggestion", () => {
    const comment: InlineComment = {
      path: "src/bar.ts",
      line: 10,
      body: "SQL injection risk",
      severity: "critical",
      confidence: 95,
      category: "security",
    };
    expect(comment.suggestion).toBeUndefined();
  });
});
