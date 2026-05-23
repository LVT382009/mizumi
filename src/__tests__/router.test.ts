import { describe, it, expect } from "vitest";
import { classifyDiff } from "../router.js";
import { MizumiConfig } from "../config.js";

const baseConfig: MizumiConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  baseUrl: "",
  profile: "chill",
  maxComments: 15,
  language: "en-US",
  selfCritique: true,
  confidenceThreshold: 80,
  autoReview: true,
  autoPauseAfter: 5,
  excludePatterns: [],
  tierRouting: true,
  smallDiffThreshold: 50,
  securityPaths: ["**/auth/**", "**/crypto/**", "**/sql/**", "**/secret*", "**/password*"],
};

describe("classifyDiff", () => {
  it("returns standard when tier routing is disabled", () => {
    const config = { ...baseConfig, tierRouting: false };
    const result = classifyDiff(10, 1, ["src/app.ts"], config);
    expect(result).toEqual({ tier: "standard", reason: "tier routing disabled" });
  });

  it("returns standard when tier routing is disabled even for security files", () => {
    const config = { ...baseConfig, tierRouting: false };
    const result = classifyDiff(500, 10, ["src/auth/login.ts"], config);
    expect(result.tier).toBe("standard");
  });

  it("returns thorough for security-sensitive auth file", () => {
    const result = classifyDiff(200, 5, ["src/auth/login.ts"], baseConfig);
    expect(result).toEqual({ tier: "thorough", reason: "security-sensitive files detected" });
  });

  it("returns thorough for crypto file", () => {
    const result = classifyDiff(100, 2, ["lib/crypto/hash.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns thorough for sql file", () => {
    const result = classifyDiff(100, 2, ["db/sql/migrations.sql"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns thorough for file matching secret* pattern", () => {
    const result = classifyDiff(50, 1, ["config/secrets.yaml"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns thorough for file matching password* pattern", () => {
    const result = classifyDiff(50, 1, ["src/password-reset.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("prioritizes thorough over light when security file is in a small diff", () => {
    const result = classifyDiff(5, 1, ["src/auth/handler.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("returns light for small diff under threshold with fewer than 3 files", () => {
    const result = classifyDiff(20, 1, ["src/utils.ts"], baseConfig);
    expect(result.tier).toBe("light");
    expect(result.reason).toContain("20 lines");
    expect(result.reason).toContain("1 files");
  });

  it("returns light for small diff with 2 files", () => {
    const result = classifyDiff(30, 2, ["src/a.ts", "src/b.ts"], baseConfig);
    expect(result.tier).toBe("light");
  });

  it("returns standard for small diff with 3+ files even if line count is low", () => {
    const result = classifyDiff(10, 3, ["src/a.ts", "src/b.ts", "src/c.ts"], baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("returns standard for diff at threshold boundary", () => {
    const result = classifyDiff(50, 1, ["src/app.ts"], baseConfig);
    expect(result.tier).toBe("standard");
  });

  it("returns standard for normal-sized diff", () => {
    const result = classifyDiff(200, 4, ["src/app.ts", "src/utils.ts", "lib/helper.ts", "test/app.test.ts"], baseConfig);
    expect(result).toEqual({ tier: "standard", reason: "normal diff" });
  });

  it("respects custom smallDiffThreshold", () => {
    const config = { ...baseConfig, smallDiffThreshold: 100 };
    const result = classifyDiff(80, 1, ["src/app.ts"], config);
    expect(result.tier).toBe("light");
  });

  it("uses default when one security file and one normal file", () => {
    // Security takes precedence
    const result = classifyDiff(100, 2, ["src/app.ts", "src/auth/oauth.ts"], baseConfig);
    expect(result.tier).toBe("thorough");
  });

  it("handles empty file list", () => {
    const result = classifyDiff(0, 0, [], baseConfig);
    expect(result.tier).toBe("light");
  });

  it("handles custom security paths", () => {
    const config = { ...baseConfig, securityPaths: ["**/payment/**"] };
    const result = classifyDiff(100, 2, ["src/payment/charge.ts"], config);
    expect(result.tier).toBe("thorough");
  });

  it("does not match security path when custom paths do not include defaults", () => {
    const config = { ...baseConfig, securityPaths: ["**/payment/**"] };
    const result = classifyDiff(100, 2, ["src/auth/login.ts"], config);
    expect(result.tier).toBe("standard");
  });
});
