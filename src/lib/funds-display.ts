// Pure fund display helpers — shared by server pages (goals/page.tsx) and
// client components (FundsTable.tsx, SavingsWaterfall.tsx), the same split
// src/lib/pl-display.ts already establishes for holdings. Required split,
// not a style choice: a plain function exported from a "use client" module
// (FundsTable.tsx, where these first lived) cannot be CALLED from a server
// component — Next's RSC boundary turns it into a client reference that can
// only be rendered as JSX, and it throws at request time, not at typecheck
// or build. Caught by the Task 3 manual verification script, not by any
// gate — moved here so every caller, server or client, can call these
// directly.
import { monthsBetween, monthsToFillAtRate, type FundKind, type FundStatus, type WaterfallStep } from "@/lib/funds";
import { formatSen } from "@/lib/money";
import type { FundRow } from "@/db/funds";

export const KIND_LABEL: Record<FundKind, string> = { emergency: "emergency", sinking: "sinking", goal: "goal" };

/** "14 Mar 2027" — day-month-year, matching mockup v6's date treatment
 *  (HoldingsTable's dayMonthLabel omits the year; funds need it since a
 *  target date can be well over a year out). */
export function formatDMY(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * F4 fix: "overdue" must key on the actual calendar date (`target_date <
 * todayIso`, plain ISO string comparison), NOT on `monthsBetween <= 0` —
 * `monthsBetween` ignores day-of-month, so the old check called a fund
 * overdue for the entire remainder of its own due month, up to 30 days
 * before it actually was. `monthsBetween`/`requiredMonthlySen` are
 * deliberately untouched: their calendar-month granularity is correct for
 * "how many months left" and for "all of it, now" once under a month
 * remains — only the overdue BOOLEAN needed day precision. Single source for
 * that boolean (was duplicated between this file's monthsLeftText and
 * nextTargetLine, the exact hazard ruling 3 warns about).
 */
function isOverdue(target_date: string, todayIso: string): boolean {
  return target_date < todayIso;
}

/**
 * "overdue" once the date has actually passed (see `isOverdue`) — carry-in
 * #3: a passed target date says so regardless of the fund's status pill.
 *
 * R2-3 fix: a target dated later in the CURRENT calendar month used to read
 * "0 months left", which is technically what `monthsBetween` returns but
 * means nothing to a person. `target_date === todayIso` and "later this
 * month" are both real, distinct states now — `monthsBetween` itself is
 * still untouched (its calendar-month granularity is right for every other
 * caller; only this display text needed the day-level distinction).
 */
export function monthsLeftText(target_date: string, todayIso: string): string {
  if (isOverdue(target_date, todayIso)) return "overdue";
  if (target_date === todayIso) return "due today";
  const months = monthsBetween(todayIso, target_date);
  if (months === 0) return "due this month";
  return `${months} month${months === 1 ? "" : "s"} left`;
}

/** F5 fix: one decimal, integer-safe (tenths rounded before dividing back) —
 *  the "3.7 of 6.0 months" / "6.0 × RM 3,090" figures. Single source; this
 *  formula was written three times across this file's functions. */
function oneDecimal(numeratorSen: number, denominatorSen: number): string {
  const tenths = Math.round((numeratorSen * 10) / denominatorSen);
  return (tenths / 10).toFixed(1);
}

/**
 * The funds table's per-row functional sub-line (never a Tip — it carries
 * the target shape and the date status, both data).
 *
 * Ruling 3's coupling disclosure (F3): fund-paid bills stay inside the
 * trailing average (ruling 7), so a months-based emergency target
 * over-provides by however much of that average was actually paid from a
 * fund — deliberately not fixed in this plan, disclosed instead, on this
 * exact line, in ruling 3's own quoted format ("6.0 × RM 3,090 avg · RM x/mo
 * of that was paid from funds"). Shown only when the coupling is actually
 * live (`avgMonthlyFundPaidExpenseSen > 0`): at zero there is no
 * over-provision to warn about and the plain line is already fully accurate
 * — an explicit "RM 0.00/mo" clause would be noise, not honesty.
 */
export function fundSubLine(
  fund: FundRow,
  avgMonthlyExpenseSen: number,
  avgMonthlyFundPaidExpenseSen: number,
  todayIso: string,
): string {
  const parts: string[] = [];
  if (fund.kind === "emergency" && fund.target_months !== null) {
    if (avgMonthlyExpenseSen > 0) {
      parts.push(`${fund.target_months.toFixed(1)} × ${formatSen(avgMonthlyExpenseSen)} avg`);
      if (avgMonthlyFundPaidExpenseSen > 0) {
        parts.push(`${formatSen(avgMonthlyFundPaidExpenseSen)}/mo of that was paid from funds`);
      }
    } else {
      parts.push(`${fund.target_months.toFixed(1)} months of expenses`);
    }
  }
  if (fund.target_date !== null) {
    parts.push(`due ${formatDMY(fund.target_date)}`, monthsLeftText(fund.target_date, todayIso));
  } else {
    parts.push("no target date");
  }
  return parts.join(" · ");
}

/** Ruling 9's over_drawn line lives in the pill itself (a functional, always-
 *  visible line naming the shortfall), compact like the mockup's own
 *  "behind RM 536/mo" pill text. */
export function statusPillText(fund: FundRow): string {
  if (fund.status === "behind") return `behind ${formatSen(fund.behind_by_sen)}/mo`;
  if (fund.status === "over_drawn") return `over-drawn ${formatSen(Math.abs(fund.balance_sen))}`;
  if (fund.status === "reached") return "target reached";
  if (fund.status === "paused") return "paused";
  return "on track";
}

export function statusPillColor(fund: FundRow): string | undefined {
  if (fund.status === "on_track" || fund.status === "reached") return "var(--good-text)";
  if (fund.status === "behind") return "var(--warning)";
  if (fund.status === "over_drawn") return "var(--critical)";
  return undefined;
}

export function progressBarColor(status: FundStatus): string {
  if (status === "behind") return "var(--warning)";
  if (status === "reached") return "var(--good)";
  if (status === "over_drawn") return "var(--critical)";
  return "var(--accent)";
}

/** The nearest fund with a target_date, priority-agnostic (this stat is
 *  about calendar urgency, not waterfall order) — ties broken by name. */
export function pickNearestDatedFund(funds: FundRow[]): (FundRow & { target_date: string }) | undefined {
  const dated = funds.filter((f): f is FundRow & { target_date: string } => f.target_date !== null);
  return dated.sort((a, b) =>
    a.target_date === b.target_date ? a.name.localeCompare(b.name) : a.target_date < b.target_date ? -1 : 1,
  )[0];
}

/** The strip's "Next target" sub-line: names the SAME fund the date belongs
 *  to (mockup v6's demo data pairs the nearest date with a different fund's
 *  status, which doesn't reconcile to one number — the internally-consistent
 *  minimal choice per rule 7) and always surfaces an overdue date (carry-in
 *  #3, via the same `isOverdue` the rest of this file uses), appended to the
 *  behind/over_drawn text rather than replacing it. */
export function nextTargetLine(fund: FundRow, todayIso: string): { text: string; color?: string } {
  const overdue = fund.target_date !== null && isOverdue(fund.target_date, todayIso);
  if (fund.status === "behind") {
    return {
      text: `${fund.name} · behind ${formatSen(fund.behind_by_sen)}/mo${overdue ? " · overdue" : ""}`,
      color: "var(--warning)",
    };
  }
  if (fund.status === "over_drawn") {
    return {
      text: `${fund.name} · over-drawn ${formatSen(Math.abs(fund.balance_sen))}${overdue ? " · overdue" : ""}`,
      color: "var(--critical)",
    };
  }
  if (overdue) return { text: `${fund.name} · overdue`, color: "var(--critical)" };
  const monthsText = fund.target_date !== null ? monthsLeftText(fund.target_date, todayIso) : "";
  return { text: `${fund.name} · ${monthsText}` };
}

export function pickEmergencyFund(funds: FundRow[]): FundRow | undefined {
  return funds.find((f) => f.kind === "emergency");
}

/** The "3.7 of 6.0 months" stat. Guards the zero-expense-history denominator. */
export function monthsCoverageText(fund: FundRow, avgMonthlyExpenseSen: number): { current: string; target: string } {
  if (avgMonthlyExpenseSen <= 0) return { current: "—", target: "—" };
  const current = oneDecimal(Math.max(0, fund.balance_sen), avgMonthlyExpenseSen);
  if (fund.target_months !== null) return { current, target: fund.target_months.toFixed(1) };
  if (fund.resolved_target_sen !== null) {
    return { current, target: oneDecimal(fund.resolved_target_sen, avgMonthlyExpenseSen) };
  }
  return { current, target: "—" };
}

/**
 * Ruling 10, on the fund edit dialog: does the "This month" figure have to be
 * written as its own `fund_contributions` row, or would the month land on that
 * figure anyway?
 *
 * ⚠ `FundRow.contribution_sen` is the stored row **or** the
 * `monthly_contribution_sen` FALLBACK, and the dialog prefills the field from
 * it. Comparing the field against it to decide whether to write is therefore
 * wrong on an unapplied month, because the fallback MOVES when the same save
 * changes Monthly contribution: raising monthly to RM 200 while leaving "This
 * month" at RM 100 compared 100 to 100, skipped the write, and let the month
 * silently follow the new RM 200 through the waterfall, the "This month"
 * card, the Budget savings row and what Apply writes — against a field whose
 * own Tip promises "Overrides just this month".
 *
 * So the comparison is against what the month would actually resolve to with
 * no write: the STORED row when one exists, and otherwise the monthly figure
 * being saved right now (`monthly_contribution_sen`, not the fund's old one).
 * That also keeps ruling 4's promise that an earmark is never a surprise —
 * saving an untouched dialog on an unapplied month still writes nothing.
 */
export function thisMonthNeedsWrite(args: {
  /** True once a `fund_contributions` row exists for the month. */
  contribution_applied: boolean;
  /** `FundRow.contribution_sen` — the stored row, or the old fallback. */
  contribution_sen: number;
  /** The monthly contribution being SAVED by this same submit. */
  monthly_contribution_sen: number;
  /** What the owner left in the "This month" field. */
  this_month_sen: number;
}): boolean {
  const withoutWrite = args.contribution_applied
    ? args.contribution_sen
    : args.monthly_contribution_sen;
  return args.this_month_sen !== withoutWrite;
}

/**
 * Ruling 20's `Sinking fund reserve` row for Investments › Allocation plan
 * (mockup v6 §9 right fragment): the summed balance of ALL ACTIVE funds with
 * a functional sub-line naming the fund count and the emergency fund's
 * months-of-expenses coverage.
 *
 * `totalSavedSen` is `FundsData.total_saved_sen` — active funds only (ruling
 * 9a), the same figure the Goals hero shows, never re-summed here. Null when
 * there is no active fund: an "RM 0.00 · 0 active funds" row would be noise,
 * not disclosure. May be NEGATIVE when a fund is over-drawn (ruling 9).
 *
 * Lives in this non-`"use client"` module (finding #20) because a server page
 * computes it and a client component renders it.
 */
export function sinkingReserveRow(
  activeFunds: FundRow[],
  totalSavedSen: number,
  avgMonthlyExpenseSen: number,
): { total_sen: number; sub: string } | null {
  if (activeFunds.length === 0) return null;
  const parts = [`${activeFunds.length} active fund${activeFunds.length === 1 ? "" : "s"}`];
  const emergency = pickEmergencyFund(activeFunds);
  if (emergency !== undefined) {
    const { current, target } = monthsCoverageText(emergency, avgMonthlyExpenseSen);
    // "—" means there is no expense history to divide by, so there is no
    // coverage figure to state — the count alone stays true.
    if (current !== "—") {
      parts.push(
        target === "—" ? `emergency ${current} months` : `emergency ${current} of ${target} months`,
      );
    }
  }
  return { total_sen: totalSavedSen, sub: parts.join(" · ") };
}

/** Fund-detail line used inside the savings waterfall (SavingsWaterfall.tsx,
 *  desktop's single-fund step and mobile's per-fund cards) — carry-in #1:
 *  monthsToFillAtRate is the ONLY source for "full in N months at this
 *  rate", never re-derived. This is the "3.7 of 6.0 months" PROGRESS ratio
 *  (matching mockup v6 §10 ph1's phone card exactly), a different display
 *  from fundSubLine's "6.0 × RM avg" TARGET-DERIVATION line above — ruling
 *  3's coupling disclosure belongs to that one, not this one. */
export function fundDetailLine(
  fund: FundRow,
  planned_sen: number,
  avgMonthlyExpenseSen: number,
  todayIso: string,
): string {
  const parts: string[] = [];
  if (fund.resolved_target_sen !== null) {
    parts.push(`${formatSen(fund.balance_sen)} of ${formatSen(fund.resolved_target_sen)}`);
    if (fund.kind === "emergency" && fund.target_months !== null && avgMonthlyExpenseSen > 0) {
      parts.push(`${oneDecimal(Math.max(0, fund.balance_sen), avgMonthlyExpenseSen)} of ${fund.target_months.toFixed(1)} months`);
    }
    const fillMonths = monthsToFillAtRate(fund.balance_sen, fund.resolved_target_sen, planned_sen);
    if (fillMonths !== null) parts.push(`full in ${fillMonths} month${fillMonths === 1 ? "" : "s"} at this rate`);
  }
  if (fund.target_date !== null) {
    parts.push(`due ${formatDMY(fund.target_date)}`, monthsLeftText(fund.target_date, todayIso));
  } else if (fund.resolved_target_sen === null) {
    parts.push("no target date");
  }
  return parts.join(" · ");
}

/** Per-fund mobile card line (mockup v6 §10 ph1) — `fundDetailLine`'s
 *  balance/target/date detail plus the same status text the desktop pill
 *  shows (F2: mobile has no funds table, so every fund needs its own status
 *  home, not just the funds sharing a waterfall step). Single source with
 *  the desktop pill (`statusPillText`/`statusPillColor`) — same vocabulary,
 *  same color, so the two surfaces cannot drift. */
export function fundCardLine(
  fund: FundRow,
  avgMonthlyExpenseSen: number,
  todayIso: string,
): { text: string; color?: string } {
  const detail = fundDetailLine(fund, fund.contribution_sen, avgMonthlyExpenseSen, todayIso);
  return { text: `${detail} · ${statusPillText(fund)}`, color: statusPillColor(fund) };
}

/**
 * The fund picker's functional line on the transaction form (mockup v6 §10
 * phone 3): `Draws RM 90 from the fund · balance RM 1,110 after this.`
 *
 * `already_drawn_sen` is what THIS transaction currently draws from THIS fund
 * — 0 for a new tag, `tx.amount_sen` when editing an expense that is already
 * tagged to the fund being shown. Without it, editing a tagged expense would
 * subtract the draw twice: the fund's stored balance already has the old
 * amount out of it (ruling 5's balance is derived from the tagged rows).
 *
 * Ruling 9: a draw larger than the fund holds is DESCRIBED, never blocked —
 * `over_drawn` lets the caller color the line critical (v6 does not draw this
 * state on the sheet; naming the shortfall is the minimal consistent choice).
 */
export function fundDrawLine(args: {
  fund_balance_sen: number;
  amount_sen: number;
  already_drawn_sen: number;
}): { text: string; over_drawn: boolean } {
  const after = args.fund_balance_sen + args.already_drawn_sen - args.amount_sen;
  if (args.amount_sen <= 0) {
    return { text: `Fund balance ${formatSen(args.fund_balance_sen)}.`, over_drawn: args.fund_balance_sen < 0 };
  }
  const draws = `Draws ${formatSen(args.amount_sen)} from the fund`;
  return after < 0
    ? { text: `${draws} · ${formatSen(Math.abs(after))} more than it holds.`, over_drawn: true }
    : { text: `${draws} · balance ${formatSen(after)} after this.`, over_drawn: false };
}

/**
 * Q7's one-line disclosure of the term a spending-by-category total drops
 * (ruling 7 keeps fund-paid spend out of `spend_by_category`, and only out of
 * that). The Budget page has carried it since Plan 7; the Dashboard's card
 * shows the same split inside one screen and had no disclosure at all.
 *
 * Null at or below zero — a line reading RM 0 would be noise on a month with
 * no fund-paid spend, and `Paid from funds RM -x` would be worse. `> 0` is
 * the Budget page's own guard (`BudgetTable.tsx`, `BudgetMobile.tsx`), so the
 * two surfaces cannot disagree about when the line exists. DATA, not a Tip:
 * it stays visible with tips off.
 *
 * `incl. archived funds` is load-bearing, not decoration. `fund_spend_sen`
 * counts every fund-tagged expense because archiving never untags one
 * (ruling 9a), while ruling 4 makes the Goals hero's drawn figure ACTIVE-only
 * — two same-named numbers that must never look like one.
 */
export function fundSpendLine(fund_spend_sen: number): string | null {
  if (!(fund_spend_sen > 0)) return null;
  return `Paid from funds ${formatSen(fund_spend_sen)} · incl. archived funds`;
}

/** The desktop waterfall's line for a step with zero or several funds (a
 *  one-fund step gets `fundDetailLine`). Moved from SavingsWaterfall.tsx
 *  (Plan 9): a sentence carrying figures is built here and reaches the screen
 *  through `<MoneyText>`, since the money fence keeps the formatters out of
 *  components. */
export function multiFundLine(step: WaterfallStep): string {
  if (step.funds.length === 0) return "nothing in this step yet";
  return step.funds
    .map((f) => (f.planned_sen > 0 ? `${f.name} ${formatSen(f.planned_sen)}` : `${f.name} · paused this month`))
    .join(" · ");
}
