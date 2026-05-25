/**
 * Review Fatigue Dashboard — per-category feedback trends and fatigue metrics.
 *
 * Competitive gap: CodeRabbit's #1 user complaint is verbosity/noise. Other
 * tools show flat review counts but never quantify which finding categories
 * reviewers actually dismiss vs find valuable. This dashboard computes
 * acceptance rates, dismissal trends, and a fatigue score per category
 * from the feedback store, then posts as a collapsible comment.
 *
 * Data sources: feedback.ts store (helpful/unhelpful reactions)
 * Metrics per category:
 * - Total findings posted
 * - Helpful / unhelpful counts
 * - Acceptance rate (helpful / total with feedback)
 * - Fatigue score (dismissal rate * volume penalty)
 * - Trend direction (improving/declining/stable over last 10 entries)
 *
 * Also shows:
 * - Overall review efficiency (what % of findings get positive feedback)
 * - Noisiest category (highest fatigue score)
 * - Suppress candidates (categories already suppressed by adaptive noise)
 * - Recommendation (e.g., "Consider reducing style findings — 85% dismissed")
 */
import { readFeedbackStore } from "./feedback.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryStats {
  category: string;
  total: number;
  helpful: number;
  unhelpful: number;
  pending: number;
  acceptanceRate: number;
  fatigueScore: number;
  trend: "improving" | "declining" | "stable";
}

export interface FatigueDashboardResult {
  categories: CategoryStats[];
  totalFindings: number;
  totalFeedback: number;
  overallAcceptance: number;
  noisiestCategory: string | null;
  suppressedCategories: string[];
}

// ---------------------------------------------------------------------------
// Analysis logic
// ---------------------------------------------------------------------------

