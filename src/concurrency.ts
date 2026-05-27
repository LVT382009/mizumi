/**
 * Concurrency & Race Condition Analysis — deterministic pre-scan for
 * concurrency hazards in PR diffs.
 *
 * Competitive gap: No AI code reviewer detects concurrency issues.
 * Every tool flags SQL injection and XSS, but NONE reason about shared
 * mutable state, lock ordering, async timing, or event loop blocking.
 * These bugs are the hardest to debug (non-deterministic, rare repro) and
 * the most dangerous in production (data corruption, security bypasses).
 *
 * This module detects 5 classes of concurrency hazards from diff content:
 * 1. Shared mutable state without synchronization (global Set/Map/Array mutations)
 * 2. Async/await race patterns (check-then-act without locks)
 * 3. Event loop blocking (synchronous I/O in async functions)
 * 4. Callback/promise error swallowing (missing error handlers)
 * 5. Lock ordering violations (nested locks in inconsistent order)
 *
 * Heuristic, not complete — operates only on diff hunks. Zero LLM cost.
 */
import * as core from "@actions/core";
import { DiffFile } from "./diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConcurrencyHazardKind =
  | "shared-mutable-state"
  | "check-then-act"
  | "event-loop-block"
  | "error-swallowed"
  | "lock-ordering";

export interface ConcurrencyHazard {
  kind: ConcurrencyHazardKind;
  file: string;
  line: number;
  variable?: string;
  message: string;
  confidence: number;
  evidence: string;
}

