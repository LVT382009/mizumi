import { describe, it, expect } from "vitest";
import { parseCommand } from "../describe.js";

describe("parseCommand", () => {
  it("parses /mizumi describe", () => {
    const result = parseCommand("/mizumi describe");
    expect(result).toEqual({ command: "describe", args: "" });
  });

  it("parses /mizumi review with instructions", () => {
    const result = parseCommand("/mizumi review focus on security");
    expect(result).toEqual({ command: "review", args: "focus on security" });
  });

  it("returns null for non-mizumi commands", () => {
    expect(parseCommand("/other command")).toBeNull();
  });

  it("returns null for plain text", () => {
    expect(parseCommand("just a comment")).toBeNull();
  });

  it("parses /mizumi improve", () => {
    const result = parseCommand("/mizumi improve");
    expect(result?.command).toBe("improve");
  });

  it("parses /mizumi spend", () => {
    const result = parseCommand("/mizumi spend");
    expect(result?.command).toBe("spend");
  });
});
