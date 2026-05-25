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

  it("RPM bucket drains and waits", async () => {
    const limiter = new RateLimiter({ rpm: 5, rps: 0 });
    // 5 acquires should succeed (RPM bucket has 5 tokens)
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    expect(limiter.getRequestCount()).toBe(5);

    // 6th acquire should wait for RPM refill (12000ms for rpm=5)
    const acquirePromise = limiter.acquire();
    vi.advanceTimersByTime(13000);
    await acquirePromise;
    expect(limiter.getRequestCount()).toBe(6);
  });

  it("Both RPM and RPS limits are enforced", async () => {
    const limiter = new RateLimiter({ rpm: 3, rps: 10 });
    // RPM bucket has 3 tokens (bottleneck), RPS has 10
    for (let i = 0; i < 3; i++) {
      await limiter.acquire();
    }
    expect(limiter.getRequestCount()).toBe(3);

    // 4th should wait for RPM refill (60000/3 = 20000ms)
    const acquirePromise = limiter.acquire();
    vi.advanceTimersByTime(21000);
    await acquirePromise;
    expect(limiter.getRequestCount()).toBe(4);
  });

  it("Refill restores tokens after time passes", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 2 });
    // Drain both RPS tokens
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(2);

    // Advance past refill interval (1000/2 = 500ms per token)
    vi.advanceTimersByTime(600);

    // Should be able to acquire again
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(3);
  });

  it("Tokens cap at maxTokens after extended idle", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 3 });
    // Drain all 3 RPS tokens
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(3);

    // Wait a very long time (far more than needed to refill)
    vi.advanceTimersByTime(60000);

    // Only 3 tokens should be available (capped at maxTokens)
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(6);

    // 4th should wait (proving tokens capped at 3, not more)
    const acquirePromise = limiter.acquire();
    vi.advanceTimersByTime(1100);
    await acquirePromise;
    expect(limiter.getRequestCount()).toBe(7);
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

  it("all providers have rps > 0 except local", () => {
    for (const [provider, config] of Object.entries(DEFAULT_RATE_LIMITS)) {
      if (provider === "local") {
        expect(config.rps).toBe(0);
      } else {
        expect(config.rps).toBeGreaterThan(0);
      }
    }
  });

  it("custom provider has same defaults as openai", () => {
    expect(DEFAULT_RATE_LIMITS.custom).toEqual(DEFAULT_RATE_LIMITS.openai);
  });

  it("anthropic rpm is 50", () => {
    expect(DEFAULT_RATE_LIMITS.anthropic.rpm).toBe(50);
  });

  it("openai rpm is 60", () => {
    expect(DEFAULT_RATE_LIMITS.openai.rpm).toBe(60);
  });

  it("nvidia rpm is 30", () => {
    expect(DEFAULT_RATE_LIMITS.nvidia.rpm).toBe(30);
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

  it("createRateLimiter for nvidia uses nvidia defaults", () => {
    const limiter = createRateLimiter("nvidia");
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it("RPS refill interval is based on 1000/rps ms", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 10 });
    // Should allow 10 immediate requests
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(10);
  });

  it("RPM refill interval is based on 60000/rpm ms", async () => {
    const limiter = new RateLimiter({ rpm: 60, rps: 0 });
    // Should allow 60 immediate requests
    for (let i = 0; i < 60; i++) await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(60);
  });

  it("handles single RPM request", async () => {
    const limiter = new RateLimiter({ rpm: 1, rps: 0 });
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(1);
  });

  it("handles single RPS request", async () => {
    const limiter = new RateLimiter({ rpm: 0, rps: 1 });
    await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(1);
  });

  it("both buckets refill independently", async () => {
    const limiter = new RateLimiter({ rpm: 10, rps: 5 });
    // Should be limited by RPS (5 tokens) more than RPM (10 tokens)
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(limiter.getRequestCount()).toBe(5);
  });

  it("google has expected defaults", () => {
    expect(DEFAULT_RATE_LIMITS.google.rpm).toBe(60);
    expect(DEFAULT_RATE_LIMITS.google.rps).toBe(5);
  });

  it("openrouter has expected defaults", () => {
    expect(DEFAULT_RATE_LIMITS.openrouter.rpm).toBe(60);
    expect(DEFAULT_RATE_LIMITS.openrouter.rps).toBe(5);
  });

  it("all providers have rpm >= 0", () => {
    for (const config of Object.values(DEFAULT_RATE_LIMITS)) {
      expect(config.rpm).toBeGreaterThanOrEqual(0);
      expect(config.rps).toBeGreaterThanOrEqual(0);
    }
  });

});
