import { describe, it, expect, vi } from "vitest";
import { confidenceBadge } from "../calibrate.js";

vi.mock("@actions/core", () => ({
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  notice: vi.fn(),
}));

describe("confidenceBadge", () => {
  it("returns green badge for high confidence", () => {
    expect(confidenceBadge("high")).toContain("green");
  });

  it("returns yellow badge for medium confidence", () => {
    expect(confidenceBadge("medium")).toContain("yellow");
  });

  it("returns gray badge for low confidence", () => {
    expect(confidenceBadge("low")).toContain("lightgray");
  });
});
