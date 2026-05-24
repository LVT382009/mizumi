import { describe, it, expect } from "vitest";
import { sanitizeSearchQuery } from "../agent.js";

describe("sanitizeSearchQuery", () => {
  it("strips repo: operator and its value from query", () => {
    expect(sanitizeSearchQuery("authenticate repo:evil/owner")).toBe("authenticate");
  });

  it("strips user: operator and its value from query", () => {
    expect(sanitizeSearchQuery("login user:attacker")).toBe("login");
  });

  it("strips language: operator and its value from query", () => {
    expect(sanitizeSearchQuery("parse language:python")).toBe("parse");
  });

  it("strips path: operator and its value from query", () => {
    expect(sanitizeSearchQuery("config path:/etc/passwd")).toBe("config");
  });

  it("strips filename: operator and its value from query", () => {
    expect(sanitizeSearchQuery("class filename:/etc/shadow")).toBe("class");
  });

  it("strips multiple operators at once", () => {
    const result = sanitizeSearchQuery("auth repo:evil/user language:go owner:victim");
    expect(result).toBe("auth");
    expect(result).not.toContain("repo:");
    expect(result).not.toContain("owner:");
  });

  it("strips special search modifiers (+, -, ~, *, quotes)", () => {
    expect(sanitizeSearchQuery('+authenticate -deprecated~4 "exact"')).toBe("authenticate deprecated 4 exact");
  });

  it("preserves safe query text", () => {
    expect(sanitizeSearchQuery("authenticate")).toBe("authenticate");
    expect(sanitizeSearchQuery("class UserService")).toBe("class UserService");
  });

  it("truncates long queries to 200 chars", () => {
    const longQuery = "a".repeat(300);
    expect(sanitizeSearchQuery(longQuery)).toHaveLength(200);
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeSearchQuery("hello   world")).toBe("hello world");
  });

  it("strips type: operator and its value", () => {
    expect(sanitizeSearchQuery("search type:pr")).toBe("search");
  });

  it("handles empty query", () => {
    expect(sanitizeSearchQuery("")).toBe("");
  });

  it("returns empty after stripping all operators", () => {
    expect(sanitizeSearchQuery("repo:evil/owner")).toBe("");
  });

  it("is case-insensitive for operators", () => {
    expect(sanitizeSearchQuery("test REPO:evil/owner")).toBe("test");
    expect(sanitizeSearchQuery("test Language:go")).toBe("test");
  });
});
