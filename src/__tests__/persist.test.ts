import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { persistLearningData } from "../persist.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

function makeOctokit(shouldFail = false) {
  const mockRef = { data: { object: { sha: "abc123" } } };
  const mockCommit = { data: { tree: { sha: "tree123" } } };
  const mockBlob = { data: { sha: "blob456" } };
  const mockTree = { data: { sha: "newtree789" } };
  const mockNewCommit = { data: { sha: "commitabc" } };

  return {
    rest: {
      git: {
        getRef: shouldFail
          ? vi.fn().mockRejectedValue(new Error("ref not found"))
          : vi.fn().mockResolvedValue(mockRef),
        getCommit: vi.fn().mockResolvedValue(mockCommit),
        createBlob: vi.fn().mockResolvedValue(mockBlob),
        createTree: vi.fn().mockResolvedValue(mockTree),
        createCommit: vi.fn().mockResolvedValue(mockNewCommit),
        updateRef: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe("persistLearningData", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-persist-"));
  });

  it("returns no-commit when no learning files exist", async () => {
    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
  });

  it("commits memory file when it exists with content", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "## 2026-05-24\n- test pattern");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
    expect(octokit.rest.git.createBlob).toHaveBeenCalled();
    expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("[skip ci]"),
      })
    );
    expect(octokit.rest.git.updateRef).toHaveBeenCalled();
  });

  it("commits feedback + memory files", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "## patterns");
    fs.writeFileSync(path.join(githubDir, "mizumi-feedback.json"), '{"entries":[]}');

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(2);
  });

  it("skips empty files", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "   ");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
  });

  it("includes skill files from mizumi-skills directory", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "security-auth.md"), "---\nname: security-auth\n---\nCheck auth");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("gracefully handles API errors", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit(true);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
  });
});
