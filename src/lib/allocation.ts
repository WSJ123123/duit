/**
 * Pure allocation-plan math (rulings 12-15) — no I/O, no clock. Integer sen
 * and integer percentage points; every rounded split uses the largest-
 * remainder pattern (house style, from budget's planSplit) so displayed
 * figures sum exactly.
 */

import { accountMyrSen } from "@/lib/fx";

export type Bucket = "bank" | "cashlike" | "equities" | "exclude";
export type PresetKey = "balanced" | "growth" | "aggressive" | "barbell";

/** Ruling 13: code-default presets (bank/cashlike/equities, sums to 100). */
export const PRESET_DEFAULTS: Record<
  PresetKey,
  { bank_pct: number; cashlike_pct: number; equities_pct: number }
> = {
  balanced: { bank_pct: 6, cashlike_pct: 50, equities_pct: 44 },
  growth: { bank_pct: 6, cashlike_pct: 32, equities_pct: 62 },
  aggressive: { bank_pct: 6, cashlike_pct: 22, equities_pct: 72 },
  barbell: { bank_pct: 6, cashlike_pct: 39, equities_pct: 55 },
};

/** Ruling 14: per-bucket annual return assumptions in basis points. */
export const RETURN_BP = { bank: 200, cashlike: 350, equities: 700 };

/** Ruling 12: derived default bucket by account type. Unknown types fall to
 *  'exclude' (never silently allocatable). */
export function defaultBucket(accountType: string): Bucket {
  switch (accountType) {
    case "bank":
    case "ewallet":
    case "cash":
      return "bank";
    case "brokerage":
      return "cashlike";
    default: // epf, other, unknown
      return "exclude";
  }
}

/** Largest-remainder apportionment: split `total` across `weights` so parts
 *  sum exactly to `total`. Floor each share, then hand leftover units to the
 *  largest remainders (ties: lowest index first). All-zero weights => zeros.
 *  Exported for the portfolio %-column (pct_tenths, ruling 19) — Task-5 plan
 *  rule: reuse this helper, never duplicate the pattern. */
