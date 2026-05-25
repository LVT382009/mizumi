import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  isDebug: vi.fn(() => false),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

import { loadCodeowners } from "../ownership.js";
import * as fs from "node:fs";

describe("loadCodeowners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("");
  });

  it("loads from .github/CODEOWNERS", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p.toString().endsWith(".github/CODEOWNERS"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("src/ @team");

    const rules = loadCodeowners("/workspace");
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(["@team"]);
  });

  it("tries root CODEOWNERS first", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      p.toString().endsWith("CODEOWNERS") && !p.toString().includes(".github") && !p.toString().includes("docs"),
    );
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("* @all-team");

    const rules = loadCodeowners("/workspace");
    expect(rules[0].owners).toEqual(["@all-team"]);
  });

  it("returns empty array when no CODEOWNERS file exists", () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const rules = loadCodeowners("/workspace");
    expect(rules).toHaveLength(0);
  });

  it("continues to next path when read fails", () => {
    let callCount = 0;
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("Permission denied");
      return "src/ @fallback-team";
    });

    loadCodeowners("/workspace");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
