/**
 * Change Stack — reorganizes large PR output into cohort/layer ordering.
 * Phase 2.18: Foundational changes (data models, contracts) first,
 * dependent code (consumers, tests) second. CodeRabbit Change Stack pattern.
 */
import { ReviewCommentType } from "./review.js";

type Cohort = "data-model" | "contract" | "logic" | "test" | "consumer" | "other";

const COHORT_ORDER: Cohort[] = ["data-model", "contract", "logic", "test", "consumer", "other"];

const COHORT_PATTERNS: Record<Cohort, RegExp[]> = {
  "data-model": [/schema/, /model/, /entity/, /migration/, /type.*def/, /interface/, /\/types?\//, /\.d\.ts$/],
  "contract": [/api/, /endpoint/, /route/, /handler/, /controller/, /service/],
  "logic": [/util/, /helper/, /function/, /class/, /module/, /core/],
  "test": [/test/, /spec/, /\.test\./, /\.spec\./],
  "consumer": [/component/, /page/, /view/, /hook/, /\buse[A-Z]/, /import/],
  "other": [],
};

/**
 * Classify a file path into a cohort for Change Stack ordering.
 * Uses COHORT_ORDER (not Object.entries) so test cohort is checked
 * before consumer — prevents false "use" matches in filenames like
 * user.test.ts from claiming test files for consumer.
 */
export function classifyCohort(filePath: string): Cohort {
  const lower = filePath.toLowerCase();

  for (const cohort of COHORT_ORDER) {
    if (cohort === "other") continue;
    const patterns = COHORT_PATTERNS[cohort];
    for (const pattern of patterns) {
      if (pattern.test(lower)) return cohort;
    }
  }

  return "other";
}

/**
 * Organize review findings into Change Stack order.
 * Groups findings by cohort, then outputs in dependency order.
 * Returns formatted markdown sections.
 */
export function buildChangeStack(findings: ReviewCommentType[]): string {
  if (findings.length < 5) return ""; // Only apply for larger reviews

  const groups = new Map<Cohort, ReviewCommentType[]>();

  for (const f of findings) {
    const cohort = classifyCohort(f.file);
    if (!groups.has(cohort)) groups.set(cohort, []);
    groups.get(cohort)!.push(f);
  }

  const sections: string[] = [];
  const cohortLabels: Record<Cohort, string> = {
    "data-model": "Data Models & Schemas",
    "contract": "API Contracts & Endpoints",
    "logic": "Core Logic & Utilities",
    "test": "Tests & Specifications",
    "consumer": "Consumers & UI Components",
    "other": "Other Changes",
  };

  for (const cohort of COHORT_ORDER) {
    const items = groups.get(cohort);
    if (!items || items.length === 0) continue;

    const label = cohortLabels[cohort];
    const severityCounts = items.reduce(
      (acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; },
      {} as Record<string, number>
    );
    const sevSummary = Object.entries(severityCounts)
      .map(([s, c]) => `${c} ${s}`)
      .join(", ");

    let section = `### ${label} (${items.length} findings — ${sevSummary})\n\n`;
    for (const f of items) {
      section += `- \`${f.file}:${f.line}\` **[${f.severity.toUpperCase()}] ${f.category}**: ${f.message}\n`;
    }
    sections.push(section);
  }

  if (sections.length === 0) return "";

  return `## Change Stack\n\n${sections.join("\n\n")}`;
}
