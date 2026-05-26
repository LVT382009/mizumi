/**
 * Review Thread Continuity — competitive gap #2.
 *
 * When authors reply to review comments (e.g., "intentional", "will fix later",
 * "disagree — see design doc"), the next review iteration should know about those
 * replies and not re-raise already-dismissed issues. This is distinct from finding
 * lifecycle (which tracks fingerprint persistence) — thread continuity reads
 * actual human replies from GitHub review threads.
 *
 * No other AI code reviewer reads prior review thread conversations. CodeRabbit
 * and Sourcery treat each push as a fresh review; CodeGuru has no threadawareness.
 * Human reviewers naturally read prior threads before commenting; AI should too.
 *
 * Implementation:
 * 1. Fetch existing review comments on the PR (with replies)
 * 2. Identify threads where the author replied (dismissed or acknowledged)
 * 3. Build a "dismissal context" map: file+line → author reply content
 * 4. Inject into the LLM prompt so it avoids re-raising dismissed issues
 * 5. Add thread continuity summary to the review body
 *
 * This depends on GitHub API access (listReviewComments + listComments on pull),
 * not on the local filesystem store.
 */
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadReply {
  /** File path the reply is on */
  file: string;
  /** Line number */
  line: number;
  /** Original review comment body (truncated) */
  originalComment: string;
  /** Author reply body */
  replyBody: string;
  /** Reply author login */
  replyAuthor: string;
  /** Whether this looks like a dismissal */
  isDismissal: boolean;
  /** Dismissal category */
  dismissalKind: DismissalKind | null;
}

export type DismissalKind =
  | "intentional"     // "this is intentional", "by design"
  | "will-fix-later"  // "will fix in a follow-up", "tracked in #123"
  | "disagree"        // "I disagree", "not applicable"
  | "already-known"   // "known issue", "legacy code"
  | "false-positive"  // "false positive", "n/a here"
  | "other";          // Unrecognized dismissal

export interface ThreadContinuityResult {
  /** Threads with author replies */
  threadReplies: ThreadReply[];
  /** Count of dismissal-style replies */
  dismissalCount: number;
  /** Context text for LLM prompt injection */
  contextText: string;
  /** Review body summary */
  bodySummary: string;
}

// ---------------------------------------------------------------------------
// Dismissal detection
// ---------------------------------------------------------------------------

