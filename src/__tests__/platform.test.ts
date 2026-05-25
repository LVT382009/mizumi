import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { detectPlatform, isCI, getWorkspace } from "../platform.js";

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
