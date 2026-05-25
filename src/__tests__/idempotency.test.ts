import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  hashDeliveryId,
  isDuplicateDelivery,
  markDeliveryProcessed,
  isReviewedSha,
  markShaReviewed,
  checkAndMarkDelivery,
  checkAndMarkSha,
} from "../idempotency.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-idem-"));
  fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("hashDeliveryId", () => {
  it("returns a 16-char hex string", () => {
    const h = hashDeliveryId("abc-123");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    expect(hashDeliveryId("x")).toBe(hashDeliveryId("x"));
  });

  it("different inputs produce different hashes", () => {
    expect(hashDeliveryId("a")).not.toBe(hashDeliveryId("b"));
  });
});

describe("delivery idempotency", () => {
  it("returns false for unseen delivery", () => {
    expect(isDuplicateDelivery(tmpDir, "del-1")).toBe(false);
  });

  it("returns true after first call marks it atomically", () => {
    expect(isDuplicateDelivery(tmpDir, "del-1")).toBe(false);
    expect(isDuplicateDelivery(tmpDir, "del-1")).toBe(true);
  });

  it("returns false for empty delivery id", () => {
    expect(isDuplicateDelivery(tmpDir, "")).toBe(false);
  });

  it("persists across calls", () => {
    isDuplicateDelivery(tmpDir, "del-99");
    // Re-read from file (atomic mark already happened)
    expect(isDuplicateDelivery(tmpDir, "del-99")).toBe(true);
  });
});

describe("SHA dedup", () => {
  it("returns false for unseen SHA", () => {
    expect(isReviewedSha(tmpDir, "abc123")).toBe(false);
  });

  it("returns true after first call marks it atomically", () => {
    expect(isReviewedSha(tmpDir, "abc123")).toBe(false);
    expect(isReviewedSha(tmpDir, "abc123")).toBe(true);
  });

  it("returns false for empty SHA", () => {
    expect(isReviewedSha(tmpDir, "")).toBe(false);
  });

  it("different SHAs are independent", () => {
    isReviewedSha(tmpDir, "sha-a");
    expect(isReviewedSha(tmpDir, "sha-b")).toBe(false);
    expect(isReviewedSha(tmpDir, "sha-a")).toBe(true);
  });

  it("persists SHA dedup to disk", () => {
    isReviewedSha(tmpDir, "abc123");
    // Re-read from file system
    const store = JSON.parse(fs.readFileSync(path.join(tmpDir, ".github", "mizumi-idempotency.json"), "utf-8"));
    expect("abc123" in store.reviewedShas).toBe(true);
  });
});

describe("checkAndMarkDelivery", () => {
  it("returns false for first delivery", () => {
    expect(checkAndMarkDelivery(tmpDir, "delivery-1")).toBe(false);
  });

  it("returns true for duplicate delivery", () => {
    checkAndMarkDelivery(tmpDir, "delivery-1");
    expect(checkAndMarkDelivery(tmpDir, "delivery-1")).toBe(true);
  });

  it("returns false for empty delivery id", () => {
    expect(checkAndMarkDelivery(tmpDir, "")).toBe(false);
  });

  it("different delivery IDs are independent", () => {
    checkAndMarkDelivery(tmpDir, "del-A");
    expect(checkAndMarkDelivery(tmpDir, "del-B")).toBe(false);
    expect(checkAndMarkDelivery(tmpDir, "del-A")).toBe(true);
  });
});

describe("checkAndMarkSha", () => {
  it("returns false for first SHA", () => {
    expect(checkAndMarkSha(tmpDir, "sha111")).toBe(false);
  });

  it("returns true for duplicate SHA", () => {
    checkAndMarkSha(tmpDir, "sha111");
    expect(checkAndMarkSha(tmpDir, "sha111")).toBe(true);
  });

  it("returns false for empty SHA", () => {
    expect(checkAndMarkSha(tmpDir, "")).toBe(false);
  });

  it("different SHAs are independent within checkAndMarkSha", () => {
    checkAndMarkSha(tmpDir, "sha-aaa");
    expect(checkAndMarkSha(tmpDir, "sha-bbb")).toBe(false);
    expect(checkAndMarkSha(tmpDir, "sha-aaa")).toBe(true);
  });

  it("persists SHA to disk via checkAndMarkSha", () => {
    checkAndMarkSha(tmpDir, "sha-disk-check");
    const store = JSON.parse(fs.readFileSync(path.join(tmpDir, ".github", "mizumi-idempotency.json"), "utf-8"));
    expect("sha-disk-check" in store.reviewedShas).toBe(true);
  });
});

