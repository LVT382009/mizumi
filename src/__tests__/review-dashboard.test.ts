import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectDashboardMetrics,
  generateDashboardHTML,
  formatDashboardSummary,
  writeDashboard,
} from "../review-dashboard.js";
import type { DashboardMetrics, DashboardConfig } from "../review-dashboard.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// collectDashboardMetrics
// ---------------------------------------------------------------------------

describe("collectDashboardMetrics", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-dash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero metrics when no data files exist", () => {
    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.totalReviews).toBe(0);
    expect(metrics.totalFindings).toBe(0);
    expect(metrics.avgRiskScore).toBe(0);
    expect(metrics.weeklyVolume).toHaveLength(0);
    expect(metrics.riskTrend).toHaveLength(0);
  });

  it("reads spend log and counts reviews", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "anthropic", inputTokens: 1000, outputTokens: 500, cost: 0.05, findingCount: 3, riskScore: 3, timestamp: "2026-05-20T10:00:00Z" }),
      JSON.stringify({ provider: "openai", inputTokens: 800, outputTokens: 400, cost: 0.03, findingCount: 1, riskScore: 2, timestamp: "2026-05-21T10:00:00Z" }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.totalReviews).toBe(2);
    expect(metrics.totalFindings).toBe(4);
    expect(metrics.providerUsage.anthropic.inputTokens).toBe(1000);
    expect(metrics.providerUsage.openai.cost).toBe(0.03);
  });

  it("reads feedback store and computes acceptance rates", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "feedback.json"), JSON.stringify([
      { category: "security", outcome: "accepted" },
      { category: "security", outcome: "rejected" },
      { category: "security", outcome: "accepted" },
      { category: "style", outcome: "rejected" },
    ]));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.acceptanceByCategory.security.total).toBe(3);
    expect(metrics.acceptanceByCategory.security.accepted).toBe(2);
    expect(metrics.acceptanceByCategory.security.rate).toBe(67); // 2/3 ≈ 67%
    expect(metrics.acceptanceByCategory.style.rate).toBe(0);
  });

  it("reads suppression memories", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "suppressions.jsonl"), [
      JSON.stringify({ category: "style", messagePattern: "Use const*", suppressCount: 5 }),
      JSON.stringify({ category: "bug", messagePattern: "Null check*", suppressCount: 3 }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.topSuppressed.length).toBe(2);
    expect(metrics.topSuppressed[0].count).toBe(5); // Sorted by count desc
  });

  it("handles malformed spend lines gracefully", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      "not valid json",
      JSON.stringify({ provider: "anthropic", inputTokens: 500, outputTokens: 200, cost: 0.02, findingCount: 1, riskScore: 2, timestamp: "2026-05-20T10:00:00Z" }),
      "{ broken: json",
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.totalReviews).toBe(1);
    expect(metrics.providerUsage.anthropic.inputTokens).toBe(500);
  });

  it("handles malformed feedback JSON gracefully", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "feedback.json"), "not valid json");

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(Object.keys(metrics.acceptanceByCategory)).toHaveLength(0);
  });

  it("computes severity distribution", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 5, riskScore: 3, timestamp: "2026-05-20T10:00:00Z", severities: { critical: 1, high: 2, medium: 2 } }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.severityDistribution.critical).toBe(1);
    expect(metrics.severityDistribution.high).toBe(2);
    expect(metrics.severityDistribution.medium).toBe(2);
  });

  it("computes category counts", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 3, riskScore: 2, timestamp: "2026-05-20T10:00:00Z", categories: { security: 1, bug: 2 } }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.topCategories.length).toBeGreaterThan(0);
    expect(metrics.topCategories.find(c => c.category === "bug")?.count).toBe(2);
  });

  it("limits weeks parameter", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    const entries = [];
    for (let i = 0; i < 8; i++) {
      const date = new Date(2026, 0, 1 + i * 7);
      entries.push(JSON.stringify({
        provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0,
        findingCount: 1, riskScore: 3, timestamp: date.toISOString(),
      }));
    }
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), entries.join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo", weeks: 4 });
    expect(metrics.weeklyVolume.length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// generateDashboardHTML
// ---------------------------------------------------------------------------

describe("generateDashboardHTML", () => {
  const emptyMetrics: DashboardMetrics = {
    totalReviews: 0,
    totalFindings: 0,
    avgRiskScore: 0,
    acceptanceByCategory: {},
    topSuppressed: [],
    severityDistribution: {},
    weeklyVolume: [],
    riskTrend: [],
    providerUsage: {},
    topCategories: [],
  };

  it("generates valid HTML document", () => {
    const html = generateDashboardHTML(emptyMetrics, "test/repo");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
    expect(html).toContain("<title>Mizumi Dashboard");
  });

  it("includes repo ID in title", () => {
    const html = generateDashboardHTML(emptyMetrics, "myorg/myrepo");
    expect(html).toContain("myorg/myrepo");
  });

  it("includes total reviews count", () => {
    const metrics = { ...emptyMetrics, totalReviews: 42 };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain(">42<");
  });

  it("includes total findings count", () => {
    const metrics = { ...emptyMetrics, totalFindings: 127 };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain(">127<");
  });

  it("includes avg risk score", () => {
    const metrics = { ...emptyMetrics, avgRiskScore: 3.5 };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain(">3.5<");
  });

  it("includes acceptance rate table with data", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      acceptanceByCategory: {
        security: { accepted: 8, total: 10, rate: 80 },
        bug: { accepted: 5, total: 10, rate: 50 },
      },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("security");
    expect(html).toContain("80%");
    expect(html).toContain("bug");
    expect(html).toContain("50%");
  });

  it("includes severity distribution with styled labels", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      severityDistribution: { critical: 5, high: 12, medium: 20, low: 8 },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("sev-label critical");
    expect(html).toContain("sev-label high");
    expect(html).toContain("sev-label medium");
    expect(html).toContain("sev-label low");
  });

  it("includes weekly volume data", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      weeklyVolume: [
        { week: "2026-W20", reviews: 5, findings: 15 },
        { week: "2026-W21", reviews: 8, findings: 22 },
      ],
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("2026-W20");
    expect(html).toContain("2026-W21");
  });

  it("includes provider usage data", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      providerUsage: {
        anthropic: { inputTokens: 500000, outputTokens: 100000, cost: 2.50 },
        openai: { inputTokens: 200000, outputTokens: 50000, cost: 0.75 },
      },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("anthropic");
    expect(html).toContain("openai");
    expect(html).toContain("$2.50");
  });

  it("includes suppressed patterns", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      topSuppressed: [
        { pattern: "style:Use const*", count: 10, category: "style" },
        { pattern: "bug:Null check*", count: 5, category: "bug" },
      ],
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("Use const*");
    expect(html).toContain("style");
  });

  it("escapes HTML in user content", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      topCategories: [{ category: "<script>alert(1)</script>", count: 1 }],
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("formats large token counts with K/M suffixes", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      providerUsage: {
        anthropic: { inputTokens: 1500000, outputTokens: 250000, cost: 5.00 },
      },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("1.5M");
    expect(html).toContain("250.0K");
  });

  it("shows No data placeholders for empty sections", () => {
    const html = generateDashboardHTML(emptyMetrics, "test/repo");
    expect(html).toContain("No data");
  });

  it("includes dark theme CSS", () => {
    const html = generateDashboardHTML(emptyMetrics, "test/repo");
    expect(html).toContain("background:#0d1117");
    expect(html).toContain("color:#c9d1d9");
  });
});

