import { describe, it, expect } from "vitest";
import {
  fundBalanceSen,
  resolveTargetSen,
  progressPct,
  requiredMonthlySen,
  fundStatus,
  monthsToFillAtRate,
  monthsBetween,
  buildWaterfall,
  type FundLike,
} from "@/lib/funds";

/**
 * Plan 7 Task 2 — pure fund math (rulings 1, 3, 5, 9, 10).
 *
 * The worked examples come from mockup v6 §7 (desktop Goals): today
 * 2026-08-19, average monthly expense RM 3,090. Every figure the mockup
 * renders is reproduced here to the sen, so the lib and the approved screen
 * cannot disagree.
 */

const TODAY = "2026-08-19";
const AVG = 309_000; // RM 3,090 average monthly expense

// The mockup's four active funds, with ruling 5's derived balances.
const EMERGENCY: FundLike = {
  id: "f-emergency",
  name: "Emergency fund",
  kind: "emergency",
  target_sen: null,
  target_months: 6,
  target_date: null,
  monthly_contribution_sen: 40_000,
  priority: 0,
  balance_sen: 1_130_000,
};
const CAR: FundLike = {
  id: "f-car",
  name: "Car insurance & road tax",
  kind: "sinking",
  target_sen: 240_000,
  target_months: null,
  target_date: "2027-03-14",
  monthly_contribution_sen: 20_000,
  priority: 0,
  balance_sen: 111_000,
};
const JAPAN: FundLike = {
  id: "f-japan",
  name: "Travel · Japan",
  kind: "goal",
  target_sen: 800_000,
  target_months: null,
  target_date: "2027-03-20",
  monthly_contribution_sen: 30_000,
  priority: 0,
  balance_sen: 215_000,
};
const GADGET: FundLike = {
  id: "f-gadget",
  name: "Gadget replacement",
  kind: "sinking",
  target_sen: null,
  target_months: null,
  target_date: null,
  monthly_contribution_sen: 0,
  priority: 0,
  balance_sen: 99_000,
};
const MOCKUP_FUNDS = [EMERGENCY, CAR, JAPAN, GADGET];

describe("fundBalanceSen — ruling 5's identity", () => {
  it("is Σ contributions − Σ drawn", () => {
    expect(fundBalanceSen([40_000, 40_000, 40_000], [9_000])).toBe(111_000);
  });

  it("is 0 with nothing on either side", () => {
    expect(fundBalanceSen([], [])).toBe(0);
  });

  it("may be NEGATIVE — ruling 9 shows over-draw, never blocks it", () => {
    // RM 1,180 bill drawn from an RM 1,110 fund.
    expect(fundBalanceSen([111_000], [118_000])).toBe(-7_000);
  });
});

describe("resolveTargetSen — ruling 3's one-shape rule", () => {
  it("returns the absolute target when target_sen is set", () => {
    expect(resolveTargetSen(CAR, AVG)).toBe(240_000);
  });

  it("resolves target_months × average expense on the emergency fund (v6 §7)", () => {
    // 6 × RM 3,090 = RM 18,540 — the mockup's emergency target.
    expect(resolveTargetSen(EMERGENCY, AVG)).toBe(1_854_000);
  });

  it("returns null when the fund has no target at all", () => {
    expect(resolveTargetSen(GADGET, AVG)).toBeNull();
  });

  it("never resolves target_months on a non-emergency kind (the illegal combination)", () => {
    // The table check already forbids this; the lib refuses to invent a
    // target from it rather than silently resolving one.
    expect(
      resolveTargetSen({ kind: "sinking", target_sen: null, target_months: 6 }, AVG),
    ).toBeNull();
    expect(
      resolveTargetSen({ kind: "goal", target_sen: null, target_months: 6 }, AVG),
    ).toBeNull();
  });

  it("prefers the absolute target if both shapes somehow arrive together", () => {
    expect(
      resolveTargetSen({ kind: "emergency", target_sen: 500_000, target_months: 6 }, AVG),
    ).toBe(500_000);
  });

  it("returns null for a months target with no expense history yet (avg 0)", () => {
    // RM 0 is not a target: it would read as "reached" the day the account
    // is created. No history ⇒ no resolvable target.
    expect(resolveTargetSen(EMERGENCY, 0)).toBeNull();
  });
});

