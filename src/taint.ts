/**
 * Security Dependency Graph — Taint-style data flow analysis for diffs.
 *
 * Competitive gap: No AI code reviewer traces how input data flows from
 * PR changes to security-sensitive sinks (SQL, auth, crypto, exec, etc).
 * Current tools flag sinks in isolation — they miss whether user input
 * actually reaches them, causing both false positives (flagging sanitized
 * paths) and false negatives (missing multi-hop taint chains).
 *
 * This module performs lightweight, diff-scoped taint tracking:
 * 1. Identify "source" variables (req.params, req.body, process.argv, etc.)
 * 2. Track variable assignments and function call data flow within hunks
 * 3. When a tracked variable reaches a "sink" call, generate a taint trace
 * 4. The trace is injected into the LLM review context as evidence
 *
 * Not a full static analysis — operates only on diff content. Zero LLM cost.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaintSource {
  /** Variable name that received untrusted input */
  variable: string;
  /** The source pattern (e.g., "req.params", "process.argv") */
  sourceType: string;
  /** File and line where the source was found */
  file: string;
  line: number;
}

export interface TaintSink {
  /** The dangerous function/method being called */
  sinkFunction: string;
  /** Category of the sink (sql, exec, xss, etc.) */
  category: "sql" | "exec" | "xss" | "crypto" | "file" | "auth" | "network";
  /** File and line where the sink was found */
  file: string;
  line: number;
}

export interface TaintTrace {
  /** The untrusted source */
  source: TaintSource;
  /** The dangerous sink */
  sink: TaintSink;
  /** Variables in the data flow path */
  flowPath: string[];
  /** Severity of this trace (high = direct flow, medium = indirect) */
  severity: "high" | "medium";
}

export interface TaintResult {
  traces: TaintTrace[];
  sourceCount: number;
  sinkCount: number;
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const SOURCE_PATTERNS: Array<{ re: RegExp; type: string; varGroup: number }> = [
  // Express/HTTP request sources
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*req\.(?:params|body|query|headers|cookies)\b/, type: "http-request", varGroup: 1 },
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*request\.(?:params|body|query|headers)\b/, type: "http-request", varGroup: 1 },
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*ctx\.(?:params|request|query)\b/, type: "http-request", varGroup: 1 },
  // Process/environment sources
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*process\.argv\b/, type: "cli-input", varGroup: 1 },
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*process\.env\./, type: "env-variable", varGroup: 1 },
  // Event sources
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*event\.(?:data|body|payload|value)\b/, type: "event-input", varGroup: 1 },
  // URL/search params
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*(?:new\s+)?URLSearchParams/, type: "url-params", varGroup: 1 },
  // File read (content from external files)
  { re: /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:fs|filesystem)\.\w*[Rr]ead/, type: "file-input", varGroup: 1 },
  // Destructured request params — const { id } = req.params
  { re: /(?:const|let|var)\s+\{\s*(\w+)\s*\}\s*=\s*req\.(?:params|body|query)/, type: "http-request", varGroup: 1 },
];

