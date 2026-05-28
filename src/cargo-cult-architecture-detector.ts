/**
 * Cargo-Cult Architecture Detector — detect LLM-generated boilerplate patterns.
 *
 * When LLMs generate code, they create patterns from training data rather
 * than domain requirements: unnecessary abstraction layers, interfaces for
 * single implementations, deep inheritance chains, and decorator stacks.
 * These add structural complexity without adding domain value.
 *
 * Categories:
 * 1. enterprise-facade: class wrapping a single function with delegation
 * 2. interface-for-single-impl: interface with exactly one implementation
 * 3. deep-inheritance: 3+ level class inheritance chains
 * 4. singleton-misuse: singleton pattern for stateless services
 * 5. decorator-stack: 3+ decorators on a single method/class
 *
 * Zero LLM cost — pure pattern analysis on diff content.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CargoCultCategory =
  | "enterprise-facade"
  | "interface-for-single-impl"
  | "deep-inheritance"
  | "singleton-misuse"
  | "decorator-stack";

export interface CargoCultIssue {
  category: CargoCultCategory;
  file: string;
  line: number;
  code: string;
  description: string;
  severity: "critical" | "warning";
}

export interface CargoCultResult {
  issues: CargoCultIssue[];
  contextText: string;
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripPrefix(content: string): string {
  return content.replace(/^\+/, "").trim();
}

function getAddedChanges(file: DiffFile) {
  return file.hunks.flatMap((h) => h.changes).filter((c) => c.type === "add");
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

// Class declarations
const CLASS_DECL_RE = /\b(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

// Interface declarations
const INTERFACE_DECL_RE = /\b(?:export\s+)?interface\s+(\w+)/;

// Extends/implements patterns
const EXTENDS_RE = /\bclass\s+\w+\s+extends\s+(\w+)/;
const IMPLEMENTS_RE = /\bclass\s+\w+\s+implements\s+(\w+(?:\s*,\s*\w+)*)/;

// Singleton patterns
const SINGLETON_PRIVATE_CTOR_RE = /private\s+(?:constructor|new)\s*\(/;
const SINGLETON_INSTANCE_RE = /(?:static\s+)?(?:get\s+)?instance\s*[:(]/;
const SINGLETON_GET_INSTANCE_RE = /getInstance\s*\(\s*\)/;

// Decorator patterns — @decorator or @Decorator(args)
const DECORATOR_RE = /@(\w+)(?:\s*\([^)]*\))?\s*$/;

// Method delegation pattern — method body just calls another method
const DELEGATION_RE = /(?:return\s+)?(?:this\.\w+|super\.\w+|_\w+)\.\w+\s*\([^)]*\)\s*;?\s*\}?\s*$/;

// Skip patterns
const SKIP_LINE_RE = /^\+\s*(\/\/|\/\*|\*|import\s+type\s|export\s+type\s)/;

// ---------------------------------------------------------------------------
// Detection: enterprise-facade
// ---------------------------------------------------------------------------

function detectEnterpriseFacade(file: DiffFile): CargoCultIssue[] {
  const issues: CargoCultIssue[] = [];
  const added = getAddedChanges(file);

  let inClass = false;
  let className = "";
  let classStartLine = 0;
  let methodCount = 0;
  let delegationCount = 0;
  let fieldCount = 0;

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const classMatch = trimmed.match(CLASS_DECL_RE);
    if (classMatch) {
      // Check previous class
      if (inClass && methodCount <= 3 && delegationCount >= methodCount - 1 && methodCount >= 2) {
        issues.push({
          category: "enterprise-facade",
          file: file.path,
          line: classStartLine,
          code: `class ${className}`,
          description: `Class \`${className}\` in \`${file.path}:${classStartLine}\` is a facade with ${methodCount} method(s), ${delegationCount} delegation(s) — LLMs generate manager/service classes that simply delegate to other objects; remove the indirection layer and call the underlying methods directly`,
          severity: "warning",
        });
      }

      inClass = true;
      className = classMatch[1];
      classStartLine = change.line;
      methodCount = 0;
      delegationCount = 0;
      fieldCount = 0;
      continue;
    }

    if (inClass) {
      // Detect method declarations
      if (/^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(?:static\s+)?(\w+)\s*\(/.test(trimmed) &&
          !/^\s*(?:if|for|while|switch|catch|constructor)\b/.test(trimmed)) {
        methodCount++;
        if (DELEGATION_RE.test(trimmed)) {
          delegationCount++;
        }
      }

      // Detect field declarations (dependency injection)
      if (/^\s*(?:private|protected|public)\s+(?:readonly\s+)?\w+\s*:\s*\w+/.test(trimmed)) {
        fieldCount++;
      }

      // Class ends
      if (trimmed.startsWith("}")) {
        if (methodCount <= 3 && delegationCount >= methodCount - 1 && methodCount >= 2) {
          issues.push({
            category: "enterprise-facade",
            file: file.path,
            line: classStartLine,
            code: `class ${className}`,
            description: `Class \`${className}\` in \`${file.path}:${classStartLine}\` is a facade with ${methodCount} method(s), ${delegationCount} delegation(s) — LLMs generate manager/service classes that simply delegate to other objects; remove the indirection layer and call the underlying methods directly`,
            severity: "warning",
          });
        }
        inClass = false;
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: interface-for-single-impl
// ---------------------------------------------------------------------------

function detectInterfaceForSingleImpl(diffFiles: DiffFile[]): CargoCultIssue[] {
  const issues: CargoCultIssue[] = [];

  // Collect all interface names defined in the diff
  const interfaceNames: Map<string, { file: string; line: number; code: string }> = new Map();
  // Collect all "implements" references
  const implementsMap: Map<string, { file: string; line: number; code: string; className: string }[]> = new Map();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      const ifaceMatch = trimmed.match(INTERFACE_DECL_RE);
      if (ifaceMatch) {
        interfaceNames.set(ifaceMatch[1], { file: file.path, line: change.line, code: trimmed });
      }

      const implMatch = trimmed.match(IMPLEMENTS_RE);
      if (implMatch) {
        const classMatch = trimmed.match(CLASS_DECL_RE);
        const className = classMatch?.[1] || "unknown";
        const ifaceNames = implMatch[1].split(",").map((s) => s.trim());
        for (const iface of ifaceNames) {
          if (!implementsMap.has(iface)) {
            implementsMap.set(iface, []);
          }
          implementsMap.get(iface)!.push({ file: file.path, line: change.line, code: trimmed, className });
        }
      }
    }
  }

  // Flag interfaces with exactly one implementation (unless the interface
  // name is a well-known pattern like Error, Event, etc.)
  const SKIP_IFACE_NAMES = new Set(["Error", "Event", "Options", "Config", "Props", "State", "Result"]);

  for (const [ifaceName, ifaceInfo] of interfaceNames) {
    if (SKIP_IFACE_NAMES.has(ifaceName)) continue;

    const impls = implementsMap.get(ifaceName);
    if (impls && impls.length === 1) {
      issues.push({
        category: "interface-for-single-impl",
        file: ifaceInfo.file,
        line: ifaceInfo.line,
        code: ifaceInfo.code,
        description: `Interface \`${ifaceName}\` in \`${ifaceInfo.file}:${ifaceInfo.line}\` has exactly one implementation (\`${impls[0].className}\` in \`${impls[0].file}:${impls[0].line}\`) — LLMs generate interface-implementation pairs from training data patterns even when there is no polymorphic need; remove the interface and use the concrete class directly unless a second implementation is planned`,
        severity: "warning",
      });
    }
  }

  return issues.slice(0, 5); // Cap to avoid noise
}

// ---------------------------------------------------------------------------
// Detection: deep-inheritance
// ---------------------------------------------------------------------------

function detectDeepInheritance(diffFiles: DiffFile[]): CargoCultIssue[] {
  const issues: CargoCultIssue[] = [];

  // Track extends chains
  const extendsMap: Map<string, { parent: string; file: string; line: number; code: string }> = new Map();

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    const added = getAddedChanges(file);

    for (const change of added) {
      if (SKIP_LINE_RE.test(change.content)) continue;
      const trimmed = stripPrefix(change.content);

      const classMatch = trimmed.match(CLASS_DECL_RE);
      const extendsMatch = trimmed.match(EXTENDS_RE);
      if (classMatch && extendsMatch) {
        extendsMap.set(classMatch[1], { parent: extendsMatch[1], file: file.path, line: change.line, code: trimmed });
      }
    }
  }

  // Walk inheritance chains to find depth >= 3
  for (const [className, info] of extendsMap) {
    let depth = 2; // this class + its direct parent
    let current = info.parent;
    const visited = new Set<string>([className]);

    while (extendsMap.has(current) && !visited.has(current)) {
      visited.add(current);
      depth++;
      current = extendsMap.get(current)!.parent;
    }

    if (depth >= 3) {
      issues.push({
        category: "deep-inheritance",
        file: info.file,
        line: info.line,
        code: info.code,
        description: `Class \`${className}\` in \`${info.file}:${info.line}\` sits in a ${depth}-level inheritance chain — LLMs generate deep class hierarchies from OOP training data; modern patterns favor composition over inheritance; flatten the chain using mixins, composition, or utility functions`,
        severity: "warning",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: singleton-misuse
// ---------------------------------------------------------------------------

function detectSingletonMisuse(file: DiffFile): CargoCultIssue[] {
  const issues: CargoCultIssue[] = [];
  const added = getAddedChanges(file);

  let hasPrivateCtor = false;
  let hasInstancePattern = false;
  let classLine = 0;
  let className = "";

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const classMatch = trimmed.match(CLASS_DECL_RE);
    if (classMatch) {
      // Check previous class
      if (hasPrivateCtor && hasInstancePattern && className) {
        issues.push({
          category: "singleton-misuse",
          file: file.path,
          line: classLine,
          code: `class ${className}`,
          description: `Class \`${className}\` in \`${file.path}:${classLine}\` uses singleton pattern — LLMs apply singleton to stateless services where dependency injection is more appropriate; singletons make testing harder and create hidden global state; use dependency injection instead`,
          severity: "warning",
        });
      }

      className = classMatch[1];
      classLine = change.line;
      hasPrivateCtor = false;
      hasInstancePattern = false;
    }

    if (SINGLETON_PRIVATE_CTOR_RE.test(trimmed)) {
      hasPrivateCtor = true;
    }
    if (SINGLETON_INSTANCE_RE.test(trimmed) || SINGLETON_GET_INSTANCE_RE.test(trimmed)) {
      hasInstancePattern = true;
    }
  }

  // Check last class
  if (hasPrivateCtor && hasInstancePattern && className) {
    issues.push({
      category: "singleton-misuse",
      file: file.path,
      line: classLine,
      code: `class ${className}`,
      description: `Class \`${className}\` in \`${file.path}:${classLine}\` uses singleton pattern — LLMs apply singleton to stateless services where dependency injection is more appropriate; singletons make testing harder and create hidden global state; use dependency injection instead`,
      severity: "warning",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Detection: decorator-stack
// ---------------------------------------------------------------------------

function detectDecoratorStack(file: DiffFile): CargoCultIssue[] {
  const issues: CargoCultIssue[] = [];
  const added = getAddedChanges(file);

  let consecutiveDecorators: { name: string; line: number; code: string }[] = [];

  for (const change of added) {
    if (SKIP_LINE_RE.test(change.content)) continue;
    const trimmed = stripPrefix(change.content);

    const decMatch = trimmed.match(DECORATOR_RE);
    if (decMatch) {
      consecutiveDecorators.push({ name: decMatch[1], line: change.line, code: trimmed });
    } else {
      // Not a decorator line — check accumulated stack
      if (consecutiveDecorators.length >= 3) {
        issues.push({
          category: "decorator-stack",
          file: file.path,
          line: consecutiveDecorators[0].line,
          code: consecutiveDecorators.map((d) => `@${d.name}`).join(" "),
          description: `${consecutiveDecorators.length} decorators stacked in \`${file.path}:${consecutiveDecorators[0].line}\` (${consecutiveDecorators.map((d) => `@${d.name}`).join(", ")}) — LLMs stack decorators from framework training data; evaluate whether each decorator adds domain value or is cargo-cult pattern matching; prefer explicit function calls for complex behavior composition`,
          severity: "warning",
        });
      }
      consecutiveDecorators = [];
    }
  }

  // Check final stack
  if (consecutiveDecorators.length >= 3) {
    issues.push({
      category: "decorator-stack",
      file: file.path,
      line: consecutiveDecorators[0].line,
      code: consecutiveDecorators.map((d) => `@${d.name}`).join(" "),
      description: `${consecutiveDecorators.length} decorators stacked in \`${file.path}:${consecutiveDecorators[0].line}\` (${consecutiveDecorators.map((d) => `@${d.name}`).join(", ")}) — LLMs stack decorators from framework training data; evaluate whether each decorator adds domain value or is cargo-cult pattern matching; prefer explicit function calls for complex behavior composition`,
      severity: "warning",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function dedupIssues(issues: CargoCultIssue[]): CargoCultIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.file}:${issue.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildCargoCultContext(result: CargoCultResult): string {
  if (result.issues.length === 0) return "";

  const critical = result.issues.filter((i) => i.severity === "critical");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  let ctx = `## Cargo-Cult Architecture Detection (${result.issues.length})\n`;
  ctx += "This PR may contain boilerplate patterns from LLM training data rather than domain requirements:\n\n";

  if (critical.length > 0) {
    ctx += "### Critical\n";
    for (const i of critical.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }
  if (warnings.length > 0) {
    ctx += "### Warnings\n";
    for (const i of warnings.slice(0, 10)) {
      ctx += `- ${i.description}\n`;
    }
  }

  return ctx.trim();
}

function buildCargoCultBodySummary(result: CargoCultResult): string {
  if (result.issues.length === 0) return "";

  let body = `<details><summary><strong>Cargo-Cult Architecture Detection</strong> — ${result.issues.length} issue(s)</summary>\n\n`;
  body += "| Category | File | Line | Severity |\n";
  body += "|----------|------|------|----------|\n";

  for (const i of result.issues.slice(0, 15)) {
    const catLabel = i.category.replace(/-/g, " ");
    body += `| ${catLabel} | \`${i.file}\` | ${i.line} | ${i.severity} |\n`;
  }

  if (result.issues.length > 15) {
    body += `| ... | | | ${result.issues.length - 15} more |\n`;
  }

  body += `\n*When LLMs generate code, they reproduce patterns from training data — unnecessary abstraction layers, interfaces with single implementations, deep inheritance chains, and decorator stacks. These add structural complexity without domain value.*\n</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run cargo-cult architecture detection on diff files. Zero LLM cost. */
export function detectCargoCultArchitecture(diffFiles: DiffFile[]): CargoCultResult {
  const allIssues: CargoCultIssue[] = [];

  for (const file of diffFiles) {
    if (file.status === "deleted") continue;
    allIssues.push(...detectEnterpriseFacade(file));
    allIssues.push(...detectSingletonMisuse(file));
    allIssues.push(...detectDecoratorStack(file));
  }

  allIssues.push(...detectInterfaceForSingleImpl(diffFiles));
  allIssues.push(...detectDeepInheritance(diffFiles));

  const issues = dedupIssues(allIssues);

  issues.sort((a, b) => {
    const sv = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sv !== 0) return sv;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });

  const result: CargoCultResult = {
    issues,
    contextText: "",
    bodySummary: "",
  };

  result.contextText = buildCargoCultContext(result);
  result.bodySummary = buildCargoCultBodySummary(result);

  if (issues.length > 0) {
    core.info(`Cargo-cult architecture detection: ${issues.length} issue(s) detected (${issues.filter((i) => i.severity === "critical").length} critical)`);
  }

  return result;
}
