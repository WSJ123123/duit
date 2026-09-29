/**
 * Pure fund math (Plan 7 Task 2) — no I/O, no clock: today is a parameter.
 * Integer sen only; every `number` exit is assertSen-guarded (signed exits
 * guard their absolute value, the src/lib/portfolio.ts convention, because a
 * fund balance may legitimately be negative — ruling 9).
 *
 * Ruling 1 is the spine: a fund is an earmark over money the accounts already
 * hold, never a balance of its own. Nothing here moves money or touches a
 * transaction; everything is derived from the contribution rows and the
 * fund-tagged expenses.
 */

import { assertSen } from "@/lib/money";

export type FundKind = "emergency" | "sinking" | "goal";

/** Ruling 3's precedence, as amended by Plan 8 ruling 3 — evaluated as
 *  over_drawn → reached → behind (target_date < today) → paused → behind →
 *  on_track; see fundStatus. */
export type FundStatus = "over_drawn" | "reached" | "paused" | "behind" | "on_track";

/** A fund row plus ruling 5's derived balance. */
export interface FundLike {
  id: string;
  name: string;
  kind: FundKind;
  target_sen: number | null;
  target_months: number | null;
  target_date: string | null;
  monthly_contribution_sen: number;
  priority: number;
  balance_sen: number;
}

/** Just the columns a target is resolved from. */
export type TargetShape = Pick<FundLike, "kind" | "target_sen" | "target_months">;

/**
 * Half-up integer division, d > 0 — **half away from zero** for negative n,
 * byte-for-byte the rule the other three copies use (src/lib/portfolio.ts:59
 * and src/lib/fx.ts:48 in bigint, `divHalfUp` in src/db/networth.ts in number). The house
 * convention is a private copy per module; this is the same rule, not a new
 * one, and the sign handling matters in a module whose central figure — the
 * fund balance — is deliberately signed.
 */
function divHalfUp(n: number, d: number): number {
  const neg = n < 0;
  const abs = Math.abs(n);
  const q = Math.floor(abs / d);
  const r = abs - q * d;
  const rounded = 2 * r >= d ? q + 1 : q;
  return neg ? -rounded : rounded;
}

/** Guarded exit for a figure that may be negative (an over-drawn fund). */
function toSigned(n: number): number {
  assertSen(Math.abs(n));
  return n;
}

/** Ruling 5: Σ contributions − Σ drawn. May be negative (ruling 9). */
export function fundBalanceSen(contributions_sen: number[], drawn_sen: number[]): number {
  let balance = 0;
  for (const sen of contributions_sen) balance += sen;
  for (const sen of drawn_sen) balance -= sen;
  return toSigned(balance);
}

/**
 * Ruling 3's one-shape rule: the absolute `target_sen` when set, else
 * `target_months × avgMonthlyExpenseSen` on the **emergency** kind only, else
 * null. `target_months` on any other kind resolves to nothing — the table
 * check already forbids it, and inventing a target from it would be worse
 * than showing none. A months target with no expense history (avg 0) is also
 * null: RM 0 is not a target, it would simply read as "reached".
 */
export function resolveTargetSen(fund: TargetShape, avgMonthlyExpenseSen: number): number | null {
  if (fund.target_sen !== null) {
    assertSen(fund.target_sen);
    return fund.target_sen;
  }
  if (fund.target_months === null || fund.kind !== "emergency") return null;
  const target = fund.target_months * avgMonthlyExpenseSen;
  if (target <= 0) return null;
  assertSen(target);
  return target;
}

/**
 * Integer percent of a resolved target; null without one (never fabricated).
 * Clamped at 0 for a negative balance; NOT clamped above 100 — an over-target
 * fund honestly reads 120%, and the progress BAR is what clamps its width.
 */
export function progressPct(balance_sen: number, target_sen: number | null): number | null {
  if (target_sen === null || target_sen <= 0) return null;
  if (balance_sen <= 0) return 0;
  const pct = divHalfUp(balance_sen * 100, target_sen);
  assertSen(pct);
  return pct;
}

