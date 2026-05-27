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

  it("posts with correct owner and repo", async () => {
    const octokit = makeOctokit();
    await postPendingGate(octokit, "acme", "widgets", "sha789", 99);
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.owner).toBe("acme");
    expect(call.repo).toBe("widgets");
    expect(call.sha).toBe("sha789");
  });
});

// ---------------------------------------------------------------------------
// Additional shouldFailGate edge cases
// ---------------------------------------------------------------------------

describe("shouldFailGate additional edge cases", () => {
  it("handles empty findings array with all thresholds", () => {
    expect(shouldFailGate([], "none")).toBe(false);
    expect(shouldFailGate([], "critical")).toBe(false);
    expect(shouldFailGate([], "high")).toBe(false);
    expect(shouldFailGate([], "medium")).toBe(false);
  });

  it("treats missing severity as lowest (never fails gate)", () => {
    expect(shouldFailGate([{ severity: "" }], "medium")).toBe(false);
  });

  it("works with single severity types at each threshold boundary", () => {
    // critical threshold: only critical fails
    expect(shouldFailGate([{ severity: "critical" }], "critical")).toBe(true);
    expect(shouldFailGate([{ severity: "high" }], "critical")).toBe(false);
    // high threshold: critical and high fail
    expect(shouldFailGate([{ severity: "critical" }], "high")).toBe(true);
    expect(shouldFailGate([{ severity: "high" }], "high")).toBe(true);
    expect(shouldFailGate([{ severity: "medium" }], "high")).toBe(false);
    // medium threshold: critical, high, and medium fail
    expect(shouldFailGate([{ severity: "medium" }], "medium")).toBe(true);
    expect(shouldFailGate([{ severity: "low" }], "medium")).toBe(false);
    expect(shouldFailGate([{ severity: "nitpick" }], "medium")).toBe(false);
  });

  it("handles large findings arrays efficiently", () => {
    const findings = Array.from({ length: 1000 }, (_, i) => ({
      severity: i === 500 ? "critical" : "low",
    }));
    expect(shouldFailGate(findings, "critical")).toBe(true);
    expect(shouldFailGate(findings, "medium")).toBe(true);
  });

  it("returns true for any invalid threshold string", () => {
    expect(shouldFailGate([], "invalid" as GateThreshold)).toBe(true);
    expect(shouldFailGate([], "info" as GateThreshold)).toBe(true);
  });

  it("is case-sensitive on threshold values", () => {
    expect(shouldFailGate([{ severity: "critical" }], "Critical" as GateThreshold)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional postGateStatus edge cases
// ---------------------------------------------------------------------------

describe("postGateStatus additional edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes with empty findings at medium threshold", async () => {
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [], riskScore: 1, threshold: "medium", findingCount: 0,
    });
    expect(result).toBe("success");
  });

  it("failure description contains threshold name", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "medium" }], riskScore: 3, threshold: "medium", findingCount: 3,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("medium");
  });

  it("success description contains passed message", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "low" }], riskScore: 2, threshold: "high", findingCount: 1,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("Passed");
  });

  it("calls setOutput even on API error", async () => {
    const octokit = makeOctokit();
    octokit.rest.repos.createCommitStatus.mockRejectedValue(new Error("fail"));
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "critical" }], riskScore: 5, threshold: "critical", findingCount: 1,
    });
    expect(mockSetOutput).toHaveBeenCalledWith("gate_status", "failure");
  });

  it("passes with all nitpick findings at medium threshold", async () => {
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "nitpick" }, { severity: "nitpick" }], riskScore: 1, threshold: "medium", findingCount: 2,
    });
    expect(result).toBe("success");
  });

  // --- Combined shouldFailGate + postGateStatus ---

  it("combined: shouldFailGate true matches postGateStatus failure", async () => {
    const findings = [{ severity: "critical" }];
    const threshold: GateThreshold = "critical";
    expect(shouldFailGate(findings, threshold)).toBe(true);
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings, riskScore: 5, threshold, findingCount: 1,
    });
    expect(result).toBe("failure");
  });

  it("combined: shouldFailGate false matches postGateStatus success", async () => {
    const findings = [{ severity: "low" }];
    const threshold: GateThreshold = "high";
    expect(shouldFailGate(findings, threshold)).toBe(false);
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings, riskScore: 2, threshold, findingCount: 1,
    });
    expect(result).toBe("success");
  });

  // --- postGateStatus with risk scores 0, 1, 5 ---

  it("postGateStatus with riskScore 0 includes 0/5 in description", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [], riskScore: 0, threshold: "high", findingCount: 0,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("0/5");
  });

  it("postGateStatus with riskScore 1 includes 1/5 in description", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [], riskScore: 1, threshold: "medium", findingCount: 0,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("1/5");
  });

  it("postGateStatus with riskScore 5 includes 5/5 in description", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "critical" }], riskScore: 5, threshold: "critical", findingCount: 1,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("5/5");
  });

  // --- postGateStatus with various finding counts ---

  it("postGateStatus with 0 findings shows 0 findings in description", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [], riskScore: 1, threshold: "medium", findingCount: 0,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("0 findings");
  });

  it("postGateStatus with 100 findings includes count in description", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "low" }], riskScore: 2, threshold: "high", findingCount: 100,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("100 findings");
  });

  // --- Low severity at medium threshold ---

  it("does not fail gate with low findings at medium threshold", () => {
    expect(shouldFailGate([{ severity: "low" }], "medium")).toBe(false);
  });

  it("postGateStatus returns success with low findings at medium threshold", async () => {
    const octokit = makeOctokit();
    const result = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "low" }, { severity: "low" }], riskScore: 2, threshold: "medium", findingCount: 2,
    });
    expect(result).toBe("success");
  });

  // --- Multiple calls in sequence ---

  it("postGateStatus handles multiple sequential calls correctly", async () => {
    const octokit = makeOctokit();
    const result1 = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha1", prNumber: 1,
      findings: [{ severity: "critical" }], riskScore: 5, threshold: "critical", findingCount: 1,
    });
    const result2 = await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha2", prNumber: 2,
      findings: [], riskScore: 1, threshold: "medium", findingCount: 0,
    });
    expect(result1).toBe("failure");
    expect(result2).toBe("success");
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledTimes(2);
  });

  // --- Correct string for all threshold+finding combos ---

  it("critical threshold + critical finding produces 'Blocked' message", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "critical" }], riskScore: 5, threshold: "critical", findingCount: 1,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("Blocked");
    expect(call.description).toContain("critical");
  });

  it("high threshold + medium findings produces 'Passed' message", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "medium" }], riskScore: 3, threshold: "high", findingCount: 1,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("Passed");
    expect(call.description).toContain("high");
  });

  it("medium threshold + medium findings produces 'Blocked' message", async () => {
    const octokit = makeOctokit();
    await postGateStatus({
      octokit, owner: "t", repo: "r", headSha: "sha", prNumber: 1,
      findings: [{ severity: "medium" }], riskScore: 3, threshold: "medium", findingCount: 1,
    });
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.description).toContain("Blocked");
    expect(call.description).toContain("medium");
  });

  // --- postPendingGate with various SHA formats ---

  it("postPendingGate with full 40-char SHA", async () => {
    const octokit = makeOctokit();
    await postPendingGate(octokit, "owner", "repo", "abc123def456abc123def456abc123def456abcd", 7);
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.sha).toBe("abc123def456abc123def456abc123def456abcd");
  });

  it("postPendingGate with short SHA", async () => {
    const octokit = makeOctokit();
    await postPendingGate(octokit, "owner", "repo", "abc", 1);
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.sha).toBe("abc");
  });

  it("postPendingGate with numeric-only SHA", async () => {
    const octokit = makeOctokit();
    await postPendingGate(octokit, "owner", "repo", "1234567890", 5);
    const call = octokit.rest.repos.createCommitStatus.mock.calls[0][0];
    expect(call.sha).toBe("1234567890");
  });

  // --- Additional shouldFailGate edge cases ---

  it("critical threshold fails only on critical, not high", () => {
    expect(shouldFailGate([{ severity: "high" }], "critical")).toBe(false);
  });

  it("high threshold fails on both critical and high", () => {
    expect(shouldFailGate([{ severity: "critical" }], "high")).toBe(true);
    expect(shouldFailGate([{ severity: "high" }], "high")).toBe(true);
  });

  it("medium threshold fails on critical, high, and medium", () => {
    expect(shouldFailGate([{ severity: "critical" }], "medium")).toBe(true);
    expect(shouldFailGate([{ severity: "high" }], "medium")).toBe(true);
    expect(shouldFailGate([{ severity: "medium" }], "medium")).toBe(true);
    expect(shouldFailGate([{ severity: "low" }], "medium")).toBe(false);
  });
});
