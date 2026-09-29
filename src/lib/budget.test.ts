import { describe, it, expect } from "vitest";
import {
  rollupToParents,
  meterState,
  unassignedSen,
  setAsideSen,
  fundEnvelopeSplit,
  planSplit,
  heroStats,
  expectedIncomeFromRules,
  nextPlanBannerVisible,
  parsePercent,
  type Tag,
} from "@/lib/budget";
import { spendByCategory, type TxLike } from "@/lib/stats";
import type { RecurringSchedule } from "@/lib/recurring";

const CATS = [
  { id: "food", parent_id: null },
  { id: "groceries", parent_id: "food" },
  { id: "eating-out", parent_id: "food" },
  { id: "transport", parent_id: null },
];

describe("rollupToParents", () => {
  it("sums subcategories into their parent; parentless maps to itself; null stays null", () => {
    const spend = new Map<string | null, number>([
      ["groceries", 12_000],
      ["eating-out", 8_000],
      ["food", 500], // spend directly on the parent joins the same bucket
      ["transport", 3_000],
      [null, 700],
    ]);
    const rolled = rollupToParents(spend, CATS);
    expect(rolled.get("food")).toBe(20_500);
    expect(rolled.get("transport")).toBe(3_000);
    expect(rolled.get(null)).toBe(700);
    expect(rolled.has("groceries")).toBe(false);
    expect(rolled.has("eating-out")).toBe(false);
  });

  it("maps a spend key missing from categories to itself", () => {
    const rolled = rollupToParents(new Map([["ghost", 1_000]]), CATS);
    expect(rolled.get("ghost")).toBe(1_000);
  });

  it("integration: transfers contribute nothing to any rolled-up bucket (rule 16)", () => {
    const tx: TxLike[] = [
      { id: "e1", type: "expense", amount_sen: 5_000, expected_back_sen: 0, category_id: "groceries", date: "2026-08-10" },
      { id: "t1", type: "transfer", amount_sen: 100_000, expected_back_sen: 0, category_id: null, date: "2026-08-10" },
      { id: "i1", type: "income", amount_sen: 620_000, expected_back_sen: 0, category_id: "transport", date: "2026-08-11" },
    ];
    const rolled = rollupToParents(spendByCategory(tx, []), CATS);
    expect(rolled.get("food")).toBe(5_000);
    expect(rolled.has(null)).toBe(false); // the transfer never entered the map
    expect(rolled.has("transport")).toBe(false); // income is not spend
    let total = 0;
    for (const v of rolled.values()) total += v;
    expect(total).toBe(5_000);
  });
});

describe("meterState", () => {
  it("pins the exact 85%/100% boundaries with integer sen", () => {
    // allocated 10000: 8499 = 84.99% ok; 8500 = 85% warn; 10000 = 100% warn; 10001 over
    expect(meterState(8_499, 10_000)).toBe("ok");
    expect(meterState(8_500, 10_000)).toBe("warn");
    expect(meterState(10_000, 10_000)).toBe("warn");
    expect(meterState(10_001, 10_000)).toBe("over");
    expect(meterState(0, 10_000)).toBe("ok");
  });

  it("spent against zero allocation is over; 0/0 is ok", () => {
    expect(meterState(1, 0)).toBe("over");
    expect(meterState(0, 0)).toBe("ok");
  });
});

describe("unassignedSen", () => {
  it("is expected − Σ allocations − savings", () => {
    expect(unassignedSen(500_000, [100_000, 200_000], 100_000)).toBe(100_000);
  });
  it("zero when fully allocated", () => {
    expect(unassignedSen(500_000, [400_000], 100_000)).toBe(0);
  });
  it("goes negative when over-allocated", () => {
    expect(unassignedSen(500_000, [450_000, 100_000], 50_000)).toBe(-100_000);
  });
});

describe("setAsideSen", () => {
  it("is income − net expense", () => {
    expect(setAsideSen(620_000, 400_000)).toBe(220_000);
  });
  it("floors at 0 when expenses exceed income", () => {
    expect(setAsideSen(100_000, 150_000)).toBe(0);
  });
});

describe("fundEnvelopeSplit", () => {
  it("sums the funds' contributions and leaves the remainder unassigned", () => {
    expect(fundEnvelopeSplit([40_000, 20_000, 30_000], 120_000)).toEqual({
      planned_sen: 90_000,
      unassigned_sen: 30_000,
    });
  });
  it("floors unassigned at 0 when the funds plan more than the envelope", () => {
    expect(fundEnvelopeSplit([90_000], 50_000)).toEqual({ planned_sen: 90_000, unassigned_sen: 0 });
  });
  it("no funds: the whole envelope is unassigned", () => {
    expect(fundEnvelopeSplit([], 120_000)).toEqual({ planned_sen: 0, unassigned_sen: 120_000 });
  });
  it("unplanned month (envelope 0) still reports what the funds plan", () => {
    expect(fundEnvelopeSplit([40_000], 0)).toEqual({ planned_sen: 40_000, unassigned_sen: 0 });
  });
});