// ---------------------------------------------------------------------------
// formatDashboardSummary
// ---------------------------------------------------------------------------

describe("formatDashboardSummary", () => {
  const emptyMetrics: DashboardMetrics = {
    totalReviews: 0,
    totalFindings: 0,
    avgRiskScore: 0,
    acceptanceByCategory: {},
    topSuppressed: [],
    severityDistribution: {},
    weeklyVolume: [],
    riskTrend: [],
    providerUsage: {},
    topCategories: [],
  };

  it("formats summary in details block", () => {
    const summary = formatDashboardSummary(emptyMetrics);
    expect(summary).toContain("<details>");
    expect(summary).toContain("</details>");
    expect(summary).toContain("<summary>");
  });

  it("includes review and finding counts", () => {
    const metrics = { ...emptyMetrics, totalReviews: 15, totalFindings: 47 };
    const summary = formatDashboardSummary(metrics);
    expect(summary).toContain("15 reviews");
    expect(summary).toContain("47 findings");
  });

  it("includes avg risk score", () => {
    const metrics = { ...emptyMetrics, avgRiskScore: 3.2 };
    const summary = formatDashboardSummary(metrics);
    expect(summary).toContain("3.2");
  });

  it("includes top categories when present", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      topCategories: [
        { category: "security", count: 10 },
        { category: "bug", count: 8 },
        { category: "style", count: 5 },
      ],
    };
    const summary = formatDashboardSummary(metrics);
    expect(summary).toContain("security");
    expect(summary).toContain("bug");
    expect(summary).toContain("style");
  });

  it("includes total cost when > 0", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      providerUsage: {
        anthropic: { inputTokens: 100, outputTokens: 50, cost: 1.50 },
      },
    };
    const summary = formatDashboardSummary(metrics);
    expect(summary).toContain("$1.50");
  });

  it("omits cost when 0", () => {
    const summary = formatDashboardSummary(emptyMetrics);
    expect(summary).not.toContain("Total Cost");
  });

  it("computes acceptance rate from category data", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      acceptanceByCategory: {
        security: { accepted: 8, total: 10, rate: 80 },
        bug: { accepted: 4, total: 10, rate: 40 },
      },
    };
    const summary = formatDashboardSummary(metrics);
    // 12 accepted / 20 total = 60%
    expect(summary).toContain("60%");
  });

  it("handles 0 total acceptance gracefully", () => {
    const summary = formatDashboardSummary(emptyMetrics);
    expect(summary).toContain("0%");
  });
});

