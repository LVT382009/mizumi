/**
 * Memory — MEMORY.md reader/writer (Hermes-style, ~2KB bounded).
 * Repo-specific knowledge that persists across reviews.
 * Skill generation follows agentskills.io open standard.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";

const MAX_MEMORY_BYTES = 2048;
const MEMORY_FILENAME = "mizumi-memory.md";
const CONSOLIDATE_THRESHOLD = 0.8; // Consolidate at 80% full

/**
 * Read MEMORY.md from the repo. Returns empty string if missing.
 */
export function readMemory(workspace: string): string {
  const memoryPath = path.join(workspace, ".github", MEMORY_FILENAME);
  if (!fs.existsSync(memoryPath)) return "";

  try {
    const content = fs.readFileSync(memoryPath, "utf-8");
    core.info(`Memory: loaded ${content.length} bytes from ${MEMORY_FILENAME}`);
    return content;
  } catch (e) {
    core.warning(`Failed to read ${MEMORY_FILENAME}: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/**
 * Write updated MEMORY.md after a review.
 * Appends new findings and consolidates when approaching size limit.
 */
export function writeMemory(
  workspace: string,
  currentMemory: string,
  reviewFindings: string
): void {
  const memoryDir = path.join(workspace, ".github");
  const memoryPath = path.join(memoryDir, MEMORY_FILENAME);

  let updated = currentMemory;

  if (reviewFindings.trim()) {
    updated += `\n\n## ${new Date().toISOString().split("T")[0]}\n${reviewFindings}`;
  }

  // Consolidate if approaching limit
  if (Buffer.byteLength(updated, "utf-8") > MAX_MEMORY_BYTES * CONSOLIDATE_THRESHOLD) {
    updated = consolidate(updated);
  }

  // Hard cap — truncate oldest entries
  if (Buffer.byteLength(updated, "utf-8") > MAX_MEMORY_BYTES) {
    updated = hardCap(updated, MAX_MEMORY_BYTES);
  }

  try {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    fs.writeFileSync(memoryPath, updated, "utf-8");
    core.info(`Memory: wrote ${Buffer.byteLength(updated, "utf-8")} bytes`);
  } catch (error) {
    core.warning(`Failed to write memory: ${error}`);
  }
}

/**
 * Consolidate memory — merge similar entries, prune stale items.
 * Keeps the most recent and most referenced patterns.
 */
function consolidate(memory: string): string {
  const sections = memory.split(/\n## \d{4}-\d{2}-\d{2}\n/);

  if (sections.length <= 2) return memory;

  // Keep header (first section) + last 3 sections
  const header = sections[0];
  const recentSections = sections.slice(-3);

  return header + recentSections
    .map((s) => `\n## consolidated\n${s.trim()}`)
    .join("\n");
}

/**
 * Hard cap — truncate from the top, keeping the most recent entries.
 */
function hardCap(memory: string, maxBytes: number): string {
  const lines = memory.split("\n");

  // Keep header (first 5 lines) + tail
  const header = lines.slice(0, 5);
  let tail = lines.slice(5);

  while (Buffer.byteLength([...header, ...tail].join("\n"), "utf-8") > maxBytes && tail.length > 0) {
    tail = tail.slice(1);
  }

  return [...header, ...tail].join("\n");
}

/**
 * Review Ghost — extract memory warnings for specific files.
 * Surfaces past issues in files being touched, e.g.
 * "Last time auth/login.ts was touched, there was a critical security issue."
 */
export function ghostWarnings(memoryContent: string, changedFiles: string[]): string[] {
  if (!memoryContent || changedFiles.length === 0) return [];

  const warnings: string[] = [];
  const lines = memoryContent.split("\n");

  for (const line of lines) {
    for (const file of changedFiles) {
      // Match memory lines that reference this file (e.g. "- [high] src/auth.ts:12 — security: ...")
      const basename = path.basename(file);
      if (line.includes(file) || line.includes(basename)) {
        // Don't repeat identical warnings
        const summary = line.replace(/^[-*]\s*/, "").trim();
        if (summary && !warnings.includes(summary)) {
          warnings.push(summary);
        }
      }
    }
  }

  return warnings.slice(0, 5); // Cap at 5 to save tokens
}

// ---------------------------------------------------------------------------
// Skill types (agentskills.io-compatible)
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name: string;
  description: string;
  tags: string[];
  category: string;
  file_pattern: string;
  version: number;
  confidence: number;
  occurrence_count: number;
  trigger_conditions: string[];
  created_at: string;
  updated_at: string;
}

/** Category→procedure mapping for auto-generated review skills. */
const CATEGORY_PROCEDURES: Record<string, { steps: string[]; pitfalls: string[]; verification: string[] }> = {
  security: {
    steps: [
      "Check for input validation on all external boundaries",
      "Verify authentication/authorization on sensitive operations",
      "Look for injection vectors (SQL, XSS, command)",
      "Check for hardcoded secrets or credentials",
      "Verify secure defaults (fail-closed, deny-by-default)",
    ],
    pitfalls: [
      "Assuming client-side validation is sufficient",
      "Missing rate limiting on auth endpoints",
      "Using string concatenation for queries",
    ],
    verification: [
      "All untrusted inputs are sanitized before use",
      "Auth checks are not bypassable by parameter tampering",
      "No secrets in source or config files",
    ],
  },
  bug: {
    steps: [
      "Verify null/undefined checks before property access",
      "Check error handling completeness (all error paths)",
      "Validate boundary conditions and off-by-one errors",
      "Verify type assumptions match actual runtime types",
      "Check for race conditions in async code",
    ],
    pitfalls: [
      "Assuming optional fields are always present",
      "Ignoring error return values",
      "Mutating shared state without synchronization",
    ],
    verification: [
      "All nullable access paths are guarded",
      "Error paths have appropriate logging/handling",
      "Edge cases (empty arrays, zero values) are handled",
    ],
  },
  performance: {
    steps: [
      "Check for N+1 query patterns in loops",
      "Verify O(n^2) or worse algorithms have small n bounds",
      "Look for unnecessary re-computations of deterministic values",
      "Check for synchronous operations that should be async",
      "Verify memory usage patterns (leaks, large allocations)",
    ],
    pitfalls: [
      "Premature optimization without measurement",
      "Caching without invalidation strategy",
      "Over-fetching data from APIs/databases",
    ],
    verification: [
      "No obvious O(n^2) loops over large collections",
      "Expensive computations are memoized where appropriate",
      "Database queries are batched, not per-loop-iteration",
    ],
  },
  style: {
    steps: [
      "Check naming consistency with project conventions",
      "Verify function/method length reasonableness",
      "Look for dead code or unreachable branches",
      "Check for consistent error handling patterns",
    ],
    pitfalls: [
      "Enforcing personal preferences over project conventions",
      "Suggesting changes that touch too many lines at once",
    ],
    verification: [
      "Naming follows the dominant pattern in the codebase",
      "No obvious dead code paths",
    ],
  },
  architecture: {
    steps: [
      "Verify separation of concerns (no business logic in handlers)",
      "Check dependency direction (no circular imports)",
      "Verify interface boundaries are clean and minimal",
      "Look for leaky abstractions across module boundaries",
    ],
    pitfalls: [
      "Over-engineering simple features",
      "Suggesting patterns the team isn't using",
    ],
    verification: [
      "Layer boundaries are respected",
      "No god objects or megaclasses",
    ],
  },
  compliance: {
    steps: [
      "Verify PII handling follows data retention policies",
      "Check for required audit logging on sensitive operations",
      "Verify access control matches compliance requirements",
    ],
    pitfalls: [
      "Assuming GDPR only applies to EU users",
      "Missing consent tracking for data collection",
    ],
    verification: [
      "PII fields are explicitly marked/encrypted",
      "Audit trails exist for sensitive data mutations",
    ],
  },
};

/** Default procedure for categories not in the map. */
const DEFAULT_PROCEDURE = {
  steps: [
    "Review code for common issues in this category",
    "Check for inconsistencies with project conventions",
  ],
  pitfalls: [
    "Flagging issues without clear remediation",
  ],
  verification: [
    "Finding is actionable and specific",
  ],
};

/** Parse YAML frontmatter from a skill file. Returns null if no valid frontmatter. */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const getField = (key: string, fallback: string = ""): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : fallback;
  };
  const getList = (key: string): string[] => {
    const block = fm.match(new RegExp(`^${key}:\\n((?:\\s+- .+\\n?)+)`, "m"));
    if (!block) return [];
    return block[1].split("\n").map((l: string) => l.replace(/^\s+- /, "").trim()).filter(Boolean);
  };

  return {
    name: getField("name"),
    description: getField("description"),
    tags: getList("tags"),
    category: getField("category"),
    file_pattern: getField("file_pattern"),
    version: parseInt(getField("version", "1"), 10) || 1,
    confidence: parseInt(getField("confidence", "70"), 10) || 70,
    occurrence_count: parseInt(getField("occurrence_count", "3"), 10) || 3,
    trigger_conditions: getList("trigger_conditions"),
    created_at: getField("created_at", new Date().toISOString().split("T")[0]),
    updated_at: getField("updated_at", new Date().toISOString().split("T")[0]),
  };
}