export function apportion(weights: number[], total: number): number[] {
  let denom = 0;
  for (const w of weights) denom += w;
  if (denom === 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((w * total) / denom));
  let leftover = total;
  for (const v of out) leftover -= v;
  const byRemainder = weights
    .map((w, i) => ({ i, remainder: (w * total) % denom }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (let k = 0; leftover > 0; k++, leftover--) {
    const i = byRemainder[k]!.i;
    out[i] = out[i]! + 1;
  }
  return out;
}

/** Ruling 12: bucketed non-exclude account balances; holdings are always
 *  equities; pot = sum. Task 5 (ruling 7): an account may carry a currency —
 *  non-MYR balances convert at their <CUR>MYR rate from `ratesByPair`; a
 *  never-fetched rate excludes that account from the pot (honest gap).
 *  Callers without foreign accounts omit both and nothing changes. */
export function potBuckets(
  accounts: Array<{ balance_sen: number; bucket: Bucket; currency?: string }>,
  holdings_total_sen: number,
  ratesByPair?: Map<string, number>,
): { bank_sen: number; cashlike_sen: number; equities_sen: number; pot_sen: number } {
  let bank = 0;
  let cashlike = 0;
  let equities = holdings_total_sen;
  for (const a of accounts) {
    const sen = accountMyrSen(a.balance_sen, a.currency ?? "MYR", ratesByPair ?? new Map());
    if (sen === null) continue; // no rate yet → outside the pot until it lands
    if (a.bucket === "bank") bank += sen;
    else if (a.bucket === "cashlike") cashlike += sen;
    else if (a.bucket === "equities") equities += sen;
    // 'exclude' stays outside the pot
  }
  return {
    bank_sen: bank,
    cashlike_sen: cashlike,
    equities_sen: equities,
    pot_sen: bank + cashlike + equities,
  };
}

/** Current bucket percentages, largest remainder — always sums to 100
 *  (empty pot => zeros). */
export function bucketPcts(b: ReturnType<typeof potBuckets>): {
  bank_pct: number;
  cashlike_pct: number;
  equities_pct: number;
} {
  const [bank, cashlike, equities] = apportion(
    [b.bank_sen, b.cashlike_sen, b.equities_sen],
    100,
  );
  return { bank_pct: bank!, cashlike_pct: cashlike!, equities_pct: equities! };
}

/** Ruling 14: (bank + cashlike) ÷ avg monthly net expense, in whole tenths
 *  of a month (half-up); null when there is no expense history. */
export function accessibleMonthsTenths(
  bank_plus_cashlike_sen: number,
  avg_monthly_expense_sen: number,
): number | null {
  if (avg_monthly_expense_sen <= 0) return null;
  const n = bank_plus_cashlike_sen * 10;
  const q = Math.floor(n / avg_monthly_expense_sen);
  const r = n - q * avg_monthly_expense_sen;
  return 2 * r >= avg_monthly_expense_sen ? q + 1 : q;
}

/** Percentage-weighted blend of RETURN_BP, in basis points (half-up). */
export function blendedReturnBp(pcts: {
  bank_pct: number;
  cashlike_pct: number;
  equities_pct: number;
}): number {
  const num =
    pcts.bank_pct * RETURN_BP.bank +
    pcts.cashlike_pct * RETURN_BP.cashlike +
    pcts.equities_pct * RETURN_BP.equities;
  return Math.floor((num + 50) / 100);
}

/** Ruling 14: stress column = 40% of the plan's equities sen (half-up). */
export function stressLossSen(equities_sen: number): number {
  return Math.floor((equities_sen * 40 + 50) / 100);
}

/** Plan in ringgit: pot split by preset percentages, largest remainder —
 *  parts always sum exactly to the pot. */
export function planInRinggit(
  pot_sen: number,
  preset: { bank_pct: number; cashlike_pct: number; equities_pct: number },
): { bank_sen: number; cashlike_sen: number; equities_sen: number } {
  const [bank, cashlike, equities] = apportion(
    [preset.bank_pct, preset.cashlike_pct, preset.equities_pct],
    pot_sen,
  );
  return { bank_sen: bank!, cashlike_sen: cashlike!, equities_sen: equities! };
}

/** Ruling 14: drift per bucket = current − target, signed points, in bucket
 *  order (v4's "route new savings" sentence picks the most-negative). */
export function driftLine(
  target: { bank_pct: number; cashlike_pct: number; equities_pct: number },
  current: { bank_pct: number; cashlike_pct: number; equities_pct: number },
): { bucket: Bucket; pts: number }[] {
  return [
    { bucket: "bank", pts: current.bank_pct - target.bank_pct },
    { bucket: "cashlike", pts: current.cashlike_pct - target.cashlike_pct },
    { bucket: "equities", pts: current.equities_pct - target.equities_pct },
  ];
}

/** Ruling 15: percentages of the EQUITIES slice. Kind 'etf' is the ETF side;
 *  everything else (stock, crypto) counts on the stock side. Side and
 *  per-holding percentages each sum to 100 via largest remainder (zero total
 *  => zeros). `target_etf_pct` is accepted for signature parity — the split
 *  bar's target labels render it directly; the math here reports actuals. */
export function equitiesSplit(
  rows: Array<{ id: string; kind: string; value_sen: number; target_pct: number | null }>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  target_etf_pct: number,
): {
  etf_pct: number;
  stock_pct: number;
  holdings: Array<{ id: string; pct: number; target_pct: number | null }>;
} {
  let etfTotal = 0;
  let stockTotal = 0;
  for (const r of rows) {
    if (r.kind === "etf") etfTotal += r.value_sen;
    else stockTotal += r.value_sen;
  }
  const [etf_pct, stock_pct] = apportion([etfTotal, stockTotal], 100);
  const pcts = apportion(rows.map((r) => r.value_sen), 100);
  return {
    etf_pct: etf_pct!,
    stock_pct: stock_pct!,
    holdings: rows.map((r, i) => ({ id: r.id, pct: pcts[i]!, target_pct: r.target_pct })),
  };
}

/** Ruling 15: the id of the holding MOST under its target (min pct −
 *  target_pct; ties: first in list). Holdings without a target can't win;
 *  null when no holding has a target set. */
export function rebalanceHint(split: ReturnType<typeof equitiesSplit>): string | null {
  let best: { id: string; diff: number } | null = null;
  for (const h of split.holdings) {
    if (h.target_pct === null) continue;
    const diff = h.pct - h.target_pct;
    if (!best || diff < best.diff) best = { id: h.id, diff };
  }
  return best ? best.id : null;
}
