/**
 * Pure budget math — no I/O, no clock: every date is a parameter. Integer sen
 * arithmetic only; percent boundaries compared without floats.
 */

import { nextRunAfter, type RecurringSchedule } from "@/lib/recurring";

export type Tag = "needs" | "wants" | "savings";
export type MeterState = "ok" | "warn" | "over";

function daysInMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the next month is this month's last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Roll subcategory spend up to top-level categories. Keys of `spend` are
 *  category ids or null (uncategorized); null stays null. A parentless
 *  category is its own top level. */
export function rollupToParents(
  spend: Map<string | null, number>,
  categories: Array<{ id: string; parent_id: string | null }>,
): Map<string | null, number> {
  const parentOf = new Map<string, string>();
  for (const c of categories) {
    parentOf.set(c.id, c.parent_id ?? c.id);
  }
  const rolled = new Map<string | null, number>();
  for (const [key, sen] of spend) {
    const top = key === null ? null : parentOf.get(key) ?? key;
    rolled.set(top, (rolled.get(top) ?? 0) + sen);
  }
  return rolled;
}

/** ok < 85% <= warn <= 100% < over; spent > 0 with allocated 0 => over. */
export function meterState(spent_sen: number, allocated_sen: number): MeterState {
  if (allocated_sen === 0) return spent_sen > 0 ? "over" : "ok";
  if (spent_sen > allocated_sen) return "over";
  if (spent_sen * 100 >= allocated_sen * 85) return "warn";
  return "ok";
}

/** expected − Σ allocations − savings. Negative = over-allocated (warn UI). */
export function unassignedSen(
  expected_income_sen: number,
  allocation_sens: number[],
  savings_sen: number,
): number {
  let allocated = 0;
  for (const sen of allocation_sens) allocated += sen;
  return expected_income_sen - allocated - savings_sen;
}

/** "Set aside so far": max(0, income − net expense), integer sen. */
export function setAsideSen(income_sen: number, expense_sen: number): number {
  return Math.max(0, income_sen - expense_sen);
}

/**
 * Plan 7 ruling 4 / mockup v6 §9 middle fragment: how the month's savings
 * envelope divides between the named funds and what is left unassigned
 * ("available to invest"). Same shape as the waterfall's step-4 remainder —
 * `max(0, …)`, because over-planning the envelope is disclosed on the Goals
 * page, not turned into a negative on the Budget page. Shared by the desktop
 * and mobile Budget surfaces so the two cannot show different numbers.
 */
export function fundEnvelopeSplit(
  fund_contribution_sens: number[],
  envelope_sen: number,
): { planned_sen: number; unassigned_sen: number } {
  let planned_sen = 0;
  for (const sen of fund_contribution_sens) planned_sen += sen;
  return { planned_sen, unassigned_sen: Math.max(0, envelope_sen - planned_sen) };
}

/** Plan split by tag incl. savings allocation. Integer percents
 *  that sum to exactly 100 via largest-remainder; all-zero plan => zeros. */
export function planSplit(
  rows: Array<{ allocated_sen: number; tag: Tag }>,
  savings_sen: number,
): { needs_pct: number; wants_pct: number; savings_pct: number } {
  const totals = { needs: 0, wants: 0, savings: savings_sen };
  for (const r of rows) totals[r.tag] += r.allocated_sen;

  const parts = [totals.needs, totals.wants, totals.savings];
  const denom = parts[0]! + parts[1]! + parts[2]!;
  if (denom === 0) return { needs_pct: 0, wants_pct: 0, savings_pct: 0 };

  // Largest-remainder in pure integer arithmetic: floor each percent, then
  // hand the leftover points to the largest remainders (ties: needs first).
  const pcts = parts.map((p) => Math.floor((p * 100) / denom));
  let leftover = 100 - (pcts[0]! + pcts[1]! + pcts[2]!);
  const byRemainder = parts
    .map((p, i) => ({ i, remainder: (p * 100) % denom }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let k = 0; leftover > 0; k++, leftover--) {
    const i = byRemainder[k]!.i;
    pcts[i] = pcts[i]! + 1;
  }
  return { needs_pct: pcts[0]!, wants_pct: pcts[1]!, savings_pct: pcts[2]! };
}

/** Mobile hero: left = max(0, allocated total − spent total); also raw
 *  over-amount when spent exceeds plan. Days left includes today. */
export function heroStats(
  allocated_total_sen: number,
  spent_total_sen: number,
  todayIso: string,
): { left_sen: number; over_sen: number; days_left: number } {
  const year = Number(todayIso.slice(0, 4));
  const month = Number(todayIso.slice(5, 7));
  const day = Number(todayIso.slice(8, 10));
  return {
    left_sen: Math.max(0, allocated_total_sen - spent_total_sen),
    over_sen: Math.max(0, spent_total_sen - allocated_total_sen),
    days_left: daysInMonth(year, month) - day + 1,
  };
}

/** Expected-income default: total sen of occurrences of ACTIVE income-type
 *  rules that fall inside `month` ("YYYY-MM"); variable rules at template amount. */
export function expectedIncomeFromRules(
  rules: Array<
    { type: string; active: boolean; amount_sen: number } & RecurringSchedule & {
      next_run: string;
    }
  >,
  month: string,
): number {
  const year = Number(month.slice(0, 4));
  const monthNum = Number(month.slice(5, 7));
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth(year, monthNum)).padStart(2, "0")}`;

  let total = 0;
  for (const rule of rules) {
    if (rule.type !== "income" || !rule.active) continue;
    // next_run is the next real occurrence; nextRunAfter advances strictly
    // past an occurrence date, so iterate occurrence-to-occurrence.
    let date = rule.next_run;
    while (date <= monthEnd) {
      if (date >= monthStart) total += rule.amount_sen;
      date = nextRunAfter(rule, date);
    }
  }
  return total;
}

/** Parse a whole-percent benchmark input ("0"–"100"); anything else (blank,
 *  decimal, negative, out of range) is invalid — same "strict, null on
 *  reject" convention as `parseAmountToSen`. */
export function parsePercent(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n <= 100 ? n : null;
}

/** True in the month's last 3 calendar days. */
export function nextPlanBannerVisible(todayIso: string): boolean {
  const year = Number(todayIso.slice(0, 4));
  const month = Number(todayIso.slice(5, 7));
  const day = Number(todayIso.slice(8, 10));
  return day >= daysInMonth(year, month) - 2;
}