describe("progressPct — integer percent, never fabricated", () => {
  it("reproduces the mockup's three percentages", () => {
    expect(progressPct(1_130_000, 1_854_000)).toBe(61); // 60.95 → 61
    expect(progressPct(111_000, 240_000)).toBe(46); // 46.25 → 46
    expect(progressPct(215_000, 800_000)).toBe(27); // 26.875 → 27
  });

  it("is null with no target", () => {
    expect(progressPct(99_000, null)).toBeNull();
  });

  it("clamps at 0 for a negative balance", () => {
    expect(progressPct(-7_000, 240_000)).toBe(0);
  });

  it("is NOT clamped above 100 — an over-target fund reads honestly", () => {
    expect(progressPct(300_000, 250_000)).toBe(120);
  });
});

describe("monthsBetween — the calendar-month rule, defined once", () => {
  it("counts whole calendar months and ignores the day (v6: 7 months left)", () => {
    expect(monthsBetween(TODAY, "2027-03-14")).toBe(7);
    expect(monthsBetween(TODAY, "2027-03-20")).toBe(7);
    expect(monthsBetween("2026-08-01", "2027-03-31")).toBe(7);
  });

  it("is 0 inside the current month and negative once the date is past", () => {
    expect(monthsBetween(TODAY, "2026-08-01")).toBe(0);
    expect(monthsBetween(TODAY, "2026-08-31")).toBe(0);
    expect(monthsBetween(TODAY, "2026-07-10")).toBe(-1);
    expect(monthsBetween(TODAY, "2025-08-19")).toBe(-12);
  });
});

describe("requiredMonthlySen — ruling 3", () => {
  it("counts whole calendar months, ignoring the day of the month", () => {
    // 2026-08-19 → 2027-03-14 is (2027−2026)×12 + (3−8) = 7 months.
    // Travel · Japan: gap 585_000 over 7 months.
    expect(requiredMonthlySen(215_000, 800_000, TODAY, "2027-03-20")).toBe(83_571);
    // Car insurance: gap 129_000 over 7 months → 18_428.57 → 18_429.
    expect(requiredMonthlySen(111_000, 240_000, TODAY, "2027-03-14")).toBe(18_429);
  });

  it("is null without BOTH a target and a date", () => {
    expect(requiredMonthlySen(215_000, null, TODAY, "2027-03-20")).toBeNull();
    expect(requiredMonthlySen(215_000, 800_000, TODAY, null)).toBeNull();
    expect(requiredMonthlySen(99_000, null, TODAY, null)).toBeNull();
  });

  it("is 0 at target and above target", () => {
    expect(requiredMonthlySen(240_000, 240_000, TODAY, "2027-03-14")).toBe(0);
    expect(requiredMonthlySen(250_000, 240_000, TODAY, "2027-03-14")).toBe(0);
  });

  it("returns the WHOLE remaining gap when the date is already past", () => {
    expect(requiredMonthlySen(111_000, 240_000, TODAY, "2026-07-10")).toBe(129_000);
  });

  it("returns the WHOLE remaining gap when the date lands in the current month", () => {
    // Same month either side of today — 0 months remaining, "all of it, now".
    expect(requiredMonthlySen(111_000, 240_000, TODAY, "2026-08-31")).toBe(129_000);
    expect(requiredMonthlySen(111_000, 240_000, TODAY, "2026-08-01")).toBe(129_000);
  });
});

