/**
 * PR auto-labeling — apply GitHub labels based on review findings.
 *
 * Derives labels from finding severity, category, and volume:
 *   - security → "security" (red)
 *   - bug → "bug" (red)
 *   - style → "style" (blue)
 *   - compliance → "compliance" (purple)
 *   - risk >= 4 → "needs-attention" (orange)
 *   - findingCount >= 10 → "review-heavy" (yellow)
 *
 * Creates missing labels, computes delta vs current labels, and
 * only adds/removes changed labels.
 */
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

interface LabelDef {
  name: string;
  color: string;
  description: string;
}

const LABEL_DEFS: LabelDef[] = [
  { name: "security", color: "ee0701", description: "Contains security findings" },
  { name: "bug", color: "fc4c46", description: "Contains bug findings" },
  { name: "style", color: "1d76db", description: "Contains style/formatting findings" },
  { name: "compliance", color: "5319e7", description: "Ticket compliance issues" },
  { name: "needs-attention", color: "fbca04", description: "High risk — needs careful review" },
  { name: "review-heavy", color: "fef2c0", description: "10+ findings — consider splitting PR" },
];

export interface LabelResult {
  added: string[];
  removed: string[];
}

/** Compute desired labels from review findings */
export function computeLabels(
  findings: Array<{ severity: string; category: string }>,
  riskScore: number
): string[] {
  const labels = new Set<string>();
  const categories = new Set(findings.map((f) => f.category));

  if (categories.has("security")) labels.add("security");
  if (categories.has("bug")) labels.add("bug");
  if (categories.has("style")) labels.add("style");
  if (categories.has("compliance")) labels.add("compliance");
  if (riskScore >= 4) labels.add("needs-attention");
  if (findings.length >= 10) labels.add("review-heavy");

  return [...labels];
}

/** Create a label if it doesn't exist yet */
async function ensureLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  def: LabelDef
): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: def.name });
  } catch {
    try {
      await octokit.rest.issues.createLabel({
        owner, repo,
        name: def.name,
        color: def.color,
        description: def.description,
      });
    } catch {
      core.debug(`Label '${def.name}' already exists or cannot be created`);
    }
  }
}

/** Apply auto-labels to a PR, computing delta vs current labels */
export async function applyLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  findings: Array<{ severity: string; category: string }>,
  riskScore: number
): Promise<LabelResult> {
  const desired = new Set(computeLabels(findings, riskScore));
  if (desired.size === 0) return { added: [], removed: [] };

  // Ensure label definitions exist in the repo
  const labelDefsByName = new Map(LABEL_DEFS.map((l) => [l.name, l]));
  for (const name of desired) {
    const def = labelDefsByName.get(name);
    if (def) await ensureLabel(octokit, owner, repo, def);
  }

  // Get current Mizumi-managed labels on the PR
  const { data: currentLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner, repo, issue_number: prNumber,
  });
  const mizumiLabelNames = new Set(LABEL_DEFS.map((l) => l.name));
  const currentMizumi = new Set(
    currentLabels.map((l) => l.name).filter((n) => mizumiLabelNames.has(n))
  );

  // Compute delta
  const toAdd = [...desired].filter((n) => !currentMizumi.has(n));
  const toRemove = [...currentMizumi].filter((n) => !desired.has(n));

  // Apply additions
  if (toAdd.length > 0) {
    await octokit.rest.issues.addLabels({
      owner, repo, issue_number: prNumber, labels: toAdd,
    });
  }

  // Apply removals (only Mizumi-managed labels)
  for (const name of toRemove) {
    try {
      await octokit.rest.issues.removeLabel({
        owner, repo, issue_number: prNumber, name,
      });
    } catch {
      // Label may already be removed
    }
  }

  if (toAdd.length > 0 || toRemove.length > 0) {
    core.info(`Auto-labels: +${toAdd.join(",")} -${toRemove.join(",")}`);
  }

  return { added: toAdd, removed: toRemove };
}
