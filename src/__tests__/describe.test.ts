import { describe, it, expect, vi } from "vitest";
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

  it("parses /mizumi test", () => {
    const result = parseCommand("/mizumi test");
    expect(result?.command).toBe("test");
  });

  it("parses /mizumi trigger", () => {
    const result = parseCommand("/mizumi trigger");
    expect(result?.command).toBe("trigger");
  });

  it("handles extra whitespace in args", () => {
    const result = parseCommand("/mizumi review   focus   on   security");
    expect(result?.command).toBe("review");
    expect(result?.args).toBe("focus   on   security");
  });

  it("returns null for /mizumi with no subcommand", () => {
    expect(parseCommand("/mizumi")).toBeNull();
  });

  it("parses /mizumi with numeric args", () => {
    const result = parseCommand("/mizumi review #42");
    expect(result?.args).toBe("#42");
  });
});
