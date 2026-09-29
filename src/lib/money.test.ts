import { describe, it, expect } from "vitest";
import { formatSen, formatCcy, parseAmountToSen, parseAmountToE8, assertSen } from "@/lib/money";

describe("formatCcy — currency-aware minor-unit formatting (Task 5)", () => {
  it("MYR delegates to formatSen", () => {
    expect(formatCcy("MYR", 123_456)).toBe(formatSen(123_456));
  });

  it("non-MYR renders the code + grouped amount", () => {
    expect(formatCcy("USD", 123_456)).toBe("USD 1,234.56");
    expect(formatCcy("USD", 5)).toBe("USD 0.05");
  });

  it("negative amounts carry the minus sign", () => {
    expect(formatCcy("USD", -123_456)).toBe("−USD 1,234.56");
  });
});

describe("formatSen", () => {
  it("formats whole ringgit with grouping", () => {
    expect(formatSen(123456)).toBe("RM 1,234.56");
    expect(formatSen(0)).toBe("RM 0.00");
    expect(formatSen(5)).toBe("RM 0.05");
  });
  it("formats negatives with minus sign", () => {
    expect(formatSen(-1250)).toBe("−RM 12.50");
  });
});

describe("parseAmountToSen", () => {
  it("parses plain and decimal amounts", () => {
    expect(parseAmountToSen("12.5")).toBe(1250);
    expect(parseAmountToSen("12.50")).toBe(1250);
    expect(parseAmountToSen("12")).toBe(1200);
    expect(parseAmountToSen("1,234.56")).toBe(123456);
    expect(parseAmountToSen("0")).toBe(0);
  });
  it("rejects garbage", () => {
    expect(parseAmountToSen("12.345")).toBeNull(); // 3 decimals
    expect(parseAmountToSen("")).toBeNull();
    expect(parseAmountToSen("abc")).toBeNull();
    expect(parseAmountToSen("-5")).toBeNull(); // sign handled by type, not amount
    expect(parseAmountToSen("1e3")).toBeNull();
  });
  it("null-propagates fee-shaped input instead of rounding — the trade form's submit gate relies on it (Task-4 review fix)", () => {
    // TradeSheet.submit(): a NON-EMPTY fees entry that parses null must
    // surface "Enter a valid fees amount." — never silently record 0¢ into
    // cost basis / realized P/L. Pre-ruling-13 this input rounded to 51¢;
    // now it is null, and null on non-empty input must block the submit.
    expect(parseAmountToSen("0.505")).toBeNull(); // sub-sen precision
    expect(parseAmountToSen("0.50")).toBe(50); // valid fee unchanged
    // An EMPTY fees field is the "no fee" case: it also parses null, and the
    // form maps that to 0 (buildInput's ?? 0) with no error — the whitespace
    // trim in the gate keeps "  " equivalent to "".
    expect(parseAmountToSen("")).toBeNull();
    expect(parseAmountToSen("  ")).toBeNull();
  });
});

describe("parseAmountToE8 (ruling 13 — parseAmountToSen semantics at e8 precision)", () => {
  it("parses quantities and unit prices exactly", () => {
    expect(parseAmountToE8("139.75")).toBe(13_975_000_000);
    expect(parseAmountToE8("16.2")).toBe(1_620_000_000);
    expect(parseAmountToE8("3")).toBe(300_000_000);
    expect(parseAmountToE8("0.00000001")).toBe(1);
    expect(parseAmountToE8("1,234.5")).toBe(123_450_000_000);
    expect(parseAmountToE8("0")).toBe(0);
  });
  it("rejects what parseAmountToSen rejects: signs, exponents, bare dots, overlong fractions", () => {
    expect(parseAmountToE8("1.234567891")).toBeNull(); // 9 decimals
    expect(parseAmountToE8("-5")).toBeNull();
    expect(parseAmountToE8("1e3")).toBeNull();
    expect(parseAmountToE8(".5")).toBeNull();
    expect(parseAmountToE8(".")).toBeNull();
    expect(parseAmountToE8("")).toBeNull();
    expect(parseAmountToE8("abc")).toBeNull();
  });
  it("returns null instead of an unsafe integer", () => {
    // 90,071,993 × 1e8 > Number.MAX_SAFE_INTEGER; one less ×1e8 is safe.
    expect(parseAmountToE8("90,071,993")).toBeNull();
    expect(parseAmountToE8("90,071,992")).toBe(9_007_199_200_000_000);
  });
});

describe("assertSen", () => {
  it("accepts non-negative safe integers", () => {
    expect(() => assertSen(0)).not.toThrow();
    expect(() => assertSen(123)).not.toThrow();
  });
  it("throws on floats, negatives, unsafe", () => {
    expect(() => assertSen(1.5)).toThrow();
    expect(() => assertSen(-1)).toThrow();
    expect(() => assertSen(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
