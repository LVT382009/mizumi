/**
 * Emoji feedback — polls reactions on Mizumi review comments.
 * 👍 / ❤️ = helpful, 👎 / ❌ = unhelpful.
 * Results stored in .github/mizumi-feedback.json for self-learning.
 * Adaptive noise reduction: suppressed patterns from feedback history
 * reduce confidence of repeatedly-dismissed finding types.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

const FEEDBACK_FILENAME = "mizumi-feedback.json";
const MAX_FEEDBACK_ENTRIES = 200;

export interface FeedbackEntry {
  repo: string;
  pr: number;
  commentId: number;
  file: string;
  line: number;
  category: string;
  severity: string;
  messageHash: string;
  outcome: "helpful" | "unhelpful" | "pending";
  createdAt: string;
}

export interface FeedbackStore {
  entries: FeedbackEntry[];
}

/** Hash a message to a short fingerprint for dedup matching. */
export function hashMessage(message: string): string {
  let hash = 0;
  for (let i = 0; i < message.length; i++) {
    const chr = message.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Classify a reaction emoji into helpful/unhelpful/pending. */
export function classifyReaction(emoji: string): "helpful" | "unhelpful" | "pending" {
  if (emoji === "+1" || emoji === "heart") return "helpful";
  if (emoji === "-1" || emoji === "no_entry") return "unhelpful";
  return "pending";
}

/** Read feedback store from disk. Returns empty store if missing. */
export function readFeedbackStore(workspace: string): FeedbackStore {
  const filePath = path.join(workspace, ".github", FEEDBACK_FILENAME);
  if (!fs.existsSync(filePath)) return { entries: [] };

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return { entries: [] };
  }
}

/** Write feedback store to disk, capping at MAX_FEEDBACK_ENTRIES. */
export function writeFeedbackStore(workspace: string, store: FeedbackStore): void {
  const dir = path.join(workspace, ".github");
  const filePath = path.join(dir, FEEDBACK_FILENAME);

  // Cap entries — keep most recent
  if (store.entries.length > MAX_FEEDBACK_ENTRIES) {
    store.entries = store.entries.slice(-MAX_FEEDBACK_ENTRIES);
  }

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
    core.info(`Feedback: wrote ${store.entries.length} entries`);
  } catch (error) {
    core.warning(`Failed to write feedback: ${error}`);
  }
}

/** Poll reactions on a Mizumi review comment. */
export async function pollReactions(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number
): Promise<{ helpful: number; unhelpful: number }> {
  let helpful = 0;
  let unhelpful = 0;

  try {
    const { data: reactions } = await octokit.rest.reactions.listForIssueComment({
      owner,
      repo,
      comment_id: commentId,
    });

    for (const reaction of reactions) {
      const outcome = classifyReaction(reaction.content);
      if (outcome === "helpful") helpful++;
      if (outcome === "unhelpful") unhelpful++;
    }
  } catch {
    // Non-critical — don't fail the review
  }

  return { helpful, unhelpful };
}

/**
 * Record initial feedback entries for a review's findings.
 * Called after posting a review so future reaction polls can update these.
 */
export function recordFindings(
  workspace: string,
  repo: string,
  pr: number,
  findings: Array<{
    commentId?: number;
    file: string;
    line: number;
    category: string;
    severity: string;
    message: string;
  }>
): void {
  const store = readFeedbackStore(workspace);

  for (const f of findings) {
    store.entries.push({
      repo,
      pr,
      commentId: f.commentId ?? 0,
      file: f.file,
      line: f.line,
      category: f.category,
      severity: f.severity,
      messageHash: hashMessage(f.message),
      outcome: "pending",
      createdAt: new Date().toISOString(),
    });
  }

  writeFeedbackStore(workspace, store);
}

/** Compute acceptance rate per category for use in prompt tuning. */
export function categoryAcceptanceRates(
  store: FeedbackStore
): Record<string, { helpful: number; unhelpful: number; rate: number }> {
  const buckets: Record<string, { helpful: number; unhelpful: number }> = {};

  for (const entry of store.entries) {
    if (entry.outcome === "pending") continue;
    if (!buckets[entry.category]) buckets[entry.category] = { helpful: 0, unhelpful: 0 };
    if (entry.outcome === "helpful") buckets[entry.category].helpful++;
    if (entry.outcome === "unhelpful") buckets[entry.category].unhelpful++;
  }

  const result: Record<string, { helpful: number; unhelpful: number; rate: number }> = {};
  for (const [cat, counts] of Object.entries(buckets)) {
    const total = counts.helpful + counts.unhelpful;
    result[cat] = { ...counts, rate: total > 0 ? counts.helpful / total : 0.5 };
  }

  return result;
}

/**
 * Adaptive noise reduction — compute suppressed patterns from feedback history.
 * When a category+severity combo has acceptance rate < 30% with 5+ responses,
 * it's flagged for suppression. Findings matching suppressed patterns get
 * their confidence reduced, making them more likely to fall below threshold.
 * Returns set of "{category}:{severity}" patterns to suppress.
 */
export function computeSuppressedPatterns(store: FeedbackStore): Set<string> {
  const buckets: Record<string, { helpful: number; unhelpful: number }> = {};

  for (const entry of store.entries) {
    if (entry.outcome === "pending") continue;
    const key = `${entry.category}:${entry.severity}`;
    if (!buckets[key]) buckets[key] = { helpful: 0, unhelpful: 0 };
    if (entry.outcome === "helpful") buckets[key].helpful++;
    if (entry.outcome === "unhelpful") buckets[key].unhelpful++;
  }

  const suppressed = new Set<string>();
  for (const [key, counts] of Object.entries(buckets)) {
    const total = counts.helpful + counts.unhelpful;
    if (total < 5) continue;
    const rate = counts.helpful / total;
    if (rate < 0.3) suppressed.add(key);
  }

  return suppressed;
}

/**
 * Apply adaptive noise reduction to findings.
 * Findings matching suppressed patterns have confidence reduced by 25 points.
 * This makes them more likely to fall below the confidence threshold
 * and get filtered out, without hard-deleting them.
 */
export function applyNoiseReduction<T extends { category: string; severity: string; confidence: number }>(
  findings: T[],
  suppressed: Set<string>
): T[] {
  if (suppressed.size === 0) return findings;

  return findings.map((f) => {
    const key = `${f.category}:${f.severity}`;
    if (suppressed.has(key) && f.confidence > 50) {
      return { ...f, confidence: Math.max(50, f.confidence - 25) };
    }
    return f;
  });
}
