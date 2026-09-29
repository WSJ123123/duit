import { describe, it, expect } from "vitest";
import {
  divHalfUp,
  monthlyInterestSen,
  paymentRateSen,
  projectPayoff,
  requiredToProgressSen,
  payoffProgress,
  monthLabel,
  ratePct,
  HORIZON_MONTHS,
} from "@/lib/debt";

/**
 * Plan 8 ruling 9: the payoff projection is derived, monthly, integer sen and
 * never fabricated. "Today" is a parameter; every case below is hand-checked.
 */
const TODAY = "2077-06-15";

describe("divHalfUp — house convention, half away from zero", () => {
  it("rounds half up on positive and half away from zero on negative", () => {
    expect(divHalfUp(3, 2)).toBe(2); // 1.5 → 2
    expect(divHalfUp(-3, 2)).toBe(-2); // −1.5 → −2, not −1
    expect(divHalfUp(-9, 2)).toBe(-5); // −4.5 → −5
    expect(divHalfUp(-7, 3)).toBe(-2); // −2.33 → −2
    expect(divHalfUp(-1, 2)).toBe(-1); // −0.5 → −1
    expect(divHalfUp(7, 3)).toBe(2);
    expect(divHalfUp(0, 5)).toBe(0);
  });
});

describe("monthlyInterestSen", () => {
  it("is 0 at 0 bp", () => {
    expect(monthlyInterestSen(1_000_000, 0)).toBe(0);
  });

  it("is RM 150.00 exactly on RM 10,000 at 1800 bp (18% ÷ 12)", () => {
    // 1_000_000 × 1800 / 120_000 = 15_000 sen
    expect(monthlyInterestSen(1_000_000, 1_800)).toBe(15_000);
  });

  it("rounds a 1-sen balance to 0 at any legal rate", () => {
    // 1 × 1800 / 120_000 = 0.015 → 0; 1 × 10_000 / 120_000 = 0.083 → 0
    expect(monthlyInterestSen(1, 1_800)).toBe(0);
    expect(monthlyInterestSen(1, 10_000)).toBe(0);
  });

  it("rounds half up at the sen", () => {
    // 32_665 × 1200 / 120_000 = 326.65 → 327
    expect(monthlyInterestSen(32_665, 1_200)).toBe(327);
  });
});

describe("paymentRateSen — ruling 9 precedence: planned > minimum > none", () => {
  it("planned wins when > 0", () => {
    expect(paymentRateSen({ planned_payment_sen: 95_000, minimum_payment_sen: 85_000 })).toBe(95_000);
  });
  it("falls back to the minimum when planned is 0", () => {
    expect(paymentRateSen({ planned_payment_sen: 0, minimum_payment_sen: 85_000 })).toBe(85_000);
  });
  it("is null when both are 0 — never a fabricated rate", () => {
    expect(paymentRateSen({ planned_payment_sen: 0, minimum_payment_sen: 0 })).toBeNull();
  });
});

describe("projectPayoff", () => {
  it("zero-rate runs linear: RM 1,200 at RM 100/mo → 12 months, no interest", () => {
    const p = projectPayoff(120_000, 0, 10_000, TODAY);
    expect(p).toEqual({
      status: "on_track",
      payoff_month: "2078-06", // 2077-06 + 12
      months: 12,
      total_interest_sen: 0,
      final_payment_sen: 10_000, // the last instalment is a full one
      required_to_progress_sen: null,
    });
  });

  it("a hand-computed 3-month run at 1200 bp (1%/month), with a final short payment", () => {
    // Balance RM 1,000.00 = 100_000 sen, payment RM 345.00 = 34_500 sen.
    // M1: interest = 100_000 × 1200 / 120_000 = 1_000.00 → 1_000
    //     balance  = 100_000 + 1_000 − 34_500 = 66_500
    // M2: interest = 66_500 × 1200 / 120_000 = 665.00 → 665
    //     balance  = 66_500 + 665 − 34_500 = 32_665
    // M3: interest = 32_665 × 1200 / 120_000 = 326.65 → 327 (half up)
    //     owed     = 32_665 + 327 = 32_992 ≤ 34_500 → cleared; final payment 32_992
    // total interest = 1_000 + 665 + 327 = 1_992
    const p = projectPayoff(100_000, 1_200, 34_500, TODAY);
    expect(p).toEqual({
      status: "on_track",
      payoff_month: "2077-09", // 2077-06 + 3
      months: 3,
      total_interest_sen: 1_992,
      final_payment_sen: 32_992,
      required_to_progress_sen: null,
    });
  });

  it("a payment equal to the first month's interest is `never`", () => {
    // first month's interest on 100_000 at 1200 bp = 1_000
    const p = projectPayoff(100_000, 1_200, 1_000, TODAY);
    expect(p.status).toBe("never");
    expect(p.payoff_month).toBeNull();
    expect(p.months).toBeNull();
    expect(p.total_interest_sen).toBe(0);
    expect(p.final_payment_sen).toBe(0);
    expect(p.required_to_progress_sen).not.toBeNull();
  });

  it("interest + 1 sen is `beyond_horizon`, NOT `never` — it reduces the balance a sen a month", () => {
    const p = projectPayoff(100_000, 1_200, 1_001, TODAY);
    expect(p.status).toBe("beyond_horizon");
    expect(p.payoff_month).toBeNull();
    expect(p.months).toBeNull();
    expect(p.required_to_progress_sen).not.toBeNull();
    // 600 months of interest were charged and are reported honestly.
    expect(p.total_interest_sen).toBeGreaterThan(0);
  });

  it("the 600-month cap: exactly 600 months is dated, 601 is beyond the horizon", () => {
    expect(HORIZON_MONTHS).toBe(600);
    const inside = projectPayoff(600, 0, 1, TODAY);
    expect(inside.status).toBe("on_track");
    expect(inside.months).toBe(600);
    expect(inside.payoff_month).toBe("2127-06"); // 2077-06 + 600 = 50 years
    const outside = projectPayoff(601, 0, 1, TODAY);
    expect(outside.status).toBe("beyond_horizon");
    expect(outside.months).toBeNull();
    expect(outside.required_to_progress_sen).toBe(2); // 2 sen/mo clears 601 in 301 months
  });

  it("balance 0 is `paid`", () => {
    expect(projectPayoff(0, 1_200, 10_000, TODAY)).toEqual({
      status: "paid",
      payoff_month: null,
      months: 0,
      total_interest_sen: 0,
      final_payment_sen: 0,
      required_to_progress_sen: null,
    });
  });

  it("payoff month rolls over the year boundary", () => {
    // RM 700 at RM 100/mo, no rate → 7 months from 2077-11 → 2078-06
    expect(projectPayoff(70_000, 0, 10_000, "2077-11-30").payoff_month).toBe("2078-06");
  });
});

