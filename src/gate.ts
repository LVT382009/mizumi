/**
 * Commit status merge gate — post check status to HEAD SHA.
 * Makes Mizumi an enforceable quality gate via branch protection rules.
 * No other AI reviewer can block merges today.
 */
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";

export type GateThreshold = "none" | "critical" | "high" | "medium";

interface GateInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  headSha: string;
  findings: Array<{ severity: string }>;
  riskScore: number;
  threshold: GateThreshold;
  findingCount: number;
}

const SEVERITY_LEVEL: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  nitpick: 4,
};

/** Check if findings exceed the gate threshold. Returns failure if any finding meets or exceeds the threshold. */
export function shouldFailGate(findings: Array<{ severity: string }>, threshold: GateThreshold): boolean {
  if (threshold === "none") return false;
  const thresholdLevel = SEVERITY_LEVEL[threshold];
  if (thresholdLevel === undefined) return false;
  return findings.some((f) => (SEVERITY_LEVEL[f.severity] ?? 4) <= thresholdLevel);
}

/** Post a commit status to the HEAD SHA. */
export async function postGateStatus(input: GateInput): Promise<"success" | "failure"> {
  const { octokit, owner, repo, headSha, findings, riskScore, threshold, findingCount } = input;

  if (threshold === "none") return "success";

  const failed = shouldFailGate(findings, threshold);

  const state = failed ? "failure" : "success";
  const description = failed
    ? `Blocked: findings at or above ${threshold} severity (risk ${riskScore}/5, ${findingCount} findings)`
    : `Passed: no findings at or above ${threshold} severity (risk ${riskScore}/5, ${findingCount} findings)`;

  try {
    await octokit.rest.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state,
      target_url: `https://github.com/${owner}/${repo}/pull/${input.headSha}`,
      description,
      context: "Mizumi Review Gate",
    });
    core.info(`Gate status: ${state} (threshold=${threshold}, findings=${findingCount})`);
  } catch (e) {
    core.warning(`Failed to post gate status: ${e instanceof Error ? e.message : String(e)}`);
  }

  core.setOutput("gate_status", state);
  return state;
}
