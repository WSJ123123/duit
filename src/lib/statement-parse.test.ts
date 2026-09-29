import { describe, it, expect } from "vitest";
import { parseStatementAmountToSen, parseDate } from "@/lib/statement-parse";

/** Plan 8 Task 5's amount and date readers, moved with the seam (Plan 9 Task
 *  4, ruling 8i) — the assertions are byte-identical to import.test.ts's. */

describe("parseStatementAmountToSen", () => {
  it.each([
    ["1,234.56", 123_456],
    ["12.00", 1200],
    ["12", 1200],
    ["0.5", 50],
    ["0", 0],
    ["-12.00", -1200],
    ["+12.00", 1200],
    ["(12.00)", -1200],
    ["RM 12.00", 1200],
    ["RM12.5", 1250],
    ["myr 3", 300],
    ["12.00 DR", -1200],
    ["12.00 cr", 1200],
    ["RM 1,234.56 DR", -123_456],
    ["RM (45.90)", -4590],
    ["  7.25  ", 725],
    ["(0.00)", 0],
    ["-0", 0],
    ["0.00 DR", 0],
  ])("accepts %s → %i", (input, sen) => {
    expect(parseStatementAmountToSen(input)).toBe(sen);
  });

  it.each([
    "12.345",
    "abc",
    "",
    "   ",
    "(-12.00)",
    "-12.00 CR",
    "+12.00 DR",
    "1,23.00",
    ".50",
    "12.",
    "- 12.00",
    "12.00DR",
    "RM",
    "1e3",
  ])("rejects %j", (input) => {
    expect(parseStatementAmountToSen(input)).toBeNull();
  });
});

describe("parseDate", () => {
  it("reads 03/04/2026 per the chosen format, never sniffed", () => {
    expect(parseDate("03/04/2026", "DD/MM/YYYY")).toBe("2026-04-03");
    expect(parseDate("03/04/2026", "MM/DD/YYYY")).toBe("2026-03-04");
  });

  it("reads the other two formats", () => {
    expect(parseDate("2026-04-03", "YYYY-MM-DD")).toBe("2026-04-03");
    expect(parseDate("3 Apr 2026", "D MMM YYYY")).toBe("2026-04-03");
    expect(parseDate("03 APR 2026", "D MMM YYYY")).toBe("2026-04-03");
    expect(parseDate("3 apr 2026", "D MMM YYYY")).toBe("2026-04-03");
    expect(parseDate(" 1/3/2026 ", "DD/MM/YYYY")).toBe("2026-03-01");
  });

  it("rejects impossible calendar dates", () => {
    expect(parseDate("31/02/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDate("2026-02-29", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("29/02/2028", "DD/MM/YYYY")).toBe("2028-02-29");
    expect(parseDate("13/04/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("00/04/2026", "DD/MM/YYYY")).toBeNull();
  });

  it("rejects a string in another format's shape", () => {
    expect(parseDate("2026-04-03", "DD/MM/YYYY")).toBeNull();
    expect(parseDate("03/04/2026", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("2026/04/03", "YYYY-MM-DD")).toBeNull();
    expect(parseDate("3 Foo 2026", "D MMM YYYY")).toBeNull();
    expect(parseDate("3 April 2026", "D MMM YYYY")).toBeNull();
    expect(parseDate("", "DD/MM/YYYY")).toBeNull();
  });
});
