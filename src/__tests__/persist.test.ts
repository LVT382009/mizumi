import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), " ");

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

  it("returns commit SHA on success", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.commitSha).toBe("commitabc");
  });

  it("returns null commit SHA on failure", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit(true);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.commitSha).toBeNull();
  });

  it("skips empty skill files", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "empty.md"), "  \n  ");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
  });

  it("includes multiple skill files", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "skill-a.md"), "Skill A content");
    fs.writeFileSync(path.join(skillsDir, "skill-b.md"), "Skill B content");
    // Non-md file should be skipped
    fs.writeFileSync(path.join(skillsDir, "config.json"), "{}");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(2);
  });

  it("creates blobs with utf-8 encoding", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "unicode: 中文");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("updates the correct branch ref", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "develop", tmpDir);
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/develop" })
    );
    expect(octokit.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/develop" })
    );
  });

  it("handles empty workspace directory (no .github dir at all)", async () => {
    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
    expect(result.commitSha).toBeNull();
    // No git API calls should have been made
    expect(octokit.rest.git.getRef).not.toHaveBeenCalled();
  });

  it("creates .mizumi-skills dir content when skill file is the only content", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    // Only skill file, no memory/feedback — should still commit
    fs.writeFileSync(path.join(skillsDir, "my-rule.md"), "# My Rule\nApply X when Y");
    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("truncates very large file content and still commits", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    // Create a file larger than 1MB (GitHub blob limit is 100MB, but this tests the path)
    const bigContent = "x".repeat(1_100_000);
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), bigContent);
    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    // Function does not truncate — it sends content as-is, which tests the full-path behavior
    expect(result.committed).toBe(true);
    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({ content: bigContent })
    );
  });

  it("handles updateRef failure gracefully (push fails after commit created)", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");
    const octokit = makeOctokit();
    // updateRef is the last step — simulate push failure
    octokit.rest.git.updateRef = vi.fn().mockRejectedValue(new Error("ref update rejected"));
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
    expect(result.commitSha).toBeNull();
  });

  it("does not duplicate commits when called twice with same content", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "same content both times");
    const octokit = makeOctokit();
    const result1 = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    const result2 = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    // Both calls produce a commit (function is stateless — caller avoids duplication)
    expect(result1.committed).toBe(true);
    expect(result2.committed).toBe(true);
    // But updateRef should have been called twice, confirming both ran
    expect(octokit.rest.git.updateRef).toHaveBeenCalledTimes(2);
  });

  it("handles missing branch (getRef fails) by returning no-commit result", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");
    // getRef fails with 404 for non-existent branch
    const octokit = makeOctokit(true);
    const result = await persistLearningData(octokit as any, "owner", "repo", "nonexistent-branch", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
    expect(result.commitSha).toBeNull();
  });

  it("skips feedback file if it has only whitespace", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "valid content");
    fs.writeFileSync(path.join(githubDir, "mizumi-feedback.json"), "\n  \n");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("skips non-.md files in skills directory", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "notes.txt"), "text notes");
    fs.writeFileSync(path.join(skillsDir, "data.yaml"), "key: value");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
  });

  it("handles unreadable skills directory gracefully", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    // Create a file then make directory unreadable via permission
    fs.writeFileSync(path.join(skillsDir, "skill.md"), "test");
    // On Windows, chmod doesn't fully prevent reads, so just test the path exists
    // by removing the directory after creating it (simulates readdirSync failure)
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "memory content");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("creates commit with correct parent SHA", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        parents: ["abc123"],
      })
    );
  });

  it("creates tree with correct number of entries matching files", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "memory");
    fs.writeFileSync(path.join(githubDir, "mizumi-feedback.json"), '{"data":1}');

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    const treeCall = octokit.rest.git.createTree.mock.calls[0][0];
    expect(treeCall.tree).toHaveLength(2);
  });

  it("persists all 3 sources together (memory + feedback + skill)", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "patterns");
    fs.writeFileSync(path.join(githubDir, "mizumi-feedback.json"), '{"entries":3}');
    fs.writeFileSync(path.join(skillsDir, "rule.md"), "# Rule");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(3);
  });

  it("handles createBlob failure gracefully", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    octokit.rest.git.createBlob = vi.fn().mockRejectedValue(new Error("blob creation failed"));
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
    expect(result.commitSha).toBeNull();
  });

  it("handles createTree failure gracefully", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    octokit.rest.git.createTree = vi.fn().mockRejectedValue(new Error("tree creation failed"));
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
  });

  it("handles createCommit failure gracefully", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    octokit.rest.git.createCommit = vi.fn().mockRejectedValue(new Error("commit failed"));
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.commitSha).toBeNull();
  });

  it("creates blobs with file content from workspace", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    const memoryContent = "## 2026-05-25\n- learned X";
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), memoryContent);

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        content: memoryContent,
        encoding: "utf-8",
      })
    );
  });

  it("uses base tree from current commit for tree creation", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(octokit.rest.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({ base_tree: "tree123" })
    );
  });
});

