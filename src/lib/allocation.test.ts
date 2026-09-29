import { describe, it, expect } from "vitest";
import {
  PRESET_DEFAULTS,
  RETURN_BP,
  defaultBucket,
  potBuckets,
  bucketPcts,
  accessibleMonthsTenths,
  blendedReturnBp,
  stressLossSen,
  planInRinggit,
  driftLine,
  equitiesSplit,
  rebalanceHint,
} from "@/lib/allocation";

describe("PRESET_DEFAULTS / RETURN_BP", () => {
  it("matches the ruled preset percentages, each summing to 100", () => {
    expect(PRESET_DEFAULTS.balanced).toEqual({ bank_pct: 6, cashlike_pct: 50, equities_pct: 44 });
    expect(PRESET_DEFAULTS.growth).toEqual({ bank_pct: 6, cashlike_pct: 32, equities_pct: 62 });
    expect(PRESET_DEFAULTS.aggressive).toEqual({ bank_pct: 6, cashlike_pct: 22, equities_pct: 72 });
    expect(PRESET_DEFAULTS.barbell).toEqual({ bank_pct: 6, cashlike_pct: 39, equities_pct: 55 });
    for (const p of Object.values(PRESET_DEFAULTS)) {
      expect(p.bank_pct + p.cashlike_pct + p.equities_pct).toBe(100);
    }
  });

  it("carries the ruled return assumptions", () => {
    expect(RETURN_BP).toEqual({ bank: 200, cashlike: 350, equities: 700 });
  });
});

describe("defaultBucket", () => {
  it("maps all six account types per ruling 12", () => {
    expect(defaultBucket("bank")).toBe("bank");
    expect(defaultBucket("ewallet")).toBe("bank");
    expect(defaultBucket("cash")).toBe("bank");
    expect(defaultBucket("brokerage")).toBe("cashlike");
    expect(defaultBucket("epf")).toBe("exclude");
    expect(defaultBucket("other")).toBe("exclude");
  });
});

describe("potBuckets", () => {
  it("sums balances by bucket, skips exclude, adds holdings to equities", () => {
    const b = potBuckets(
      [
        { balance_sen: 1_000_00, bucket: "bank" },
        { balance_sen: 500_00, bucket: "bank" },
        { balance_sen: 2_000_00, bucket: "cashlike" },
        { balance_sen: 999_00, bucket: "exclude" }, // EPF etc — outside the pot
        { balance_sen: 300_00, bucket: "equities" },
      ],
      700_00,
    );
    expect(b).toEqual({
      bank_sen: 1_500_00,
      cashlike_sen: 2_000_00,
      equities_sen: 1_000_00, // 300 account + 700 holdings
      pot_sen: 4_500_00,
    });
  });

  it("empty accounts: pot is just the holdings", () => {
    expect(potBuckets([], 50_00)).toEqual({
      bank_sen: 0,
      cashlike_sen: 0,
      equities_sen: 50_00,
      pot_sen: 50_00,
    });
  });

  it("Task 5: converts a non-MYR cashlike account at the <CUR>MYR rate", () => {
    const b = potBuckets(
      [
        { balance_sen: 1_000_00, bucket: "bank" },
        // USD brokerage cash: USD 100.00 × 4.42 → RM 442.00
        { balance_sen: 100_00, bucket: "cashlike", currency: "USD" },
      ],
      0,
      new Map([["USDMYR", 442_000_000]]),
    );
    expect(b).toEqual({
      bank_sen: 1_000_00,
      cashlike_sen: 442_00,
      equities_sen: 0,
      pot_sen: 1_442_00,
    });
  });

  it("Task 5: a never-fetched rate excludes that account from the pot (honest gap)", () => {
    const b = potBuckets(
      [
        { balance_sen: 1_000_00, bucket: "bank", currency: "MYR" },
        { balance_sen: 100_00, bucket: "cashlike", currency: "ZZQ" },
      ],
      0,
      new Map(),
    );
    expect(b).toEqual({
      bank_sen: 1_000_00,
      cashlike_sen: 0,
      equities_sen: 0,
      pot_sen: 1_000_00,
    });
  });
});

