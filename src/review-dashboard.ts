/**
 * Review Dashboard — team-facing metrics for review quality over time.
 *
 * Competitive gap: No AI code reviewer provides a review dashboard.
 * CodeRabbit has no metrics UI. Sourcery shows acceptance rates
 * but no quality trends. Mizumi generates a self-contained HTML
 * dashboard that teams can host as a GitHub Page or artifact.
 *
 * Metrics:
 * 1. Review volume trend (reviews/week over last 4 weeks)
 * 2. Finding acceptance rate by category
 * 3. Top suppressed patterns (what the team keeps dismissing)
 * 4. Severity distribution over time
 * 5. Average risk score trend
 * 6. Provider cost breakdown (from spend logs)
 *
 * Zero LLM cost — built from deterministic data already collected.
 * Dashboard is a standalone HTML file with inline CSS/JS.
 */
import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardMetrics {
  /** Total reviews in period */
  totalReviews: number;
  /** Total findings across all reviews */
  totalFindings: number;
  /** Average risk score */
  avgRiskScore: number;
  /** Finding acceptance rate by category */
  acceptanceByCategory: Record<string, { accepted: number; total: number; rate: number }>;
  /** Top suppressed patterns */
  topSuppressed: Array<{ pattern: string; count: number; category: string }>;
  /** Severity distribution */
  severityDistribution: Record<string, number>;
  /** Volume per week (last 4 weeks) */
  weeklyVolume: Array<{ week: string; reviews: number; findings: number }>;
  /** Risk score trend per week */
  riskTrend: Array<{ week: string; avgRisk: number }>;
  /** Per-provider token usage */
  providerUsage: Record<string, { inputTokens: number; outputTokens: number; cost: number }>;
  /** Top finding categories */
  topCategories: Array<{ category: string; count: number }>;
}

