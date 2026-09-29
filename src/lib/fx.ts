/**
 * Pure FX helpers (Plan 6 rulings 6–8): MYR-cross rates, rate resolution
 * against `fx_rates` rows, and the cross-currency trade cash estimate. No
 * I/O, no clock. All arithmetic is BigInt internally; rounding is half-up;
 * every `number` exit is assertSen-guarded (Plan-5 ruling 1, unchanged).
 *
 * Split from src/lib/portfolio.ts under the house "genuinely shared" rule:
 * the trade form (Task 4), cross-currency transfers and non-MYR account
 * conversion (Task 5) all consume the same resolution + estimate helpers,
 * and none of them are average-cost/valuation concerns.
 *
 * Scale conventions:
 * - `fx_rates.rate_e8` is MYR per 1 unit of CUR, × 1e8 (pair "<CUR>MYR").
 * - The pure libs consume `fx_e8` = sen per 1 minor unit of CUR, × 1e8.
 *   For 2-decimal currencies the two are numerically IDENTICAL (the ×100
 *   sen-per-RM and ÷100 minor-units-per-CUR factors cancel), so `rate_e8`
 *   is used as `fx_e8` directly at every join point (loadPortfolioValuation
 *   and resolveFxRateE8 here).
 */
import { assertSen } from "@/lib/money";
import { centToSen } from "@/lib/portfolio";

/** Same-currency rate: 1.0 × 1e8 (sen per minor unit). */
export const FX_IDENTITY_E8 = 100_000_000;

/** One `fx_rates` row as the pages load it. */
export interface FxRateRow {
  pair: string;
  rate_e8: number;
  as_of: string; // "YYYY-MM-DD"
}

export interface ResolvedFxRate {
  fx_e8: number;
  /** null only for the identity (no market rate involved). A cross rate is
   *  dated by its OLDER leg — stale detection stays conservative. */
  as_of: string | null;
  via: "identity" | "direct" | "cross";
}

// Ruling 11: tsconfig now targets ES2020, so numeric-literal arguments become
// BigInt literals. `aToMyr_e8`/`bToMyr_e8` below are runtime values, not
// literals, so those two call sites stay BigInt(...) calls.
const TWO = 2n;
const E8 = 100_000_000n;

/** Half-up division for non-negative n (rates are positive); d > 0. */
function divHalfUp(n: bigint, d: bigint): bigint {
  return (n + d / TWO) / d;
}

/** Guarded BigInt → number exit (non-negative safe integer or throw). */
function toAmount(b: bigint): number {
  const n = Number(b);
  assertSen(n);
  return n;
}

/**
 * A→B rate from the two <CUR>MYR legs: rate(A→B) = (A→MYR) / (B→MYR),
 * × 1e8 fixed point. BigInt, half-up — a × 1e8 overflows 2^53 for
 * realistic magnitudes, so this never touches float arithmetic.
 */
export function crossRateE8(aToMyr_e8: number, bToMyr_e8: number): number {
  return toAmount(divHalfUp(BigInt(aToMyr_e8) * E8, BigInt(bToMyr_e8)));
}

/**
 * Resolves the `from` → `to` conversion rate from the fx_rates rows the
 * page already loads, IN ORDER (ruling 6): identity (same currency), the
 * direct pair ("<from><to>"), the via-MYR cross (both <CUR>MYR legs, a MYR
 * side counting as the identity leg), else null — no prefill, never a guess.
 */
export function resolveFxRateE8(
  from: string,
  to: string,
  rates: FxRateRow[],
): ResolvedFxRate | null {
  if (from === to) return { fx_e8: FX_IDENTITY_E8, as_of: null, via: "identity" };

  const byPair = new Map(rates.map((r) => [r.pair, r]));
  const direct = byPair.get(`${from}${to}`);
  if (direct) return { fx_e8: direct.rate_e8, as_of: direct.as_of, via: "direct" };

  const leg = (cur: string): { rate_e8: number; as_of: string | null } | null => {
    if (cur === "MYR") return { rate_e8: FX_IDENTITY_E8, as_of: null };
    const row = byPair.get(`${cur}MYR`);
    return row ? { rate_e8: row.rate_e8, as_of: row.as_of } : null;
  };
  const legFrom = leg(from);
  const legTo = leg(to);
  if (!legFrom || !legTo) return null;

  const dates = [legFrom.as_of, legTo.as_of].filter((d): d is string => d !== null);
  return {
    fx_e8: crossRateE8(legFrom.rate_e8, legTo.rate_e8),
    as_of: dates.length === 0 ? null : dates.length === 1 ? dates[0]! : dates[0]! < dates[1]! ? dates[0]! : dates[1]!,
    via: "cross",
  };
}

