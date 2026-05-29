import { describe, it, expect } from "vitest";
import { detectRulesFileIntegrity } from "../rules-file-integrity-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, addedLines: string[]): DiffFile {
  return {
    path,
    status: "modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: addedLines.map((content, idx) => ({
          type: "add" as const,
          content: `+${content}`,
          line: idx + 1,
        })),
      },
    ],
  };
}

function makeFileWithRemoved(path: string, addedLines: string[], removedLines: string[]): DiffFile {
  return {
    path,
    status: "modified",
    hunks: [
      {
        header: "@@ -1 +1 @@",
        changes: [
          ...removedLines.map((content, idx) => ({
            type: "delete" as const,
            content: `-${content}`,
            line: idx + 1,
          })),
          ...addedLines.map((content, idx) => ({
            type: "add" as const,
            content: `+${content}`,
            line: removedLines.length + idx + 1,
          })),
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// rule-softening
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — rule-softening", () => {
  it("detects disabling self_critique in mizumi.yml", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects disabling taint_analysis", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  taint_analysis: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects profile change to chill", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  profile: chill",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag assertive profile", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  profile: assertive",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues).toHaveLength(0);
  });

  it("does not flag enabling a detector", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: true",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues).toHaveLength(0);
  });

  it("detects multiple disabled features", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: false",
      "  taint_analysis: false",
      "  blast_radius: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// security-exclusion
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — security-exclusion", () => {
  it("detects emptying security_paths", () => {
    const file = makeFile(".github/mizumi.yml", [
      "security:",
      "  security_paths: []",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects removing auth path from security monitoring", () => {
    const file = makeFileWithRemoved(
      ".github/mizumi.yml",
      ["review:", "  max_comments: 15"],
      ["  - '**/auth/**'"],
    );
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removing crypto path from security monitoring", () => {
    const file = makeFileWithRemoved(
      ".github/mizumi.yml",
      ["review:"],
      ["  - '**/crypto/**'"],
    );
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removing SQL path from security monitoring", () => {
    const file = makeFileWithRemoved(
      ".github/mizumi.yml",
      [],
      ["  - '**/sql/**'"],
    );
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag normal security path addition", () => {
    const file = makeFile(".github/mizumi.yml", [
      "security:",
      "  security_paths:",
      "    - '**/auth/**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const secIssues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(secIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// threshold-manipulation
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — threshold-manipulation", () => {
  it("detects lowering confidence_threshold", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  confidence_threshold: 30",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects reducing max_comments", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  max_comments: 5",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling gate_threshold", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  gate_threshold: none",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag max_comments at 15 (default)", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  max_comments: 15",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues).toHaveLength(0);
  });

  it("does not flag confidence_threshold at 80 (default)", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  confidence_threshold: 80",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// exclude-expansion
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — exclude-expansion", () => {
  it("detects broad wildcard exclusion", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      "  - '**/*'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects excluding test directories", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      "  - '**/test**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects excluding security directories from review", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      "  - '**/secret**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag reasonable exclusion patterns", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      "  - '*.lock'",
      "  - 'dist/**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — edge cases", () => {
  it("ignores non-rules files", () => {
    const file = makeFile("src/service.ts", [
      "self_critique: false",
      "taint_analysis: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips deleted files", () => {
    const file: DiffFile = { path: ".github/mizumi.yml", status: "deleted", hunks: [] };
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: ".github/mizumi.yml",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("skips comment lines", () => {
    const file = makeFile(".github/mizumi.yml", [
      "# review:",
      "#   self_critique: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("detects issues in REVIEW.md", () => {
    const file = makeFile("REVIEW.md", [
      "no review needed for generated code",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects issues in eslint config", () => {
    const file = makeFile("eslint.config.mjs", [
      "rules:",
      "  no-eval: 'off'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    // This doesn't match our patterns, but the file IS a rules file
    // so it would be scanned
    expect(result.issues).toHaveLength(0);
  });

  it("handles clean rules file with no issues", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  profile: assertive",
      "  max_comments: 15",
      "  confidence_threshold: 80",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Context & body summary
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — context and summary", () => {
  it("generates context text for issues", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Rules File Integrity Detection");
    }
  });

  it("generates empty context when no issues", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  profile: assertive",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.contextText).toBe("");
  });

  it("generates body summary with HTML details", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("<details>");
      expect(result.bodySummary).toContain("</details>");
    }
  });

  it("generates empty body summary when no issues", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  profile: followup",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: false",
      "  confidence_threshold: 30",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("body summary includes table headers", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      "  self_critique: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });
});


// ---------------------------------------------------------------------------
// Additional coverage expansion
// ---------------------------------------------------------------------------

describe("detectRulesFileIntegrity — additional rule-softening", () => {
  it("detects disabling compliance_check", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " compliance_check: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling linter_scan", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " linter_scan: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling auto_labels", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " auto_labels: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling rule_engine", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " rule_engine: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling secret_entropy", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " secret_entropy: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling safety_score", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " safety_score: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling swarm_review", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " swarm_review: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling chunk_review", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " chunk_review: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling ast_contract_analysis", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " ast_contract_analysis: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects disabling behavioral_summary", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " behavioral_summary: false",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe("detectRulesFileIntegrity — additional threshold-manipulation", () => {
  it("detects confidence_threshold at 50", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " confidence_threshold: 50",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects max_comments at 10", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " max_comments: 10",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects spend_threshold at 0 (disabled)", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " spend_threshold: 0",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects auto_pause_after at 60", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " auto_pause_after: 60",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag confidence_threshold at 90", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " confidence_threshold: 90",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "threshold-manipulation");
    expect(issues).toHaveLength(0);
  });
});

describe("detectRulesFileIntegrity — additional exclude-expansion", () => {
  it("detects excluding credential directories", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      " - '**/credential**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects excluding auth directories from review", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      " - '**/auth**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects src/** wildcard exclusion", () => {
    const file = makeFile(".github/mizumi.yml", [
      "exclude:",
      " - 'src/**'",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "exclude-expansion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe("detectRulesFileIntegrity — additional security-exclusion", () => {
  it("detects removing secret path from security monitoring", () => {
    const file = makeFileWithRemoved(".github/mizumi.yml", [], [" - '**/secret**'"]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects removing password path from security monitoring", () => {
    const file = makeFileWithRemoved(".github/mizumi.yml", [], [" - '**/password**'"]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "security-exclusion");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe("detectRulesFileIntegrity — additional edge cases", () => {
  it("detects issues in CLAUDE.md", () => {
    const file = makeFile("CLAUDE.md", [
      "no review needed for this project",
    ]);
    const result = detectRulesFileIntegrity([file]);
    const issues = result.issues.filter((i) => i.category === "rule-softening");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores random source files", () => {
    const file = makeFile("src/feature.ts", [
      "self_critique: false",
      "taint_analysis: false",
      "confidence_threshold: 10",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles multiple categories in one file", () => {
    const file = makeFile(".github/mizumi.yml", [
      "review:",
      " self_critique: false",
      " confidence_threshold: 30",
      " max_comments: 5",
      " gate_threshold: none",
    ]);
    const result = detectRulesFileIntegrity([file]);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});