/**
 * Auto Skill Generation — agentskills.io-compliant.
 * When a file+category combo appears 3+ times in memory, create a
 * structured SKILL.md with procedure steps, pitfalls, and verification.
 * Existing skills are refined (version bump + occurrence increment) rather
 * than overwritten.
 */
export function autoGenerateSkills(memoryContent: string, workspace: string): string[] {
  if (!memoryContent) return [];
  const patternRe = /^[-*]\s+\[[^\]]+\]\s+(\S+):(\d+)\s+—\s+(\w+)/gm;
  const counts = new Map<string, { file: string; category: string; count: number }>();
  let m: RegExpExecArray | null;
  while ((m = patternRe.exec(memoryContent)) !== null) {
    const key = `${m[1]}|${m[3]}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { file: m[1], category: m[3], count: 1 });
  }

  const skillsDir = path.join(workspace, ".github", "mizumi-skills");
  const generated: string[] = [];

  for (const [, v] of counts) {
    if (v.count < 3) continue;
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

    const basename = path.basename(v.file, path.extname(v.file));
    const skillName = `${v.category}-${basename}`;
    const skillPath = path.join(skillsDir, `${skillName}.md`);

    const procedure = CATEGORY_PROCEDURES[v.category] ?? DEFAULT_PROCEDURE;
    const now = new Date().toISOString().split("T")[0];

    // If skill already exists, refine it (self-improve)
    let version = 1;
    let occurrenceCount = v.count;
    let createdAt = now;

    if (fs.existsSync(skillPath)) {
      const existingRaw = fs.readFileSync(skillPath, "utf-8");
      const existingFm = parseSkillFrontmatter(existingRaw);
      if (existingFm) {
        version = existingFm.version + 1;
        occurrenceCount = existingFm.occurrence_count + v.count;
        createdAt = existingFm.created_at;
      }
    }

    const triggerConditions = [
      `File matches ${v.file} or similar path patterns`,
      `${v.category} category review is active`,
      `PR changes files in ${path.dirname(v.file)} directory`,
    ];

    const confidence = Math.min(95, 70 + Math.floor(occurrenceCount / 3) * 5);
    const tags = [v.category, v.file.includes("test") ? "testing" : "production", `v${version}`];

    const content = `---
name: ${skillName}
description: Recurring ${v.category} patterns for ${v.file} — auto-generated from ${occurrenceCount} review observations
tags:
${tags.map((t) => `  - ${t}`).join("\n")}
category: ${v.category}
file_pattern: "${v.file}"
version: ${version}
confidence: ${confidence}
occurrence_count: ${occurrenceCount}
trigger_conditions:
${triggerConditions.map((c) => `  - "${c}"`).join("\n")}
created_at: "${createdAt}"
updated_at: "${now}"
---

## When to Use
Apply this skill when reviewing changes to \`${v.file}\` or similar files in the \`${path.dirname(v.file)}\` directory, especially when ${v.category} concerns are relevant.

## Procedure
${procedure.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Pitfalls
${procedure.pitfalls.map((p) => `- ${p}`).join("\n")}

## Verification Checklist
${procedure.verification.map((c) => `- [ ] ${c}`).join("\n")}
`;

    fs.writeFileSync(skillPath, content, "utf-8");
    generated.push(skillPath);
  }
  return generated;
}

