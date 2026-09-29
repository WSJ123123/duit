import { describe, it, expect } from "vitest";
import { shiftMonth, clampMonth } from "@/lib/budget-nav";

describe("shiftMonth", () => {
  it("shifts within a year", () => {
    expect(shiftMonth("2026-08", 1)).toBe("2026-09");
    expect(shiftMonth("2026-08", -1)).toBe("2026-07");
  });
  it("crosses year boundaries", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("clampMonth", () => {
  it("passes through values inside the range", () => {
    expect(clampMonth("2026-06", "2026-01", "2026-09")).toBe("2026-06");
  });
  it("clamps below the minimum", () => {
    expect(clampMonth("2025-12", "2026-01", "2026-09")).toBe("2026-01");
  });
  it("clamps above the maximum", () => {
    expect(clampMonth("2026-11", "2026-01", "2026-09")).toBe("2026-09");
  });
  it("is inclusive at both boundaries", () => {
    expect(clampMonth("2026-01", "2026-01", "2026-09")).toBe("2026-01");
    expect(clampMonth("2026-09", "2026-01", "2026-09")).toBe("2026-09");
  });
});