describe("bucketPcts", () => {
  it("thirds case: naive rounding gives 99, largest remainder gives exactly 100", () => {
    const pcts = bucketPcts({ bank_sen: 1_00, cashlike_sen: 1_00, equities_sen: 1_00, pot_sen: 3_00 });
    // 33.33% each → floors 33/33/33, leftover 1 goes to the tied-first bucket (bank)
    expect(pcts).toEqual({ bank_pct: 34, cashlike_pct: 33, equities_pct: 33 });
    expect(pcts.bank_pct + pcts.cashlike_pct + pcts.equities_pct).toBe(100);
  });

  it("half-points case where naive half-up rounding would sum to 101", () => {
    // 16.5% / 16.5% / 67% → naive half-up = 17+17+67 = 101
    const pcts = bucketPcts({ bank_sen: 165_00, cashlike_sen: 165_00, equities_sen: 670_00, pot_sen: 1_000_00 });
    expect(pcts).toEqual({ bank_pct: 17, cashlike_pct: 16, equities_pct: 67 });
  });

  it("exact split passes through untouched", () => {
    expect(bucketPcts({ bank_sen: 6_00, cashlike_sen: 50_00, equities_sen: 44_00, pot_sen: 100_00 }))
      .toEqual({ bank_pct: 6, cashlike_pct: 50, equities_pct: 44 });
  });

  it("empty pot: all zeros", () => {
    expect(bucketPcts({ bank_sen: 0, cashlike_sen: 0, equities_sen: 0, pot_sen: 0 }))
      .toEqual({ bank_pct: 0, cashlike_pct: 0, equities_pct: 0 });
  });
});

describe("accessibleMonthsTenths", () => {
  it("returns whole tenths of a month", () => {
    // RM 730 accessible ÷ RM 100/month = 7.3 months → 73 tenths
    expect(accessibleMonthsTenths(730_00, 100_00)).toBe(73);
  });

  it("rounds half-up at the tenths boundary", () => {
    expect(accessibleMonthsTenths(1_250, 1_000)).toBe(13); // 1.25 → 1.3
    expect(accessibleMonthsTenths(12_345, 1_000)).toBe(123); // 12.345 → 12.3
  });

  it("null when there is no expense history", () => {
    expect(accessibleMonthsTenths(730_00, 0)).toBeNull();
  });
});

describe("blendedReturnBp", () => {
  it("blends per-bucket assumptions by percentage (hand-checked)", () => {
    // balanced: 6%·200 + 50%·350 + 44%·700 = (1200+17500+30800)/100 = 495 bp
    expect(blendedReturnBp({ bank_pct: 6, cashlike_pct: 50, equities_pct: 44 })).toBe(495);
    expect(blendedReturnBp({ bank_pct: 100, cashlike_pct: 0, equities_pct: 0 })).toBe(200);
    expect(blendedReturnBp({ bank_pct: 0, cashlike_pct: 0, equities_pct: 100 })).toBe(700);
  });
});

describe("stressLossSen", () => {
  it("is 40% of the equities sen", () => {
    expect(stressLossSen(1_000_00)).toBe(400_00);
    expect(stressLossSen(0)).toBe(0);
  });

  it("rounds half-up on non-divisible amounts", () => {
    expect(stressLossSen(101)).toBe(40); // 40.4
    expect(stressLossSen(104)).toBe(42); // 41.6
  });
});

