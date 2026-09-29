import { formatSen } from "@/lib/money";
import { monthLabel, monthlyInterestSen, payoffProgress, projectPayoff, type PayoffProjection } from "@/lib/debt";
import type { LiabilityListRow } from "@/db/networth";

/**
 * DebtPayoffCard's view-model (Plan 8 rulings 9–10), moved verbatim out of
 * `src/components/DebtPayoffCard.tsx` (Plan 9 Task 3 Step 1) so the amounts
 * sweep can be reviewed against an unchanged projection. Pure: the card
 * renders these rows and sentences; nothing here reads the clock.
 */

export type Payoff =
  | { kind: "dated"; month: string; months: number; interest_sen: number }
  | { kind: "never"; required_sen: number; by: string }
  | { kind: "beyond"; required_sen: number; by: string }
  | { kind: "paid" }
  | { kind: "no_rate" }
  | { kind: "no_balance" };

export interface RowView {
  id: string;
  name: string;
  balance_sen: number;
  rate_bp: number;
  /** The payment the row is projected at — planned/minimum plus the what-if extra. */
  payment_sen: number | null;
  interest_this_month_sen: number;
  payoff: Payoff;
  /** null before any balance is recorded, or when the first one was 0. */
  progress_pct: number | null;
  first: LiabilityListRow["first_recorded"];
}

function toPayoff(p: PayoffProjection, rate_bp: number, balance_sen: number, todayIso: string): Payoff {
  switch (p.status) {
    case "paid":
      return { kind: "paid" };
    // Ruling 9: both no-date states carry the same figure — the smallest
    // payment that clears the balance inside the cap — and the month it does.
    case "never":
    case "beyond_horizon": {
      const required_sen = p.required_to_progress_sen!;
      const by = projectPayoff(balance_sen, rate_bp, required_sen, todayIso).payoff_month!;
      return { kind: p.status === "never" ? "never" : "beyond", required_sen, by: monthLabel(by) };
    }
    case "on_track":
      return { kind: "dated", month: monthLabel(p.payoff_month!), months: p.months!, interest_sen: p.total_interest_sen };
  }
}

export function toView(row: LiabilityListRow, extra_sen: number, todayIso: string): RowView {
  const payment_sen = row.payment_rate_sen === null ? null : row.payment_rate_sen + extra_sen;
  let payoff: Payoff;
  if (row.first_recorded === null) payoff = { kind: "no_balance" };
  else if (row.balance_sen <= 0) payoff = { kind: "paid" }; // cleared needs no payment rate
  else if (payment_sen === null) payoff = { kind: "no_rate" };
  else {
    const projection =
      extra_sen === 0 && row.projection
        ? row.projection
        : projectPayoff(row.balance_sen, row.interest_rate_bp, payment_sen, todayIso);
    payoff = toPayoff(projection, row.interest_rate_bp, row.balance_sen, todayIso);
  }
  return {
    id: row.id,
    name: row.name,
    balance_sen: row.balance_sen,
    rate_bp: row.interest_rate_bp,
    payment_sen,
    interest_this_month_sen: monthlyInterestSen(row.balance_sen, row.interest_rate_bp),
    payoff,
    progress_pct: row.first_recorded ? payoffProgress(row.balance_sen, row.first_recorded.balance_sen) : null,
    first: row.first_recorded,
  };
}

export const NEVER_COPY = "never at this rate";
export const BEYOND_COPY = "more than 50 years at this rate";
export const NO_RATE_COPY = "set a planned payment to see a payoff date";
export const NO_BALANCE_COPY = "no balance recorded yet";

export function isCritical(p: Payoff): boolean {
  return p.kind === "never" || p.kind === "beyond";
}

/** "38% · of RM 160,000.00 when tracking began (Feb 2077)" — or why not. */
export function progressLine(v: RowView): string {
  if (!v.first) return NO_BALANCE_COPY;
  if (v.progress_pct === null) return "—";
  return `${v.progress_pct}% · of ${formatSen(v.first.balance_sen)} when tracking began (${monthLabel(v.first.noted_on.slice(0, 7))})`;
}

/** The what-if result per row: a month, or the state's one word. */
export function whatIfWord(p: Payoff): string {
  switch (p.kind) {
    case "dated":
      return p.month;
    case "never":
      return "never";
    case "beyond":
      return "50+ years";
    case "paid":
      return "paid off";
    case "no_rate":
    case "no_balance":
      return "—";
  }
}

/** Mobile functional line (v7 §13): payoff · interest to go · % paid. */
export function mobileLine(v: RowView): string {
  const paid = v.progress_pct === null ? null : `${v.progress_pct}% paid`;
  const at = v.payment_sen === null ? "" : ` at ${formatSen(v.payment_sen)}/mo`;
  const p = v.payoff;
  switch (p.kind) {
    case "dated":
      return [`${p.month}${at}`, `${formatSen(p.interest_sen)} interest to go`, paid].filter(Boolean).join(" · ");
    case "never":
      return `never${at} · ${formatSen(p.required_sen)}/mo would clear it by ${p.by}`;
    case "beyond":
      return `more than 50 years${at} · ${formatSen(p.required_sen)}/mo would clear it by ${p.by}`;
    case "paid":
      return ["paid off", paid].filter(Boolean).join(" · ");
    case "no_rate":
      return [NO_RATE_COPY, paid].filter(Boolean).join(" · ");
    case "no_balance":
      return NO_BALANCE_COPY;
  }
}
