/**
 * Pure net-worth math — no I/O, no clock: every date is a parameter
 * (`todayIso`). Integer sen arithmetic only; ISO date strings compare
 * lexicographically.
 */
import { accountMyrSen } from "@/lib/fx";

export interface NetWorthParts {
  accounts_sen: number;
  holdings_sen: number;
  business_sen: number;
  manual_assets_sen: number;
  liabilities_sen: number; // liabilities positive
  total_sen: number; // a + h + b + m − l
}

/** Ruling 20: lifetime figures + current value from one entries ledger.
 *  Invested = Σ contributions, Returned = Σ returns (returns never reduce
 *  either); value = latest valuation by date (created_at breaks ties; on a
 *  full tie the first-seen entry wins), defaulting to Σ contributions when
 *  no valuation was ever recorded. Unknown kinds are ignored. */
export function businessStats(
  entries: Array<{ kind: string; amount_sen: number; date: string; created_at: string }>,
): { invested_sen: number; returned_sen: number; value_sen: number } {
  let invested = 0;
  let returned = 0;
  let latest: { amount_sen: number; date: string; created_at: string } | null = null;
  for (const e of entries) {
    if (e.kind === "contribution") invested += e.amount_sen;
    else if (e.kind === "return") returned += e.amount_sen;
    else if (e.kind === "valuation") {
      if (
        !latest ||
        e.date > latest.date ||
        (e.date === latest.date && e.created_at > latest.created_at)
      ) {
        latest = e;
      }
    }
  }
  return {
    invested_sen: invested,
    returned_sen: returned,
    value_sen: latest ? latest.amount_sen : invested,
  };
}

/**
 * Task 5 (ruling 7): the accounts part of net worth over a multi-currency
 * book. Balances stay integer minor units of their OWN account currency;
 * each non-MYR balance converts at its <CUR>MYR rate (accountMyrSen). A
 * currency with no rate row yet is EXCLUDED from the total and returned in
 * `missing_currencies` (first-seen order, deduped) so pages can show the
 * warn line — honest gap, never a fabricated rate. Snapshot cron and pages
 * both compose THIS function, so they cannot disagree (ruling 12).
 */
export function accountsTotalMyrSen(
  accounts: Array<{ balance_sen: number; currency: string }>,
  ratesByPair: Map<string, number>,
): { total_sen: number; missing_currencies: string[] } {
  let total = 0;
  const missing: string[] = [];
  for (const a of accounts) {
    const sen = accountMyrSen(a.balance_sen, a.currency, ratesByPair);
    if (sen === null) {
      if (!missing.includes(a.currency)) missing.push(a.currency);
    } else {
      total += sen;
    }
  }
  return { total_sen: total, missing_currencies: missing };
}

export function netWorthTotal(parts: Omit<NetWorthParts, "total_sen">): NetWorthParts {
  return {
    ...parts,
    total_sen:
      parts.accounts_sen +
      parts.holdings_sen +
      parts.business_sen +
      parts.manual_assets_sen -
      parts.liabilities_sen,
  };
}

/** Latest value per item from a history list (ruling 5): max noted_on wins,
 *  created_at breaks ties (full tie: first-seen row wins). */
export function latestValues(
  rows: Array<{ item_id: string; value_sen: number; noted_on: string; created_at: string }>,
): Map<string, number> {
  const best = new Map<string, { value_sen: number; noted_on: string; created_at: string }>();
  for (const r of rows) {
    const cur = best.get(r.item_id);
    if (
      !cur ||
      r.noted_on > cur.noted_on ||
      (r.noted_on === cur.noted_on && r.created_at > cur.created_at)
    ) {
      best.set(r.item_id, r);
    }
  }
  const out = new Map<string, number>();
  for (const [id, row] of best) out.set(id, row.value_sen);
  return out;
}

function daysInMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the next month is this month's last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoParts(iso: string): { year: number; month: number; day: number } {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** iso minus `months` calendar months, day clamped to the target month's
 *  length (e.g. 2026-05-31 − 3 → 2026-02-28). */
function monthsBack(iso: string, months: number): string {
  const { year, month, day } = isoParts(iso);
  const total = year * 12 + (month - 1) - months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toIso(y, m, Math.min(day, daysInMonth(y, m)));
}

function prevMonthEnd(iso: string): string {
  const { year, month } = isoParts(iso);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return toIso(y, m, daysInMonth(y, m));
}

/** Delta vs previous month: live total − the latest snapshot dated ≤ the
 *  previous month's end; null when no such snapshot exists. */
export function deltaVsPrevMonth(
  snapshots: Array<{ date: string; total_sen: number }>,
  live_total_sen: number,
  todayIso: string,
): number | null {
  const cutoff = prevMonthEnd(todayIso);
  let best: { date: string; total_sen: number } | null = null;
  for (const s of snapshots) {
    if (s.date <= cutoff && (!best || s.date > best.date)) best = s;
  }
  return best ? live_total_sen - best.total_sen : null;
}

/** Snapshot series for a range ("3M" | "6M" | "1Y" | "ALL") back from
 *  todayIso, sorted ascending, plus the live today point appended last. The
 *  live point replaces a same-day snapshot; snapshots dated after today are
 *  dropped. Ruling 8. Unknown range strings behave as "ALL". */
export function chartSeries(
  snapshots: Array<{ date: string; total_sen: number }>,
  range: string,
  todayIso: string,
  live_total_sen: number,
): Array<{ date: string; total_sen: number }> {
  const months = range === "3M" ? 3 : range === "6M" ? 6 : range === "1Y" ? 12 : null;
  const start = months === null ? null : monthsBack(todayIso, months);
  const kept = snapshots
    .filter((s) => s.date < todayIso && (start === null || s.date >= start))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((s) => ({ date: s.date, total_sen: s.total_sen }));
  kept.push({ date: todayIso, total_sen: live_total_sen });
  return kept;
}
