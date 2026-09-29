import type { TxType } from "@/lib/transactions";
import { netExpenseSen } from "@/lib/stats";

/**
 * Minimal shape needed to group transactions into day buckets for the mobile
 * Activity list. Deliberately loose (extra fields pass through).
 */
export interface ActivityTxLike {
  id: string;
  type: TxType;
  amount_sen: number;
  expected_back_sen: number;
  date: string;
  /** Ruling 7 trend guard: rows on non-MYR accounts still LIST, but their
   *  amount_sen are that currency's minor units — day totals skip them.
   *  Absent = MYR (older callers unaffected). */
  accountCurrency?: string;
}

export interface ActivityDay<T extends ActivityTxLike> {
  date: string;
  /**
   * Day total = sum over the day's expenses net of expected_back_sen
   * (amount_sen - expected_back_sen). Transfers are excluded entirely.
   * Income is not included (this is a spend total).
   */
  total_sen: number;
  rows: T[];
}

/**
 * Group rows by KL calendar date, newest day first. Row order within a day
 * is preserved exactly as given (stable) — callers are expected to have
 * already ordered rows the way they want them to display.
 */
export function groupByDay<T extends ActivityTxLike>(rows: T[]): Array<ActivityDay<T>> {
  const byDate = new Map<string, T[]>();
  for (const row of rows) {
    const existing = byDate.get(row.date);
    if (existing) {
      existing.push(row);
    } else {
      byDate.set(row.date, [row]);
    }
  }

  const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  return dates.map((date) => {
    const dayRows = byDate.get(date)!;
    // Shared net-spend semantics (src/lib/stats.ts): expenses net of
    // expected_back; income and transfers contribute 0. Non-MYR-account rows
    // contribute 0 too (ruling 7 — their sen are not MYR sen).
    const total_sen = dayRows.reduce(
      (sum, r) =>
        r.accountCurrency !== undefined && r.accountCurrency !== "MYR"
          ? sum
          : sum + netExpenseSen(r),
      0,
    );
    return { date, total_sen, rows: dayRows };
  });
}