const DISMISSAL_PATTERNS: Array<{ re: RegExp; kind: DismissalKind }> = [
  { re: /\b(intentional|by design|on purpose|expected behavior|working as intended)\b/i, kind: "intentional" },
  { re: /\b(will fix|follow.?up|later|next pr|tracked in|JIRA|ticket|issue #)\b/i, kind: "will-fix-later" },
  { re: /\b(disagree|not applicable|doesn't apply|not relevant|not needed|unnecessary)\b/i, kind: "disagree" },
  { re: /\b(known issue|legacy|existing|already known|historical)\b/i, kind: "already-known" },
  { re: /\b(false positive|won't fix|not a bug|not an issue|n\/a)\b/i, kind: "false-positive" },
];

/**
 * Classify a reply as a dismissal and determine its kind.
 */
export function classifyDismissal(replyBody: string): { isDismissal: boolean; kind: DismissalKind | null } {
  for (const pattern of DISMISSAL_PATTERNS) {
    if (pattern.re.test(replyBody)) {
      return { isDismissal: true, kind: pattern.kind };
    }
  }
  return { isDismissal: false, kind: null };
}

// ---------------------------------------------------------------------------
// Thread reading from GitHub API
// ---------------------------------------------------------------------------

const MIZUMI_MARKER = "<!-- mizumi-review-marker -->";
const MAX_ORIGINAL_LENGTH = 100;
const MAX_THREADS = 15;

/**
 * Fetch review threads with author replies from GitHub.
 * Only reads Mizumi's own review comments (identified by marker).
 */
export async function fetchReviewThreadReplies(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthor: string,
): Promise<ThreadReply[]> {
  const replies: ThreadReply[] = [];

  try {
    // Fetch all review comments on the PR
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner, repo, pull_number: prNumber, per_page: 100,
    });

    // Group by (path, line) to find threads
    const threadsByLocation = new Map<string, Array<{
      id: number;
      body: string;
      author: string;
      inReplyToId?: number;
      path?: string;
      line?: number;
    }>>();

    for (const comment of comments) {
      const key = `${comment.path || ""}:${comment.line || 0}`;
      if (!threadsByLocation.has(key)) {
        threadsByLocation.set(key, []);
      }
      threadsByLocation.get(key)!.push({
        id: comment.id,
        body: comment.body || "",
        author: comment.user?.login || "",
        inReplyToId: comment.in_reply_to_id ?? undefined,
        path: comment.path,
        line: comment.line,
      });
    }

    // Find threads where the PR author replied to a Mizumi comment
    for (const [, threadComments] of threadsByLocation) {
      // Find the root Mizumi comment
      const rootComment = threadComments.find(c =>
        !c.inReplyToId && c.body.includes(MIZUMI_MARKER)
      );
      if (!rootComment) continue;

      // Find author replies in this thread
      const authorReplies = threadComments.filter(c =>
        c.inReplyToId === rootComment.id && c.author === prAuthor
      );

      for (const reply of authorReplies) {
        const dismissal = classifyDismissal(reply.body);

        replies.push({
          file: rootComment.path || "unknown",
          line: rootComment.line || 0,
          originalComment: rootComment.body
            .replace(/<!--[\s\S]*?-->/g, "").trim()
            .substring(0, MAX_ORIGINAL_LENGTH),
          replyBody: reply.body.trim(),
          replyAuthor: reply.author,
          isDismissal: dismissal.isDismissal,
          dismissalKind: dismissal.kind,
        });

        if (replies.length >= MAX_THREADS) break;
      }

      if (replies.length >= MAX_THREADS) break;
    }
  } catch (e) {
    // Non-critical — thread continuity is best-effort
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("rate limit") && !msg.includes("404")) {
      // Don't warn on rate limits or missing resources
    }
  }

  return replies;
}

// ---------------------------------------------------------------------------
// Context generation
// ---------------------------------------------------------------------------

function buildThreadContext(replies: ThreadReply[]): string {
  const dismissals = replies.filter(r => r.isDismissal);
  if (dismissals.length === 0) return "";

  let ctx = `## Author Dismissals from Previous Review Thread\n`;
  ctx += "The PR author dismissed the following review comments in the previous iteration. ";
  ctx += "Do NOT re-raise these same issues unless you have new information:\n\n";

  for (const r of dismissals.slice(0, 10)) {
    const kind = r.dismissalKind ?? "other";
    ctx += `- \`${r.file}:${r.line}\` — author says: **${kind}** ("${r.replyBody.substring(0, 80)}")\n`;
  }

  if (dismissals.length > 10) {
    ctx += `\n... and ${dismissals.length - 10} more dismissed findings.\n`;
  }

  return ctx.trim() + "\n";
}

function buildThreadBodySummary(replies: ThreadReply[]): string {
  const dismissals = replies.filter(r => r.isDismissal);
  if (dismissals.length === 0 && replies.length === 0) return "";

  let body = `<details><summary><strong>Thread Continuity</strong> — ${replies.length} author ${replies.length === 1 ? "reply" : "replies"}</summary>\n\n`;

  if (dismissals.length > 0) {
    body += `| Location | Dismissal | Author Reply |\n|----------|-----------|-------------|\n`;
    for (const r of dismissals.slice(0, 10)) {
      const kind = r.dismissalKind ?? "other";
      body += `| \`${r.file}:${r.line}\` | ${kind} | ${r.replyBody.substring(0, 60)} |\n`;
    }
    body += "\n";
  }

  if (replies.length > dismissals.length) {
    body += `**${replies.length - dismissals.length} non-dismissal author ${replies.length - dismissals.length === 1 ? "reply" : "replies"}** (acknowledged or discussed).\n\n`;
  }

  body += `</details>\n`;
  return body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze review thread continuity for a PR.
 * Reads author replies to prior Mizumi review comments.
 */
export async function analyzeThreadContinuity(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthor: string,
): Promise<ThreadContinuityResult> {
  const threadReplies = await fetchReviewThreadReplies(octokit, owner, repo, prNumber, prAuthor);
  const dismissalCount = threadReplies.filter(r => r.isDismissal).length;

  return {
    threadReplies,
    dismissalCount,
    contextText: buildThreadContext(threadReplies),
    bodySummary: buildThreadBodySummary(threadReplies),
  };
}
