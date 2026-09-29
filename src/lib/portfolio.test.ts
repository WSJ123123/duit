import { describe, it, expect } from "vitest";
import {
  OversellError,
  positionFromTrades,
  realizedInYear,
  holdingValueSen,
  centToSen,
  unrealizedCent,
  effectivePriceE8,
  priceIsStale,
  unitPriceMinor,
  type TradeLike,
} from "@/lib/portfolio";

// e8 fixed-point literals (RM/major-currency units × 1e8). Written as integer
// literals — never float math — so the fixtures themselves stay exact.
const buy = (date: string, quantity_e8: number, price_e8: number, fees_cent: number): TradeLike => ({
  side: "buy",
  date,
  quantity_e8,
  price_e8,
  fees_cent,
});
const sell = (date: string, quantity_e8: number, price_e8: number, fees_cent: number): TradeLike => ({
  side: "sell",
  date,
  quantity_e8,
  price_e8,
  fees_cent,
});

const FX_IDENTITY = 100_000_000; // MYR holding: 1.0 × 1e8

describe("positionFromTrades", () => {
  it("returns a flat zero position for no trades", () => {
    expect(positionFromTrades([])).toEqual({
      quantity_e8: 0,
      cost_cent: 0,
      avg_cost_e8: 0,
      realized_cent: 0,
    });
  });

  it("accumulates buy-only cost including fees", () => {
    // buy 10 @ RM5.00 fee RM1.00: gross = 10×5.00 = RM50.00 = 5000c; cost 5100c
    // buy  5 @ RM6.00 fee RM0.50: gross =  5×6.00 = RM30.00 = 3000c; cost += 3050c → 8150c
    // qty 15 units; avg = 8150c × 1e14 / 1_500_000_000 = 543,333,333.33… → 543_333_333 (half-up)
    const p = positionFromTrades([
      buy("2026-01-05", 1_000_000_000, 500_000_000, 100),
      buy("2026-02-01", 500_000_000, 600_000_000, 50),
    ]);
    expect(p).toEqual({
      quantity_e8: 1_500_000_000,
      cost_cent: 8150,
      avg_cost_e8: 543_333_333,
      realized_cent: 0,
    });
  });

  it("handles interleaved buys and sells (hand-computed worked example)", () => {
    // b1 buy 10 @ 5.00 fee 100c: gross 5000c → cost 5100c, qty 10
    // s1 sell 4 @ 7.00 fee  80c: gross 2800c; removed = 5100×4/10 = 2040c (exact)
    //    realized = (2800−80)−2040 = 680c → cost 3060c, qty 6
    // b2 buy  6 @ 4.00 fee  60c: gross 2400c → cost 5520c, qty 12
    // s2 sell 5 @ 6.00 fee  70c: gross 3000c; removed = 5520×5/12 = 2300c (exact)
    //    realized += (3000−70)−2300 = 630c → total 1310c; cost 3220c, qty 7
    // avg = 3220c × 1e14 / 700_000_000 = 460_000_000 (RM 4.60/unit, exact)
    const p = positionFromTrades([
      buy("2026-01-05", 1_000_000_000, 500_000_000, 100),
      sell("2026-02-10", 400_000_000, 700_000_000, 80),
      buy("2026-03-01", 600_000_000, 400_000_000, 60),
      sell("2026-04-15", 500_000_000, 600_000_000, 70),
    ]);
    expect(p).toEqual({
      quantity_e8: 700_000_000,
      cost_cent: 3220,
      avg_cost_e8: 460_000_000,
      realized_cent: 1310,
    });
  });

  it("sell-all zeroes cost exactly, with no rounding residue", () => {
    // buy 3 @ RM3.33 fee 10c: gross 999c → cost 1009c (1009/3 does not divide evenly)
    // sell 1 @ RM4.00 fee 5c: gross 400c; removed = round(1009/3) = round(336.33) = 336c
    //    realized = 395 − 336 = 59c → cost 673c, qty 2
    // sell 2 @ RM4.00 fee 5c (sell-all): gross 800c; removed = ALL remaining cost = 673c
    //    realized += 795 − 673 = 122c → total 181c
    const p = positionFromTrades([
      buy("2026-01-02", 300_000_000, 333_000_000, 10),
      sell("2026-01-10", 100_000_000, 400_000_000, 5),
      sell("2026-01-20", 200_000_000, 400_000_000, 5),
    ]);
    expect(p.cost_cent).toBe(0); // exactly zero — no residue from the earlier 1009/3 rounding
    expect(p.quantity_e8).toBe(0);
    expect(p.avg_cost_e8).toBe(0);
    expect(p.realized_cent).toBe(181);
  });

  it("rounds cost removal half-up on an odd division", () => {
    // buy 2 @ RM0.50 fee 1c: gross 100c → cost 101c
    // sell 1 @ RM1.00 fee 0: removed = round(101×1/2) = round(50.5) = 51c (half-up)
    //    realized = 100 − 51 = 49c → cost 50c, qty 1, avg = 50_000_000 (RM0.50)
    const p = positionFromTrades([
      buy("2026-01-02", 200_000_000, 50_000_000, 1),
      sell("2026-01-10", 100_000_000, 100_000_000, 0),
    ]);
    expect(p).toEqual({
      quantity_e8: 100_000_000,
      cost_cent: 50,
      avg_cost_e8: 50_000_000,
      realized_cent: 49,
    });
  });

  it("throws OversellError mid-sequence — a later buy cannot rescue an earlier oversell", () => {
    const trades = [
      buy("2026-01-01", 500_000_000, 100_000_000, 0),
      sell("2026-01-10", 800_000_000, 100_000_000, 0), // only 5 held
      buy("2026-02-01", 1_000_000_000, 100_000_000, 0), // would cover it — must NOT rescue
    ];
    expect(() => positionFromTrades(trades)).toThrow(OversellError);
    try {
      positionFromTrades(trades);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OversellError);
      expect((e as OversellError).date).toBe("2026-01-10");
    }
  });

  it("throws OversellError on a sell with nothing held", () => {
    expect(() => positionFromTrades([sell("2026-03-03", 100_000_000, 100_000_000, 0)])).toThrow(
      OversellError,
    );
  });

  it("sorts by date (stable), keeping array order for same-day trades", () => {
    // Array order: [buy 5 Jan2, sell 6 Jan2, buy 3 Jan1]. Chronological + stable:
    // buy 3 (Jan1) → buy 5 (Jan2) → sell 6 (Jan2): qty 8 covers the sell → final 2.
    // An unstable sort putting the Jan2 sell before the Jan2 buy would oversell.
    const p = positionFromTrades([
      buy("2026-01-02", 500_000_000, 100_000_000, 0),
      sell("2026-01-02", 600_000_000, 100_000_000, 0),
      buy("2026-01-01", 300_000_000, 100_000_000, 0),
    ]);
    expect(p.quantity_e8).toBe(200_000_000);
  });

  it("same-day sell listed before its buy in the array oversells (array order rules the day)", () => {
    expect(() =>
      positionFromTrades([
        sell("2026-01-02", 100_000_000, 100_000_000, 0),
        buy("2026-01-02", 100_000_000, 100_000_000, 0),
      ]),
    ).toThrow(OversellError);
  });

  it("values a Number-overflow-sized position exactly via BigInt", () => {
    // 1,000 units @ RM 1,000: qty_e8 × price_e8 = 1e11 × 1e11 = 1e22 ≫ 2^53.
    // cost = 1,000 × RM1,000 = RM 1,000,000 = 100_000_000c; avg = RM1,000 = 1e11 e8.
    const p = positionFromTrades([buy("2026-01-02", 100_000_000_000, 100_000_000_000, 0)]);
    expect(p.cost_cent).toBe(100_000_000);
    expect(p.avg_cost_e8).toBe(100_000_000_000);
  });
});