/** Compute trend from most recent entries vs older entries */
export function computeTrend(
  entries: Array<{ outcome: string; createdAt: string; category?: string }>,
  category: string
): "improving" | "declining" | "stable" {
  const catEntries = entries
    .filter((e) => e.category === category && e.outcome !== "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (catEntries.length < 6) return "stable";

  const mid = Math.floor(catEntries.length / 2);
  const older = catEntries.slice(0, mid);
  const newer = catEntries.slice(mid);

  const olderRate = older.filter((e) => e.outcome === "helpful").length / older.length;
  const newerRate = newer.filter((e) => e.outcome === "helpful").length / newer.length;

  const diff = newerRate - olderRate;
  if (diff > 0.15) return "improving";
  if (diff < -0.15) return "declining";
  return "stable";
}

/** Compute fatigue score: (dismissal rate) * (volume factor) * 100
 * Volume factor: log10(total+1) — more findings = more fatigue per dismissal */
export function computeFatigueScore(total: number, unhelpfulRate: number): number {
  if (total === 0) return 0;
  const volumeFactor = Math.log10(total + 1);
  return Math.round(unhelpfulRate * volumeFactor * 100) / 10;
}

/**
 * Build the fatigue dashboard from the feedback store.
 */
export function buildFatigueDashboard(
  workspace: string,
  suppressedPatterns: Set<string>
): FatigueDashboardResult {
  const store = readFeedbackStore(workspace);

  // Get all entries for trend computation
  const allEntries = store.entries;

  // Aggregate per-category stats
  const categoryMap = new Map<string, { total: number; helpful: number; unhelpful: number; pending: number }>();

  for (const entry of allEntries) {
    if (!categoryMap.has(entry.category)) {
      categoryMap.set(entry.category, { total: 0, helpful: 0, unhelpful: 0, pending: 0 });
    }
    const stats = categoryMap.get(entry.category)!;
    stats.total++;
    if (entry.outcome === "helpful") stats.helpful++;
    else if (entry.outcome === "unhelpful") stats.unhelpful++;
    else stats.pending++;
  }

  const categories: CategoryStats[] = [];
  for (const [category, stats] of categoryMap) {
    const feedbackTotal = stats.helpful + stats.unhelpful;
    const acceptanceRate = feedbackTotal > 0 ? stats.helpful / feedbackTotal : 0.5;
    const unhelpfulRate = feedbackTotal > 0 ? stats.unhelpful / feedbackTotal : 0;
    const fatigueScore = computeFatigueScore(stats.total, unhelpfulRate);
    const trend = computeTrend(allEntries, category);

    categories.push({
      category,
      total: stats.total,
      helpful: stats.helpful,
      unhelpful: stats.unhelpful,
      pending: stats.pending,
      acceptanceRate: Math.round(acceptanceRate * 100),
      fatigueScore,
      trend,
    });
  }

  // Sort by fatigue score descending (noisiest first)
  categories.sort((a, b) => b.fatigueScore - a.fatigueScore);

  // Summary stats
  const totalFindings = allEntries.length;
  const totalFeedback = allEntries.filter((e) => e.outcome !== "pending").length;
  const helpfulTotal = allEntries.filter((e) => e.outcome === "helpful").length;
  const overallAcceptance = totalFeedback > 0 ? Math.round((helpfulTotal / totalFeedback) * 100) : 0;

  const noisiestCategory = categories.length > 0 && categories[0].fatigueScore > 5
    ? categories[0].category
    : null;

  // Extract suppressed categories
  const suppressedCategories = [...suppressedPatterns]
    .map((p) => p.split(":")[0])
    .filter((v, i, a) => a.indexOf(v) === i);

  return {
    categories,
    totalFindings,
    totalFeedback,
    overallAcceptance,
    noisiestCategory,
    suppressedCategories,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const TREND_ICON: Record<string, string> = {
  improving: "[UP]",
  declining: "[DOWN]",
  stable: "[-]",
};

const TREND_COLOR: Record<string, string> = {
  improving: "green",
  declining: "red",
  stable: "gray",
};

/** Format the fatigue dashboard as a collapsible markdown comment */
export function formatFatigueDashboard(result: FatigueDashboardResult): string {
  if (result.categories.length === 0) return "";

  let body = `<!-- mizumi-fatigue-dashboard -->\n`;
  body += `<details>\n<summary>Review Fatigue Dashboard</summary>\n\n`;
  body += `### Overall Metrics\n\n`;
  body += `- **Total findings:** ${result.totalFindings}\n`;
  body += `- **Feedback received:** ${result.totalFeedback}\n`;
  body += `- **Overall acceptance:** ${result.overallAcceptance}%\n`;

  if (result.noisiestCategory) {
    const noisy = result.categories.find((c) => c.category === result.noisiestCategory);
    body += `- **Noisiest category:** ${result.noisiestCategory} (fatigue: ${noisy?.fatigueScore})\n`;
  }

  if (result.suppressedCategories.length > 0) {
    body += `- **Suppressed categories:** ${result.suppressedCategories.join(", ")}\n`;
  }

  body += `\n### Per-Category Breakdown\n\n`;
  body += `| Category | Total | Helpful | Dismissed | Acceptance | Fatigue | Trend |\n`;
  body += `|----------|-------|---------|-----------|------------|---------|-------|\n`;

  for (const cat of result.categories.slice(0, 15)) {
    const trendBadge = `![${cat.trend}](https://img.shields.io/badge/${TREND_ICON[cat.trend]}-${cat.trend}-${TREND_COLOR[cat.trend]})`;
    body += `| ${cat.category} | ${cat.total} | ${cat.helpful} | ${cat.unhelpful} | ${cat.acceptanceRate}% | ${cat.fatigueScore} | ${trendBadge} |\n`;
  }

  if (result.categories.length > 15) {
    body += `| ... | | | | | | |\n`;
    body += `\n> Showing top 15 categories by fatigue score (${result.categories.length} total)\n`;
  }

  // Recommendations
  const recommendations: string[] = [];
  const lowAccept = result.categories.filter((c) => c.acceptanceRate < 30 && c.total >= 5);
  for (const cat of lowAccept.slice(0, 3)) {
    recommendations.push(`Consider reducing **${cat.category}** findings — ${cat.acceptanceRate}% acceptance (${cat.unhelpful} dismissed)`);
  }

  const decliners = result.categories.filter((c) => c.trend === "declining");
  for (const cat of decliners.slice(0, 2)) {
    if (!recommendations.some((r) => r.includes(cat.category))) {
      recommendations.push(`**${cat.category}** trend declining — review quality may be dropping`);
    }
  }

  if (recommendations.length > 0) {
    body += `\n### Recommendations\n\n`;
    for (const rec of recommendations) {
      body += `- ${rec}\n`;
    }
  }

  body += `\n</details>`;

  return body;
}