describe("fundStatus — the documented precedence, in order (Plan 8 ruling 3)", () => {
  // over_drawn → reached → behind (target_date < today) → paused → behind →
  // on_track. `paused` is only reachable while no target date has passed.

  it("1. over_drawn wins on a negative balance", () => {
    expect(fundStatus(-7_000, 240_000, 20_000, TODAY, "2027-03-14")).toEqual({
      status: "over_drawn",
      behind_by_sen: 0,
    });
  });

  it("1. a fund that is BOTH over-drawn and paused reports over_drawn", () => {
    expect(fundStatus(-7_000, 240_000, 0, TODAY, "2027-03-14")).toEqual({
      status: "over_drawn",
      behind_by_sen: 0,
    });
  });

  it("2. reached at or above a resolved target, even with no contribution", () => {
    expect(fundStatus(240_000, 240_000, 20_000, TODAY, "2027-03-14")).toEqual({
      status: "reached",
      behind_by_sen: 0,
    });
    expect(fundStatus(250_000, 240_000, 0, TODAY, "2027-03-14")).toEqual({
      status: "reached",
      behind_by_sen: 0,
    });
  });

  it("3. a PASSED target date with a zero contribution is behind by the WHOLE gap — never paused", () => {
    // Japan's date a year and a half ago. Nothing is contributed, but the
    // fund is not resting — it is late, and the whole remaining gap is due.
    expect(fundStatus(215_000, 800_000, 0, TODAY, "2026-03-20")).toEqual({
      status: "behind",
      behind_by_sen: 585_000,
    });
  });

  it("3. a passed date with a contribution is behind by gap − contribution", () => {
    expect(fundStatus(215_000, 800_000, 30_000, TODAY, "2026-03-20")).toEqual({
      status: "behind",
      behind_by_sen: 555_000,
    });
  });

  it("4. paused when the month's contribution is 0 and there is no date (v6: Gadget replacement)", () => {
    expect(fundStatus(99_000, null, 0, TODAY, null)).toEqual({
      status: "paused",
      behind_by_sen: 0,
    });
  });

  it("4. paused with a FUTURE date and a zero contribution — paused outranks behind only while the date is ahead", () => {
    // Required 83_571/mo, contributing nothing: paused, not behind.
    expect(fundStatus(215_000, 800_000, 0, TODAY, "2027-03-20")).toEqual({
      status: "paused",
      behind_by_sen: 0,
    });
    // A date later THIS month has not passed yet either.
    expect(fundStatus(215_000, 800_000, 0, TODAY, "2026-08-31")).toEqual({
      status: "paused",
      behind_by_sen: 0,
    });
  });

  it("5. behind by required − contribution (v6: Travel · Japan)", () => {
    // v6 renders "behind RM 536/mo" — RM 535.71 rounded for DISPLAY only.
    expect(fundStatus(215_000, 800_000, 30_000, TODAY, "2027-03-20")).toEqual({
      status: "behind",
      behind_by_sen: 53_571,
    });
  });

  it("6. on_track when the contribution covers the required figure (v6: Car insurance)", () => {
    expect(fundStatus(111_000, 240_000, 20_000, TODAY, "2027-03-14")).toEqual({
      status: "on_track",
      behind_by_sen: 0,
    });
  });

  it("6. on_track with a contribution but no target (nothing to be behind on)", () => {
    expect(fundStatus(99_000, null, 5_000, TODAY, null)).toEqual({
      status: "on_track",
      behind_by_sen: 0,
    });
  });

  it("6. on_track with a target but no date (v6: Emergency fund)", () => {
    expect(fundStatus(1_130_000, 1_854_000, 40_000, TODAY, null)).toEqual({
      status: "on_track",
      behind_by_sen: 0,
    });
  });
});

describe("monthsToFillAtRate — v6 §7 waterfall step 1", () => {
  it("is the number of whole contributions still needed to reach the target", () => {
    // ⚠ Gap 724_000 at RM 400/mo is 18.1 months, so 19 contributions are
    // needed — 18 × 40_000 = 720_000 leaves the fund 4_000 short. The mockup
    // renders "full in 18 months at this rate" (18.1 truncated); flagged to
    // the architect rather than rounded away here. See the task report.
    expect(monthsToFillAtRate(1_130_000, 1_854_000, 40_000)).toBe(19);
  });

  it("divides exactly when the gap is a whole multiple of the rate", () => {
    expect(monthsToFillAtRate(0, 80_000, 20_000)).toBe(4);
  });

  it("is null with no target, no positive rate, or the target already reached", () => {
    expect(monthsToFillAtRate(99_000, null, 5_000)).toBeNull();
    expect(monthsToFillAtRate(111_000, 240_000, 0)).toBeNull();
    expect(monthsToFillAtRate(240_000, 240_000, 20_000)).toBeNull();
    expect(monthsToFillAtRate(250_000, 240_000, 20_000)).toBeNull();
  });

  it("is null while the fund is over-drawn against no target", () => {
    expect(monthsToFillAtRate(-7_000, null, 20_000)).toBeNull();
  });
});