describe("realizedInYear", () => {
  // buy 10 @ 5.00 (2025-06-01): cost 5000c
  // sell 4 @ 6.00 (2025-12-31): gross 2400c; removed 5000×4/10 = 2000c → realized 400c in 2025
  // sell 3 @ 7.00 (2026-01-02): cost 3000c qty 6; removed 3000×3/6 = 1500c;
  //   gross 2100c → realized 600c in 2026
  const trades = [
    buy("2025-06-01", 1_000_000_000, 500_000_000, 0),
    sell("2025-12-31", 400_000_000, 600_000_000, 0),
    sell("2026-01-02", 300_000_000, 700_000_000, 0),
  ];
  it("splits realized P/L across the year boundary", () => {
    expect(realizedInYear(trades, 2025)).toBe(400);
    expect(realizedInYear(trades, 2026)).toBe(600);
  });
  it("returns 0 for a year with no sells", () => {
    expect(realizedInYear(trades, 2024)).toBe(0);
  });
});

describe("holdingValueSen", () => {
  it("values an MYR holding with identity FX", () => {
    // 10 units @ RM 5.00 → RM 50.00 = 5000 sen
    expect(holdingValueSen(1_000_000_000, 500_000_000, FX_IDENTITY)).toBe(5000);
  });

  it("values the module-header USD worked example (VWRA)", () => {
    // 16.2 × USD 139.75 = USD 2,263.95; × 4.42 = RM 10,006.659 → 1_000_666 sen (half-up)
    expect(holdingValueSen(1_620_000_000, 13_975_000_000, 442_000_000)).toBe(1_000_666);
  });

  it("values a Number-overflow-sized product exactly (BigInt path)", () => {
    // 1,000 units @ RM 1,000 (1e11 × 1e11 e8-units = 1e22 ≫ 2^53) → RM 1,000,000 = 1e8 sen
    expect(holdingValueSen(100_000_000_000, 100_000_000_000, FX_IDENTITY)).toBe(100_000_000);
    // 86,400 units @ RM 12,345.67 → 86,400 × 12,345.67 = RM 1,066,665,888.00
    //   (12,345.67 × 864 = 10,666,658.88; × 100) = 106_666_588_800 sen exactly
    expect(holdingValueSen(8_640_000_000_000, 1_234_567_000_000, FX_IDENTITY)).toBe(
      106_666_588_800,
    );
  });

  it("rounds half-up at the sen", () => {
    // 1 unit @ RM 0.005 → 0.5 sen → 1 sen
    expect(holdingValueSen(100_000_000, 500_000, FX_IDENTITY)).toBe(1);
  });
});

