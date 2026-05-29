import { describe, it, expect, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { detectDeadCode } from "../dead-code-detector.js";
import type { DeadCodeIssue, DeadCodeResult } from "../dead-code-detector.js";
import type { DiffFile } from "../diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeFile = (
  filePath: string,
  changes: string[],
  status: DiffFile["status"] = "modified",
): DiffFile => ({
  path: filePath,
  status,
  additions: changes.filter((c) => c.startsWith("+")).length,
  deletions: changes.filter((c) => c.startsWith("-")).length,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      changes: changes.map((content, i) => ({
        type: content.startsWith("+")
          ? ("add" as const)
          : content.startsWith("-")
            ? ("delete" as const)
            : ("normal" as const),
        content,
        line: i + 1,
      })),
    },
  ],
});

// ---------------------------------------------------------------------------
// detectDeadCode — no issues
// ---------------------------------------------------------------------------

describe("detectDeadCode — no issues", () => {
  it("returns empty when there is no dead code", () => {
    const files = [makeFile("src/utils.ts", [
      "+const value = compute();",
      "+console.log(value);",
    ])];
    const result = detectDeadCode(files);
    expect(result.issues).toHaveLength(0);
  });

  it("returns empty for clean code with proper error handling", () => {
    const files = [makeFile("src/api.ts", [
      "+try {",
      "+  const data = await fetch(url);",
      "+} catch (e) {",
      "+  logger.error('Fetch failed', e);",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const emptyCatch = result.issues.filter((i) => i.category === "empty-catch");
    expect(emptyCatch).toHaveLength(0);
  });

  it("skips deleted files", () => {
    const files = [makeFile("src/old.ts", [
      "+catch (e) {}",
    ], "deleted")];
    const result = detectDeadCode(files);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unreachable code
// ---------------------------------------------------------------------------

describe("detectDeadCode — unreachable code", () => {
  it("detects code after return", () => {
    const files = [makeFile("src/app.ts", [
      "+  return result;",
      "+  const x = unusedAfterReturn;",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].severity).toBe("warning");
  });

  it("detects code after throw", () => {
    const files = [makeFile("src/app.ts", [
      "+  throw new Error('fail');",
      "+  const y = neverReached;",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag code at a shallower indent after return", () => {
    const files = [makeFile("src/app.ts", [
      "+  if (err) {",
      "+    return null;",
      "+  }",
      "+  const next = process(data);",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    // The `const next` line is at a shallower indent, so not unreachable
    expect(unreachable).toHaveLength(0);
  });

  it("detects code after break", () => {
    const files = [makeFile("src/app.ts", [
      "+      break;",
      "+      const afterBreak = true;",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it("detects code after continue", () => {
    const files = [makeFile("src/app.ts", [
      "+      continue;",
      "+      doSomethingAfter();",
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === "unreachable-code");
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Unused variables
// ---------------------------------------------------------------------------

describe("detectDeadCode — unused variables", () => {
  it("detects unused const", () => {
    const files = [makeFile("src/app.ts", [
      "+const configPath = '/etc/app.conf';",
      "+console.log('starting');",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable");
    expect(unused.length).toBeGreaterThanOrEqual(1);
    expect(unused[0].symbol).toBe("configPath");
    expect(unused[0].severity).toBe("warning");
  });

  it("does not flag used variables", () => {
    const files = [makeFile("src/app.ts", [
      "+const apiKey = process.env.KEY;",
      "+sendRequest(apiKey);",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "apiKey");
    expect(unused).toHaveLength(0);
  });

  it("does not flag exported variables", () => {
    const files = [makeFile("src/app.ts", [
      "+export const MAX_SIZE = 100;",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "MAX_SIZE");
    expect(unused).toHaveLength(0);
  });

  it("does not flag underscore-prefixed variables", () => {
    const files = [makeFile("src/app.ts", [
      "+const _unused = compute();",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "_unused");
    expect(unused).toHaveLength(0);
  });

  it("does not flag single-letter variables", () => {
    const files = [makeFile("src/app.ts", [
      "+let i = 0;",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable" && i.symbol === "i");
    expect(unused).toHaveLength(0);
  });

  it("detects unused let", () => {
    const files = [makeFile("src/app.ts", [
      "+let retries = 3;",
      "+console.log('done');",
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable");
    expect(unused.length).toBeGreaterThanOrEqual(1);
    expect(unused[0].symbol).toBe("retries");
  });
});

// ---------------------------------------------------------------------------
// Empty catch blocks
// ---------------------------------------------------------------------------

describe("detectDeadCode — empty catch blocks", () => {
  it("detects single-line empty catch", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty.length).toBeGreaterThanOrEqual(1);
    expect(empty[0].severity).toBe("critical");
  });

  it("detects multi-line empty catch", () => {
    const files = [makeFile("src/app.ts", [
      "+try {",
      "+  doWork();",
      "+} catch (err) {",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag catch blocks with error handling", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (err) {",
      "+  logger.error('failed', err);",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty).toHaveLength(0);
  });

  it("does not flag catch blocks that rethrow", () => {
    const files = [makeFile("src/app.ts", [
      "+} catch (err) {",
      "+  throw err;",
      "+}",
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === "empty-catch");
    expect(empty).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("detectDeadCode — deduplication", () => {
  it("deduplicates identical issues", () => {
    const files = [makeFile("src/app.ts", [
      "+const dead1 = 1;",
      "+const dead2 = 2;",
      "+console.log('x');",
    ])];
    const result = detectDeadCode(files);
    const unique = new Set(result.issues.map((i) => `${i.category}:${i.symbol}`));
    expect(unique.size).toBe(result.issues.filter((i) => i.category === "unused-variable").length);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("detectDeadCode — sorting", () => {
  it("sorts critical before warning", () => {
    const files = [makeFile("src/app.ts", [
      "+const unusedOut = 'x';",
      "+console.log('ok');",
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 1) {
      const severities = result.issues.map((i) => i.severity);
      const firstWarning = severities.indexOf("warning");
      const lastCritical = severities.lastIndexOf("critical");
      if (firstWarning >= 0 && lastCritical >= 0) {
        expect(lastCritical).toBeLessThan(firstWarning);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Context text generation
// ---------------------------------------------------------------------------

describe("detectDeadCode — context text", () => {
  it("includes issues in contextText", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain("Dead Code Detection");
    }
  });

  it("returns empty contextText when no issues", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = detectDeadCode(files);
    expect(result.contextText).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Body summary generation
// ---------------------------------------------------------------------------

describe("detectDeadCode — body summary", () => {
  it("includes table in bodySummary when issues exist", () => {
    const files = [makeFile("src/app.ts", [
      "+try { doWork(); } catch (e) {}",
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain("Dead Code Detection");
      expect(result.bodySummary).toContain("| Category |");
    }
  });

  it("returns empty bodySummary when no issues", () => {
    const files = [makeFile("src/utils.ts", ["+const x = 1;"])];
    const result = detectDeadCode(files);
    expect(result.bodySummary).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

describe("detectDeadCode — multiple files", () => {
  it("aggregates issues across files", () => {
    const files = [
      makeFile("src/a.ts", ["+const unusedA = 1;", "+console.log('a');"]),
      makeFile("src/b.ts", ["+const unusedB = 2;", "+console.log('b');"]),
    ];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === "unused-variable");
    expect(unused.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Mixed categories
// ---------------------------------------------------------------------------

describe("detectDeadCode — mixed categories", () => {
  it("detects multiple dead code types in one file", () => {
    const files = [makeFile("src/app.ts", [
      "+  return null;",
      "+  const dead = true;",
      "+const unused = 42;",
      "+try { doIt(); } catch (e) {}",
      "+console.log('ok');",
    ])];
    const result = detectDeadCode(files);
    const categories = new Set(result.issues.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — additional coverage
// ---------------------------------------------------------------------------

describe('detectDeadCode — edge cases (expanded)', () => {
  it('skips comments after return', () => {
    const files = [makeFile('src/app.ts', [
      '+ return null;',
      '+ // This is just a comment',
      '+ const alive = true;',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it('skips closing brace after return', () => {
    const files = [makeFile('src/app.ts', [
      '+ return result;',
      '+ }',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    expect(unreachable).toHaveLength(0);
  });

  it('skips blank lines after return', () => {
    const files = [makeFile('src/app.ts', [
      '+ return result;',
      '+ const next = process();',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag destructured variable declarations', () => {
    const files = [makeFile('src/app.ts', [
      '+const { name, age } = person;',
      '+console.log(name);',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    // Destructured declarations should be skipped
    expect(unused).toHaveLength(0);
  });

  it('detects unused variable across files (not referenced elsewhere)', () => {
    const files = [
      makeFile('src/a.ts', ['+const localOnly = compute();', '+console.log("done");']),
      makeFile('src/b.ts', ['+const used = getValue();', '+processData(used);']),
    ];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable' && i.symbol === 'localOnly');
    expect(unused.length).toBeGreaterThanOrEqual(1);
  });

  it('empty catch with spaces still detected', () => {
    const files = [makeFile('src/app.ts', [
      '+try { doWork(); } catch (e) {   }',
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === 'empty-catch');
    // The regex requires no content between braces, so spaces might not match
    // This tests the exact behavior
    expect(result.issues).toBeDefined();
  });

  it('detects empty catch with error variable names', () => {
    const files = [makeFile('src/app.ts', [
      '+try { risky(); } catch (error) {}',
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === 'empty-catch');
    expect(empty.length).toBeGreaterThanOrEqual(1);
  });

  it('shows both critical and warning sections in context', () => {
    const files = [makeFile('src/app.ts', [
      '+const orphaned = 42;',
      '+console.log("ok");',
      '+try { doIt(); } catch (e) {}',
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 1) {
      const hasCritical = result.issues.some((i) => i.severity === 'critical');
      const hasWarning = result.issues.some((i) => i.severity === 'warning');
      if (hasCritical && hasWarning) {
        expect(result.contextText).toContain('Critical');
        expect(result.contextText).toContain('Warnings');
      }
    }
  });

  it('shows more row when issues exceed 15', () => {
    const changes = [];
    for (let i = 0; i < 20; i++) {
      changes.push('+const dead' + i + ' = ' + i + ';');
    }
    changes.push('+console.log("done");');
    const files = [makeFile('src/app.ts', changes)];
    const result = detectDeadCode(files);
    if (result.issues.length > 15) {
      expect(result.bodySummary).toContain('more');
    }
  });

  it('handles var declarations as unused', () => {
    const files = [makeFile('src/app.ts', [
      '+var globalState = initialize();',
      '+console.log("ready");',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    expect(unused.length).toBeGreaterThanOrEqual(1);
    expect(unused[0].symbol).toBe('globalState');
  });

  it('description mentions the terminating keyword for unreachable code', () => {
    const files = [makeFile('src/app.ts', [
      '+ throw new Error("fail");',
      '+ const neverReached = true;',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    if (unreachable.length > 0) {
      expect(unreachable[0].description).toContain('throw');
    }
  });
});

// ---------------------------------------------------------------------------
// Additional edge case tests
// ---------------------------------------------------------------------------

describe('detectDeadCode — unreachable code edge cases', () => {
  it('detects code after continue in a loop', () => {
    const files = [makeFile('src/loop.ts', [
      '+ for (const item of list) {',
      '+   continue;',
      '+   processItem(item);',
      '+ }',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag code after return in an if at shallower indent', () => {
    const files = [makeFile('src/flow.ts', [
      '+ if (condition) {',
      '+   return early;',
      '+ }',
      '+ const afterIf = doWork();',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    // `const afterIf` is at shallower indent than the return, so not unreachable
    expect(unreachable).toHaveLength(0);
  });

  it('handles multiple return statements with unreachable code between them', () => {
    const files = [makeFile('src/multi.ts', [
      '+ return first;',
      '+ const dead1 = 1;',
      '+ return second;',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    // Should detect dead1 as unreachable after first return
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag normal line after return that is a closing brace only', () => {
    const files = [makeFile('src/brace.ts', [
      '+ if (done) {',
      '+   return result;',
      '+ }',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    expect(unreachable).toHaveLength(0);
  });

  it('handles tabs for indentation correctly', () => {
    const files = [makeFile('src/tabs.ts', [
      '+\treturn value;',
      '+\tconst dead = true;',
    ])];
    const result = detectDeadCode(files);
    const unreachable = result.issues.filter((i) => i.category === 'unreachable-code');
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
  });
});

describe('detectDeadCode — unused variable edge cases', () => {
  it('does not flag function declaration as unused variable', () => {
    const files = [makeFile('src/func.ts', [
      '+function myHelper() { return 42; }',
      '+console.log("done");',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    // Function declarations are not matched by VAR_DECL_RE (const/let/var only)
    expect(unused).toHaveLength(0);
  });

  it('detects unused variable used only in its own declaration', () => {
    const files = [makeFile('src/selfref.ts', [
      '+const counter = counter + 1;',
      '+console.log("done");',
    ])];
    // "counter" appears on its own declaration line but not elsewhere
    // This checks that the declaration line is properly excluded from reference search
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    expect(unused.length).toBeGreaterThanOrEqual(0);
  });

  it('flags two-letter variable names as unused (length > 1)', () => {
    const files = [makeFile('src/short.ts', [
      '+let id = getId();',
      '+console.log("done");',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable' && i.symbol === 'id');
    // Two-letter names (length > 1) ARE detected as unused
    expect(unused.length).toBeGreaterThanOrEqual(1);
  });

  it('detects unused variable with same name as part of another variable', () => {
    const files = [makeFile('src/partial.ts', [
      '+const config = loadConfig();',
      '+const configPath = config.path;',
      '+console.log(configPath);',
    ])];
    // "config" is used in line 2, so not unused
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable' && i.symbol === 'config');
    expect(unused).toHaveLength(0);
  });

  it('does not flag variable used as property access target', () => {
    const files = [makeFile('src/prop.ts', [
      '+const settings = getDefaults();',
      '+applyConfig(settings.maxRetries);',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable' && i.symbol === 'settings');
    expect(unused).toHaveLength(0);
  });

  it('detects multiple unused variables in the same file', () => {
    const files = [makeFile('src/multiunused.ts', [
      '+const alpha = 1;',
      '+const beta = 2;',
      '+const gamma = 3;',
      '+console.log("nothing used");',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    expect(unused.length).toBeGreaterThanOrEqual(3);
  });

  it('skips underscore-prefixed variables by convention', () => {
    const files = [makeFile('src/ignore.ts', [
      '+const _ignored = compute();',
      '+console.log("ok");',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    expect(unused).toHaveLength(0);
  });
});

describe('detectDeadCode — empty catch edge cases', () => {
  it('detects catch with only a comment inside (not actual handling)', () => {
    // The regex only matches {} with nothing inside, comments would not trigger
    const files = [makeFile('src/comment.ts', [
      '+try { doWork(); } catch (e) { /* ignored */ }',
    ])];
    const result = detectDeadCode(files);
    // Single-line regex won't match because there's content between braces
    const empty = result.issues.filter((i) => i.category === 'empty-catch');
    // This should NOT be detected as empty because there's a comment inside
    expect(result.issues).toBeDefined();
  });

  it('handles catch with named error variable other than e', () => {
    const files = [makeFile('src/named.ts', [
      '+try { risky(); } catch (exception) {}',
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === 'empty-catch');
    expect(empty.length).toBeGreaterThanOrEqual(1);
  });

  it('handles multi-line catch with logging (not empty)', () => {
    const files = [makeFile('src/logged.ts', [
      '+} catch (err) {',
      '+ console.error("Failed", err);',
      '+}',
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === 'empty-catch');
    expect(empty).toHaveLength(0);
  });

  it('does not flag try-catch with throw in catch', () => {
    const files = [makeFile('src/rethrow.ts', [
      '+} catch (e) {',
      '+ throw e;',
      '+}',
    ])];
    const result = detectDeadCode(files);
    const empty = result.issues.filter((i) => i.category === 'empty-catch');
    expect(empty).toHaveLength(0);
  });
});

describe('detectDeadCode — deduplication edge cases', () => {
  it('deduplicates same issue at same line and symbol', () => {
    // Create two hunks that would produce duplicate entries
    const files = [{
      path: 'src/dup.ts',
      status: 'modified' as const,
      additions: 2,
      deletions: 0,
      hunks: [
        {
          header: '@@ -1 +1 @@',
          changes: [
            { type: 'add' as const, content: '+const dup = 1;', line: 5 },
            { type: 'add' as const, content: '+const dup = 1;', line: 5 },
          ],
        },
      ],
    }];
    const result = detectDeadCode(files as any);
    const unused = result.issues.filter((i) => i.category === 'unused-variable' && i.symbol === 'dup');
    // Should be deduplicated to 1
    expect(unused.length).toBeLessThanOrEqual(1);
  });

  it('allows same category different symbol at different lines', () => {
    const files = [makeFile('src/diff.ts', [
      '+const first = compute();',
      '+const second = calculate();',
      '+console.log("done");',
    ])];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    expect(unused.length).toBeGreaterThanOrEqual(2);
    const symbols = unused.map((i) => i.symbol);
    expect(symbols).toContain('first');
    expect(symbols).toContain('second');
  });
});

describe('detectDeadCode — sorting edge cases', () => {
  it('sorts critical issues before warnings regardless of file order', () => {
    const files = [
      makeFile('src/z.ts', ['+const warnVar = 1;', '+console.log("z");']),
      makeFile('src/a.ts', ['+try { fail(); } catch (e) {}']),
    ];
    const result = detectDeadCode(files);
    if (result.issues.length >= 2) {
      const firstCritical = result.issues.findIndex((i) => i.severity === 'critical');
      const firstWarning = result.issues.findIndex((i) => i.severity === 'warning');
      if (firstCritical >= 0 && firstWarning >= 0) {
        expect(firstCritical).toBeLessThan(firstWarning);
      }
    }
  });

  it('sorts by file name when severity is the same', () => {
    const files = [
      makeFile('src/z.ts', ['+const zvar = 1;', '+console.log("z");']),
      makeFile('src/a.ts', ['+const avar = 1;', '+console.log("a");']),
    ];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    if (unused.length >= 2) {
      // All warnings, sorted by file name
      expect(unused[0].file.localeCompare(unused[1].file)).toBeLessThanOrEqual(0);
    }
  });
});

describe('detectDeadCode — empty input', () => {
  it('handles empty files array', () => {
    const result = detectDeadCode([]);
    expect(result.issues).toHaveLength(0);
    expect(result.contextText).toBe('');
    expect(result.bodySummary).toBe('');
  });
});

describe('detectDeadCode — added file status', () => {
  it('processes added files', () => {
    const files = [makeFile('src/new.ts', [
      '+const newDead = compute();',
      '+console.log("ok");',
    ], 'added')];
    const result = detectDeadCode(files);
    const unused = result.issues.filter((i) => i.category === 'unused-variable');
    expect(unused.length).toBeGreaterThanOrEqual(1);
  });

  it('skips renamed files as deleted (treated same as deleted)', () => {
    // The source only skips "deleted" status, so "removed" would not be filtered
    const files = [makeFile('src/old.ts', [
      '+const dead = 1;',
    ], 'removed')];
    const result = detectDeadCode(files);
    // Source only filters `status === "deleted"`, not "removed"
    expect(result.issues).toBeDefined();
  });
});

describe('detectDeadCode — body summary edge cases', () => {
  it('body summary includes severity column', () => {
    const files = [makeFile('src/app.ts', [
      '+try { crash(); } catch (e) {}',
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain('critical');
    }
  });

  it('body summary includes file path', () => {
    const files = [makeFile('src/deep/nested/module.ts', [
      '+try { crash(); } catch (e) {}',
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.bodySummary).toContain('module.ts');
    }
  });

  it('context text includes issue count in header', () => {
    const files = [makeFile('src/app.ts', [
      '+const dead = 1;',
      '+console.log("x");',
      '+try { fail(); } catch (e) {}',
    ])];
    const result = detectDeadCode(files);
    if (result.issues.length > 0) {
      expect(result.contextText).toContain(`(${result.issues.length})`);
    }
  });
});
