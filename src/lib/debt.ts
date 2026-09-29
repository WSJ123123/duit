import { assertSen } from "@/lib/money";

/**
 * Debt payoff projection (Plan 8 ruling 9) — pure, clock-free, integer sen.
 *
 * Shared by a Server Component (getNetWorth computes each liability's initial
 * projection) and the client Debt payoff card / Plan payment dialog mode (the
 * extra-per-month what-if and the live preview), so it lives here under
 * src/lib/ and is NEVER re-exported from a "use client" module — finding #20.
 *
 * Nothing here reads a clock: `todayIso` is a parameter, and the payoff month
 * is plain month arithmetic on its `YYYY-MM` prefix. Nothing here is ever
 * written anywhere — no schedule is stored, no balance row moves (ruling 9).
 */

export type PayoffStatus = "on_track" | "never" | "beyond_horizon" | "paid";

export interface PayoffProjection {
  status: PayoffStatus;
  /** `YYYY-MM`, KL calendar month `months` after todayIso's month; null for
   *  the two no-date states and for `paid`. */
  payoff_month: string | null;
  /** Months of payments to clear the balance; 0 for `paid`, null when no
   *  date exists inside the horizon. */
  months: number | null;
  /** Interest charged over the run — over the whole 600-month horizon for
   *  `beyond_horizon`, 0 for `never` (no month is run) and `paid`. */
  total_interest_sen: number;
  /** The last instalment, which is usually short of the payment. */
  final_payment_sen: number;
  /** For `never` and `beyond_horizon`: the smallest payment that clears the
   *  balance inside the cap (binary search, not interest + 1 sen). Null for
   *  the dated statuses — nothing to recommend. */
  required_to_progress_sen: number | null;
}

/** The projection cap: 50 years of monthly steps. */
export const HORIZON_MONTHS = 600;

/** Integer division, half away from zero — the house convention (local
 *  copy, byte-identical to src/db/networth.ts's). Exported for its pin. */
export function divHalfUp(n: number, d: number): number {
  const neg = n < 0;
  const abs = Math.abs(n);
  const q = Math.floor(abs / d);
  const r = abs - q * d;
  const rounded = 2 * r >= d ? q + 1 : q;
  return neg ? -rounded : rounded;
}

/** One month's interest: annual basis points → one twelfth, integer sen.
 *  `balance × rate_bp` stays exact in a double: rate_bp ≤ 10_000 (the
 *  column's check) and a balance under RM 10⁸ (10¹⁰ sen) give at most 10¹⁴,
 *  far inside Number's 2⁵³ ≈ 9 × 10¹⁵ safe-integer range. */
export function monthlyInterestSen(balance_sen: number, rate_bp: number): number {
  const interest = divHalfUp(balance_sen * rate_bp, 120_000);
  assertSen(interest);
  return interest;
}

/** Ruling 9 precedence: planned when > 0, else minimum when > 0, else none. */
export function paymentRateSen(liability: {
  planned_payment_sen: number;
  minimum_payment_sen: number;
}): number | null {
  if (liability.planned_payment_sen > 0) return liability.planned_payment_sen;
  if (liability.minimum_payment_sen > 0) return liability.minimum_payment_sen;
  return null;
}

/** `YYYY-MM` + n months, string arithmetic only. */
function addMonths(yyyyMm: string, n: number): string {
  const y = Number(yyyyMm.slice(0, 4));
  const m = Number(yyyyMm.slice(5, 7)) - 1 + n; // 0-based
  const year = y + Math.floor(m / 12);
  const month = (m % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

interface Run {
  cleared: boolean;
  months: number;
  total_interest_sen: number;
  final_payment_sen: number;
}

/** Step one calendar month at a time until the balance clears or the cap. */
function run(balance_sen: number, rate_bp: number, payment_sen: number): Run {
  let balance = balance_sen;
  let total_interest_sen = 0;
  for (let months = 1; months <= HORIZON_MONTHS; months++) {
    const interest = monthlyInterestSen(balance, rate_bp);
    total_interest_sen += interest;
    const owed = balance + interest;
    if (owed <= payment_sen) {
      return { cleared: true, months, total_interest_sen, final_payment_sen: owed };
    }
    balance = owed - payment_sen;
  }
  return { cleared: false, months: HORIZON_MONTHS, total_interest_sen, final_payment_sen: 0 };
}

export function projectPayoff(
  balance_sen: number,
  rate_bp: number,
  payment_sen: number,
  todayIso: string,
): PayoffProjection {
  if (balance_sen <= 0) {
    return {
      status: "paid",
      payoff_month: null,
      months: 0,
      total_interest_sen: 0,
      final_payment_sen: 0,
      required_to_progress_sen: null,
    };
  }
  if (payment_sen <= monthlyInterestSen(balance_sen, rate_bp)) {
    return {
      status: "never",
      payoff_month: null,
      months: null,
      total_interest_sen: 0,
      final_payment_sen: 0,
      required_to_progress_sen: requiredToProgressSen(balance_sen, rate_bp),
    };
  }
  const r = run(balance_sen, rate_bp, payment_sen);
  assertSen(r.total_interest_sen);
  assertSen(r.final_payment_sen);
  if (!r.cleared) {
    return {
      status: "beyond_horizon",
      payoff_month: null,
      months: null,
      total_interest_sen: r.total_interest_sen,
      final_payment_sen: 0,
      required_to_progress_sen: requiredToProgressSen(balance_sen, rate_bp),
    };
  }
  return {
    status: "on_track",
    payoff_month: addMonths(todayIso.slice(0, 7), r.months),
    months: r.months,
    total_interest_sen: r.total_interest_sen,
    final_payment_sen: r.final_payment_sen,
    required_to_progress_sen: null,
  };
}

/**
 * The smallest payment whose projection is dated inside the cap. Payment is
 * monotone in months (more payment never means more months), so a binary
 * search over [1, balance] is exact: a payment of the whole balance always
 * clears within two months (month 1 leaves only that month's interest).
 */
export function requiredToProgressSen(balance_sen: number, rate_bp: number): number {
  if (balance_sen <= 0) return 0;
  const dated = (payment: number): boolean => {
    if (payment <= monthlyInterestSen(balance_sen, rate_bp)) return false;
    return run(balance_sen, rate_bp, payment).cleared;
  };
  let lo = 1;
  let hi = balance_sen;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dated(mid)) hi = mid;
    else lo = mid + 1;
  }
  assertSen(lo);
  return lo;
}

/** 1 − latest / first, as a whole percent clamped to [0, 100]; null when
 *  there is no first-recorded balance to measure against. */
export function payoffProgress(latest_sen: number, first_sen: number): number | null {
  if (first_sen === 0) return null;
  const pct = divHalfUp((first_sen - latest_sen) * 100, first_sen);
  return Math.min(100, Math.max(0, pct));
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM` → `Mon YYYY` — the card's and the dialog's month treatment. */
export function monthLabel(yyyyMm: string): string {
  return `${MONTH_NAMES[Number(yyyyMm.slice(5, 7)) - 1]} ${yyyyMm.slice(0, 4)}`;
}

/** Basis points → `3.50%`, two decimals everywhere (v7 §11). Both digit
 *  groups are integer-exact for 0..10_000 bp: the whole part divides a
 *  multiple of 100 (an exact quotient), the fraction is the remainder. */
export function ratePct(rate_bp: number): string {
  const whole = (rate_bp - (rate_bp % 100)) / 100;
  return `${whole}.${String(rate_bp % 100).padStart(2, "0")}%`;
}