describe("unitPriceMinor (Q35 — HoldingsTable's e8 → minor conversion, moved here)", () => {
  it("converts a per-unit e8 price to 2dp minor units", () => {
    expect(unitPriceMinor(12_840_000_000)).toBe(12_840); // USD 128.40
    expect(unitPriceMinor(0)).toBe(0);
  });

  it("rounds half-up at the minor unit (sub-cent e8 digits)", () => {
    expect(unitPriceMinor(12_840_500_000)).toBe(12_841); // 128.405 → 128.41
    expect(unitPriceMinor(12_840_499_999)).toBe(12_840);
    expect(unitPriceMinor(500_000)).toBe(1); // 0.005 → 0.01
  });
});

describe("centToSen", () => {
  it("is identity for MYR", () => {
    expect(centToSen(1234, FX_IDENTITY)).toBe(1234);
    expect(centToSen(0, FX_IDENTITY)).toBe(0);
  });
  it("converts USD cents to sen", () => {
    // 100 US cents × 4.42 = 442 sen
    expect(centToSen(100, 442_000_000)).toBe(442);
  });
  it("rounds half-up, half away from zero for negative P/L", () => {
    expect(centToSen(1, 150_000_000)).toBe(2); // 1.5 → 2
    expect(centToSen(3, 150_000_000)).toBe(5); // 4.5 → 5
    expect(centToSen(-1, 150_000_000)).toBe(-2); // −1.5 → −2 (symmetric)
    expect(centToSen(-100, 442_000_000)).toBe(-442);
  });
});

describe("unrealizedCent", () => {
  const position = {
    quantity_e8: 700_000_000,
    cost_cent: 3220,
    avg_cost_e8: 460_000_000,
    realized_cent: 1310,
  };
  it("is market value minus cost basis (gain)", () => {
    // 7 units @ RM 8.00 = 5600c − 3220c = 2380c
    expect(unrealizedCent(position, 800_000_000)).toBe(2380);
  });
  it("goes negative on a loss", () => {
    // 7 units @ RM 4.00 = 2800c − 3220c = −420c
    expect(unrealizedCent(position, 400_000_000)).toBe(-420);
  });
});

describe("effectivePriceE8", () => {
  const fetched = { price_e8: 456_000_000 };
  it("manual override wins even when a fetched price exists", () => {
    expect(
      effectivePriceE8({ price_source: "manual", manual_price_e8: 123_000_000 }, fetched),
    ).toBe(123_000_000);
    expect(effectivePriceE8({ price_source: "manual", manual_price_e8: 123_000_000 }, null)).toBe(
      123_000_000,
    );
  });
  it("auto uses the fetched price", () => {
    expect(effectivePriceE8({ price_source: "auto", manual_price_e8: null }, fetched)).toBe(
      456_000_000,
    );
  });
  it("returns null when there is no data", () => {
    expect(effectivePriceE8({ price_source: "auto", manual_price_e8: null }, null)).toBeNull();
    expect(effectivePriceE8({ price_source: "manual", manual_price_e8: null }, fetched)).toBeNull();
  });
});

describe("priceIsStale", () => {
  it("today and yesterday are fresh; the day before is stale", () => {
    expect(priceIsStale("2026-08-17", "2026-08-17")).toBe(false);
    expect(priceIsStale("2026-08-16", "2026-08-17")).toBe(false);
    expect(priceIsStale("2026-08-15", "2026-08-17")).toBe(true);
  });
  it("handles month and year boundaries", () => {
    expect(priceIsStale("2026-02-28", "2026-03-01")).toBe(false);
    expect(priceIsStale("2026-02-27", "2026-03-01")).toBe(true);
    expect(priceIsStale("2025-12-31", "2026-01-01")).toBe(false);
    expect(priceIsStale("2025-12-30", "2026-01-01")).toBe(true);
  });
});