/**
 * Progressive Skill Loading — agentskills.io-compatible.
 * Matches on file_pattern, tags, and category. Returns loaded content
 * with procedure/pitfalls/verification for LLM context injection.
 * Backward-compatible with old format (file_pattern only).
 */
export function loadSkills(workspace: string, changedFiles: string[]): { names: string[]; loaded: string } {
  const skillsDir = path.join(workspace, ".github", "mizumi-skills");
  if (!fs.existsSync(skillsDir)) return { names: [], loaded: "" };

  const allFiles = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  const names = allFiles.map((f) => f.replace(/\.md$/, ""));

  let loaded = "";
  let skillCount = 0;

  for (const f of allFiles) {
    if (skillCount >= 5) break;
    const raw = fs.readFileSync(path.join(skillsDir, f), "utf-8");
    const fm = parseSkillFrontmatter(raw);

    let matches = false;
    if (fm) {
      // New format: match on file_pattern + tags
      const fileMatch = changedFiles.some(
        (cf) => cf === fm.file_pattern || cf.endsWith(fm.file_pattern) || fm.file_pattern.endsWith(path.basename(cf)),
      );
      const tagMatch = fm.tags.some((tag) => changedFiles.some((cf) => path.basename(cf).includes(tag)));
      matches = fileMatch || tagMatch;
    } else {
      // Legacy format: parse file_pattern from simple frontmatter
      const legacyMatch = raw.match(/file_pattern:\s*"([^"]+)"/);
      if (legacyMatch) {
        matches = changedFiles.some((cf) => cf === legacyMatch[1] || cf.endsWith(legacyMatch[1]));
      }
    }

    if (!matches) continue;

    // Extract body content (after frontmatter)
    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1].trim() : raw.trim();

    loaded += `\n${body}\n`;
    skillCount++;
    if (loaded.length > 2000) { loaded = loaded.slice(0, 2000); break; }
  }
  return { names, loaded: loaded.trim() };
}

