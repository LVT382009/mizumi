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
});
