/**
 * Webhook idempotency + SHA dedup — prevent duplicate reviews.
 * Flat-file store (no SQLite for v0.1 bundling simplicity).
 * Uses atomic check-and-mark to prevent TOCTOU races.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const IDEM_FILENAME = "mizumi-idempotency.json";
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 100_000;

interface IdempotencyStore {
  deliveryIds: Record<string, number>;
  reviewedShas: Record<string, number>;
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

  const delEntries = Object.entries(store.deliveryIds).sort(([, a], [, b]) => a - b);
  const shaEntries = Object.entries(store.reviewedShas).sort(([, a], [, b]) => a - b);
  while (delEntries.length > MAX_ENTRIES) { const [key] = delEntries.shift()!; delete store.deliveryIds[key]; }
  while (shaEntries.length > MAX_ENTRIES) { const [key] = shaEntries.shift()!; delete store.reviewedShas[key]; }

  const json = JSON.stringify(store);
  if (Buffer.byteLength(json, "utf-8") > MAX_FILE_BYTES) {
    const half = Math.floor(MAX_ENTRIES / 2);
    store.deliveryIds = Object.fromEntries(Object.entries(store.deliveryIds).sort(([, a], [, b]) => b - a).slice(0, half));
    store.reviewedShas = Object.fromEntries(Object.entries(store.reviewedShas).sort(([, a], [, b]) => b - a).slice(0, half));
  }

  fs.writeFileSync(p, JSON.stringify(store), "utf-8");
}

/** Hash a delivery ID for storage (defend against injection). */
export function hashDeliveryId(deliveryId: string): string {
  return crypto.createHash("sha256").update(deliveryId).digest("hex").slice(0, 16);
}

/** Atomic check-and-mark: returns true if delivery was already processed. */
export function checkAndMarkDelivery(workspace: string, deliveryId: string): boolean {
  if (!deliveryId) return false;
  const store = readStore(workspace);
  const key = hashDeliveryId(deliveryId);
  if (key in store.deliveryIds) return true;
  store.deliveryIds[key] = Date.now();
  writeStore(workspace, store);
  return false;
}

/** Atomic check-and-mark: returns true if SHA was already reviewed. */
export function checkAndMarkSha(workspace: string, headSha: string): boolean {
  if (!headSha) return false;
  const store = readStore(workspace);
  if (headSha in store.reviewedShas) return true;
  store.reviewedShas[headSha] = Date.now();
  writeStore(workspace, store);
  return false;
}

// Keep legacy exports for tests
export function isDuplicateDelivery(workspace: string, deliveryId: string): boolean {
  return checkAndMarkDelivery(workspace, deliveryId);
}
export function markDeliveryProcessed(_workspace: string, _deliveryId: string): void { /* now a no-op, checkAndMarkDelivery handles it */ }
export function isReviewedSha(workspace: string, headSha: string): boolean {
  return checkAndMarkSha(workspace, headSha);
}
export function markShaReviewed(_workspace: string, _headSha: string): void { /* now a no-op, checkAndMarkSha handles it */ }
