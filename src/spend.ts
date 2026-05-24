/**
 * Spend tracking — per-review token usage logging.
 * Writes to .github/mizumi-spend.jsonl (append-only, one JSON line per review).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";

const SPEND_FILENAME = "mizumi-spend.jsonl";
const MAX_SPEND_ENTRIES = 500;

export interface SpendEntry {
  timestamp: string;
  repo: string;
  pr: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  tier: string;
  findingCount: number;
  riskScore: number;
}

export function createSpendEntry(
  repo: string,
  pr: number,
  provider: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  tier: string,
  findingCount: number,
  riskScore: number
): SpendEntry {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedTokens = usage.cachedInputTokens ?? 0;
  return {
    timestamp: new Date().toISOString(),
    repo,
    pr,
    provider,
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    tier,
    findingCount,
    riskScore,
  };
}

export function appendSpendEntry(workspace: string, entry: SpendEntry): void {
  const dir = path.join(workspace, ".github");
  const filePath = path.join(dir, SPEND_FILENAME);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    core.info(`Spend: ${entry.totalTokens} tokens (${entry.provider}/${entry.model})`);

    // Rotate if too large — keep last MAX_SPEND_ENTRIES lines
    truncateIfNeeded(filePath);
  } catch (error) {
    core.warning(`Failed to write spend entry: ${error}`);
  }
}

function truncateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 500_000) return; // Under 500KB — no rotation needed

    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    if (lines.length > MAX_SPEND_ENTRIES) {
      const kept = lines.slice(-MAX_SPEND_ENTRIES);
      fs.writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
    }
  } catch (e) {
    core.warning(`Spend log rotation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function readSpendLog(workspace: string): SpendEntry[] {
  const filePath = path.join(workspace, ".github", SPEND_FILENAME);
  if (!fs.existsSync(filePath)) return [];

  try {
    return fs.readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) as SpendEntry; } catch { return null; } })
      .filter((e): e is SpendEntry => e !== null);
  } catch {
    return [];
  }
}

export function formatSpendDigest(entries: SpendEntry[]): string {
  if (entries.length === 0) return "No spend data available.";

  const totalTokens = entries.reduce((s, e) => s + e.totalTokens, 0);
  const totalCached = entries.reduce((s, e) => s + e.cachedTokens, 0);
  const byProvider: Record<string, { count: number; tokens: number }> = {};

  for (const e of entries) {
    const key = `${e.provider}/${e.model}`;
    if (!byProvider[key]) byProvider[key] = { count: 0, tokens: 0 };
    byProvider[key].count++;
    byProvider[key].tokens += e.totalTokens;
  }

  let digest = `**Mizumi Spend Digest** (${entries.length} reviews)\n\n`;
  digest += `- Total tokens: ${totalTokens.toLocaleString()}\n`;
  digest += `- Cached tokens: ${totalCached.toLocaleString()} (${totalTokens > 0 ? Math.round((totalCached / totalTokens) * 100) : 0}% cache hit)\n\n`;
  digest += "| Provider/Model | Reviews | Tokens |\n|---------------|---------|--------|\n";
  for (const [key, val] of Object.entries(byProvider).sort((a, b) => b[1].tokens - a[1].tokens)) {
    digest += `| ${key} | ${val.count} | ${val.tokens.toLocaleString()} |\n`;
  }

  return digest;
}
