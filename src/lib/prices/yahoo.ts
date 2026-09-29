/**
 * Yahoo Finance adapter — unofficial, keyless v8 chart endpoint
 * (query1.finance.yahoo.com/v8/finance/chart/{symbol}). The v7 quote
 * endpoint needs a cookie+crumb dance, the chart meta does not; symbols go
 * up exactly as the user entered them (VWRA.L, 1155.KL, AAPL) and FX pairs
 * as {PAIR}=X. as_of is the trading date in the exchange's own timezone.
 * Caveat: LSE GBp listings report currency "GBp" in pence — stored
 * uppercased as a label only; valuation FX keys off holdings.currency.
 */
import { z } from "zod";
import { FETCH_TIMEOUT_MS, isoDateInZone, toE8, type PriceSource, type Quote } from "./types";

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            currency: z.string(),
            regularMarketPrice: z.number(),
            regularMarketTime: z.number(),
            exchangeTimezoneName: z.string().optional(),
          }),
        }),
      )
      .nullish(),
  }),
});

async function fetchChart(symbol: string): Promise<Quote | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      {
        headers: { "user-agent": "Mozilla/5.0 (compatible; duit-cron/1.0)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const parsed = chartSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const meta = parsed.data.chart.result?.[0]?.meta;
    if (!meta) return null;
    const price_e8 = toE8(meta.regularMarketPrice);
    if (price_e8 === null) return null;
    return {
      price_e8,
      currency: meta.currency.toUpperCase(),
      as_of: isoDateInZone(meta.regularMarketTime, meta.exchangeTimezoneName ?? "UTC"),
    };
  } catch {
    return null; // timeout, network, non-JSON body — the chain falls through
  }
}

export const yahoo: PriceSource = {
  name: "yahoo",
  quote: (symbol) => fetchChart(symbol),
  fx: (pair) => (/^[A-Z]{6}$/.test(pair) ? fetchChart(`${pair}=X`) : Promise.resolve(null)),
};
