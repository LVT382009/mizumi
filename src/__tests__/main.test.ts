import { describe, it, expect } from "vitest";

// getPrNumber logic extracted for testability
function getPrNumber(payload: Record<string, unknown>): number | null {
  if ((payload.pull_request as Record<string, unknown>)?.number) {
    return (payload.pull_request as Record<string, unknown>).number as number;
  }
  if ((payload.issue as Record<string, unknown>)?.pull_request) {
    const body = (payload.comment as Record<string, unknown>)?.body || "";
    if (typeof body === "string" && body.startsWith("/mizumi")) {
      return payload.issue?.number as number;
    }
  }
  return null;
}

describe("getPrNumber", () => {
  it("extracts PR number from pull_request event", () => {
    expect(getPrNumber({ pull_request: { number: 42 } })).toBe(42);
  });

  it("extracts from issue_comment with /mizumi command", () => {
    expect(getPrNumber({
      issue: { number: 99, pull_request: {} },
      comment: { body: "/mizumi review" },
    })).toBe(99);
  });

  it("returns null for non-mizumi comments on issues", () => {
    expect(getPrNumber({
      issue: { number: 99, pull_request: {} },
      comment: { body: "Nice code!" },
    })).toBeNull();
  });

  it("returns null when no PR context exists", () => {
    expect(getPrNumber({})).toBeNull();
  });

  it("returns null for regular issue comments without pull_request", () => {
    expect(getPrNumber({
      issue: { number: 10 },
      comment: { body: "/mizumi review" },
    })).toBeNull();
  });
});