/**
 * Ruling 6: the trade's estimated cash movement in account-currency minor
 * units — `centToSen(gross ± fees, fx)`. A buy settles gross + fees; a
 * sell's proceeds are gross − fees. `gross_cent` is the trade's own rounded
 * gross (per-trade rounding, see src/lib/portfolio.ts).
 */
export function estimateCashSen(
  side: "buy" | "sell",
  gross_cent: number,
  fees_cent: number,
  fx_e8: number,
): number {
  return centToSen(side === "buy" ? gross_cent + fees_cent : gross_cent - fees_cent, fx_e8);
}

export interface TradeCashPrefillArgs {
  mode: "create" | "edit";
  cashDirty: boolean;
  side: "buy" | "sell";
  gross_cent: number;
  fees_cent: number;
  fx_e8: number | null; // null = unresolved rate
}

/**
 * The SINGLE gate for the trade form's cash prefill (ruling 6 + the
 * Session-9 T7 lesson). Returns the estimate to prefill, or null to leave
 * the field alone:
 * - edit mode NEVER re-prefills — the saved cash_delta_sen may be the
 *   broker's divergent to-the-sen figure and must survive re-renders;
 * - a user-touched field (cashDirty) is theirs;
 * - no resolvable rate → no prefill.
 * Clamped at 0: cash_delta_sen is non-negative by schema, and a
 * fees-exceed-gross sell estimate below zero is meaningless to record.
 */
export function tradeCashPrefillSen(args: TradeCashPrefillArgs): number | null {
  if (args.mode === "edit" || args.cashDirty || args.fx_e8 === null) return null;
  const estimate = estimateCashSen(args.side, args.gross_cent, args.fees_cent, args.fx_e8);
  return estimate < 0 ? 0 : estimate;
}

/**
 * Task 5 (ruling 7): one non-MYR account balance → MYR sen at the account
 * currency's <CUR>MYR rate, half-up via centToSen (BigInt path). MYR is the
 * identity. A never-fetched rate returns null — the caller EXCLUDES the
 * account from MYR totals and says so (ruled: honest gap beats a fabricated
 * rate). `ratesByPair` maps "<CUR>MYR" → rate_e8 (used directly as fx_e8;
 * the scales coincide for 2-decimal currencies — see the header).
 */
export function accountMyrSen(
  balance_sen: number,
  currency: string,
  ratesByPair: Map<string, number>,
): number | null {
  if (currency === "MYR") return balance_sen;
  const rate_e8 = ratesByPair.get(`${currency}MYR`);
  if (rate_e8 === undefined) return null;
  return centToSen(balance_sen, rate_e8);
}

export interface TransferReceivedPrefillArgs {
  mode: "create" | "edit";
  receivedDirty: boolean;
  amount_sen: number; // amount leaving the source account, its minor units
  fx_e8: number | null; // resolved source→destination rate; null = unresolved
}

/**
 * The single gate for the cross-currency transfer form's destination-amount
 * prefill (ruling 7, same shape as tradeCashPrefillSen): edit mode never
 * re-prefills over the saved received_sen, a user-touched field is theirs,
 * and an unresolvable rate never prefills — type what actually arrived.
 */
export function transferReceivedPrefillSen(args: TransferReceivedPrefillArgs): number | null {
  if (args.mode === "edit" || args.receivedDirty || args.fx_e8 === null) return null;
  return centToSen(args.amount_sen, args.fx_e8);
}
