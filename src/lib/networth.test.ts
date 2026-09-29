import { describe, it, expect } from "vitest";
import {
  businessStats,
  netWorthTotal,
  latestValues,
  deltaVsPrevMonth,
  chartSeries,
  accountsTotalMyrSen,
} from "@/lib/networth";

describe("accountsTotalMyrSen — Task 5 conversion-aware accounts part", () => {
  const rates = new Map([["USDMYR", 442_000_000]]);

  it("identity: an all-MYR book sums unchanged", () => {
    const r = accountsTotalMyrSen(
      [
        { balance_sen: 10_000, currency: "MYR" },
        { balance_sen: -2_500, currency: "MYR" },
      ],
      new Map(),
    );
    expect(r).toEqual({ total_sen: 7_500, missing_currencies: [] });
  });

  it("converts non-MYR balances at the <CUR>MYR rate (half-up, BigInt path)", () => {
    const r = accountsTotalMyrSen(
      [
        { balance_sen: 10_000, currency: "MYR" },
        { balance_sen: 10_000, currency: "USD" }, // USD 100 × 4.42 → 44_200
      ],
      rates,
    );
    expect(r).toEqual({ total_sen: 54_200, missing_currencies: [] });
  });

  it("EXCLUDES a never-fetched currency from the total and names it (honest gap)", () => {
    const r = accountsTotalMyrSen(
      [
        { balance_sen: 10_000, currency: "MYR" },
        { balance_sen: 7_777, currency: "ZZQ" }, // no rate row yet
        { balance_sen: 5_555, currency: "ZZQ" }, // same currency named once
      ],
      rates,
    );
    expect(r).toEqual({ total_sen: 10_000, missing_currencies: ["ZZQ"] });
  });
});

describe("netWorthTotal", () => {
  it("adds accounts, holdings, business, manual assets and subtracts liabilities", () => {
    const parts = netWorthTotal({
      accounts_sen: 100_00,
      holdings_sen: 200_00,
      business_sen: 300_00,
      manual_assets_sen: 50_00,
      liabilities_sen: 120_00,
    });
    expect(parts.total_sen).toBe(530_00);
    // parts pass through unchanged
    expect(parts.accounts_sen).toBe(100_00);
    expect(parts.liabilities_sen).toBe(120_00);
  });

  it("can go negative when liabilities exceed assets", () => {
    const parts = netWorthTotal({
      accounts_sen: 10_00,
      holdings_sen: 0,
      business_sen: 0,
      manual_assets_sen: 0,
      liabilities_sen: 25_00,
    });
    expect(parts.total_sen).toBe(-15_00);
  });
});

describe("businessStats", () => {
  it("returns all zeros on an empty ledger", () => {
    expect(businessStats([])).toEqual({
      invested_sen: 0,
      returned_sen: 0,
      value_sen: 0,
    });
  });

  it("defaults value to sum of contributions when no valuation was ever recorded", () => {
    const stats = businessStats([
      { kind: "contribution", amount_sen: 100_000_00, date: "2077-01-01", created_at: "2077-01-01T00:00:00Z" },
      { kind: "contribution", amount_sen: 50_000_00, date: "2077-03-01", created_at: "2077-03-01T00:00:00Z" },
    ]);
    expect(stats).toEqual({
      invested_sen: 150_000_00,
      returned_sen: 0,
      value_sen: 150_000_00,
    });
  });

  it("returns never reduce value or invested", () => {
    const stats = businessStats([
      { kind: "contribution", amount_sen: 100_000_00, date: "2077-01-01", created_at: "2077-01-01T00:00:00Z" },
      { kind: "return", amount_sen: 30_000_00, date: "2077-06-01", created_at: "2077-06-01T00:00:00Z" },
    ]);
    expect(stats.invested_sen).toBe(100_000_00);
    expect(stats.returned_sen).toBe(30_000_00);
    expect(stats.value_sen).toBe(100_000_00); // still Σ contributions
  });

  it("value = latest valuation by date, even when an older valuation is larger", () => {
    const stats = businessStats([
      { kind: "contribution", amount_sen: 100_000_00, date: "2077-01-01", created_at: "2077-01-01T00:00:00Z" },
      { kind: "valuation", amount_sen: 200_000_00, date: "2077-02-01", created_at: "2077-02-01T00:00:00Z" },
      { kind: "valuation", amount_sen: 180_000_00, date: "2077-05-01", created_at: "2077-05-01T00:00:00Z" },
    ]);
    expect(stats.value_sen).toBe(180_000_00);
  });

  it("created_at breaks a same-date valuation tie", () => {
    const stats = businessStats([
      { kind: "valuation", amount_sen: 111_00, date: "2077-05-01", created_at: "2077-05-01T10:00:00Z" },
      { kind: "valuation", amount_sen: 222_00, date: "2077-05-01", created_at: "2077-05-01T11:00:00Z" },
      { kind: "contribution", amount_sen: 1_00, date: "2077-01-01", created_at: "2077-01-01T00:00:00Z" },
    ]);
    expect(stats.value_sen).toBe(222_00);
  });
});