/**
 * Read project rules files — highest priority context.
 * Ingests: REVIEW.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md
 * Auto-discovers team coding standards without manual setup.
 */
export function readRules(workspace: string): string {
  const rulesPaths = [
    path.join(workspace, "REVIEW.md"),
    path.join(workspace, "CLAUDE.md"),
    path.join(workspace, ".github", "REVIEW.md"),
    path.join(workspace, ".cursorrules"),
    path.join(workspace, ".github", "copilot-instructions.md"),
  ];

  const parts: string[] = [];
  for (const p of rulesPaths) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        if (content.trim()) parts.push(content.trim());
      } catch { /* skip unreadable files */ }
    }
  }

  return parts.join("\n\n");
}

/**
 * Build a learning prompt from past review feedback.
 * Tells the LLM which finding categories this team accepts vs dismisses,
 * so it focuses on valuable findings and avoids noise.
 */
export function buildLearningPrompt(
  learningWeights: Record<string, "demote" | "promote" | "neutral">,
  acceptanceRates: Record<string, { helpful: number; unhelpful: number; rate: number }>,
): string {
  const lines: string[] = [];

  const demoted = Object.entries(learningWeights)
    .filter(([, w]) => w === "demote")
    .map(([cat]) => cat);
  const promoted = Object.entries(learningWeights)
    .filter(([, w]) => w === "promote")
    .map(([cat]) => cat);

  if (demoted.length > 0) {
    lines.push(`This team dismisses most ${demoted.join("/")} findings — reduce severity or skip unless clearly critical.`);
  }
  if (promoted.length > 0) {
    lines.push(`This team values ${promoted.join("/")} findings — be thorough for these categories.`);
  }

  // Add per-category detail from reaction rates
  const lowAcceptance = Object.entries(acceptanceRates)
    .filter(([, r]) => r.rate < 0.3 && (r.helpful + r.unhelpful) >= 5)
    .map(([cat, r]) => `${cat} (${Math.round(r.rate * 100)}% accepted, ${r.helpful + r.unhelpful} responses)`);

  if (lowAcceptance.length > 0) {
    lines.push(`Low-acceptance categories (consider skipping): ${lowAcceptance.join(", ")}`);
  }

  if (lines.length === 0) return "";
  return `## Adaptive Learning (from ${demoted.length + promoted.length} categories)\n${lines.join("\n")}`;
}