/**
 * Whole calendar months from `todayIso` to `date`; day of month ignored.
 * Exported because it is also v6 §7's "7 months left" line — the calendar-month
 * rule is defined once here, never re-derived in a component.
 */
export function monthsBetween(todayIso: string, date: string): number {
  const ty = Number(todayIso.slice(0, 4));
  const tm = Number(todayIso.slice(5, 7));
  const dy = Number(date.slice(0, 4));
  const dm = Number(date.slice(5, 7));
  return (dy - ty) * 12 + (dm - tm);
}

/**
 * Ruling 3's required-per-month: null without BOTH a target and a date, 0 once
 * the balance is at or past the target, and **the whole remaining gap** when
 * the date is this month or already past ("all of it, now").
 */
export function requiredMonthlySen(
  balance_sen: number,
  target_sen: number | null,
  todayIso: string,
  target_date: string | null,
): number | null {
  if (target_sen === null || target_date === null) return null;
  const gap = target_sen - balance_sen;
  if (gap <= 0) return 0;
  const months = monthsBetween(todayIso, target_date);
  const required = months <= 0 ? gap : divHalfUp(gap, months);
  assertSen(required);
  return required;
}

/**
 * Ruling 3's status, in the pinned precedence (Plan 8 ruling 3): over_drawn,
 * reached, behind with a PASSED target date, paused, behind, on_track.
 * `paused` is only reachable while no target date has passed — a fund whose
 * date is behind it and whose contribution is 0 is not resting, it is late,
 * and reports `behind` by the whole remaining gap (requiredMonthlySen's
 * past-date rule) less whatever is contributed. `contribution_sen` is the
 * fund's contribution FOR THAT MONTH (the stored row when one exists —
 * ruling 10). `behind_by_sen` is 0 for every status but `behind`.
 */
export function fundStatus(
  balance_sen: number,
  target_sen: number | null,
  contribution_sen: number,
  todayIso: string,
  target_date: string | null,
): { status: FundStatus; behind_by_sen: number } {
  if (balance_sen < 0) return { status: "over_drawn", behind_by_sen: 0 };
  if (target_sen !== null && balance_sen >= target_sen) {
    return { status: "reached", behind_by_sen: 0 };
  }
  const required = requiredMonthlySen(balance_sen, target_sen, todayIso, target_date);
  const behind = required !== null && required > contribution_sen;
  const datePassed = target_date !== null && target_date < todayIso;
  if (behind && datePassed) return behindBy(required - contribution_sen);
  if (contribution_sen === 0) return { status: "paused", behind_by_sen: 0 };
  if (behind) return behindBy(required - contribution_sen);
  return { status: "on_track", behind_by_sen: 0 };
}

function behindBy(behind_by_sen: number): { status: FundStatus; behind_by_sen: number } {
  assertSen(behind_by_sen);
  return { status: "behind", behind_by_sen };
}

/**
 * v6 §7's "full in n months at this rate": the number of whole contributions
 * still needed. Null with no target, no positive rate, or a target already
 * reached.
 */
export function monthsToFillAtRate(
  balance_sen: number,
  target_sen: number | null,
  monthly_sen: number,
): number | null {
  if (target_sen === null || monthly_sen <= 0) return null;
  const gap = target_sen - balance_sen;
  if (gap <= 0) return null;
  const whole = Math.floor(gap / monthly_sen);
  const months = whole * monthly_sen === gap ? whole : whole + 1;
  assertSen(months);
  return months;
}

// ---------------------------------------------------------------------------
// The savings waterfall (ruling 10)
// ---------------------------------------------------------------------------

export type WaterfallStepKey = "emergency" | "dated" | "open" | "invest";

export interface WaterfallStepFund {
  id: string;
  name: string;
  /** This month's contribution — stored row first, monthly amount as fallback. */
  planned_sen: number;
  status: FundStatus;
  behind_by_sen: number;
}

