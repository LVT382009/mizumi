/**
 * Webhook idempotency + SHA dedup — prevent duplicate reviews.
 * Flat-file store (no SQLite for v0.1 bundling simplicity).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const IDEM_FILENAME = "mizumi-idempotency.json";
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 100_000;

interface IdempotencyStore {
  deliveryIds: Record<string, number>; // delivery_id → timestamp
  reviewedShas: Record<string, number>; // head_sha → timestamp
}

function storePath(workspace: string): string {
  return path.join(workspace, ".github", IDEM_FILENAME);
}

function readStore(workspace: string): IdempotencyStore {
  const p = storePath(workspace);
  if (!fs.existsSync(p)) return { deliveryIds: {}, reviewedShas: {} };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as IdempotencyStore;
  } catch {
    return { deliveryIds: {}, reviewedShas: {} };
  }
}

function writeStore(workspace: string, store: IdempotencyStore): void {
  const p = storePath(workspace);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Prune oldest entries if over limit
  const delEntries = Object.entries(store.deliveryIds).sort(([, a], [, b]) => a - b);
  const shaEntries = Object.entries(store.reviewedShas).sort(([, a], [, b]) => a - b);
  while (delEntries.length > MAX_ENTRIES) {
    const [key] = delEntries.shift()!;
    delete store.deliveryIds[key];
  }
  while (shaEntries.length > MAX_ENTRIES) {
    const [key] = shaEntries.shift()!;
    delete store.reviewedShas[key];
  }

  const json = JSON.stringify(store);
  if (Buffer.byteLength(json, "utf-8") > MAX_FILE_BYTES) {
    // Hard truncation: keep only newer half
    const half = Math.floor(MAX_ENTRIES / 2);
    const delKeep = Object.entries(store.deliveryIds).sort(([, a], [, b]) => b - a).slice(0, half);
    const shaKeep = Object.entries(store.reviewedShas).sort(([, a], [, b]) => b - a).slice(0, half);
    store.deliveryIds = Object.fromEntries(delKeep);
    store.reviewedShas = Object.fromEntries(shaKeep);
  }

  fs.writeFileSync(p, JSON.stringify(store), "utf-8");
}

/** Hash a delivery ID for storage (defend against injection). */
export function hashDeliveryId(deliveryId: string): string {
  return crypto.createHash("sha256").update(deliveryId).digest("hex").slice(0, 16);
}

/** Check if a webhook delivery was already processed. Returns true if duplicate. */
export function isDuplicateDelivery(workspace: string, deliveryId: string): boolean {
  if (!deliveryId) return false;
  const store = readStore(workspace);
  const key = hashDeliveryId(deliveryId);
  return key in store.deliveryIds;
}

/** Mark a webhook delivery as processed. */
export function markDeliveryProcessed(workspace: string, deliveryId: string): void {
  if (!deliveryId) return;
  const store = readStore(workspace);
  store.deliveryIds[hashDeliveryId(deliveryId)] = Date.now();
  writeStore(workspace, store);
}

/** Check if a head_sha was already reviewed. Returns true if duplicate. */
export function isReviewedSha(workspace: string, headSha: string): boolean {
  if (!headSha) return false;
  const store = readStore(workspace);
  return headSha in store.reviewedShas;
}

/** Mark a head_sha as reviewed. */
export function markShaReviewed(workspace: string, headSha: string): void {
  if (!headSha) return;
  const store = readStore(workspace);
  store.reviewedShas[headSha] = Date.now();
  writeStore(workspace, store);
}
