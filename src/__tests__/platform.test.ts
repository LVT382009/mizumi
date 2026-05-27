import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { detectPlatform, isCI, getWorkspace, createPlatformClient } from "../platform.js";
import type { PlatformType, InlineComment, PlatformMR, PlatformComment, PlatformReviewResult, PlatformClient } from "../platform.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn(() => ""),
  getBooleanInput: vi.fn(() => false),
  isDebug: vi.fn(() => false),
}));

import * as actionsCore from "@actions/core";

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

// ---------------------------------------------------------------------------
// detectPlatform additional edge cases — truthy but semantically false
// ---------------------------------------------------------------------------

describe("detectPlatform truthy-but-falsy semantics", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('returns github for GITHUB_ACTION="false" (string is truthy in env)', () => {
    process.env.GITHUB_ACTION = "false";
    expect(detectPlatform()).toBe("github");
  });

  it('returns gitlab for GITLAB_CI="false" (string is truthy in env)', () => {
    process.env.GITLAB_CI = "false";
    expect(detectPlatform()).toBe("gitlab");
  });

  it('returns github for GITHUB_ACTION="0" (string "0" is truthy in env)', () => {
    process.env.GITHUB_ACTION = "0";
    expect(detectPlatform()).toBe("github");
  });

  it("returns github when only whitespace env vars are set", () => {
    process.env.GITHUB_ACTION = "   ";
    expect(detectPlatform()).toBe("github");
  });

  it("defaults to github when env has no platform-specific vars at all", () => {
    const cleanEnv = { ...origEnv };
    delete cleanEnv.GITHUB_ACTION;
    delete cleanEnv.GITLAB_CI;
    delete cleanEnv.CI;
    process.env = cleanEnv;
    expect(detectPlatform()).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// isCI additional edge cases
// ---------------------------------------------------------------------------

describe("isCI additional edge cases", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns true when both GITHUB_ACTION and GITLAB_CI are set", () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITLAB_CI = "true";
    expect(isCI()).toBe(true);
  });

  it('returns false for empty GITHUB_ACTION string', () => {
    process.env.GITHUB_ACTION = "";
    expect(isCI()).toBe(false);
  });

  it('returns false for empty GITLAB_CI string', () => {
    process.env.GITLAB_CI = "";
    expect(isCI()).toBe(false);
  });

  it("returns true only when at least one platform env var is truthy", () => {
    process.env.GITHUB_ACTION = "run";
    expect(isCI()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getWorkspace additional edge cases
// ---------------------------------------------------------------------------

describe("getWorkspace additional edge cases", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_WORKSPACE;
    delete process.env.CI_PROJECT_DIR;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("returns dot when both workspace env vars are empty strings", () => {
    process.env.GITHUB_WORKSPACE = "";
    process.env.CI_PROJECT_DIR = "";
    expect(getWorkspace()).toBe(".");
  });

  it("returns root path when GITHUB_WORKSPACE is /", () => {
    process.env.GITHUB_WORKSPACE = "/";
    expect(getWorkspace()).toBe("/");
  });

  it("handles relative parent path in CI_PROJECT_DIR", () => {
    process.env.CI_PROJECT_DIR = "..";
    expect(getWorkspace()).toBe("..");
  });

  it("handles Unicode characters in workspace path", () => {
    process.env.GITHUB_WORKSPACE = "/home/ユーザー/project";
    expect(getWorkspace()).toBe("/home/ユーザー/project");
  });

  it("handles very long workspace path", () => {
    const longPath = "/a/" + "subdir/".repeat(100);
    process.env.GITHUB_WORKSPACE = longPath;
    expect(getWorkspace()).toBe(longPath);
  });
});

// ---------------------------------------------------------------------------
// createPlatformClient — core.info logging and MIZUMI_GITLAB_TOKEN
// ---------------------------------------------------------------------------

describe("createPlatformClient logging and token fallback", () => {
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
    vi.clearAllMocks();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("logs detected platform via core.info for GitHub", async () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITHUB_TOKEN = "ghp-test";
    process.env.GITHUB_REPOSITORY = "test-owner/test-repo";
    process.env.GITHUB_EVENT_PATH = "/dev/null";
    process.env.GITHUB_SHA = "abc123";
    const { createPlatformClient } = await import("../platform.js");
    await createPlatformClient();
    expect(actionsCore.info).toHaveBeenCalledWith("Platform detected: github");
  });

  it("logs detected platform via core.info for GitLab", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_PROJECT_ID = "100";
    process.env.CI_MERGE_REQUEST_IID = "200";
    const { createPlatformClient } = await import("../platform.js");
    await createPlatformClient();
    expect(actionsCore.info).toHaveBeenCalledWith("Platform detected: gitlab");
  });

  it("creates gitlab client with MIZUMI_GITLAB_TOKEN fallback", async () => {
    process.env.GITLAB_CI = "true";
    process.env.MIZUMI_GITLAB_TOKEN = "mizumi-token";
    process.env.CI_PROJECT_ID = "10";
    process.env.CI_MERGE_REQUEST_IID = "20";
    const { createPlatformClient } = await import("../platform.js");
    const client = await createPlatformClient();
    expect(client.platform).toBe("gitlab");
  });

  it("throws when both GITLAB_TOKEN and MIZUMI_GITLAB_TOKEN are missing", async () => {
    process.env.GITLAB_CI = "true";
    delete process.env.GITLAB_TOKEN;
    delete process.env.MIZUMI_GITLAB_TOKEN;
    const { createPlatformClient } = await import("../platform.js");
    await expect(createPlatformClient()).rejects.toThrow("GITLAB_TOKEN");
  });

  it("prefers GITLAB_TOKEN over MIZUMI_GITLAB_TOKEN when both are set", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "primary-token";
    process.env.MIZUMI_GITLAB_TOKEN = "fallback-token";
    process.env.CI_PROJECT_ID = "10";
    process.env.CI_MERGE_REQUEST_IID = "20";
    const { createPlatformClient } = await import("../platform.js");
    const client = await createPlatformClient();
    expect(client.platform).toBe("gitlab");
  });
});

// ---------------------------------------------------------------------------
// PlatformMR type compliance
// ---------------------------------------------------------------------------

describe("PlatformMR type", () => {
  it("creates valid PlatformMR with all required fields", () => {
    const mr: PlatformMR = {
      number: 42,
      title: "Add feature X",
      body: "This PR adds X",
      headSha: "abc123",
      headRef: "feature-x",
      baseRef: "main",
      baseSha: "def456",
      author: "devuser",
    };
    expect(mr.number).toBe(42);
    expect(mr.headSha).toBe("abc123");
    expect(mr.baseRef).toBe("main");
  });

  it("handles empty string fields in PlatformMR", () => {
    const mr: PlatformMR = {
      number: 1,
      title: "",
      body: "",
      headSha: "",
      headRef: "",
      baseRef: "",
      baseSha: "",
      author: "",
    };
    expect(mr.title).toBe("");
    expect(mr.body).toBe("");
    expect(mr.headSha).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PlatformComment type compliance
// ---------------------------------------------------------------------------

describe("PlatformComment type", () => {
  it("creates valid PlatformComment with all fields", () => {
    const comment: PlatformComment = {
      id: 101,
      body: "Review finding",
      path: "src/foo.ts",
      line: 15,
      createdAt: "2025-06-01T12:00:00Z",
    };
    expect(comment.id).toBe(101);
    expect(comment.path).toBe("src/foo.ts");
    expect(comment.line).toBe(15);
  });

  it("creates PlatformComment without optional path and line", () => {
    const comment: PlatformComment = {
      id: 202,
      body: "General note",
      createdAt: "2025-06-01T12:00:00Z",
    };
    expect(comment.path).toBeUndefined();
    expect(comment.line).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PlatformReviewResult type compliance
// ---------------------------------------------------------------------------

describe("PlatformReviewResult type", () => {
  it("creates valid PlatformReviewResult", () => {
    const result: PlatformReviewResult = {
      reviewId: 999,
      findingCount: 5,
    };
    expect(result.reviewId).toBe(999);
    expect(result.findingCount).toBe(5);
  });

  it("handles zero finding count", () => {
    const result: PlatformReviewResult = {
      reviewId: 0,
      findingCount: 0,
    };
    expect(result.findingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// InlineComment boundary values
// ---------------------------------------------------------------------------

describe("InlineComment boundary values", () => {
  it("handles confidence at boundary 0", () => {
    const comment: InlineComment = {
      path: "src/a.ts",
      line: 1,
      body: "Low confidence finding",
      severity: "low",
      confidence: 0,
      category: "style",
    };
    expect(comment.confidence).toBe(0);
  });

  it("handles confidence at boundary 100", () => {
    const comment: InlineComment = {
      path: "src/b.ts",
      line: 1,
      body: "Certain finding",
      severity: "critical",
      confidence: 100,
      category: "security",
    };
    expect(comment.confidence).toBe(100);
  });

  it("handles line number 0", () => {
    const comment: InlineComment = {
      path: "src/c.ts",
      line: 0,
      body: "File-level comment",
      severity: "medium",
      confidence: 50,
      category: "architecture",
    };
    expect(comment.line).toBe(0);
  });

  it("handles suggestion with empty string", () => {
    const comment: InlineComment = {
      path: "src/d.ts",
      line: 10,
      body: "Consider refactoring",
      severity: "low",
      confidence: 40,
      category: "style",
      suggestion: "",
    };
    expect(comment.suggestion).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PlatformClient interface — applyFix optional method
// ---------------------------------------------------------------------------

describe("PlatformClient applyFix optional method", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.GITHUB_ACTION;
    delete process.env.GITLAB_CI;
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it("GitHub client does not expose applyFix by default", async () => {
    process.env.GITHUB_ACTION = "true";
    process.env.GITHUB_TOKEN = "ghp-test";
    process.env.GITHUB_REPOSITORY = "test/repo";
    process.env.GITHUB_EVENT_PATH = "/dev/null";
    process.env.GITHUB_SHA = "abc123";
    try {
      const client = await createPlatformClient();
      expect(client.applyFix).toBeUndefined();
    } finally {
      delete process.env.GITHUB_ACTION;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_EVENT_PATH;
      delete process.env.GITHUB_SHA;
    }
  });

  it("GitLab client does not expose applyFix by default", async () => {
    process.env.GITLAB_CI = "true";
    process.env.GITLAB_TOKEN = "glpat-test";
    process.env.CI_PROJECT_ID = "55";
    process.env.CI_MERGE_REQUEST_IID = "66";
    try {
      const client = await createPlatformClient();
      expect(client.applyFix).toBeUndefined();
    } finally {
      delete process.env.GITLAB_CI;
      delete process.env.GITLAB_TOKEN;
      delete process.env.CI_PROJECT_ID;
      delete process.env.CI_MERGE_REQUEST_IID;
    }
  });
});