describe("planInRinggit", () => {
  it("splits the pot by preset and sums back exactly (largest remainder)", () => {
    const plan = planInRinggit(1_000_00, PRESET_DEFAULTS.balanced);
    expect(plan).toEqual({ bank_sen: 60_00, cashlike_sen: 500_00, equities_sen: 440_00 });
  });

  it("thirds-style pot where floors alone would lose a sen", () => {
    // pot 101 at 33/33/34: floors 33/33/34 = 100, the leftover sen goes to the
    // largest remainder (equities: .34 vs .33)
    expect(planInRinggit(101, { bank_pct: 33, cashlike_pct: 33, equities_pct: 34 }))
      .toEqual({ bank_sen: 33, cashlike_sen: 33, equities_sen: 35 });
  });

  it("zero pot: all zeros", () => {
    expect(planInRinggit(0, PRESET_DEFAULTS.growth))
      .toEqual({ bank_sen: 0, cashlike_sen: 0, equities_sen: 0 });
  });
});

describe("driftLine", () => {
  it("signed points per bucket: current − target", () => {
    expect(
      driftLine(
        { bank_pct: 6, cashlike_pct: 50, equities_pct: 44 },
        { bank_pct: 10, cashlike_pct: 40, equities_pct: 50 },
      ),
    ).toEqual([
      { bucket: "bank", pts: 4 },
      { bucket: "cashlike", pts: -10 },
      { bucket: "equities", pts: 6 },
    ]);
  });
});

describe("equitiesSplit", () => {
  it("percentages are of the equities slice; crypto counts on the stock side", () => {
    const split = equitiesSplit(
      [
        { id: "vwra", kind: "etf", value_sen: 700_00, target_pct: 60 },
        { id: "aapl", kind: "stock", value_sen: 200_00, target_pct: 25 },
        { id: "btc", kind: "crypto", value_sen: 100_00, target_pct: null },
      ],
      70,
    );
    expect(split.etf_pct).toBe(70);
    expect(split.stock_pct).toBe(30); // stock + crypto
    expect(split.holdings).toEqual([
      { id: "vwra", pct: 70, target_pct: 60 },
      { id: "aapl", pct: 20, target_pct: 25 },
      { id: "btc", pct: 10, target_pct: null },
    ]);
  });

  it("per-holding percentages sum to 100 in a thirds case", () => {
    const split = equitiesSplit(
      [
        { id: "a", kind: "etf", value_sen: 1_00, target_pct: null },
        { id: "b", kind: "stock", value_sen: 1_00, target_pct: null },
        { id: "c", kind: "crypto", value_sen: 1_00, target_pct: null },
      ],
      70,
    );
    const sum = split.holdings.reduce((acc, h) => acc + h.pct, 0);
    expect(sum).toBe(100);
    expect(split.etf_pct + split.stock_pct).toBe(100); // 33.3/66.6 → 33/67
    expect(split.etf_pct).toBe(33);
    expect(split.stock_pct).toBe(67);
  });

  it("zero total value: everything is 0", () => {
    const split = equitiesSplit(
      [{ id: "a", kind: "etf", value_sen: 0, target_pct: 50 }],
      70,
    );
    expect(split.etf_pct).toBe(0);
    expect(split.stock_pct).toBe(0);
    expect(split.holdings).toEqual([{ id: "a", pct: 0, target_pct: 50 }]);
  });
});

describe("rebalanceHint", () => {
  it("names the holding most under its target", () => {
    const split = equitiesSplit(
      [
        { id: "vwra", kind: "etf", value_sen: 300_00, target_pct: 40 }, // 30% → −10
        { id: "aapl", kind: "stock", value_sen: 350_00, target_pct: 30 }, // 35% → +5
        { id: "btc", kind: "crypto", value_sen: 350_00, target_pct: null }, // no target, can't win
      ],
      70,
    );
    expect(rebalanceHint(split)).toBe("vwra");
  });

  it("null when no holding has a target set", () => {
    const split = equitiesSplit(
      [
        { id: "a", kind: "etf", value_sen: 500_00, target_pct: null },
        { id: "b", kind: "stock", value_sen: 500_00, target_pct: null },
      ],
      70,
    );
    expect(rebalanceHint(split)).toBeNull();
  });
});