export interface WaterfallStep {
  /** 1-4, in the order they are fed. */
  step: number;
  key: WaterfallStepKey;
  funds: WaterfallStepFund[];
  planned_sen: number;
  /** clamp(envelope − everything planned before this step, 0, planned_sen). */
  funded_sen: number;
  shortfall_sen: number;
  /** Only the FIRST step the envelope cannot fill carries the flag. */
  first_shortfall: boolean;
}

export interface Waterfall {
  steps: WaterfallStep[];
  /** Σ steps 1-3 — what the funds want this month. */
  planned_total_sen: number;
  /** Step 4: max(0, envelope − planned_total). */
  leftover_sen: number;
}

/** priority asc, then target_date (nulls last), then name. */
function byWaterfallOrder(a: FundLike, b: FundLike): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.target_date !== b.target_date) {
    if (a.target_date === null) return 1;
    if (b.target_date === null) return -1;
    return a.target_date < b.target_date ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Ruling 10's four ordered steps over the ACTIVE funds (the caller filters):
 * emergency funds, then non-emergency funds with a target_date, then the
 * open-ended ones, then "invest the rest". Steps 1-3 partition the funds
 * exactly — an emergency fund with a date stays in step 1.
 *
 * `contributionsForMonth` (fund id → stored `fund_contributions.amount_sen`)
 * is REQUIRED: `monthly_contribution_sen` is only the fallback for a month not
 * yet applied. Without it, editing a contribution after Apply would make the
 * waterfall and the "This month" card describe the same month with different
 * numbers, and `on conflict do nothing` guarantees the stored row never
 * catches up. **No step caps its planned amount at a fund's remaining gap** —
 * a cap would make the waterfall disagree with what Apply actually writes; a
 * fund at or past target carries `reached` so the UI can nudge instead.
 */
export function buildWaterfall(
  funds: FundLike[],
  contributionsForMonth: Map<string, number>,
  envelope_sen: number,
  avgMonthlyExpenseSen: number,
  todayIso: string,
): Waterfall {
  const members: Record<Exclude<WaterfallStepKey, "invest">, FundLike[]> = {
    emergency: [],
    dated: [],
    open: [],
  };
  for (const fund of funds) {
    if (fund.kind === "emergency") members.emergency.push(fund);
    else if (fund.target_date !== null) members.dated.push(fund);
    else members.open.push(fund);
  }

  const steps: WaterfallStep[] = [];
  let planned_total_sen = 0;
  const keys: Array<Exclude<WaterfallStepKey, "invest">> = ["emergency", "dated", "open"];
  for (const [index, key] of keys.entries()) {
    const stepFunds = members[key].sort(byWaterfallOrder).map((fund) => {
      const planned_sen = contributionsForMonth.get(fund.id) ?? fund.monthly_contribution_sen;
      assertSen(planned_sen);
      const target_sen = resolveTargetSen(fund, avgMonthlyExpenseSen);
      const { status, behind_by_sen } = fundStatus(
        fund.balance_sen,
        target_sen,
        planned_sen,
        todayIso,
        fund.target_date,
      );
      return { id: fund.id, name: fund.name, planned_sen, status, behind_by_sen };
    });
    const planned_sen = stepFunds.reduce((sum, f) => sum + f.planned_sen, 0);
    const funded_sen = Math.min(Math.max(envelope_sen - planned_total_sen, 0), planned_sen);
    steps.push({
      step: index + 1,
      key,
      funds: stepFunds,
      planned_sen,
      funded_sen,
      shortfall_sen: planned_sen - funded_sen,
      first_shortfall: false,
    });
    planned_total_sen += planned_sen;
  }

  const leftover_sen = Math.max(envelope_sen - planned_total_sen, 0);
  steps.push({
    step: 4,
    key: "invest",
    funds: [],
    planned_sen: leftover_sen,
    funded_sen: Math.min(Math.max(envelope_sen - planned_total_sen, 0), leftover_sen),
    shortfall_sen: 0,
    first_shortfall: false,
  });

  const first = steps.find((s) => s.shortfall_sen > 0);
  if (first) first.first_shortfall = true;

  assertSen(planned_total_sen);
  assertSen(leftover_sen);
  return { steps, planned_total_sen, leftover_sen };
}