const SINK_PATTERNS: Array<{ re: RegExp; category: TaintSink["category"]; func: string }> = [
  // SQL sinks
  { re: /(?:query|execute|raw|sql)\s*\(/, category: "sql", func: "query" },
  { re: /\.query\s*\(/, category: "sql", func: "db.query" },
  { re: /knex.*\.raw\s*\(/, category: "sql", func: "knex.raw" },
  // Command execution sinks
  { re: /(?:exec|execSync|spawn|execFile)\s*\(/, category: "exec", func: "exec" },
  { re: /child_process\./, category: "exec", func: "child_process" },
  // XSS sinks
  { re: /\.innerHTML\s*=/, category: "xss", func: "innerHTML" },
  { re: /\.outerHTML\s*=/, category: "xss", func: "outerHTML" },
  { re: /document\.write\s*\(/, category: "xss", func: "document.write" },
  // Crypto sinks (data used as key material)
  { re: /create(?:Hash|Cipher|Decipher|Sign|Verify)\s*\(/, category: "crypto", func: "crypto" },
  { re: /createSecretKey\s*\(/, category: "crypto", func: "createSecretKey" },
  // File write sinks
  { re: /(?:writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/, category: "file", func: "writeFile" },
  { re: /\.createWriteStream\s*\(/, category: "file", func: "createWriteStream" },
  // Auth sinks
  { re: /(?:verify|check|validate)(?:Token|Jwt|JWT|Session)\s*\(/, category: "auth", func: "verifyToken" },
  { re: /jwt\.\w+\s*\(/, category: "auth", func: "jwt" },
  // Network sinks
  { re: /fetch\s*\(/, category: "network", func: "fetch" },
  { re: /(?:axios|http|https)\.\w+\s*\(/, category: "network", func: "httpClient" },
];

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Find taint sources (untrusted input entry points) in the diff.
 */
export function findSources(files: DiffFile[]): TaintSource[] {
  const sources: TaintSource[] = [];

  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;
        const line = change.content;

        for (const pattern of SOURCE_PATTERNS) {
          const match = line.match(pattern.re);
          if (match) {
            sources.push({
              variable: match[pattern.varGroup],
              sourceType: pattern.type,
              file: file.path,
              line: change.line,
            });
          }
        }
      }
    }
  }

  return sources;
}

/**
 * Find security sinks (dangerous function calls) in the diff.
 */
export function findSinks(files: DiffFile[]): TaintSink[] {
  const sinks: TaintSink[] = [];

  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;
        const line = change.content;

        for (const pattern of SINK_PATTERNS) {
          if (pattern.re.test(line)) {
            sinks.push({
              sinkFunction: pattern.func,
              category: pattern.category,
              file: file.path,
              line: change.line,
            });
          }
        }
      }
    }
  }

  return sinks;
}

/**
 * Trace data flow from sources to sinks within diff hunks.
 * Tracks variable assignments and function call arguments.
 */
export function traceTaintFlow(files: DiffFile[], sources: TaintSource[], sinks: TaintSink[]): TaintTrace[] {
  if (sources.length === 0 || sinks.length === 0) return [];

  const traces: TaintTrace[] = [];
  const traced = new Set<string>(); // dedup key: "srcVar:sinkFile:sinkLine"

  // Build a map of tracked variables per file → their original source
  const trackedVars = new Map<string, Set<string>>();
  const varToSource = new Map<string, Map<string, TaintSource>>(); // file → varName → TaintSource
  for (const src of sources) {
    const key = src.file;
    if (!trackedVars.has(key)) trackedVars.set(key, new Set());
    trackedVars.get(key)!.add(src.variable);
    if (!varToSource.has(key)) varToSource.set(key, new Map());
    varToSource.get(key)!.set(src.variable, src);
  }

  // Track variable aliasing within hunks and detect sink hits
  for (const file of files) {
    const fileTracked = trackedVars.get(file.path);
    const fileSourceMap = varToSource.get(file.path);
    if (!fileTracked) continue;

    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;
        const line = change.content;

        // Detect aliasing: const y = x or const y = x.something
        for (const varName of [...fileTracked]) {
          // Match: const/let/var newVar = oldVar or oldVar.prop or end-of-line
          const aliasRe = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${escapeRegex(varName)}(?:[\\s.\\[]|$)`);
          const aliasMatch = line.match(aliasRe);
          if (aliasMatch) {
            const aliasName = aliasMatch[1];
            // Don't alias a variable to itself
            if (aliasName !== varName) {
              fileTracked.add(aliasName);
              // Propagate the original source to the alias
              const origSource = fileSourceMap!.get(varName);
              if (origSource) fileSourceMap!.set(aliasName, origSource);
            }
          }

          // Match: function call passing tracked var as arg
          const callRe = new RegExp(`(?:\\w+\\.)?\\w+\\s*\\(.*${escapeRegex(varName)}.*\\)`);
          if (callRe.test(line)) {
            // Check if this line contains a sink
            for (const sink of sinks) {
              if (sink.file !== file.path || sink.line !== change.line) continue;
              const src = fileSourceMap!.get(varName);
              if (!src) continue;
              const dedupKey = `${src.variable}:${sink.file}:${sink.line}`;
              if (traced.has(dedupKey)) continue;
              traced.add(dedupKey);
              traces.push({
                source: src,
                sink,
                flowPath: [varName],
                severity: "high",
              });
            }
          }
        }
      }
    }
  }

  // Also check direct source-to-sink in same line (covers inline cases)
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type !== "add") continue;
        const line = change.content;

        for (const src of sources) {
          if (src.file !== file.path) continue;
          if (!line.includes(src.variable)) continue;

          for (const sink of sinks) {
            if (sink.file !== file.path || sink.line !== change.line) continue;
            const dedupKey = `${src.variable}:${sink.file}:${sink.line}`;
            if (traced.has(dedupKey)) continue;
            traced.add(dedupKey);
            traces.push({
              source: src,
              sink,
              flowPath: [src.variable],
              severity: "high",
            });
          }
        }
      }
    }
  }

  // Cross-file traces: source in one file, sink in another with matching variable names
  for (const src of sources) {
    for (const sink of sinks) {
      if (src.file === sink.file) continue;

      const dedupKey = `${src.variable}:${sink.file}:${sink.line}`;
      if (traced.has(dedupKey)) continue;

      // Check if the source variable name appears in any sink file's hunk
      for (const file of files) {
        if (file.path !== sink.file) continue;
        for (const hunk of file.hunks) {
          for (const change of hunk.changes) {
            if (change.type !== "add") continue;
            if (change.content.includes(src.variable)) {
              traced.add(dedupKey);
              traces.push({
                source: src,
                sink,
                flowPath: [src.variable],
                severity: "medium",
              });
            }
          }
        }
      }
    }
  }

  return traces;
}

/**
 * Run the full taint analysis pipeline on the diff files.
 */
export function runTaintAnalysis(files: DiffFile[]): TaintResult {
  const sources = findSources(files);
  const sinks = findSinks(files);
  const traces = traceTaintFlow(files, sources, sinks);

  if (traces.length > 0) {
    core.info(`Taint analysis: ${sources.length} source(s), ${sinks.length} sink(s), ${traces.length} trace(s)`);
  }

  return { traces, sourceCount: sources.length, sinkCount: sinks.length };
}

/**
 * Build review context from taint traces.
 * Produces a prompt section with evidence chains for the LLM.
 */
export function buildTaintContext(result: TaintResult): string {
  if (result.traces.length === 0) return "";

  let context = `## Security Data Flow Analysis (${result.traces.length} trace(s))\n`;
  context += "The following data flow traces show untrusted input reaching security-sensitive operations. Prioritize findings along these traces.\n\n";

  for (const trace of result.traces.slice(0, 8)) {
    const severity = trace.severity === "high" ? "HIGH" : "MEDIUM";
    context += `**[${severity}]** \`${trace.source.variable}\` (${trace.source.sourceType}) at ${trace.source.file}:${trace.source.line} `;
    context += `→ \`${trace.sink.sinkFunction}\` (${trace.sink.category}) at ${trace.sink.file}:${trace.sink.line}\n`;
    if (trace.flowPath.length > 1) {
      context += `  Flow: ${trace.flowPath.join(" → ")}\n`;
    }
  }

  if (result.traces.length > 8) {
    context += `\n... and ${result.traces.length - 8} more trace(s).\n`;
  }

  return context.trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
