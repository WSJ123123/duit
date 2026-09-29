import { describe, it, expect } from "vitest";
import { fundDrawLine, fundSpendLine, sinkingReserveRow, thisMonthNeedsWrite } from "@/lib/funds-display";
import type { FundRow } from "@/db/funds";

/**
 * The transaction form's fund line (mockup v6 §10 phone 3). Pure money math
 * on a client surface, so it lives in this non-"use client" module and is
 * tested here rather than eyeballed in the sheet (finding #20).
 */
describe("fundDrawLine", () => {
  it("new tag: subtracts the amount from the fund's current balance", () => {
    expect(fundDrawLine({ fund_balance_sen: 120_000, amount_sen: 9_000, already_drawn_sen: 0 })).toEqual({
      text: "Draws RM 90.00 from the fund · balance RM 1,110.00 after this.",
      over_drawn: false,
    });
  });

  it("PIN: editing an already-tagged expense does not subtract the draw twice", () => {
    // The fund's derived balance already has the old 9000 out of it. Re-saving
    // the same amount must leave the balance where it is, not 9000 lower.
    expect(
      fundDrawLine({ fund_balance_sen: 111_000, amount_sen: 9_000, already_drawn_sen: 9_000 }),
    ).toEqual({ text: "Draws RM 90.00 from the fund · balance RM 1,110.00 after this.", over_drawn: false });
    // Raising the amount by 1000 moves the balance by exactly 1000.
    expect(
      fundDrawLine({ fund_balance_sen: 111_000, amount_sen: 10_000, already_drawn_sen: 9_000 }),
    ).toEqual({ text: "Draws RM 100.00 from the fund · balance RM 1,100.00 after this.", over_drawn: false });
  });

  it("ruling 9: an over-draw is named, not hidden and not blocked", () => {
    expect(fundDrawLine({ fund_balance_sen: 111_000, amount_sen: 118_000, already_drawn_sen: 0 })).toEqual({
      text: "Draws RM 1,180.00 from the fund · RM 70.00 more than it holds.",
      over_drawn: true,
    });
  });

  it("no amount typed yet: still shows the balance (tips-off density rule)", () => {
    expect(fundDrawLine({ fund_balance_sen: 111_000, amount_sen: 0, already_drawn_sen: 0 })).toEqual({
      text: "Fund balance RM 1,110.00.",
      over_drawn: false,
    });
  });

  it("an already over-drawn fund reads critical before anything is typed", () => {
    expect(fundDrawLine({ fund_balance_sen: -7_000, amount_sen: 0, already_drawn_sen: 0 })).toEqual({
      text: "Fund balance −RM 70.00.",
      over_drawn: true,
    });
  });
});

/**
 * Ruling 20's `Sinking fund reserve` row (mockup v6 §9 right fragment). The
 * figures below are v6's own demo data: RM 15,550 across 4 active funds with
 * an emergency fund at 3.7 of 6.0 months.
 */
function fund(over: Partial<FundRow>): FundRow {
  return {
    id: "f1",
    name: "Fund",
    kind: "sinking",
    target_sen: null,
    target_months: null,
    target_date: null,
    monthly_contribution_sen: 0,
    priority: 0,
    archived: false,
    balance_sen: 0,
    resolved_target_sen: null,
    progress_pct: null,
    status: "on_track",
    behind_by_sen: 0,
    required_monthly_sen: null,
    contribution_sen: 0,
    contribution_applied: false,
    ...over,
  };
}

const AVG = 309_000; // RM 3,090 average monthly expense

describe("sinkingReserveRow (ruling 20)", () => {
  it("renders v6's row: the active total plus the count and emergency coverage", () => {
    const funds = [
      fund({ id: "e", name: "Emergency fund", kind: "emergency", target_months: 6, balance_sen: 1_143_300 }),
      fund({ id: "a", name: "Car" }),
      fund({ id: "b", name: "Travel" }),
      fund({ id: "c", name: "Laptop" }),
    ];
    expect(sinkingReserveRow(funds, 1_555_000, AVG)).toEqual({
      total_sen: 1_555_000,
      sub: "4 active funds · emergency 3.7 of 6.0 months",
    });
  });

  it("takes the total it is GIVEN — never re-sums the fund rows", () => {
    // total_saved_sen is getFunds' own ruling-9a figure (active funds, paged
    // history). A second sum here would be a second source of truth that can
    // drift from the Goals hero.
    const funds = [fund({ id: "a", name: "Car", balance_sen: 1 })];
    expect(sinkingReserveRow(funds, 999_999, AVG)!.total_sen).toBe(999_999);
  });

  it("may read negative — an over-drawn fund is shown, not hidden (ruling 9)", () => {
    expect(sinkingReserveRow([fund({ name: "Car", balance_sen: -7_000 })], -7_000, AVG)).toEqual({
      total_sen: -7_000,
      sub: "1 active fund",
    });
  });

  it("is null with no active funds — an RM 0.00 row would be noise, not disclosure", () => {
    expect(sinkingReserveRow([], 0, AVG)).toBeNull();
  });

  it("drops the coverage clause when there is no expense history to divide by", () => {
    const funds = [fund({ id: "e", name: "Emergency fund", kind: "emergency", target_months: 6, balance_sen: 50_000 })];
    expect(sinkingReserveRow(funds, 50_000, 0)).toEqual({ total_sen: 50_000, sub: "1 active fund" });
  });

  it("states plain months when the emergency fund has no months target", () => {
    const funds = [fund({ id: "e", name: "Emergency fund", kind: "emergency", balance_sen: 618_000 })];
    expect(sinkingReserveRow(funds, 618_000, AVG)).toEqual({
      total_sen: 618_000,
      sub: "1 active fund · emergency 2.0 months",
    });
  });
});

