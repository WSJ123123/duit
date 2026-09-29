import { describe, it, expect } from "vitest";
import { safeEqual } from "@/lib/safe-equal";

describe("safeEqual", () => {
  it("matches equal strings", () => expect(safeEqual("abc123", "abc123")).toBe(true));
  it("rejects different strings of same length", () => expect(safeEqual("abc123", "abc124")).toBe(false));
  it("rejects different lengths without throwing", () => expect(safeEqual("short", "longer-string")).toBe(false));
  it("handles empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "x")).toBe(false);
  });
});