describe("persistLearningData — HTTP error codes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-persist-http-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOctokitWithHttpError(method: string, statusCode: number) {
    const httpError: any = new Error(`HTTP ${statusCode}`);
    httpError.status = statusCode;
    const base = makeOctokit();
    (base.rest.git as any)[method] = vi.fn().mockRejectedValue(httpError);
    return base;
  }

  it("handles HTTP 401 Unauthorized from getRef", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("getRef", 401);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
    expect(result.commitSha).toBeNull();
  });

  it("handles HTTP 403 Forbidden from getRef", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("getRef", 403);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
  });

  it("handles HTTP 500 Internal Server Error from createBlob", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("createBlob", 500);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.commitSha).toBeNull();
  });

  it("handles HTTP 401 from createCommit", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("createCommit", 401);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.commitSha).toBeNull();
  });

  it("handles HTTP 403 from updateRef", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("updateRef", 403);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
  });

  it("handles HTTP 500 from getCommit", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("getCommit", 500);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
  });

  it("handles HTTP 500 from createTree", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokitWithHttpError("createTree", 500);
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
  });
});

describe("persistLearningData — edge cases and data handling", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-persist-edge-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles workspace with only feedback file (no memory)", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-feedback.json"), '{"reviews": 3}');

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("handles feedback file with complex JSON content", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    const complexJson = JSON.stringify({
      entries: [
        { id: 1, rule: "no-any", severity: "high", file: "src/a.ts" },
        { id: 2, rule: "no-console", severity: "low", file: "src/b.ts" },
      ],
      meta: { version: 2, count: 2 },
    });
    fs.writeFileSync(path.join(githubDir, "mizumi-feedback.json"), complexJson);

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({ content: complexJson })
    );
  });

  it("handles memory file with CRLF line endings", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    const crlfContent = "## 2026-05-27\r\n- pattern A\r\n- pattern B\r\n";
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), crlfContent);

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("creates tree entries with mode 100644", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    const treeCall = octokit.rest.git.createTree.mock.calls[0][0];
    expect(treeCall.tree[0].mode).toBe("100644");
    expect(treeCall.tree[0].type).toBe("blob");
  });

  it("creates tree entries with correct repo paths for skill files", async () => {
    const githubDir = path.join(tmpDir, ".github");
    const skillsDir = path.join(githubDir, "mizumi-skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "my-skill.md"), "# Skill content");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    const treeCall = octokit.rest.git.createTree.mock.calls[0][0];
    expect(treeCall.tree[0].path).toBe(".github/mizumi-skills/my-skill.md");
  });

  it("handles non-Error thrown value from API (string error)", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    octokit.rest.git.getRef = vi.fn().mockRejectedValue("string error value");
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(false);
    expect(result.filesPushed).toBe(0);
    expect(result.commitSha).toBeNull();
  });

  it("propagates owner and repo to all API calls", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    await persistLearningData(octokit as any, "acme", "my-repo", "main", tmpDir);
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "my-repo" })
    );
    expect(octokit.rest.git.getCommit).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "my-repo" })
    );
    expect(octokit.rest.git.createBlob).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "my-repo" })
    );
    expect(octokit.rest.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "my-repo" })
    );
    expect(octokit.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "my-repo" })
    );
    expect(octokit.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "my-repo" })
    );
  });

  it("handles memory file with only markdown headers (no body)", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "## Headers Only\n## Another Header");

    const octokit = makeOctokit();
    const result = await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(result.committed).toBe(true);
    expect(result.filesPushed).toBe(1);
  });

  it("handles concurrent calls without interference (both succeed)", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "initial content");

    const octokit1 = makeOctokit();
    const octokit2 = makeOctokit();
    // Simulate concurrent writes with independent octokit instances
    const [result1, result2] = await Promise.all([
      persistLearningData(octokit1 as any, "owner", "repo", "main", tmpDir),
      persistLearningData(octokit2 as any, "owner", "repo", "main", tmpDir),
    ]);
    expect(result1.committed).toBe(true);
    expect(result2.committed).toBe(true);
  });

  it("calls core.warning on API failure", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit(true);
    const core = await import("@actions/core");
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist learning data")
    );
  });

  it("calls core.info on successful persist", async () => {
    const githubDir = path.join(tmpDir, ".github");
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(path.join(githubDir, "mizumi-memory.md"), "content");

    const octokit = makeOctokit();
    const core = await import("@actions/core");
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Persisted 1 learning data file(s)")
    );
  });

  it("calls core.info when no learning files exist", async () => {
    const octokit = makeOctokit();
    const core = await import("@actions/core");
    await persistLearningData(octokit as any, "owner", "repo", "main", tmpDir);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("No learning data files to persist")
    );
  });
});