describe("requiredToProgressSen — the smallest payment that clears inside the cap", () => {
  it("fed back into projectPayoff yields a dated payoff; one sen less does not", () => {
    const required = requiredToProgressSen(100_000, 1_200);
    // Ruling 9: NOT interest + 1 sen (1_001 lands in beyond_horizon).
    expect(required).toBeGreaterThan(1_001);
    const dated = projectPayoff(100_000, 1_200, required, TODAY);
    expect(dated.status).toBe("on_track");
    // Inside the cap, not necessarily AT it: months steps discontinuously in
    // the payment because interest rounds to the sen (observed: 585 here).
    expect(dated.months).toBeLessThanOrEqual(HORIZON_MONTHS);
    const short = projectPayoff(100_000, 1_200, required - 1, TODAY);
    expect(short.status).not.toBe("on_track");
    // …and both no-date states carry the same figure the card prints.
    expect(projectPayoff(100_000, 1_200, 1_000, TODAY).required_to_progress_sen).toBe(required);
    expect(projectPayoff(100_000, 1_200, 1_001, TODAY).required_to_progress_sen).toBe(required);
  });

  it("zero rate: ceil(balance / 600)", () => {
    expect(requiredToProgressSen(600, 0)).toBe(1);
    expect(requiredToProgressSen(601, 0)).toBe(2);
    expect(requiredToProgressSen(1, 1_800)).toBe(1);
  });
});

describe("payoffProgress — 1 − latest / first-recorded, integer percent", () => {
  it("0 when nothing has been paid", () => {
    expect(payoffProgress(100_000, 100_000)).toBe(0);
  });
  it("50 at half", () => {
    expect(payoffProgress(50_000, 100_000)).toBe(50);
  });
  it("100 when fully paid", () => {
    expect(payoffProgress(0, 100_000)).toBe(100);
  });
  it("clamps to 0 when the balance has grown past the first recorded one", () => {
    expect(payoffProgress(120_000, 100_000)).toBe(0);
  });
  it("null when the first recorded balance is 0 — no percentage is invented", () => {
    expect(payoffProgress(0, 0)).toBeNull();
  });
  it("rounds half up to a whole percent", () => {
    // 1 − 33_670 / 100_000 = 66.33% → 66; 1 − 33_500 / 100_000 = 66.5% → 67
    expect(payoffProgress(33_670, 100_000)).toBe(66);
    expect(payoffProgress(33_500, 100_000)).toBe(67);
  });
});

describe("monthLabel", () => {
  it("renders YYYY-MM as `Mon YYYY`", () => {
    expect(monthLabel("2030-07")).toBe("Jul 2030");
    expect(monthLabel("2077-01")).toBe("Jan 2077");
  });
});

describe("ratePct", () => {
  it("renders basis points with two decimals, integer arithmetic only (v7 §11)", () => {
    expect(ratePct(0)).toBe("0.00%");
    expect(ratePct(1)).toBe("0.01%");
    expect(ratePct(350)).toBe("3.50%");
    expect(ratePct(1800)).toBe("18.00%");
  });
});