/**
 * F2 — the fund edit dialog silently discarded a "This month" figure and
 * reported success. `contribution_sen` is the stored row OR the monthly
 * fallback, and comparing the field against it skipped the write on exactly
 * the sequence smoke steps 5.1/5.3 walk.
 */
describe("thisMonthNeedsWrite (ruling 10, the edit dialog's write gate)", () => {
  it("F2 REPRODUCTION: raising Monthly while leaving This month must WRITE", () => {
    // Unapplied month, so contribution_sen IS the old monthly fallback (100).
    // The owner raises Monthly to 200 and leaves This month at 100. Without a
    // write the month falls back to the NEW 200 — silently, everywhere.
    expect(
      thisMonthNeedsWrite({
        contribution_applied: false,
        contribution_sen: 10_000,
        monthly_contribution_sen: 20_000,
        this_month_sen: 10_000,
      }),
    ).toBe(true);
  });

  it("writes nothing when an untouched dialog is saved on an unapplied month", () => {
    // Ruling 4: an earmark is never a surprise. Editing only the name must not
    // materialise a fund_contributions row (it would hide the Apply banner).
    expect(
      thisMonthNeedsWrite({
        contribution_applied: false,
        contribution_sen: 10_000,
        monthly_contribution_sen: 10_000,
        this_month_sen: 10_000,
      }),
    ).toBe(false);
  });

  it("writes nothing when This month is raised to match the new Monthly", () => {
    expect(
      thisMonthNeedsWrite({
        contribution_applied: false,
        contribution_sen: 10_000,
        monthly_contribution_sen: 20_000,
        this_month_sen: 20_000,
      }),
    ).toBe(false);
  });

  it("an APPLIED month compares against the stored row, which Monthly cannot move", () => {
    // The stored row wins over the fallback (ruling 10), so changing Monthly
    // leaves this month alone and no write is needed…
    expect(
      thisMonthNeedsWrite({
        contribution_applied: true,
        contribution_sen: 10_000,
        monthly_contribution_sen: 20_000,
        this_month_sen: 10_000,
      }),
    ).toBe(false);
    // …and editing the field itself still writes.
    expect(
      thisMonthNeedsWrite({
        contribution_applied: true,
        contribution_sen: 10_000,
        monthly_contribution_sen: 10_000,
        this_month_sen: 15_000,
      }),
    ).toBe(true);
  });

  it("zero is a real override, not an absent value", () => {
    expect(
      thisMonthNeedsWrite({
        contribution_applied: false,
        contribution_sen: 10_000,
        monthly_contribution_sen: 10_000,
        this_month_sen: 0,
      }),
    ).toBe(true);
  });
});

/**
 * Q7: the Dashboard's spending-by-category card gains the Budget page's
 * one-line disclosure of the term those category totals drop. It is DATA, not
 * a Tip (it stays with tips off), and it names `incl. archived funds` because
 * ruling 4 makes the Goals hero's drawn figure ACTIVE-only — two same-named
 * numbers must never look like one.
 */
describe("fundSpendLine", () => {
  it("names the figure and says which funds it counts", () => {
    expect(fundSpendLine(13_000)).toBe("Paid from funds RM 130.00 · incl. archived funds");
  });

  it("is hidden when no fund-paid spend exists this month", () => {
    expect(fundSpendLine(0)).toBeNull();
  });

  // The Budget page hides its own line at `<= 0`; the dashboard matches it, so
  // a net-negative sum (a refund larger than the month's fund-paid spend)
  // cannot print `Paid from funds RM -x` here while the Budget page shows none.
  it("is hidden when the sum is negative, exactly as the Budget page hides it", () => {
    expect(fundSpendLine(-1)).toBeNull();
    expect(fundSpendLine(-13_000)).toBeNull();
  });
});