// ---------------------------------------------------------------------------
// writeDashboard
// ---------------------------------------------------------------------------

describe("writeDashboard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-dash-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes HTML file to .mizumi/dashboard.html", () => {
    const filePath = writeDashboard(tmpDir, "<html>test</html>");
    expect(filePath).toContain("dashboard.html");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("<html>test</html>");
  });

  it("creates .mizumi directory if not exists", () => {
    const filePath = writeDashboard(tmpDir, "<html>test</html>");
    expect(fs.existsSync(path.join(tmpDir, ".mizumi"))).toBe(true);
  });

  it("overwrites existing dashboard file", () => {
    writeDashboard(tmpDir, "first");
    writeDashboard(tmpDir, "second");
    const content = fs.readFileSync(path.join(tmpDir, ".mizumi", "dashboard.html"), "utf8");
    expect(content).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// expanded collectDashboardMetrics tests
// ---------------------------------------------------------------------------

describe("collectDashboardMetrics — expanded", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-dash2-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("computes average risk score from spend data", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 1, riskScore: 4, timestamp: "2026-05-20T10:00:00Z" }),
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 1, riskScore: 2, timestamp: "2026-05-21T10:00:00Z" }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.avgRiskScore).toBe(3);
  });

  it("computes weekly volume correctly", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 2, riskScore: 3, timestamp: "2026-05-12T10:00:00Z" }),
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 1, riskScore: 2, timestamp: "2026-05-19T10:00:00Z" }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.weeklyVolume.length).toBeGreaterThanOrEqual(1);
  });

  it("computes risk trend with averages", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 1, riskScore: 5, timestamp: "2026-05-20T10:00:00Z" }),
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 1, riskScore: 3, timestamp: "2026-05-20T12:00:00Z" }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.riskTrend.length).toBeGreaterThanOrEqual(1);
    const trendItem = metrics.riskTrend[0];
    expect(trendItem.avgRisk).toBe(4);
  });

  it("handles spend log with missing fields gracefully", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "unknown" }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.totalReviews).toBe(1);
    expect(metrics.totalFindings).toBe(0);
    expect(metrics.providerUsage.unknown.inputTokens).toBe(0);
  });

  it("handles malformed suppression lines gracefully", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    fs.writeFileSync(path.join(mizDir, "suppressions.jsonl"), [
      "not valid json",
      JSON.stringify({ category: "bug", messagePattern: "Null check*", suppressCount: 2 }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.topSuppressed.length).toBeGreaterThanOrEqual(1);
  });

  it("limits top categories to 10 entries", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    const categories: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      categories[`cat${i}`] = i + 1;
    }
    fs.writeFileSync(path.join(mizDir, "spend.jsonl"), [
      JSON.stringify({ provider: "openai", inputTokens: 100, outputTokens: 50, cost: 0, findingCount: 15, riskScore: 3, timestamp: "2026-05-20T10:00:00Z", categories }),
    ].join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.topCategories.length).toBeLessThanOrEqual(10);
  });

  it("limits top suppressed to 10 entries", () => {
    const mizDir = path.join(tmpDir, ".mizumi");
    fs.mkdirSync(mizDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push(JSON.stringify({ category: `cat${i}`, messagePattern: `pattern${i}`, suppressCount: i + 1 }));
    }
    fs.writeFileSync(path.join(mizDir, "suppressions.jsonl"), lines.join("\n"));

    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    expect(metrics.topSuppressed.length).toBeLessThanOrEqual(10);
  });

  it("uses default weeks=4 when not specified", () => {
    const metrics = collectDashboardMetrics({ workspace: tmpDir, repoId: "test/repo" });
    // No data files exist, so weeks parameter doesn't matter, but this tests the path
    expect(metrics.weeklyVolume).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// expanded generateDashboardHTML tests
// ---------------------------------------------------------------------------

describe("generateDashboardHTML — expanded", () => {
  const emptyMetrics: DashboardMetrics = {
    totalReviews: 0,
    totalFindings: 0,
    avgRiskScore: 0,
    acceptanceByCategory: {},
    topSuppressed: [],
    severityDistribution: {},
    weeklyVolume: [],
    riskTrend: [],
    providerUsage: {},
    topCategories: [],
  };

  it("includes risk score trend data", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      riskTrend: [
        { week: "2026-W18", avgRisk: 5.2 },
        { week: "2026-W19", avgRisk: 3.1 },
      ],
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("2026-W18");
    expect(html).toContain("5.2");
    expect(html).toContain("3.1");
  });

  it("escapes quotes in user content", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      acceptanceByCategory: {
        'test"cat': { accepted: 1, total: 1, rate: 100 },
      },
    };
    const html = generateDashboardHTML(metrics, 'repo"with"quotes');
    expect(html).toContain("&quot;");
  });

  it("includes nitpick severity class", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      severityDistribution: { nitpick: 10 },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("sev-label nitpick");
    expect(html).toContain("10");
  });

  it("formats 999 tokens without suffix", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      providerUsage: {
        local: { inputTokens: 999, outputTokens: 0, cost: 0 },
      },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain(">999<");
  });

  it("formats 1000 tokens as 1.0K", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      providerUsage: {
        local: { inputTokens: 1000, outputTokens: 0, cost: 0 },
      },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("1.0K");
  });

  it("formats 1000000 tokens as 1.0M", () => {
    const metrics: DashboardMetrics = {
      ...emptyMetrics,
      providerUsage: {
        local: { inputTokens: 1000000, outputTokens: 0, cost: 0 },
      },
    };
    const html = generateDashboardHTML(metrics, "test/repo");
    expect(html).toContain("1.0M");
  });

  it("includes footer", () => {
    const html = generateDashboardHTML(emptyMetrics, "test/repo");
    expect(html).toContain("Generated by Mizumi");
  });

  it("includes viewport meta tag", () => {
    const html = generateDashboardHTML(emptyMetrics, "test/repo");
    expect(html).toContain("viewport");
  });

  it("shows No suppressions when empty", () => {
    const html = generateDashboardHTML(emptyMetrics, "test/repo");
    expect(html).toContain("No suppressions");
  });
});
