/**
 * CoinGecko adapter — keyless simple/price endpoint, quoted in USD (crypto
 * holdings are entered with currency USD; USDMYR converts at valuation).
 * Holding symbol → coin id via the in-module map below (majors only). The
 * documented fallback for anything not in the map: return null → the chain
 * records an error entry → stale grace keeps the old price, and a manual
 * price override on the holding is the escape hatch. as_of is the UTC date
 * of last_updated_at (crypto trades continuously; no exchange calendar).
 */
import { z } from "zod";
import { FETCH_TIMEOUT_MS, toE8, type PriceSource, type Quote } from "./types";

const COIN_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  LTC: "litecoin",
  LINK: "chainlink",
  AVAX: "avalanche-2",
  USDT: "tether",
  USDC: "usd-coin",
  SHIB: "shiba-inu",
};

const priceSchema = z.record(
  z.string(),
  z.object({ usd: z.number(), last_updated_at: z.number().optional() }),
);

async function fetchSimplePrice(symbol: string): Promise<Quote | null> {
  const id = COIN_IDS[symbol.toUpperCase()];
  if (!id) return null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_last_updated_at=true`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const parsed = priceSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const coin = parsed.data[id];
    if (!coin) return null;
    const price_e8 = toE8(coin.usd);
    if (price_e8 === null) return null;
    const asOfMs = (coin.last_updated_at ?? Math.floor(Date.now() / 1000)) * 1000;
    return { price_e8, currency: "USD", as_of: new Date(asOfMs).toISOString().slice(0, 10) };
  } catch {
    return null;
  }
}

export const coingecko: PriceSource = {
  name: "coingecko",
  quote: (symbol) => fetchSimplePrice(symbol),
  fx: () => Promise.resolve(null), // FX is yahoo's job
};