describe("buildWaterfall — ruling 10's four ordered steps", () => {
  const noneApplied = new Map<string, number>();

  it("(a) envelope > planned: the mockup's August, RM 300 left to invest", () => {
    const wf = buildWaterfall(MOCKUP_FUNDS, noneApplied, 120_000, AVG, TODAY);

    expect(wf.steps.map((s) => s.key)).toEqual(["emergency", "dated", "open", "invest"]);
    expect(wf.planned_total_sen).toBe(90_000);

    const [emergency, dated, open, invest] = wf.steps;
    expect(emergency!.funds.map((f) => f.id)).toEqual(["f-emergency"]);
    expect(emergency!.planned_sen).toBe(40_000);
    expect(emergency!.funded_sen).toBe(40_000);
    expect(emergency!.shortfall_sen).toBe(0);
    expect(emergency!.funds[0]!.status).toBe("on_track");

    // Ordering inside the step: priority, then target_date, then name.
    expect(dated!.funds.map((f) => f.id)).toEqual(["f-car", "f-japan"]);
    expect(dated!.planned_sen).toBe(50_000);
    expect(dated!.funded_sen).toBe(50_000);
    expect(dated!.funds[1]).toEqual({
      id: "f-japan",
      name: "Travel · Japan",
      planned_sen: 30_000,
      status: "behind",
      behind_by_sen: 53_571,
    });

    expect(open!.funds.map((f) => f.id)).toEqual(["f-gadget"]);
    expect(open!.planned_sen).toBe(0);
    expect(open!.funds[0]!.status).toBe("paused");

    expect(invest!.funds).toEqual([]);
    expect(invest!.planned_sen).toBe(30_000); // v6: RM 300 to investing
    expect(invest!.funded_sen).toBe(30_000);
    expect(wf.leftover_sen).toBe(30_000);
    expect(wf.steps.every((s) => s.shortfall_sen === 0)).toBe(true);
    expect(wf.steps.every((s) => !s.first_shortfall)).toBe(true);
  });

  it("(b) envelope = planned: nothing left to invest, no shortfall", () => {
    const wf = buildWaterfall(MOCKUP_FUNDS, noneApplied, 90_000, AVG, TODAY);
    expect(wf.planned_total_sen).toBe(90_000);
    expect(wf.leftover_sen).toBe(0);
    expect(wf.steps.map((s) => s.funded_sen)).toEqual([40_000, 50_000, 0, 0]);
    expect(wf.steps.map((s) => s.shortfall_sen)).toEqual([0, 0, 0, 0]);
  });

  it("(c) envelope < planned: the shortfall lands on the FIRST step that cannot be filled", () => {
    // Envelope 50_000: step 1 takes 40_000, step 2 wants 50_000 and gets 10_000.
    const wf = buildWaterfall(MOCKUP_FUNDS, noneApplied, 50_000, AVG, TODAY);
    const [emergency, dated, open, invest] = wf.steps;

    expect(emergency!.funded_sen).toBe(40_000);
    expect(emergency!.shortfall_sen).toBe(0);
    expect(emergency!.first_shortfall).toBe(false);

    expect(dated!.planned_sen).toBe(50_000);
    expect(dated!.funded_sen).toBe(10_000);
    expect(dated!.shortfall_sen).toBe(40_000);
    expect(dated!.first_shortfall).toBe(true);

    // Later steps simply fund 0 — only the first shortfall carries the flag.
    expect(open!.funded_sen).toBe(0);
    expect(open!.first_shortfall).toBe(false);
    expect(invest!.planned_sen).toBe(0);
    expect(invest!.funded_sen).toBe(0);
    expect(invest!.first_shortfall).toBe(false);
    expect(wf.leftover_sen).toBe(0);
  });

  it("(d) no budget month: envelope 0 is legal — steps still report planned amounts", () => {
    const wf = buildWaterfall(MOCKUP_FUNDS, noneApplied, 0, AVG, TODAY);
    expect(wf.planned_total_sen).toBe(90_000);
    expect(wf.steps.map((s) => s.planned_sen)).toEqual([40_000, 50_000, 0, 0]);
    expect(wf.steps.map((s) => s.funded_sen)).toEqual([0, 0, 0, 0]);
    expect(wf.steps.map((s) => s.shortfall_sen)).toEqual([40_000, 50_000, 0, 0]);
    expect(wf.steps.map((s) => s.first_shortfall)).toEqual([true, false, false, false]);
  });

  it("(e) no funds at all: the whole envelope is the remainder", () => {
    const wf = buildWaterfall([], noneApplied, 120_000, AVG, TODAY);
    expect(wf.planned_total_sen).toBe(0);
    expect(wf.steps.map((s) => s.funds.length)).toEqual([0, 0, 0, 0]);
    expect(wf.steps.map((s) => s.planned_sen)).toEqual([0, 0, 0, 120_000]);
    expect(wf.leftover_sen).toBe(120_000);
  });

  it("(f) a stored contribution differing from monthly_contribution_sen — the STORED row wins", () => {
    // Applied at RM 400, then hand-edited to RM 250: the waterfall must
    // describe the month the way the "This month" card does.
    const applied = new Map<string, number>([
      ["f-emergency", 25_000],
      ["f-car", 20_000],
      ["f-japan", 30_000],
      ["f-gadget", 0],
    ]);
    const wf = buildWaterfall(MOCKUP_FUNDS, applied, 120_000, AVG, TODAY);
    expect(wf.steps[0]!.planned_sen).toBe(25_000);
    expect(wf.steps[0]!.funds[0]!.planned_sen).toBe(25_000);
    expect(wf.planned_total_sen).toBe(75_000);
    expect(wf.leftover_sen).toBe(45_000);
  });

  it("(f) a stored 0 beats a non-zero monthly_contribution_sen (paused this month)", () => {
    const applied = new Map<string, number>([["f-car", 0]]);
    const wf = buildWaterfall([CAR], applied, 120_000, AVG, TODAY);
    expect(wf.steps[1]!.planned_sen).toBe(0);
    expect(wf.steps[1]!.funds[0]!.status).toBe("paused");
  });

  it("(g) a fund past its target is NOT capped and reports `reached`", () => {
    const full: FundLike = { ...CAR, balance_sen: 300_000 };
    const wf = buildWaterfall([full], noneApplied, 120_000, AVG, TODAY);
    expect(wf.steps[1]!.planned_sen).toBe(20_000); // no cap at the 0 remaining gap
    expect(wf.steps[1]!.funds[0]!.status).toBe("reached");
    expect(wf.leftover_sen).toBe(100_000);
  });

  it("an emergency fund WITH a target_date stays in step 1", () => {
    const dated: FundLike = { ...EMERGENCY, target_date: "2027-01-31" };
    const wf = buildWaterfall([dated, CAR], noneApplied, 120_000, AVG, TODAY);
    expect(wf.steps[0]!.funds.map((f) => f.id)).toEqual(["f-emergency"]);
    expect(wf.steps[1]!.funds.map((f) => f.id)).toEqual(["f-car"]);
  });

  it("orders inside a step by priority, then target_date (nulls last), then name", () => {
    const mk = (
      id: string,
      name: string,
      priority: number,
      target_date: string | null,
    ): FundLike => ({
      ...GADGET,
      id,
      name,
      priority,
      target_date,
      monthly_contribution_sen: 1_000,
    });
    const wf = buildWaterfall(
      [
        mk("d", "Zulu", 1, null),
        mk("c", "Alpha", 1, null),
        mk("b", "Bravo", 1, "2027-01-01"),
        mk("a", "Yankee", 0, null),
      ],
      noneApplied,
      120_000,
      AVG,
      TODAY,
    );
    // All four are non-emergency; only "b" has a date, so it is alone in
    // step 2 and the other three order inside step 3.
    expect(wf.steps[1]!.funds.map((f) => f.id)).toEqual(["b"]);
    expect(wf.steps[2]!.funds.map((f) => f.id)).toEqual(["a", "c", "d"]);
  });

  it("puts a dated fund before an undated one at equal priority (nulls last)", () => {
    // Step 1 is the only step that can hold both shapes at once, so it is the
    // only place the nulls-last branch is reachable. Asserted from both input
    // orders, so neither side of the comparison can be dropped unnoticed.
    const dated: FundLike = { ...EMERGENCY, id: "dated", name: "Zulu", target_date: "2027-01-31" };
    const undated: FundLike = { ...EMERGENCY, id: "undated", name: "Alpha", target_date: null };
    expect(
      buildWaterfall([undated, dated], new Map(), 0, AVG, TODAY).steps[0]!.funds.map((f) => f.id),
    ).toEqual(["dated", "undated"]);
    expect(
      buildWaterfall([dated, undated], new Map(), 0, AVG, TODAY).steps[0]!.funds.map((f) => f.id),
    ).toEqual(["dated", "undated"]);
  });

  it("keeps the dated step ordered by date before name", () => {
    const early: FundLike = { ...JAPAN, id: "early", name: "Zulu", target_date: "2026-12-01" };
    const late: FundLike = { ...CAR, id: "late", name: "Alpha", target_date: "2027-06-01" };
    const wf = buildWaterfall([late, early], new Map(), 0, AVG, TODAY);
    expect(wf.steps[1]!.funds.map((f) => f.id)).toEqual(["early", "late"]);
  });
});
