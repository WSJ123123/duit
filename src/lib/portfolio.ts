/**
 * Pure portfolio math: average-cost basis, realized/unrealized P/L, and
 * valuation. No I/O, no clock — every date is a parameter. All arithmetic is
 * native BigInt internally (two e8 values multiplied overflow 2^53); results
 * convert to `number` only at the final sen/cent exit, guarded by assertSen.
 *
 * Scale conventions (binding for Tasks 4–7):
 * - `quantity_e8` and `price_e8` are fixed-point × 1e8 in units / major
 *   currency units (16.2 units → 1_620_000_000; USD 139.75 → 13_975_000_000).
 * - `fx_e8` is sen per 1 minor unit of the holding currency, × 1e8 — for a
 *   MYR holding fx is the identity 100_000_000; USDMYR 4.42 → 442_000_000.
 * - Worked example: VWRA 16.2 units @ USD 139.75, USDMYR 4.42 →
 *   16.2 × 139.75 = USD 2,263.95 → × 4.42 = RM 10,006.659 → 1_000_666 sen.
 *
 * Rounding is half-up (half away from zero for negative P/L figures) at
 * minor-unit precision, in BigInt. Gross (qty × price) rounds to minor units
 * PER TRADE — each trade's gross rounds independently before costs, fees or
 * estimates accumulate, so a multi-trade total may differ by a sen from
 * rounding the summed product. Trades are processed chronologically; the
 * sort is stable, so same-day trades keep their input array order.
 */
import { assertSen } from "@/lib/money";

export interface TradeLike {
  side: "buy" | "sell";
  date: string; // "YYYY-MM-DD"
  quantity_e8: number;
  price_e8: number;
  fees_cent: number;
}

export interface Position {
  quantity_e8: number;
  cost_cent: number; // total average-cost basis, holding-currency minor units
  avg_cost_e8: number; // per-unit average cost (0 when flat)
  realized_cent: number; // lifetime realized P/L
}

/** A sell would take the held quantity negative at this date. */
export class OversellError extends Error {
  readonly date: string;
  constructor(date: string) {
    super(`sell exceeds held quantity on ${date}`);
    this.name = "OversellError";
    this.date = date;
  }
}

// Ruling 11: tsconfig now targets ES2020, so numeric-literal arguments become
// BigInt literals. Every other BigInt(...) call in this file takes a runtime
// value (trade/holding fields, not a literal) and stays a call.
const ZERO = 0n;
const TWO = 2n;
const E8 = 100_000_000n;
const E14 = 100_000_000_000_000n; // qty_e8 × price_e8 → minor units
const E22 = E8 * E14; // qty_e8 × price_e8 × fx_e8 → sen

/** Half-up division (half away from zero for negative n); d > 0. */
function divHalfUp(n: bigint, d: bigint): bigint {
  if (n < ZERO) return -divHalfUp(-n, d);
  return (n + d / TWO) / d;
}

/** Guarded BigInt → number exit for non-negative amounts. */
function toAmount(b: bigint): number {
  const n = Number(b);
  assertSen(n);
  return n;
}

/** Guarded BigInt → number exit for signed P/L figures. */
function toSigned(b: bigint): number {
  const n = Number(b);
  assertSen(Math.abs(n));
  return n;
}

/** Replays trades chronologically through the average-cost engine. */
function replay(
  trades: TradeLike[],
  onSell?: (date: string, realized_cent: bigint) => void,
): { qty: bigint; cost: bigint; realized: bigint } {
  const ordered = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let qty = ZERO;
  let cost = ZERO;
  let realized = ZERO;
  for (const t of ordered) {
    const q = BigInt(t.quantity_e8);
    const gross = divHalfUp(q * BigInt(t.price_e8), E14);
    const fees = BigInt(t.fees_cent);
    if (t.side === "buy") {
      qty += q;
      cost += gross + fees;
    } else {
      if (q > qty) throw new OversellError(t.date);
      // Sell-all removes the entire remaining cost exactly — no rounding residue.
      const removed = q === qty ? cost : divHalfUp(cost * q, qty);
      const delta = gross - fees - removed;
      qty -= q;
      cost -= removed;
      realized += delta;
      onSell?.(t.date, delta);
    }
  }
  return { qty, cost, realized };
}

/** Chronological average-cost engine (ruling 2). BigInt internally; half-up
 *  rounding at minor units; throws OversellError (with the offending date) if
 *  quantity would go negative at ANY point; sell-all zeroes cost exactly. */
export function positionFromTrades(trades: TradeLike[]): Position {
  const { qty, cost, realized } = replay(trades);
  return {
    quantity_e8: toAmount(qty),
    cost_cent: toAmount(cost),
    avg_cost_e8: qty === ZERO ? 0 : toAmount(divHalfUp(cost * E14, qty)),
    realized_cent: toSigned(realized),
  };
}

/** Realized P/L within one calendar year (ruling 17). */
export function realizedInYear(trades: TradeLike[], year: number): number {
  let total = ZERO;
  replay(trades, (date, realized_cent) => {
    if (Number(date.slice(0, 4)) === year) total += realized_cent;
  });
  return toSigned(total);
}

/** qty × price → holding-currency minor units → MYR sen via fx (see header). */
export function holdingValueSen(quantity_e8: number, price_e8: number, fx_e8: number): number {
  return toAmount(divHalfUp(BigInt(quantity_e8) * BigInt(price_e8) * BigInt(fx_e8), E22));
}

/** price_e8 / avg_cost_e8 → holding-currency minor units at 2dp (the unit
 *  price column's figure), half-up. Moved out of HoldingsTable.tsx's
 *  formatUnitPrice (Plan 9 Q35) so the component only formats. */
export function unitPriceMinor(priceE8: number): number {
  const n = Math.round(priceE8 / 1_000_000);
  assertSen(n);
  return n;
}

/** Holding-currency minor units → sen; same fx convention as holdingValueSen. */
export function centToSen(cent: number, fx_e8: number): number {
  return toSigned(divHalfUp(BigInt(cent) * BigInt(fx_e8), E8));
}

/** value − cost, in holding-currency minor units (display converts via centToSen). */
export function unrealizedCent(position: Position, price_e8: number): number {
  const value = divHalfUp(BigInt(position.quantity_e8) * BigInt(price_e8), E14);
  return toSigned(value - BigInt(position.cost_cent));
}

/** Effective price for a holding row (ruling 11): manual override wins. */
export function effectivePriceE8(
  h: { price_source: string; manual_price_e8: number | null },
  fetched: { price_e8: number } | null,
): number | null {
  if (h.price_source === "manual") return h.manual_price_e8;
  return fetched?.price_e8 ?? null;
}

/** Stale test (ruling 10): as_of older than the previous KL day. Both
 *  arguments are KL-calendar "YYYY-MM-DD" strings (callers derive todayIso
 *  via klToday). */
export function priceIsStale(as_of: string, todayIso: string): boolean {
  const [y, m, d] = todayIso.split("-").map(Number);
  const prevDay = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
  return as_of < prevDay;
}
