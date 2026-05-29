/**
 * Tests for Cross-File Taint Path Detector
 */
import { describe, it, expect } from "vitest";
import { detectTaintPaths } from "../taint-path-detector.js";
import type { DiffFile } from "../diff.js";

function makeDiffFile(path: string, added: string[], status: "modified" | "added" = "modified"): DiffFile {
  const changes = added.map((content, i) => ({ type: "add" as const, content: `+${content}`, line: i + 1, ln: i + 1 }));
  return {
    path,
    status,
    hunks: [{ header: "@@ -0 +0 @@", changes }],
  };
}

// ---------------------------------------------------------------------------
// pr-content-to-exec
// ---------------------------------------------------------------------------

describe("detectTaintPaths — pr-content-to-exec", () => {
  it("detects pr.title reaching eval", () => {
    const file = makeDiffFile("src/handler.ts", ["eval(pr.title);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects req.body reaching exec", () => {
    const file = makeDiffFile("src/runner.ts", ["exec(req.body.command);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects agent output reaching exec", () => {
    const file = makeDiffFile("src/agent.ts", ["exec(agentOutput);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects ctx.request reaching spawn", () => {
    const file = makeDiffFile("src/api.ts", ["spawn(ctx.request.body.cmd);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects process.env reaching exec", () => {
    const file = makeDiffFile("src/config.ts", ["exec(process.env.CMD);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag validated exec", () => {
    const file = makeDiffFile("src/handler.ts", ["exec(validate(req.body.command));"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag sanitized input", () => {
    const file = makeDiffFile("src/handler.ts", ["exec(sanitizeInput(agentOutput));"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag test files", () => {
    const file = makeDiffFile("src/__tests__/handler.test.ts", ["eval(pr.title);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "pr-content-to-exec");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// unvalidated-redirect
// ---------------------------------------------------------------------------

describe("detectTaintPaths — unvalidated-redirect", () => {
  it("detects fetch with req.query url", () => {
    const file = makeDiffFile("src/proxy.ts", ["fetch(req.query.url);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("warning");
  });

  it("detects redirect with input URL", () => {
    const file = makeDiffFile("src/redirect.ts", ["redirect(inputUrl);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects response.redirect with endpoint", () => {
    const file = makeDiffFile("src/api.ts", ["response.redirect(req.params.endpoint);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("detects window.location assignment", () => {
    const file = makeDiffFile("src/client.ts", ["window.location = userInput;"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag validated redirect", () => {
    const file = makeDiffFile("src/proxy.ts", ["fetch(validateUrl(req.query.url));"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag allowlisted URL", () => {
    const file = makeDiffFile("src/proxy.ts", ["fetch(ALLOWED_URLS.includes(url) ? url : defaultUrl);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag test files", () => {
    const file = makeDiffFile("src/__tests__/redirect.test.ts", ["fetch(req.query.url);"]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "unvalidated-redirect");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// taint-across-files
// ---------------------------------------------------------------------------

describe("detectTaintPaths — taint-across-files", () => {
  it("detects variable from req.body used in exec in different file", () => {
    const sourceFile = makeDiffFile("src/input.ts", ["const userCmd = req.body.command;"]);
    const sinkFile = makeDiffFile("src/runner.ts", ["exec(userCmd);"]);
    const result = detectTaintPaths([sourceFile, sinkFile]);
    const issues = result.issues.filter((i) => i.category === "taint-across-files");
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].severity).toBe("critical");
  });

  it("detects variable from params used in writeFile in different file", () => {
    const sourceFile = makeDiffFile("src/routes.ts", ["const outputPath = params.destination;"]);
    const sinkFile = makeDiffFile("src/storage.ts", ["writeFile(outputPath, data);"]);
    const result = detectTaintPaths([sourceFile, sinkFile]);
    const issues = result.issues.filter((i) => i.category === "taint-across-files");
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag same-file taint (not cross-file)", () => {
    const file = makeDiffFile("src/handler.ts", [
      "const userCmd = req.body.command;",
      "exec(userCmd);",
    ]);
    const result = detectTaintPaths([file]);
    const issues = result.issues.filter((i) => i.category === "taint-across-files");
    expect(issues).toHaveLength(0);
  });

  it("does NOT flag validated sink", () => {
    const sourceFile = makeDiffFile("src/input.ts", ["const userCmd = req.body.command;"]);
    const sinkFile = makeDiffFile("src/runner.ts", ["exec(validate(userCmd));"]);
    const result = detectTaintPaths([sourceFile, sinkFile]);
    const issues = result.issues.filter((i) => i.category === "taint-across-files");
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios
// ---------------------------------------------------------------------------

describe("detectTaintPaths — combined scenarios", () => {
  it("detects multiple categories", () => {
    const file1 = makeDiffFile("src/handler.ts", ["eval(pr.title);"]);
    const file2 = makeDiffFile("src/proxy.ts", ["fetch(req.query.url);"]);
    const sourceFile = makeDiffFile("src/input.ts", ["const userCmd = req.body.command;"]);
    const sinkFile = makeDiffFile("src/runner.ts", ["exec(userCmd);"]);
    const result = detectTaintPaths([file1, file2, sourceFile, sinkFile]);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });

  it("sorts critical before warning", () => {
    const file1 = makeDiffFile("src/handler.ts", ["eval(pr.title);"]);
    const file2 = makeDiffFile("src/proxy.ts", ["fetch(req.query.url);"]);
    const result = detectTaintPaths([file1, file2]);
    const critical = result.issues.filter((i) => i.severity === "critical");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    if (critical.length > 0 && warnings.length > 0) {
      const lastC = result.issues.indexOf(critical[critical.length - 1]);
      const firstW = result.issues.indexOf(warnings[0]);
      expect(lastC).toBeLessThan(firstW);
    }
  });

  it("handles deleted files", () => {
    const file: DiffFile = { path: "src/handler.ts", status: "deleted", hunks: [] };
    const result = detectTaintPaths([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("handles empty hunks", () => {
    const file: DiffFile = {
      path: "src/handler.ts",
      status: "modified",
      hunks: [{ header: "@@ -0 +0 @@", changes: [] }],
    };
    const result = detectTaintPaths([file]);
    expect(result.issues).toHaveLength(0);
  });

  it("produces context text", () => {
    const file = makeDiffFile("src/handler.ts", ["eval(pr.title);"]);
    const result = detectTaintPaths([file]);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Taint Path Detection");
    }
  });

  it("produces body summary with table", () => {
    const file = makeDiffFile("src/handler.ts", ["eval(pr.title);"]);
    const result = detectTaintPaths([file]);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty for clean PR", () => {
    const file = makeDiffFile("src/app.ts", ["const x = 1 + 2;"]);
    const result = detectTaintPaths([file]);
    expect(result.contextText).toBe("");
    expect(result.bodySummary).toBe("");
  });
});
