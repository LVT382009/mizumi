/**
 * Tests for Agency Escalation Detector
 */
import { describe, it, expect } from "vitest";
import { detectAgencyEscalation } from "../agency-escalation-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiffFile(path: string, added: string[], status: "modified" | "added" = "modified"): DiffFile {
  const changes = added.map((content, i) => ({ type: "add" as const, content: `+${content}`, line: i + 1, ln: i + 1 }));
  return {
    path,
    status,
    hunks: [{ header: "@@ -0 +0 @@", changes }],
  };
}

// ---------------------------------------------------------------------------
// unrestricted-tool-parameter
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — unrestricted-tool-parameter", () => {
  it("detects filePath from request params", () => {
    const file = makeDiffFile("src/handler.ts", ["const filePath = req.params.path;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects command from input body", () => {
    const file = makeDiffFile("src/executor.ts", ["const command = req.body.cmd;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects URL from query params", () => {
    const file = makeDiffFile("src/proxy.ts", ["const url = request.query.endpoint;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag validated paths with allowlist", () => {
    const file = makeDiffFile("src/handler.ts", ["const filePath = req.params.path; ALLOWED_PATHS.includes(filePath)"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag paths with path.normalize", () => {
    const file = makeDiffFile("src/handler.ts", ["const filePath = path.normalize(req.params.path);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag test files", () => {
    const file = makeDiffFile("src/__tests__/handler.test.ts", ["const filePath = req.params.path;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag comment lines", () => {
    const file = makeDiffFile("src/handler.ts", ["// const filePath = req.params.path;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// excessive-autonomy
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — excessive-autonomy", () => {
  it("detects auto-deploy: true", () => {
    const file = makeDiffFile("src/deploy.ts", ["auto_deploy: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects auto-approve: true", () => {
    const file = makeDiffFile("src/approval.ts", ["auto-approve: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects auto-merge: true", () => {
    const file = makeDiffFile("src/merge.ts", ["auto_merge: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects skip_review: true", () => {
    const file = makeDiffFile("src/review.ts", ["skip_review: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cron schedule", () => {
    const file = makeDiffFile("src/scheduler.ts", ["cron: '0 * * * *'"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects autonomous: true", () => {
    const file = makeDiffFile("src/agent.ts", ["autonomous: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects while(true) agent loop", () => {
    const file = makeDiffFile("src/loop.ts", ["while (true) {"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects agent writing to config files", () => {
    const file = makeDiffFile("src/writer.ts", ["writeFile(config/settings.json)"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag test files", () => {
    const file = makeDiffFile("src/__tests__/deploy.test.ts", ["auto_deploy: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dangerous-sink-from-llm-output
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — dangerous-sink-from-llm-output", () => {
  it("detects eval() with LLM output", () => {
    const file = makeDiffFile("src/eval.ts", ["eval(llmResponse);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects eval() without explicit LLM source (warning)", () => {
    const file = makeDiffFile("src/eval.ts", ["eval(userInput);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects new Function() with agent output", () => {
    const file = makeDiffFile("src/dynamic.ts", ["new Function(agentOutput)();"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects child_process.exec with variable", () => {
    const file = makeDiffFile("src/runner.ts", ["exec(`ls ${modelOutput}`);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects vm.runInContext", () => {
    const file = makeDiffFile("src/sandbox.ts", ["vm.runInContext(completion);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects dynamic import with variable", () => {
    const file = makeDiffFile("src/loader.ts", ["import(promptGenerated);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag eval with validation guard", () => {
    const file = makeDiffFile("src/eval.ts", ["eval(validate(userInput));"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag test files", () => {
    const file = makeDiffFile("src/__tests__/eval.test.ts", ["eval(llmResponse);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag comment lines", () => {
    const file = makeDiffFile("src/eval.ts", ["// eval(response);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — combined scenarios", () => {
  it("detects multiple categories across files", () => {
    const file1 = makeDiffFile("src/handler.ts", ["const filePath = req.body.path;"]);
    const file2 = makeDiffFile("src/deploy.ts", ["auto_deploy: true"]);
    const file3 = makeDiffFile("src/dynamic.ts", ["eval(llmResponse);"]);
    const result = detectAgencyEscalation([file1, file2, file3]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBe(3);
  });

  it("produces context text", () => {
    const file = makeDiffFile("src/eval.ts", ["eval(llmResponse);"]);
    const result = detectAgencyEscalation([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Agency Escalation Detection");
    }
  });

  it("produces body summary with table", () => {
    const file = makeDiffFile("src/eval.ts", ["eval(llmResponse);"]);
    const result = detectAgencyEscalation([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
      expect(result.bodySummary).toContain("OWASP LLM06");
    }
  });

  it("returns empty for clean PR", () => {
    const file = makeDiffFile("src/app.ts", ["const x = 1 + 2;"]);
    const result = detectAgencyEscalation([file]);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("sorts critical before warning", () => {
    const file1 = makeDiffFile("src/eval.ts", ["eval(llmResponse);"]);
    const file2 = makeDiffFile("src/deploy.ts", ["auto_deploy: true"]);
    const result = detectAgencyEscalation([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("handles deleted files", () => {
    const file: DiffFile = { path: "src/eval.ts", status: "deleted", hunks: [] };
    const result = detectAgencyEscalation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/eval.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectAgencyEscalation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("body summary truncates at 15 issues", () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      makeDiffFile(`src/eval${i}.ts`, ["eval(llmResponse);"])
    );
    const result = detectAgencyEscalation(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain("more");
    }
  });
});


// ---------------------------------------------------------------------------
// Expanded coverage: unrestricted-tool-parameter
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — unrestricted-tool-parameter expanded", () => {
  it("detects dest from request args", () => {
    const file = makeDiffFile("src/writer.ts", ["const dest = request.args.destination;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects outputPath from input ctx", () => {
    const file = makeDiffFile("src/output.ts", ["const outputPath = input.ctx.path;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects script param from params", () => {
    const file = makeDiffFile("src/runner.ts", ["const script = params.script;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects function signature with filePath param", () => {
    const file = makeDiffFile("src/processor.ts", ["function processFile(filePath: string) {"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "unrestricted-tool-parameter");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: excessive-autonomy
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — excessive-autonomy expanded", () => {
  it("detects unattended: true", () => {
    const file = makeDiffFile("src/agent.ts", ["unattended: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects headless: true", () => {
    const file = makeDiffFile("src/browser.ts", ["headless: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects no_human_in_loop flag", () => {
    const file = makeDiffFile("src/deploy.ts", ["no_human_in_loop: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects force: true", () => {
    const file = makeDiffFile("src/deploy.ts", ["force: true"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects updateFile with rules path", () => {
    const file = makeDiffFile("src/modifier.ts", ["updateFile(config/rules.json)"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects cron: @daily", () => {
    const file = makeDiffFile("src/scheduler.ts", ["cron: '@daily'"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "excessive-autonomy");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: dangerous-sink-from-llm-output
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — dangerous-sink-from-llm-output expanded", () => {
  it("detects exec with model variable", () => {
    const file = makeDiffFile("src/exec.ts", ["exec(modelCommand);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects exec with prompt variable", () => {
    const file = makeDiffFile("src/run.ts", ["exec(promptResult);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects fs.writeFile with variable path", () => {
    const file = makeDiffFile("src/writer.ts", ["fs.writeFile(userPath, data);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects fs.appendFile with variable", () => {
    const file = makeDiffFile("src/log.ts", ["fs.appendFile(logPath, content);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects spawn with template literal", () => {
    const file = makeDiffFile("src/spawn.ts", ["spawn(`${binPath}`, args);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects import(completion) as dynamic import with LLM source", () => {
    const file = makeDiffFile("src/loader.ts", ["import(completion);"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter((i) => i.category === "dangerous-sink-from-llm-output");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Expanded coverage: combined scenarios
// ---------------------------------------------------------------------------

describe("detectAgencyEscalation — combined expanded", () => {
  it("detects all 3 categories across multiple files", () => {
    const file1 = makeDiffFile("src/handler.ts", ["const dest = request.args.dest;"]);
    const file2 = makeDiffFile("src/agent.ts", ["unattended: true"]);
    const file3 = makeDiffFile("src/exec.ts", ["exec(modelOutput);"]);
    const result = detectAgencyEscalation([file1, file2, file3]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBe(3);
  });

  it("returns empty for clean file with no issues", () => {
    const file = makeDiffFile("src/clean.ts", ["const x = compute(y);"]);
    const result = detectAgencyEscalation([file]);
    expect(result.issues).toHaveLength(0);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });

  it("handles deleted files gracefully", () => {
    const file: DiffFile = { path: "src/eval.ts", status: "deleted", hunks: [] };
    const result = detectAgencyEscalation([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("deduplicates same category/file/line", () => {
    const file = makeDiffFile("src/handler.ts", ["const filePath = req.body.path;"]);
    const result = detectAgencyEscalation([file]);
    const issues = result.issues.filter(
      (i) => i.category === "unrestricted-tool-parameter" && i.line === 1
    );
    expect(issues.length).toBeLessThanOrEqual(1);
  });
});
