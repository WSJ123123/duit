/**
 * Price/FX source adapter contract (rule 31). External market-data fetches
 * happen ONLY inside src/lib/prices/, and only the cron route calls the
 * chain in index.ts — nothing outside this layer knows which source is in
 * use. Adapters never throw out of the chain: any failure (HTTP error,
 * malformed body, schema miss, timeout) resolves to null.
 */

export interface Quote {
  price_e8: number; // fixed-point ×1e8, major currency units per unit
  currency: string; // ISO-4217; label only — valuation FX keys off holdings.currency
  as_of: string; // "YYYY-MM-DD" trading date
}

/** Chain result: the winning quote plus the adapter name for provenance
 *  (the prices/fx_rates `source` column). Callers treat it as opaque. */
export interface ResolvedQuote extends Quote {
  source: string;
}

export interface PriceSource {
  name: string;
  /** Resolve one symbol; null = not found / unparseable (caller falls through). */
  quote(symbol: string): Promise<Quote | null>;
  /** FX pair e.g. "USDMYR"; null = unsupported. */
  fx(pair: string): Promise<Quote | null>;
}

export const FETCH_TIMEOUT_MS = 8000;

/**
 * Decimal → e8 fixed point: one Number() parse of the source's decimal,
 * scaled by 1e8 with explicit rounding (pinned by tests, incl. sub-cent
 * crypto). Null for non-finite, non-positive, or unsafe-integer results —
 * the prices/fx tables require price_e8 > 0.
 */
export function toE8(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const e8 = Math.round(value * 1e8);
  return Number.isSafeInteger(e8) && e8 > 0 ? e8 : null;
}

/** Epoch seconds → "YYYY-MM-DD" in the given IANA zone (en-CA formats ISO);
 *  falls back to the UTC date if the zone name is unusable. */
export function isoDateInZone(epochSec: number, timeZone: string): string {
  const d = new Date(epochSec * 1000);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