export interface DashboardConfig {
  /** Workspace path for data files */
  workspace: string;
  /** Repository identifier (owner/repo) */
  repoId: string;
  /** Number of weeks to show in trend (default 4) */
  weeks?: number;
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

/**
 * Collect dashboard metrics from existing data stores.
 * Reads from feedback store, spend log, and finding snapshots.
 */
export function collectDashboardMetrics(config: DashboardConfig): DashboardMetrics {
  const weeks = config.weeks ?? 4;
  const workspace = config.workspace;

  // Read feedback store for acceptance rates
  const acceptanceByCategory: Record<string, { accepted: number; total: number; rate: number }> = {};
  try {
    const feedbackPath = path.join(workspace, ".mizumi", "feedback.json");
    if (fs.existsSync(feedbackPath)) {
      const store = JSON.parse(fs.readFileSync(feedbackPath, "utf8")) as Array<{
        category?: string; outcome?: string; [k: string]: unknown;
      }>;
      for (const entry of store) {
        const cat = entry.category || "other";
        if (!acceptanceByCategory[cat]) {
          acceptanceByCategory[cat] = { accepted: 0, total: 0, rate: 0 };
        }
        acceptanceByCategory[cat].total++;
        if (entry.outcome === "accepted") {
          acceptanceByCategory[cat].accepted++;
        }
      }
      // Calculate rates
      for (const cat of Object.keys(acceptanceByCategory)) {
        const d = acceptanceByCategory[cat];
        d.rate = d.total > 0 ? Math.round((d.accepted / d.total) * 100) : 0;
      }
    }
  } catch {
    // Non-critical
  }

  // Read spend log for provider usage
  const providerUsage: Record<string, { inputTokens: number; outputTokens: number; cost: number }> = {};
  let totalFindings = 0;
  let totalReviews = 0;
  const severityDist: Record<string, number> = {};
  const weeklyReviews: Record<string, number> = {};
  const weeklyFindings: Record<string, number> = {};
  const weeklyRisk: Record<string, number[]> = {};
  const categoryCounts: Record<string, number> = {};

  try {
    const spendPath = path.join(workspace, ".mizumi", "spend.jsonl");
    if (fs.existsSync(spendPath)) {
      const lines = fs.readFileSync(spendPath, "utf8").trim().split("\n");
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          totalReviews++;

          // Provider usage
          const provider = String(entry.provider || "unknown");
          if (!providerUsage[provider]) {
            providerUsage[provider] = { inputTokens: 0, outputTokens: 0, cost: 0 };
          }
          providerUsage[provider].inputTokens += Number(entry.inputTokens || 0);
          providerUsage[provider].outputTokens += Number(entry.outputTokens || 0);
          providerUsage[provider].cost += Number(entry.cost || 0);

          // Findings count
          const findings = Number(entry.findingCount || 0);
          totalFindings += findings;

          // Severity distribution
          const severities = entry.severities as Record<string, number> | undefined;
          if (severities) {
            for (const [sev, count] of Object.entries(severities)) {
              severityDist[sev] = (severityDist[sev] || 0) + count;
            }
          }

          // Categories
          const categories = entry.categories as Record<string, number> | undefined;
          if (categories) {
            for (const [cat, count] of Object.entries(categories)) {
              categoryCounts[cat] = (categoryCounts[cat] || 0) + count;
            }
          }

          // Weekly grouping
          const ts = String(entry.timestamp || "");
          if (ts) {
            const week = getWeekKey(ts);
            weeklyReviews[week] = (weeklyReviews[week] || 0) + 1;
            weeklyFindings[week] = (weeklyFindings[week] || 0) + findings;
            const risk = Number(entry.riskScore || 0);
            if (risk > 0) {
              if (!weeklyRisk[week]) weeklyRisk[week] = [];
              weeklyRisk[week].push(risk);
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    // Non-critical
  }

  // Read suppression memories for top suppressed patterns
  const topSuppressed: Array<{ pattern: string; count: number; category: string }> = [];
  try {
    const suppPath = path.join(workspace, ".mizumi", "suppressions.jsonl");
    if (fs.existsSync(suppPath)) {
      const lines = fs.readFileSync(suppPath, "utf8").trim().split("\n");
      const patternCounts: Record<string, { count: number; category: string }> = {};
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const key = String(entry.category || "other") + ":" + String(entry.messagePattern || "");
          if (!patternCounts[key]) {
            patternCounts[key] = { count: 0, category: String(entry.category || "other") };
          }
          patternCounts[key].count += Number(entry.suppressCount || 1);
        } catch {
          // Skip
        }
      }
      for (const [pattern, data] of Object.entries(patternCounts)) {
        topSuppressed.push({ pattern, count: data.count, category: data.category });
      }
      topSuppressed.sort((a, b) => b.count - a.count);
    }
  } catch {
    // Non-critical
  }

  // Build weekly arrays (last N weeks)
  const allWeeks = Object.keys(weeklyReviews).sort();
  const recentWeeks = allWeeks.slice(-weeks);
  const weeklyVolume = recentWeeks.map((w) => ({
    week: w,
    reviews: weeklyReviews[w] || 0,
    findings: weeklyFindings[w] || 0,
  }));
  const riskTrend = recentWeeks.map((w) => ({
    week: w,
    avgRisk: weeklyRisk[w] && weeklyRisk[w].length > 0
      ? Math.round(weeklyRisk[w].reduce((s, v) => s + v, 0) / weeklyRisk[w].length * 10) / 10
      : 0,
  }));

  // Build top categories
  const topCategories = Object.entries(categoryCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([category, count]) => ({ category, count }));

  const avgRiskScore = totalReviews > 0
    ? Math.round(Object.values(weeklyRisk).flat().reduce((s, v) => s + v, 0) / Math.max(Object.values(weeklyRisk).flat().length, 1) * 10) / 10
    : 0;

  return {
    totalReviews,
    totalFindings,
    avgRiskScore,
    acceptanceByCategory,
    topSuppressed: topSuppressed.slice(0, 10),
    severityDistribution: severityDist,
    weeklyVolume,
    riskTrend,
    providerUsage,
    topCategories,
  };
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

/**
 * Generate a standalone HTML dashboard from collected metrics.
 */
export function generateDashboardHTML(metrics: DashboardMetrics, repoId: string): string {
  const acceptanceRows = Object.entries(metrics.acceptanceByCategory)
    .map(([cat, data]) => `<tr><td>${esc(cat)}</td><td>${data.total}</td><td>${data.accepted}</td><td>${data.rate}%</td></tr>`)
    .join("\n");

  const suppressionRows = metrics.topSuppressed
    .map((s) => `<tr><td>${esc(s.category)}</td><td>${esc(s.pattern.split(":").pop() || s.pattern)}</td><td>${s.count}</td></tr>`)
    .join("\n");

  const weeklyRows = metrics.weeklyVolume
    .map((w) => `<tr><td>${esc(w.week)}</td><td>${w.reviews}</td><td>${w.findings}</td></tr>`)
    .join("\n");

  const riskRows = metrics.riskTrend
    .map((r) => `<tr><td>${esc(r.week)}</td><td>${r.avgRisk}</td></tr>`)
    .join("\n");

  const providerRows = Object.entries(metrics.providerUsage)
    .map(([p, d]) => `<tr><td>${esc(p)}</td><td>${formatTokens(d.inputTokens)}</td><td>${formatTokens(d.outputTokens)}</td><td>$${d.cost.toFixed(2)}</td></tr>`)
    .join("\n");

  const categoryRows = metrics.topCategories
    .map((c) => `<tr><td>${esc(c.category)}</td><td>${c.count}</td></tr>`)
    .join("\n");

  const sevData = Object.entries(metrics.severityDistribution)
    .map(([sev, count]) => `<div class="sev-bar"><span class="sev-label ${sev}">${esc(sev)}</span><span class="sev-count">${count}</span></div>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mizumi Dashboard — ${esc(repoId)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px}
h1{color:#58a6ff;font-size:1.5em;margin-bottom:8px}
.subtitle{color:#8b949e;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px}
.card h2{color:#58a6ff;font-size:1.1em;margin-bottom:12px;border-bottom:1px solid #30363d;padding-bottom:8px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:600;font-size:0.85em}
td{font-size:0.9em}
.stat{font-size:2em;color:#58a6ff;font-weight:700}
.stat-label{color:#8b949e;font-size:0.85em}
.sev-bar{display:flex;align-items:center;justify-content:space-between;padding:6px 0}
.sev-label{padding:2px 8px;border-radius:4px;font-size:0.85em;font-weight:600}
.sev-label.critical{background:#da3633;color:#fff}
.sev-label.high{background:#d29922;color:#fff}
.sev-label.medium{background:#1f6feb;color:#fff}
.sev-label.low{background:#238636;color:#fff}
.sev-label.nitpick{background:#30363d;color:#8b949e}
.sev-count{color:#c9d1d9;font-weight:600}
footer{color:#484f58;font-size:0.8em;text-align:center;margin-top:32px}
</style>
</head>
<body>
<h1>Mizumi Review Dashboard</h1>
<p class="subtitle">${esc(repoId)}</p>

<div class="grid">
<div class="card">
  <div class="stat">${metrics.totalReviews}</div>
  <div class="stat-label">Total Reviews</div>
</div>
<div class="card">
  <div class="stat">${metrics.totalFindings}</div>
  <div class="stat-label">Total Findings</div>
</div>
<div class="card">
  <div class="stat">${metrics.avgRiskScore}</div>
  <div class="stat-label">Avg Risk Score</div>
</div>
</div>

<div class="grid">
<div class="card">
  <h2>Severity Distribution</h2>
  ${sevData || "<p>No severity data</p>"}
</div>
<div class="card">
  <h2>Top Categories</h2>
  <table><tr><th>Category</th><th>Count</th></tr>${categoryRows || "<tr><td colspan=2>No data</td></tr>"}</table>
</div>
</div>

<div class="grid">
<div class="card">
  <h2>Acceptance Rate by Category</h2>
  <table><tr><th>Category</th><th>Total</th><th>Accepted</th><th>Rate</th></tr>${acceptanceRows || "<tr><td colspan=4>No data</td></tr>"}</table>
</div>
<div class="card">
  <h2>Top Suppressed Patterns</h2>
  <table><tr><th>Category</th><th>Pattern</th><th>Suppressed</th></tr>${suppressionRows || "<tr><td colspan=3>No suppressions</td></tr>"}</table>
</div>
</div>

<div class="grid">
<div class="card">
  <h2>Weekly Volume</h2>
  <table><tr><th>Week</th><th>Reviews</th><th>Findings</th></tr>${weeklyRows || "<tr><td colspan=3>No data</td></tr>"}</table>
</div>
<div class="card">
  <h2>Risk Score Trend</h2>
  <table><tr><th>Week</th><th>Avg Risk</th></tr>${riskRows || "<tr><td colspan=2>No data</td></tr>"}</table>
</div>
</div>

<div class="card">
  <h2>Provider Usage</h2>
  <table><tr><th>Provider</th><th>Input Tokens</th><th>Output Tokens</th><th>Cost</th></tr>${providerRows || "<tr><td colspan=4>No spend data</td></tr>"}</table>
</div>

<footer>Generated by Mizumi Review Dashboard</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function getWeekKey(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  } catch {
    return "unknown";
  }
}

/**
 * Write dashboard HTML to a file.
 */
export function writeDashboard(workspace: string, html: string): string {
  const dir = path.join(workspace, ".mizumi");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "dashboard.html");
  fs.writeFileSync(filePath, html, "utf8");
  core.info(`Dashboard written to ${filePath}`);
  return filePath;
}

/**
 * Format a one-line dashboard summary for posting as a comment.
 */
export function formatDashboardSummary(metrics: DashboardMetrics): string {
  const topCats = metrics.topCategories.slice(0, 3).map((c) => c.category).join(", ");
  const acceptanceRate = Object.values(metrics.acceptanceByCategory).length > 0
    ? Math.round(
        Object.values(metrics.acceptanceByCategory).reduce((s, d) => s + d.accepted, 0) /
        Math.max(Object.values(metrics.acceptanceByCategory).reduce((s, d) => s + d.total, 0), 1) * 100
      )
    : 0;
  const totalCost = Object.values(metrics.providerUsage).reduce((s, d) => s + d.cost, 0);

  let summary = `<details><summary><strong>Mizumi Dashboard</strong> — ${metrics.totalReviews} reviews, ${metrics.totalFindings} findings</summary>\n\n`;
  summary += `| Metric | Value |\n|--------|-------|\n`;
  summary += `| Total Reviews | ${metrics.totalReviews} |\n`;
  summary += `| Total Findings | ${metrics.totalFindings} |\n`;
  summary += `| Avg Risk Score | ${metrics.avgRiskScore} |\n`;
  summary += `| Acceptance Rate | ${acceptanceRate}% |\n`;
  if (topCats) summary += `| Top Categories | ${topCats} |\n`;
  if (totalCost > 0) summary += `| Total Cost | $${totalCost.toFixed(2)} |\n`;
  summary += `\n</details>`;
  return summary;
}