describe("latestValues", () => {
  it("keeps the max noted_on per item; created_at breaks ties", () => {
    const map = latestValues([
      { item_id: "a", value_sen: 10_00, noted_on: "2077-01-01", created_at: "2077-01-01T00:00:00Z" },
      { item_id: "a", value_sen: 20_00, noted_on: "2077-02-01", created_at: "2077-02-01T00:00:00Z" },
      { item_id: "b", value_sen: 30_00, noted_on: "2077-03-01", created_at: "2077-03-01T09:00:00Z" },
      { item_id: "b", value_sen: 40_00, noted_on: "2077-03-01", created_at: "2077-03-01T10:00:00Z" },
    ]);
    expect(map.get("a")).toBe(20_00);
    expect(map.get("b")).toBe(40_00); // same noted_on, later created_at wins
    expect(map.size).toBe(2);
  });

  it("returns an empty map for no rows", () => {
    expect(latestValues([]).size).toBe(0);
  });
});

describe("deltaVsPrevMonth", () => {
  it("uses a snapshot exactly on the previous month end", () => {
    const delta = deltaVsPrevMonth(
      [
        { date: "2026-07-31", total_sen: 500_000_00 },
        { date: "2026-08-05", total_sen: 510_000_00 }, // this month — ignored
      ],
      520_000_00,
      "2026-08-17",
    );
    expect(delta).toBe(20_000_00);
  });

  it("falls back to the latest snapshot before the month end (mid-month)", () => {
    const delta = deltaVsPrevMonth(
      [
        { date: "2026-07-10", total_sen: 400_000_00 },
        { date: "2026-07-20", total_sen: 450_000_00 },
      ],
      440_000_00,
      "2026-08-17",
    );
    expect(delta).toBe(-10_000_00); // vs 2026-07-20, signed
  });

  it("returns null when no snapshot exists at or before the previous month end", () => {
    expect(
      deltaVsPrevMonth([{ date: "2026-08-02", total_sen: 1_00 }], 2_00, "2026-08-17"),
    ).toBeNull();
    expect(deltaVsPrevMonth([], 2_00, "2026-08-17")).toBeNull();
  });

  it("handles January (previous month end is December 31 of the prior year)", () => {
    const delta = deltaVsPrevMonth(
      [{ date: "2026-12-31", total_sen: 100_00 }],
      150_00,
      "2027-01-10",
    );
    expect(delta).toBe(50_00);
  });
});

describe("chartSeries", () => {
  const snaps = [
    { date: "2025-08-16", total_sen: 1_00 },
    { date: "2025-08-17", total_sen: 2_00 },
    { date: "2026-05-16", total_sen: 3_00 },
    { date: "2026-05-17", total_sen: 4_00 },
    { date: "2026-08-10", total_sen: 5_00 },
  ];

  it("3M keeps snapshots on/after today−3months and appends the live today point", () => {
    const series = chartSeries(snaps, "3M", "2026-08-17", 9_00);
    expect(series).toEqual([
      { date: "2026-05-17", total_sen: 4_00 }, // range edge inclusive
      { date: "2026-08-10", total_sen: 5_00 },
      { date: "2026-08-17", total_sen: 9_00 }, // live point appended
    ]);
  });

  it("1Y keeps snapshots on/after today−12months", () => {
    const series = chartSeries(snaps, "1Y", "2026-08-17", 9_00);
    expect(series.map((p) => p.date)).toEqual([
      "2025-08-17",
      "2026-05-16",
      "2026-05-17",
      "2026-08-10",
      "2026-08-17",
    ]);
  });

  it("ALL keeps everything, sorted ascending", () => {
    const shuffled = [snaps[2]!, snaps[0]!, snaps[4]!, snaps[1]!, snaps[3]!];
    const series = chartSeries(shuffled, "ALL", "2026-08-17", 9_00);
    expect(series.map((p) => p.date)).toEqual([
      "2025-08-16",
      "2025-08-17",
      "2026-05-16",
      "2026-05-17",
      "2026-08-10",
      "2026-08-17",
    ]);
  });

  it("the live point replaces a same-day snapshot", () => {
    const series = chartSeries(
      [
        { date: "2026-08-10", total_sen: 5_00 },
        { date: "2026-08-17", total_sen: 7_00 }, // cron already wrote today
      ],
      "6M",
      "2026-08-17",
      9_00,
    );
    expect(series).toEqual([
      { date: "2026-08-10", total_sen: 5_00 },
      { date: "2026-08-17", total_sen: 9_00 }, // live wins, no duplicate
    ]);
  });

  it("clamps the range start when the target month is shorter", () => {
    // 2026-05-31 minus 3 months → 2026-02-28 (2026 is not a leap year)
    const series = chartSeries(
      [
        { date: "2026-02-27", total_sen: 1_00 },
        { date: "2026-02-28", total_sen: 2_00 },
      ],
      "3M",
      "2026-05-31",
      9_00,
    );
    expect(series.map((p) => p.date)).toEqual(["2026-02-28", "2026-05-31"]);
  });

  it("live-only when no snapshots exist", () => {
    expect(chartSeries([], "ALL", "2026-08-17", 9_00)).toEqual([
      { date: "2026-08-17", total_sen: 9_00 },
    ]);
  });
});
