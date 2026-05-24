import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldFailGate, postGateStatus, postPendingGate } from "../gate.js";
import type { GateThreshold } from "../gate.js";

// ---------------------------------------------------------------------------
// shouldFailGate — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("shouldFailGate", () => {
  it("returns false when threshold is none", () => {
    expect(shouldFailGate([{ severity: "critical" }], "none")).toBe(false);
  });

  it("returns false when threshold is none even with many findings", () => {
    const findings = [
      { severity: "critical" },
      { severity: "high" },
      { severity: "medium" },
    ];
    expect(shouldFailGate(findings, "none")).toBe(false);
  });

  it("fails on critical finding when threshold is critical", () => {
    expect(shouldFailGate([{ severity: "critical" }], "critical")).toBe(true);
  });

  it("passes when no findings meet critical threshold", () => {
    expect(shouldFailGate([{ severity: "high" }], "critical")).toBe(false);
  });

  it("passes when no findings at all with critical threshold", () => {
    expect(shouldFailGate([], "critical")).toBe(false);
  });

  it("fails on high finding when threshold is high", () => {
    expect(shouldFailGate([{ severity: "high" }], "high")).toBe(true);
  });

  it("fails on critical finding when threshold is high (critical > high)", () => {
    expect(shouldFailGate([{ severity: "critical" }], "high")).toBe(true);
  });

  it("passes on medium finding when threshold is high", () => {
    expect(shouldFailGate([{ severity: "medium" }], "high")).toBe(false);
  });

  it("fails on medium finding when threshold is medium", () => {
    expect(shouldFailGate([{ severity: "medium" }], "medium")).toBe(true);
  });

  it("fails on high+critical findings when threshold is medium", () => {
    const findings = [{ severity: "high" }, { severity: "critical" }];
    expect(shouldFailGate(findings, "medium")).toBe(true);
  });

  it("passes on low finding when threshold is medium", () => {
    expect(shouldFailGate([{ severity: "low" }], "medium")).toBe(false);
  });

  it("passes on nitpick finding when threshold is medium", () => {
    expect(shouldFailGate([{ severity: "nitpick" }], "medium")).toBe(false);
  });

  it("handles mixed severity findings correctly", () => {
    const findings = [
      { severity: "low" },
      { severity: "nitpick" },
      { severity: "medium" },
    ];
    expect(shouldFailGate(findings, "high")).toBe(false);
    expect(shouldFailGate(findings, "medium")).toBe(true);
    expect(shouldFailGate(findings, "critical")).toBe(false);
  });

  it("handles unknown severity as lowest priority", () => {
    expect(shouldFailGate([{ severity: "unknown" }], "medium")).toBe(false);
  });

  it("fails closed on invalid threshold (fail-safe default)", () => {
    expect(shouldFailGate([], "invalid" as GateThreshold)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// postGateStatus / postPendingGate — requires mocking Octokit
// ---------------------------------------------------------------------------

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

import * as core from "@actions/core";

const mockSetOutput = vi.mocked(core.setOutput);
const mockWarning = vi.mocked(core.warning);

function makeOctokit() {
  return {
    rest: {
      repos: {
        createCommitStatus: vi.fn().mockResolvedValue({}),
      },
    },
  } as any;
}

describe("postGateStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success without posting when threshold is none", async () => {
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit,
      owner: "test",
      repo: "repo",
      headSha: "abc123",
      prNumber: 7,
      findings: [{ severity: "critical" }],
      riskScore: 5,
      threshold: "none",
      findingCount: 1,
    });
    expect(result).toBe("success");
    expect(octokit.rest.repos.createCommitStatus).not.toHaveBeenCalled();
  });

  it("posts failure status when findings exceed threshold", async () => {
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit,
      owner: "test",
      repo: "repo",
      headSha: "abc123",
      prNumber: 7,
      findings: [{ severity: "critical" }, { severity: "high" }],
      riskScore: 4,
      threshold: "high",
      findingCount: 2,
    });
    expect(result).toBe("failure");
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "abc123",
        state: "failure",
        context: "Mizumi Review Gate",
      })
    );
    expect(mockSetOutput).toHaveBeenCalledWith("gate_status", "failure");
  });

  it("posts success status when findings do not exceed threshold", async () => {
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit,
      owner: "test",
      repo: "repo",
      headSha: "abc123",
      prNumber: 7,
      findings: [{ severity: "low" }],
      riskScore: 2,
      threshold: "high",
      findingCount: 1,
    });
    expect(result).toBe("success");
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "success",
      })
    );
    expect(mockSetOutput).toHaveBeenCalledWith("gate_status", "success");
  });

  it("includes finding count and risk score in description", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit,
      owner: "test",
      repo: "repo",
      headSha: "abc123",
      prNumber: 7,
      findings: [{ severity: "high" }],
      riskScore: 3,
      threshold: "high",
      findingCount: 5,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("5 findings");
    expect(call.description).toContain("3/5");
  });

  it("gracefully handles API errors", async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.createCommitStatus.mockRejectedValue(new Error("API error"));
    const result = await postGateStatus({
      octokit,
      owner: "test",
      repo: "repo",
      headSha: "abc123",
      prNumber: 7,
      findings: [{ severity: "critical" }],
      riskScore: 5,
      threshold: "critical",
      findingCount: 1,
    });
    expect(result).toBe("failure");
  });

  it("includes PR URL in target_url", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit,
      owner: "myorg",
      repo: "myrepo",
      headSha: "def456",
      prNumber: 42,
      findings: [{ severity: "low" }],
      riskScore: 1,
      threshold: "high",
      findingCount: 1,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.target_url).toBe("https://github.com/myorg/myrepo/pull/42");
  });
});

describe("postPendingGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts pending status with correct context", async () => {
    const octokit = makeOctokit();
    await postPendingGate(octokit, "owner", "repo", "abc123", 7);
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sha: "abc123",
        state: "pending",
        context: "Mizumi Review Gate",
        description: "Review in progress...",
      })
    );
  });

  it("includes PR URL in target_url", async () => {
    const octokit = makeOctokit();
    await postPendingGate(octokit, "myorg", "myrepo", "def456", 42);
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.target_url).toBe("https://github.com/myorg/myrepo/pull/42");
  });

  it("gracefully handles API errors", async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.createCommitStatus.mockRejectedValue(new Error("API error"));
    await expect(postPendingGate(octokit, "owner", "repo", "abc123", 7)).resolves.toBeUndefined();
    expect(mockWarning).toHaveBeenCalled();
  });
});
