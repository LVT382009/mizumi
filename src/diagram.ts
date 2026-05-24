/**
 * Mermaid diagram generator — produces flowcharts from diff analysis.
 * GitHub natively renders ```mermaid blocks in PR comments and descriptions.
 * Phase 2.23: Auto-generates architecture diagrams for /mizumi describe
 * and large review bodies.
 */
import { ReviewCommentType } from "./review.js";

interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Generate a Mermaid flowchart showing the PR's change architecture.
 * Groups files by directory, shows addition/deletion sizes, and
 * draws connections between related modules.
 */
export function generateArchDiagram(
  files: DiffFile[],
  findings: ReviewCommentType[] = []
): string {
  if (files.length < 2) return "";

  const groups = new Map<string, { files: string[]; additions: number; deletions: number }>();

  for (const f of files) {
    const dir = getGroupKey(f.path);
    if (!groups.has(dir)) {
      groups.set(dir, { files: [], additions: 0, deletions: 0 });
    }
    const g = groups.get(dir)!;
    g.files.push(f.path);
    g.additions += f.additions;
    g.deletions += f.deletions;
  }

  if (groups.size < 2) return "";

  const lines: string[] = ["flowchart TD"];

  // Add nodes for each group
  const groupKeys = [...groups.keys()];
  for (const key of groupKeys) {
    const g = groups.get(key)!;
    const label = key.replace(/_/g, " ");
    const stats = `+${g.additions}/-${g.deletions}`;
    const findingCount = findings.filter((f) =>
      groups.get(key)!.files.some((fp) => f.file === fp)
    ).length;
    const badge = findingCount > 0 ? ` [${findingCount}]` : "";
    lines.push(`    ${safeId(key)}["${label}<br/><small>${stats}${badge}</small>"]`);
  }

  // Draw connections between adjacent groups in dependency order
  const sortedKeys = groupKeys.sort();
  for (let i = 0; i < sortedKeys.length - 1; i++) {
    lines.push(`    ${safeId(sortedKeys[i])} --> ${safeId(sortedKeys[i + 1])}`);
  }

  // Add severity annotations for groups with critical/high findings
  for (const key of groupKeys) {
    const g = groups.get(key)!;
    const criticalFindings = findings.filter(
      (f) => g.files.some((fp) => f.file === fp) && (f.severity === "critical" || f.severity === "high")
    );
    if (criticalFindings.length > 0) {
      lines.push(`    ${safeId(key)}:::critical`);
    }
  }

  lines.push("");
  lines.push("    classDef critical fill:#ff6b6b,stroke:#c0392b,color:#fff");

  const diagram = lines.join("\n");

  return "```mermaid\n" + diagram + "\n```";
}

/**
 * Generate a finding-severity diagram showing review findings distribution.
 */
export function generateSeverityDiagram(findings: ReviewCommentType[]): string {
  if (findings.length === 0) return "";

  const severityCounts: Record<string, number> = {};
  for (const f of findings) {
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  const lines: string[] = ["flowchart LR"];

  const order = ["critical", "high", "medium", "low", "nitpick"];
  const colors: Record<string, string> = {
    critical: "#ff6b6b",
    high: "#e17055",
    medium: "#fdcb6e",
    low: "#74b9ff",
    nitpick: "#dfe6e9",
  };

  lines.push(`    total["${findings.length} findings"]`);

  for (const sev of order) {
    const count = severityCounts[sev];
    if (!count) continue;
    lines.push(`    ${sev}["${sev}<br/>${count}"]`);
    lines.push(`    total --> ${sev}`);
  }

  lines.push("");
  for (const [sev, color] of Object.entries(colors)) {
    if (severityCounts[sev]) {
      lines.push(`    classDef ${sev} fill:${color},stroke:#333,color:#000`);
      lines.push(`    ${sev}:::${sev}`);
    }
  }

  const diagram = lines.join("\n");

  return "```mermaid\n" + diagram + "\n```";
}

function getGroupKey(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "root";
  // Use top-level directory as group
  if (parts[0] === "src" && parts.length > 2) {
    return parts.slice(0, 2).join("_");
  }
  return parts[0];
}

function safeId(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "_");
}
