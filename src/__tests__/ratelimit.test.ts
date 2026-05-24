import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter, DEFAULT_RATE_LIMITS, createRateLimiter } from "../ratelimit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests immediately when tokens available", async () => {
    const limiter = new RateLimiter({ rpm: 10, rps: 5 });
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(1);
  });

  it("allows burst up to max tokens", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 3 });
    // Should allow 3 immediate requests (RPS bucket has 3 tokens)
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(3);
  });

  it("waits when RPS bucket is depleted", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 1 });
    // Use up the initial token
    await limiter.acquire();

    // Next request should wait ~1000ms for refill
    const acquirePromise = limiter.acquire();
    // Advance time by 1000ms to trigger refill
    vi.advanceTimersByTime(1100);
    await acquirePromise;
    expect(limiter.getRequestCount()).toBe(2);
  });

  it("skips rate limiting when both rpm and rps are 0", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 0 });
    // Should allow many requests immediately
    for (let i = 0; i < 100; i++) {
      await limiter.acquire();
    }
    expect(limiter.getRequestCount()).toBe(100);
  });

  it("only RPS limit when RPM is 0", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 2 });
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(2);
  });

  it("only RPM limit when RPS is 0", async () => {
    const limiter = new RateLimiter({ rpm: 5, rps: 0 });
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    expect(limiter.getRequestCount()).toBe(5);
  });

  it("counts total requests", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 0 });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(3);
  });
});

describe("DEFAULT_RATE_LIMITS", () => {
  it("has limits for all 7 providers", () => {
    const providers = ["anthropic", "openai", "google", "openrouter", "nvidia", "local", "custom"];
    for (const p of providers) {
      expect(DEFAULT_RATE_LIMITS[p]).toBeDefined();
      expect(DEFAULT_RATE_LIMITS[p].rpm).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_RATE_LIMITS[p].rps).toBeGreaterThanOrEqual(0);
    }
  });

  it("local provider has no limits by default", () => {
    expect(DEFAULT_RATE_LIMITS.local.rpm).toBe(0);
    expect(DEFAULT_RATE_LIMITS.local.rps).toBe(0);
  });

  it("nvidia has lower limits than other providers", () => {
    expect(DEFAULT_RATE_LIMITS.nvidia.rpm).toBeLessThan(DEFAULT_RATE_LIMITS.openai.rpm);
  });
});

describe("createRateLimiter", () => {
  it("uses provider defaults when no input overrides", () => {
    // Without action inputs, falls back to defaults
    const limiter = createRateLimiter("anthropic");
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it("returns unlimited limiter for unknown provider", () => {
    const limiter = createRateLimiter("unknown");
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it("anthropic has RPS of 5", () => {
    expect(DEFAULT_RATE_LIMITS.anthropic.rps).toBe(5);
  });

  it("all non-local providers have non-zero RPM", () => {
    const nonLocal = Object.entries(DEFAULT_RATE_LIMITS).filter(([k]) => k !== "local");
    for (const [, config] of nonLocal) {
      expect(config.rpm).toBeGreaterThan(0);
    }
  });
});
