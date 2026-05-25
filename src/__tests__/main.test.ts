import { describe, it, expect } from "vitest";
import { parseCommand } from "../describe.js";

// getPrNumber logic extracted for testability — mirrors src/main.ts
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

  it("returns null for empty payload", () => {
    expect(getPrNumber({})).toBeNull();
  });

  it("returns null when pull_request.number is 0 (falsy — no valid PR)", () => {
    expect(getPrNumber({ pull_request: { number: 0 } })).toBeNull();
  });

  it("handles /mizumi describe command on PR issue_comment", () => {
    expect(getPrNumber({
      issue: { number: 7, pull_request: {} },
      comment: { body: "/mizumi describe" },
    })).toBe(7);
  });

  it("handles /mizumi improve command on PR issue_comment", () => {
    expect(getPrNumber({
      issue: { number: 13, pull_request: {} },
      comment: { body: "/mizumi improve" },
    })).toBe(13);
  });

  it("returns null for /mizumi on non-PR issue", () => {
    expect(getPrNumber({
      issue: { number: 5 },
      comment: { body: "/mizumi review" },
    })).toBeNull();
  });

  it("returns null when comment body is missing", () => {
    expect(getPrNumber({
      issue: { number: 5, pull_request: {} },
    })).toBeNull();
  });

  it("handles /mizumi test command on PR issue_comment", () => {
    expect(getPrNumber({
      issue: { number: 21, pull_request: {} },
      comment: { body: "/mizumi test" },
    })).toBe(21);
  });

  it("handles /mizumi spend command on PR issue_comment", () => {
    expect(getPrNumber({
      issue: { number: 33, pull_request: {} },
      comment: { body: "/mizumi spend" },
    })).toBe(33);
  });

  it("handles /mizumi with additional text after command", () => {
    expect(getPrNumber({
      issue: { number: 55, pull_request: {} },
      comment: { body: "/mizumi review focus on security" },
    })).toBe(55);
  });

  it("matches /mizumicommand as it starts with /mizumi", () => {
    // The startsWith check is loose — "/mizumicommand" starts with "/mizumi"
    expect(getPrNumber({
      issue: { number: 55, pull_request: {} },
      comment: { body: "/mizumicommand" },
    })).toBe(55);
  });

  it("returns null when pull_request is present but has no number", () => {
    expect(getPrNumber({ pull_request: { sha: "abc" } })).toBeNull();
  });

  it("handles negative PR number (should still return it)", () => {
    // Negative PR numbers don't exist in GitHub, but the function
    // doesn't validate — it just returns the number
    expect(getPrNumber({ pull_request: { number: -1 } })).toBe(-1);
  });

  it("handles large PR numbers", () => {
    expect(getPrNumber({ pull_request: { number: 999999 } })).toBe(999999);
  });

  it("returns null for non-string comment body", () => {
    expect(getPrNumber({
      issue: { number: 5, pull_request: {} },
      comment: { body: 12345 },
    })).toBeNull();
  });

  it("returns undefined when issue has no number", () => {
    expect(getPrNumber({
      issue: { pull_request: {} },
      comment: { body: "/mizumi review" },
    })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseCommand — verify /mizumi subcommand parsing (imported from describe.ts)
// ---------------------------------------------------------------------------

describe("parseCommand for /mizumi review", () => {
  it("parses /mizumi review with custom instructions", () => {
    const result = parseCommand("/mizumi review focus on security");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("review");
    expect(result!.args).toBe("focus on security");
  });

  it("parses /mizumi review without instructions", () => {
    const result = parseCommand("/mizumi review");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("review");
    expect(result!.args).toBe("");
  });

  it("parses /mizumi review with multi-word instructions", () => {
    const result = parseCommand("/mizumi review check for SQL injection and XSS in API handlers");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("review");
    expect(result!.args).toBe("check for SQL injection and XSS in API handlers");
  });

  it("parses /mizumi describe command", () => {
    const result = parseCommand("/mizumi describe");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("describe");
    expect(result!.args).toBe("");
  });

  it("parses /mizumi improve command", () => {
    const result = parseCommand("/mizumi improve");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("improve");
  });

  it("parses /mizumi test command", () => {
    const result = parseCommand("/mizumi test");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("test");
  });

  it("parses /mizumi spend command", () => {
    const result = parseCommand("/mizumi spend");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("spend");
  });

  it("returns null for non-mizumi commands", () => {
    expect(parseCommand("/review please")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCommand("")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(parseCommand("just a regular comment")).toBeNull();
  });

  it("returns null for /mizumi without subcommand", () => {
    expect(parseCommand("/mizumi")).toBeNull();
  });

  it("parses /mizumi calibrate command", () => {
    const result = parseCommand("/mizumi calibrate");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("calibrate");
  });

  it("parses /mizumi labels command", () => {
    const result = parseCommand("/mizumi labels");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("labels");
  });

  it("returns object for /mizumi with unknown subcommand", () => {
    // parseCommand accepts any subcommand — no validation
    const result = parseCommand("/mizumi deploy");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("deploy");
  });

  it("handles /mizumi with trailing whitespace", () => {
    const result = parseCommand("/mizumi review  ");
    expect(result).not.toBeNull();
    expect(result!.command).toBe("review");
  });

  it("is case-sensitive for /mizumi prefix", () => {
    expect(parseCommand("/Mizumi review")).toBeNull();
  });

  it("returns null for /MIZUMI (uppercase)", () => {
    expect(parseCommand("/MIZUMI review")).toBeNull();
  });

  it("preserves args with special characters", () => {
    const result = parseCommand("/mizumi review check API /v2/users?ids=1,2,3");
    expect(result).not.toBeNull();
    expect(result!.args).toContain("/v2/users?ids=1,2,3");
  });
});

// ---------------------------------------------------------------------------
// Pipeline step order — verify the main.ts step constants exist
// ---------------------------------------------------------------------------

describe("pipeline step constants", () => {
  it("main.ts exports are importable without error", async () => {
    // This is a smoke test — just verifying the module structure is valid
    const mod = await import("../main.js");
    expect(typeof mod).toBe("object");
  });
});