describe("planSplit", () => {
  const row = (allocated_sen: number, tag: Tag) => ({ allocated_sen, tag });

  it("returns integer percents summing to exactly 100 on three equal thirds", () => {
    const out = planSplit([row(10_000, "needs"), row(10_000, "wants")], 10_000);
    expect(out.needs_pct + out.wants_pct + out.savings_pct).toBe(100);
    expect(out).toEqual({ needs_pct: 34, wants_pct: 33, savings_pct: 33 });
  });

  it("handles an awkward split with largest-remainder rounding", () => {
    // 1/6, 2/6, 3/6 of 60000 → 16.67%, 33.33%, 50% → 17/33/50
    const out = planSplit([row(10_000, "needs"), row(20_000, "wants")], 30_000);
    expect(out).toEqual({ needs_pct: 17, wants_pct: 33, savings_pct: 50 });
    expect(out.needs_pct + out.wants_pct + out.savings_pct).toBe(100);
  });

  it("counts savings_sen under savings alongside savings-tagged rows", () => {
    const out = planSplit([row(25_000, "needs"), row(25_000, "savings")], 50_000);
    expect(out).toEqual({ needs_pct: 25, wants_pct: 0, savings_pct: 75 });
  });

  it("returns all zeros for an all-zero plan", () => {
    expect(planSplit([], 0)).toEqual({ needs_pct: 0, wants_pct: 0, savings_pct: 0 });
    expect(planSplit([row(0, "needs"), row(0, "wants")], 0)).toEqual({
      needs_pct: 0,
      wants_pct: 0,
      savings_pct: 0,
    });
  });
});

describe("heroStats", () => {
  it("computes left, zero over, and days_left including today (2026-08-17 → 15)", () => {
    expect(heroStats(500_000, 320_000, "2026-08-17")).toEqual({
      left_sen: 180_000,
      over_sen: 0,
      days_left: 15,
    });
  });

  it("floors left at 0 and reports the raw over-amount when spent exceeds plan", () => {
    expect(heroStats(500_000, 512_345, "2026-08-31")).toEqual({
      left_sen: 0,
      over_sen: 12_345,
      days_left: 1,
    });
  });
});

describe("expectedIncomeFromRules", () => {
  type Rule = { type: string; active: boolean; amount_sen: number } & RecurringSchedule & {
    next_run: string;
  };
  const monthly = (overrides: Partial<Rule> = {}): Rule => ({
    type: "income",
    active: true,
    amount_sen: 620_000,
    freq: "monthly",
    day_of_month: 1,
    weekday: null,
    month_of_year: null,
    next_run: "2026-08-01",
    ...overrides,
  });

  it("counts a monthly salary rule (day 1) exactly once in its month", () => {
    expect(expectedIncomeFromRules([monthly()], "2026-08")).toBe(620_000);
  });

  it("counts only in-month occurrences of a weekly rule whose next_run precedes the month", () => {
    // 2026-07-31 is a Friday; Fridays in Aug 2026: 7, 14, 21, 28 → 4 occurrences
    const weekly = monthly({
      freq: "weekly",
      day_of_month: null,
      weekday: 5,
      amount_sen: 50_000,
      next_run: "2026-07-31",
    });
    expect(expectedIncomeFromRules([weekly], "2026-08")).toBe(200_000);
  });

  it("contributes 0 when next_run is after the month's end", () => {
    expect(expectedIncomeFromRules([monthly({ next_run: "2026-09-01" })], "2026-08")).toBe(0);
  });

  it("ignores inactive and non-income rules", () => {
    const rules = [
      monthly({ active: false }),
      monthly({ type: "expense" }),
      monthly({ type: "transfer" }),
    ];
    expect(expectedIncomeFromRules(rules, "2026-08")).toBe(0);
  });

  it("sums across multiple qualifying rules", () => {
    const rules = [monthly(), monthly({ amount_sen: 100_000, day_of_month: 25, next_run: "2026-08-25" })];
    expect(expectedIncomeFromRules(rules, "2026-08")).toBe(720_000);
  });
});

describe("nextPlanBannerVisible", () => {
  it("is true only in the last 3 days of a 31-day month", () => {
    expect(nextPlanBannerVisible("2026-08-28")).toBe(false);
    expect(nextPlanBannerVisible("2026-08-29")).toBe(true);
    expect(nextPlanBannerVisible("2026-08-30")).toBe(true);
    expect(nextPlanBannerVisible("2026-08-31")).toBe(true);
  });

  it("handles leap-year February (2024: 27–29 true, 26 false)", () => {
    expect(nextPlanBannerVisible("2024-02-26")).toBe(false);
    expect(nextPlanBannerVisible("2024-02-27")).toBe(true);
    expect(nextPlanBannerVisible("2024-02-28")).toBe(true);
    expect(nextPlanBannerVisible("2024-02-29")).toBe(true);
  });

  it("handles non-leap February (2026: 26–28 true, 25 false)", () => {
    expect(nextPlanBannerVisible("2026-02-25")).toBe(false);
    expect(nextPlanBannerVisible("2026-02-26")).toBe(true);
    expect(nextPlanBannerVisible("2026-02-27")).toBe(true);
    expect(nextPlanBannerVisible("2026-02-28")).toBe(true);
  });
});

describe("parsePercent", () => {
  it("accepts whole numbers 0–100", () => {
    expect(parsePercent("0")).toBe(0);
    expect(parsePercent("50")).toBe(50);
    expect(parsePercent("100")).toBe(100);
    expect(parsePercent("  60  ")).toBe(60);
  });

  it("rejects out-of-range, decimal, negative, and non-numeric input", () => {
    expect(parsePercent("101")).toBeNull();
    expect(parsePercent("-5")).toBeNull();
    expect(parsePercent("5.5")).toBeNull();
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("abc")).toBeNull();
  });
});