export interface ConcurrencyAnalysisResult {
  hazards: ConcurrencyHazard[];
  fileCount: number;
  hunkCount: number;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

interface DiffLine {
  type: string;
  content: string;
  targetLine: number | null;
}

const SHARED_STATE_PATTERNS = [
  { pattern: /\b(const|let|var)\s+(\w+)\s*=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/, confidence: 85 },
  { pattern: /\b(const|let|var)\s+(\w+)\s*=\s*\[\]/, confidence: 60 },
  { pattern: /\b(const|let|var)\s+(\w+)\s*=\s*\{.*\}/, confidence: 40 },
  { pattern: /\b(let|var)\s+(\w+)\s*=\s*\d+/, confidence: 35 },
  { pattern: /^(\w+)\s*=\s*\{.*\}/, confidence: 50 },
  { pattern: /^(\w+)\s*=\s*\[.*\]/, confidence: 55 },
  { pattern: /\bvar\s+(\w+)\s*=\s*make\s*\(\s*map/, confidence: 75 },
  { pattern: /\bvar\s+(\w+)\s+map\b/, confidence: 75 },
  { pattern: /\bstatic\s+mut\s+(\w+)\s*:/, confidence: 80 },
  { pattern: /\bprivate\s+static\s+\w+(?:<[^>]+>\s*)?\s+(\w+)\s*=\s*new\s+\w+/, confidence: 70 },
];

const MUTATION_PATTERNS = [
  { pattern: /\b(\w+)\.(push|pop|shift|unshift|splice|sort|reverse)\s*\(/, confidence: 70, desc: "Array mutation" },
  { pattern: /\b(\w+)\.(set|delete|clear)\s*\(/, confidence: 75, desc: "Map/Set mutation" },
  { pattern: /\b(\w+)\s*(\+\+|\-\-|\+=|-=)/, confidence: 65, desc: "Counter mutation" },
];

const BLOCKING_PATTERNS = [
  { pattern: /\bfs\.(readFileSync|writeFileSync|appendFileSync|copyFileSync|readdirSync|statSync|existsSync|mkdirSync|rmSync|unlinkSync|accessSync|chmodSync|chownSync)\s*\(/, confidence: 90, desc: "Synchronous filesystem call in async context" },
  { pattern: /\brequire\s*\(/, confidence: 30, desc: "Synchronous require() in async context" },
  { pattern: /\bexecSync|spawnSync|execFileSync\b/, confidence: 85, desc: "Synchronous child process in async context" },
  { pattern: /\bcrypto\.(pbkdf2Sync|scryptSync|generateKeyPairSync)\s*\(/, confidence: 80, desc: "Synchronous crypto in async context" },
  { pattern: /\bzlib\.(deflateSync|inflateSync|gunzipSync|gzipSync)\s*\(/, confidence: 80, desc: "Synchronous zlib in async context" },
];

const ERROR_SWALLOW_INLINE = [
  { pattern: /\.catch\(\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\)/, confidence: 90, desc: "Empty .catch() handler" },
  { pattern: /\.catch\(\s*\(\s*\)\s*=>\s*null\s*\)/, confidence: 85, desc: ".catch(() => null) swallows error" },
  { pattern: /\.catch\(\s*\(\s*\)\s*=>\s*undefined\s*\)/, confidence: 85, desc: ".catch(() => undefined) swallows error" },
  { pattern: /catch\s*\(\s*\w+\s*\)\s*\{\s*\/\/\s*ignor/i, confidence: 70, desc: "Catch block with only 'ignore' comment" },
];

const LOCK_ACQUIRE = /\b(await\s+)?(\w+)\.(acquire|lock|wait|enter|take)\s*\(/;
const LOCK_MUTEX = /\bmutex\.(lock|acquire)\s*\(/;
const LOCK_SEMAPHORE = /\bsemaphore\.(acquire|wait)\s*\(/;
const LOCK_WITH = /\bwithLock\s*\(/;
const LOCK_RELEASE = /\.(release|unlock)\s*\(/;

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cpp", ".h", ".hpp", ".cs",
]);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeConcurrency(files: DiffFile[]): ConcurrencyAnalysisResult {
  const hazards: ConcurrencyHazard[] = [];
  let hunkCount = 0;

  for (const file of files) {
    if (!isCodeFile(file.path)) continue;

    const allLines: DiffLine[] = file.hunks.flatMap((h) =>
      h.changes.map((c) => ({ type: c.type, content: c.content, targetLine: c.line }))
    );
    const added = allLines.filter((l) => l.type === "add");
    hunkCount += file.hunks.length;

    // Phase 1: Shared mutable state declarations
    const globalVars = new Set<string>();
    for (const line of added) {
      for (const pat of SHARED_STATE_PATTERNS) {
        const m = pat.pattern.exec(line.content);
        if (m) {
          const varName = m[2] || m[1];
          const collType = m[3] || "collection";
          if (varName) {
            globalVars.add(varName);
            if (pat.confidence >= 50) {
              hazards.push({
                kind: "shared-mutable-state", file: file.path,
                line: line.targetLine ?? 0, variable: varName,
                message: `Declares module-level mutable state: \`${varName}\` (${collType}). In concurrent environments, this creates shared mutable state without synchronization.`,
                confidence: pat.confidence, evidence: line.content.trim(),
              });
            }
          }
        }
      }
    }

    // Phase 2: Async context tracking
    const asyncLines = new Set<number>();
    let inAsync = false;
    let depth = 0;
    for (const line of added) {
      const ln = line.targetLine ?? 0;
      if (/async\s+(function|\(|[a-z])/.test(line.content) || /=>\s*async/.test(line.content)) {
        inAsync = true;
        depth = 0;
      }
      depth += (line.content.match(/\{/g) || []).length;
      depth -= (line.content.match(/\}/g) || []).length;
      if (inAsync) asyncLines.add(ln);
      if (inAsync && depth <= 0 && /\}/.test(line.content)) inAsync = false;
    }

    // Phase 2-5: Scan each added line
    for (let idx = 0; idx < added.length; idx++) {
      const line = added[idx];
      const ln = line.targetLine ?? 0;
      const isAsync = asyncLines.has(ln);

      // Phase 2b: Mutations of shared state
      for (const pat of MUTATION_PATTERNS) {
        const m = pat.pattern.exec(line.content);
        if (m) {
          const varName = m[1];
          if (globalVars.has(varName) || (isAsync && isLikelyShared(varName, added))) {
            hazards.push({
              kind: "shared-mutable-state", file: file.path, line: ln, variable: varName,
              message: `${pat.desc} on \`${varName}\` in ${isAsync ? "async" : "synchronous"} context. ${globalVars.has(varName) ? "Module-level state is inherently shared." : "Variable may be shared across concurrent operations."}`,
              confidence: globalVars.has(varName) ? 80 : pat.confidence - 10,
              evidence: line.content.trim(),
            });
          }
        }
      }

      // Phase 3: TOCTOU — check on this line, action in window
      if (isAsync) {
        const ifMatch = /\bif\s*\(\s*!(\w+)\s*\)/.exec(line.content)
          || /\bif\s*\(\s*!?(\w+)\.(has|includes|contains|exists)\s*\(/.exec(line.content)
          || /\bif\s*\(\s*(\w+)(?:\.(length|size))?\s*[<>!=]+\s*\d+\s*\)/.exec(line.content);
        if (ifMatch) {
          const varName = ifMatch[1];
          const window = added.slice(idx + 1, idx + 6).map((l) => l.content).join(" ");
          if (varName && window.includes(varName)) {
            hazards.push({
              kind: "check-then-act", file: file.path, line: ln,
              message: "TOCTOU race: condition check followed by action in async code. The condition can change between check and action.",
              confidence: 80, evidence: line.content.trim(),
            });
          }
        }
      }

      // Phase 4: Event loop blocking
      if (isAsync) {
        for (const pat of BLOCKING_PATTERNS) {
          if (pat.pattern.test(line.content)) {
            hazards.push({
              kind: "event-loop-block", file: file.path, line: ln,
              message: pat.desc + ". This blocks the event loop and starves other async operations.",
              confidence: pat.confidence, evidence: line.content.trim(),
            });
          }
        }
      }

      // Phase 5: Error swallowing — inline patterns
      for (const pat of ERROR_SWALLOW_INLINE) {
        if (pat.pattern.test(line.content)) {
          hazards.push({
            kind: "error-swallowed", file: file.path, line: ln,
            message: pat.desc + ". Swallowed errors hide concurrency failures (deadlock, timeout, race).",
            confidence: pat.confidence, evidence: line.content.trim(),
          });
        }
      }
      // Phase 5b: Multi-line empty catch block
      if (/\bcatch\s*\(\s*\w*\s*\)\s*\{/.test(line.content)) {
        // Inline empty: catch (e) {} on one line
        if (/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(line.content)) {
          hazards.push({
            kind: "error-swallowed", file: file.path, line: ln,
            message: "Empty catch block. Swallowed errors hide concurrency failures (deadlock, timeout, race).",
            confidence: 85, evidence: line.content.trim(),
          });
        } else {
          // Multi-line: catch (e) { on this line, } on next
          const afterCatch = line.content.replace(/^.*catch\s*\(\s*\w*\s*\)\s*\{/, "").trim();
          const next = added.slice(idx + 1, idx + 3);
          const blockContent = [afterCatch, ...next.map((l) => l.content.trim())].filter((c) => c && !/^\}\s*;?\s*$/.test(c));
          const hasClose = afterCatch.includes("}") || next.some((l) => /^\s*\}\s*;?\s*$/.test(l.content));
          if (hasClose && blockContent.length === 0) {
            hazards.push({
              kind: "error-swallowed", file: file.path, line: ln,
              message: "Empty catch block. Swallowed errors hide concurrency failures (deadlock, timeout, race).",
              confidence: 85, evidence: line.content.trim(),
            });
          }
      // Multi-line catch with only "ignore" comment
      const windowContent = [afterCatch, ...next.map((l) => l.content.trim())].filter((c) => c && !/^\s*\}\s*;?\s*$/.test(c));
      const onlyIgnore = windowContent.length === 1 && /\/\/\s*ignor/i.test(windowContent[0]);
      if (onlyIgnore) {
        hazards.push({
          kind: "error-swallowed", file: file.path, line: ln,
          message: "Catch block with only 'ignore' comment. Swallowed errors hide concurrency failures.",
          confidence: 70, evidence: line.content.trim(),
        });
      }
        }
      }
    }

    // Phase 6: Lock ordering
    const sequences = extractLockSequences(added);
    if (sequences.length >= 2) {
      hazards.push(...detectLockOrdering(sequences, file.path));
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = hazards.filter((h) => {
    const key = `${h.kind}:${h.file}:${h.line}:${h.variable || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  core.info(`Concurrency analysis: ${unique.length} hazards across ${files.length} files (${hunkCount} hunks)`);
  return {
    hazards: unique.sort((a, b) => b.confidence - a.confidence),
    fileCount: files.length,
    hunkCount,
  };
}

export function buildConcurrencyContext(result: ConcurrencyAnalysisResult): string {
  if (result.hazards.length === 0) return "";
  const high = result.hazards.filter((h) => h.confidence >= 70);
  if (high.length === 0) return "";

  let ctx = "### Concurrency Hazards Detected\n\n";
  ctx += "The following potential concurrency issues were found in this diff. Verify whether these are actual race conditions:\n\n";
  for (const h of high.slice(0, 10)) {
    ctx += `- **[${h.kind}]** ${h.file}:${h.line} — ${h.message} (confidence: ${h.confidence}%)\n`;
    ctx += `  \`${h.evidence}\`\n`;
  }
  if (high.length > 10) ctx += `\n...and ${high.length - 10} more.\n`;
  return ctx;
}

export function formatConcurrencySummary(result: ConcurrencyAnalysisResult): string {
  if (result.hazards.length === 0) return "";

  const byKind = groupBy(result.hazards, (h) => h.kind);
  let text = "<details>\n<summary>Concurrency Analysis</summary>\n\n";
  text += `| Type | Count |\n|------|-------|\n`;
  for (const [kind, list] of Object.entries(byKind)) {
    text += `| ${kind} | ${list.length} |\n`;
  }

  const high = result.hazards.filter((h) => h.confidence >= 70);
  if (high.length > 0) {
    text += `\n### High-Confidence Hazards\n\n`;
    for (const h of high) {
      text += `- [${h.confidence}%] **${h.kind}** ${h.file}:${h.line} — ${h.message}\n`;
    }
  }
  text += `\n</details>`;
  return text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCodeFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return CODE_EXTENSIONS.has(filePath.slice(dot));
}

function isLikelyShared(varName: string, lines: DiffLine[]): boolean {
  const usages = lines.filter((l) => l.content.includes(varName));
  const hasConcurrent = usages.some((l) => /\bawait\b/.test(l.content)) ||
    usages.some((l) => /\.then\s*\(/.test(l.content));
  return usages.length >= 2 && hasConcurrent;
}

interface LockSequence { locks: string[]; line: number; }

function extractLockSequences(lines: DiffLine[]): LockSequence[] {
  const sequences: LockSequence[] = [];
  let current: string[] = [];
  let curLine = 0;

  for (const line of lines) {
    const ln = line.targetLine ?? 0;
    for (const pat of [LOCK_ACQUIRE, LOCK_MUTEX, LOCK_SEMAPHORE, LOCK_WITH]) {
      const m = pat.exec(line.content);
      if (m) {
        const name = m[2] || m[0].replace(/\(.*$/, "");
        if (current.length === 0) curLine = ln;
        current.push(name);
      }
    }
    if (LOCK_RELEASE.test(line.content) && current.length > 0) {
      if (current.length >= 2) sequences.push({ locks: [...current], line: curLine });
      current = current.slice(0, -1);
    }
  }
  if (current.length >= 2) sequences.push({ locks: [...current], line: curLine });
  return sequences;
}

function detectLockOrdering(seqs: LockSequence[], filePath: string): ConcurrencyHazard[] {
  const results: ConcurrencyHazard[] = [];
  for (let i = 0; i < seqs.length; i++) {
    for (let j = i + 1; j < seqs.length; j++) {
      const common = seqs[i].locks.filter((l) => seqs[j].locks.includes(l));
      if (common.length >= 2) {
        for (let k = 0; k < common.length - 1; k++) {
          const a = seqs[i].locks.indexOf(common[k]) < seqs[i].locks.indexOf(common[k + 1]);
          const b = seqs[j].locks.indexOf(common[k]) < seqs[j].locks.indexOf(common[k + 1]);
          if (a !== b) {
            results.push({
              kind: "lock-ordering", file: filePath, line: seqs[j].line,
              variable: `${common[k]},${common[k + 1]}`,
              message: `Lock ordering violation: \`${common[k]}\` and \`${common[k + 1]}\` acquired in different order. This can cause deadlock.`,
              confidence: 75,
              evidence: `Path A: ${seqs[i].locks.join(" → ")} | Path B: ${seqs[j].locks.join(" → ")}`,
            });
            break;
          }
        }
      }
    }
  }
  return results;
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}
