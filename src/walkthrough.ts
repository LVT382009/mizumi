/**
 * Walkthrough — generate a concise change summary by directory/module.
 *
 * Groups diff files by directory, summarizes finding counts per group,
 * and produces a collapsible <details> block at the top of the review body
 * (CodeRabbit-inspired pattern).
 */
import { DiffFileSummary } from "./post.js";

interface WalkthroughGroup {
  dir: string;
  files: number;
  additions: number;
  deletions: number;
  findingSeverities: Record<string, number>;
}

/** Derive directory from file path (top-level or first N levels) */
function dirFromPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath;
  return parts.slice(0, 2).join("/") + "/";
}

/** Build a walkthrough summary from diff files and findings */
export function buildWalkthrough(
  diffFiles: DiffFileSummary[],
  findings: Array<{ file: string; severity: string; category: string }>,
  riskScore: number
): string {
  if (diffFiles.length < 2) return "";

  const groups = new Map<string, WalkthroughGroup>();

  for (const f of diffFiles) {
    const dir = dirFromPath(f.path);
    let group = groups.get(dir);
    if (!group) {
      group = { dir, files: 0, additions: 0, deletions: 0, findingSeverities: {} };
      groups.set(dir, group);
    }
    group.files++;
    group.additions += f.additions;
    group.deletions += f.deletions;
  }

  // Attach findings to groups
  for (const finding of findings) {
    const dir = dirFromPath(finding.file);
    const group = groups.get(dir);
    if (group) {
      group.findingSeverities[finding.severity] = (group.findingSeverities[finding.severity] || 0) + 1;
    }
  }

  const sortedGroups = [...groups.values()].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));

  let body = `<details><summary><strong>Walkthrough</strong> — ${diffFiles.length} files, ${findings.length} findings, risk ${riskScore}/5</summary>\n\n`;
  body += "| Directory | Files | +/- | Key Findings |\n";
  body += "|-----------|-------|-----|-------------|\n";

  for (const g of sortedGroups) {
    const change = `+${g.additions}/-${g.deletions}`;
    const findingStr = Object.entries(g.findingSeverities)
      .sort(([a], [b]) => severityOrder(a) - severityOrder(b))
      .map(([sev, count]) => `${severityEmoji(sev)}${count}`)
      .join(" ") || "—";
    body += `| \`${g.dir}\` | ${g.files} | ${change} | ${findingStr} |\n`;
  }

  body += "\n</details>\n";
  return body;
}

function severityOrder(s: string): number {
  switch (s) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    default: return 4;
  }
}

function severityEmoji(s: string): string {
  switch (s) {
    case "critical": return ":rotating_light:";
    case "high": return ":red_circle:";
    case "medium": return ":orange_circle:";
    case "low": return ":white_circle:";
    default: return ":white_circle:";
  }
}

/** Estimate review effort from diff size + finding count (1-5 scale) */
export function estimateEffort(
  diffFiles: DiffFileSummary[],
  findingCount: number
): number {
  const totalLines = diffFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  let effort = 1;
  if (totalLines > 500) effort++;
  if (totalLines > 1500) effort++;
  if (findingCount > 5) effort++;
  if (findingCount > 15) effort++;
  return Math.min(effort, 5);
}
