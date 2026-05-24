/**
 * Provider rate limiter — token bucket for RPM and RPS.
 *
 * Prevents exceeding provider API rate limits. Configurable per-provider
 * RPM (requests per minute) and RPS (requests per second).
 *
 * Algorithm: token bucket with separate RPM and RPS buckets.
 * - RPS bucket: refills 1 token per (1000/rps)ms
 * - RPM bucket: refills 1 token per (60000/rpm)ms
 *
 * Both buckets must have tokens available for a request to proceed.
 * If depleted, sleeps until the next token is available.
 */
import * as core from "@actions/core";

export interface RateLimitConfig {
  rpm: number; // requests per minute (0 = unlimited)
  rps: number; // requests per second (0 = unlimited)
}

interface Bucket {
  tokens: number;
  maxTokens: number;
  refillIntervalMs: number;
  lastRefill: number;
}

export class RateLimiter {
  private rpmBucket: Bucket | null;
  private rpsBucket: Bucket | null;
  private requestCount = 0;

  constructor(config: RateLimitConfig) {
    if (config.rpm > 0) {
      this.rpmBucket = {
        tokens: config.rpm,
        maxTokens: config.rpm,
        refillIntervalMs: 60000 / config.rpm,
        lastRefill: Date.now(),
      };
    } else {
      this.rpmBucket = null;
    }

    if (config.rps > 0) {
      this.rpsBucket = {
        tokens: config.rps,
        maxTokens: config.rps,
        refillIntervalMs: 1000 / config.rps,
        lastRefill: Date.now(),
      };
    } else {
      this.rpsBucket = null;
    }
  }

  /** Refill tokens based on elapsed time */
  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = Math.floor(elapsed / bucket.refillIntervalMs);
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
      bucket.lastRefill += tokensToAdd * bucket.refillIntervalMs;
    }
  }

  /** Wait for a token to become available in a bucket */
  private async waitForToken(bucket: Bucket, name: string): Promise<void> {
    this.refill(bucket);
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }

    // Calculate wait time for next token
    const elapsed = Date.now() - bucket.lastRefill;
    const waitMs = bucket.refillIntervalMs - elapsed;
    if (waitMs > 0) {
      core.debug(`Rate limit: waiting ${waitMs}ms for ${name} token`);
      await sleep(waitMs);
    }
    this.refill(bucket);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  /** Acquire permission for one request (blocks until available) */
  async acquire(): Promise<void> {
    if (this.rpsBucket) await this.waitForToken(this.rpsBucket, "RPS");
    if (this.rpmBucket) await this.waitForToken(this.rpmBucket, "RPM");
    this.requestCount++;
  }

  /** Get total requests made through this limiter */
  getRequestCount(): number {
    return this.requestCount;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default rate limits per provider (conservative defaults) */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  anthropic: { rpm: 50, rps: 5 },
  openai: { rpm: 60, rps: 5 },
  google: { rpm: 60, rps: 5 },
  openrouter: { rpm: 60, rps: 5 },
  nvidia: { rpm: 30, rps: 3 },
  local: { rpm: 0, rps: 0 },
  custom: { rpm: 60, rps: 5 },
};

/** Create a rate limiter from action inputs + provider defaults */
export function createRateLimiter(provider: string): RateLimiter {
  const defaults = DEFAULT_RATE_LIMITS[provider] || { rpm: 60, rps: 5 };
  const rpm = parseInt(core.getInput("rpm") || "0", 10) || defaults.rpm;
  const rps = parseInt(core.getInput("rps") || "0", 10) || defaults.rps;
  core.info(`Rate limiter: ${provider} — ${rpm} RPM, ${rps} RPS`);
  return new RateLimiter({ rpm, rps });
}