describe("hashDeliveryId — additional edge cases", () => {
  it("produces consistent hash for unicode input", () => {
    const h1 = hashDeliveryId(".delivery-日本語");
    const h2 = hashDeliveryId("delivery-日本語");
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h2).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).not.toBe(h2);
  });

  it("produces different hashes for similar inputs", () => {
    expect(hashDeliveryId("del-1")).not.toBe(hashDeliveryId("del-2"));
    expect(hashDeliveryId("abc")).not.toBe(hashDeliveryId("abcd"));
  });

  it("handles very long delivery IDs", () => {
    const longId = "x".repeat(10000);
    const h = hashDeliveryId(longId);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("store persistence and eviction", () => {
  it("stores delivery id with timestamp", () => {
    isDuplicateDelivery(tmpDir, "del-timestamp");
    const store = JSON.parse(fs.readFileSync(path.join(tmpDir, ".github", "mizumi-idempotency.json"), "utf-8"));
    const key = hashDeliveryId("del-timestamp");
    expect(store.deliveryIds[key]).toBeTypeOf("number");
    expect(store.deliveryIds[key]).toBeGreaterThan(0);
  });

  it("stores SHA with timestamp", () => {
    isReviewedSha(tmpDir, "sha-timestamp");
    const store = JSON.parse(fs.readFileSync(path.join(tmpDir, ".github", "mizumi-idempotency.json"), "utf-8"));
    expect(store.reviewedShas["sha-timestamp"]).toBeTypeOf("number");
  });

  it("handles concurrent check-and-mark of different IDs", () => {
    // Simulate rapid sequential marking of different IDs
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(checkAndMarkDelivery(tmpDir, `del-concurrent-${i}`));
    }
    // All first-checks should return false
    expect(results.every((r) => r === false)).toBe(true);
    // Re-checking all should return true
    for (let i = 0; i < 10; i++) {
      expect(checkAndMarkDelivery(tmpDir, `del-concurrent-${i}`)).toBe(true);
    }
  });

  it("handles concurrent check-and-mark of different SHAs", () => {
    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      results.push(checkAndMarkSha(tmpDir, `sha-concurrent-${i}`));
    }
    expect(results.every((r) => r === false)).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(checkAndMarkSha(tmpDir, `sha-concurrent-${i}`)).toBe(true);
    }
  });

  it("creates .github directory if not present", () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizumi-nodir-"));
    try {
      expect(fs.existsSync(path.join(freshDir, ".github"))).toBe(false);
      checkAndMarkDelivery(freshDir, "del-auto-create");
      expect(fs.existsSync(path.join(freshDir, ".github"))).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("survives corrupted store file by resetting", () => {
    // Write garbage to the store file
    fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".github", "mizumi-idempotency.json"),
      "NOT VALID JSON{{{{",
      "utf-8"
    );
    // Should not throw, should treat as empty store
    expect(checkAndMarkDelivery(tmpDir, "del-after-corrupt")).toBe(false);
    // After writing, it should be valid
    const raw = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-idempotency.json"), "utf-8");
    const store = JSON.parse(raw);
    expect(store.deliveryIds).toBeDefined();
    expect(store.reviewedShas).toBeDefined();
  });

  it("evicts oldest entries when store exceeds MAX_ENTRIES", () => {
    // Insert MAX_ENTRIES + 10 delivery IDs
    for (let i = 0; i < 510; i++) {
      checkAndMarkDelivery(tmpDir, `del-evict-${i}`);
    }
    // The store file should still be valid JSON
    const raw = fs.readFileSync(path.join(tmpDir, ".github", "mizumi-idempotency.json"), "utf-8");
    const store = JSON.parse(raw);
    const entryCount = Object.keys(store.deliveryIds).length;
    // Should cap at MAX_ENTRIES (500)
    expect(entryCount).toBeLessThanOrEqual(500);
  });
});

describe("markDeliveryProcessed and markShaReviewed (legacy no-ops)", () => {
  it("markDeliveryProcessed does not throw", () => {
    expect(() => markDeliveryProcessed(tmpDir, "del-noop")).not.toThrow();
  });

  it("markShaReviewed does not throw", () => {
    expect(() => markShaReviewed(tmpDir, "sha-noop")).not.toThrow();
  });
});
