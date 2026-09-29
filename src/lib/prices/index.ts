/**
 * The source chain — the ONLY entry point the cron route uses (rule 31).
 * Stocks/ETFs and FX: yahoo. Crypto: coingecko. Yahoo-only is an accepted
 * reality (docs/findings.md #14 — the prior fallback source was unusable
 * server-side and was deleted rather than kept as a dead adapter); the
 * backstops for an outage are stale grace (downstream in the cron route)
 * and manual price override. Per-symbol failures become { error } entries;
 * the chain never rejects.
 */
import { coingecko } from "./coingecko";
import { yahoo } from "./yahoo";
import type { PriceSource, Quote, ResolvedQuote } from "./types";

export type { Quote, ResolvedQuote } from "./types";

const STOCK_CHAIN: PriceSource[] = [yahoo];
const CRYPTO_CHAIN: PriceSource[] = [coingecko];
const FX_CHAIN: PriceSource[] = [yahoo];

async function resolve(
  chain: PriceSource[],
  call: (source: PriceSource) => Promise<Quote | null>,
): Promise<ResolvedQuote | { error: string }> {
  for (const source of chain) {
    try {
      const quote = await call(source);
      if (quote) return { ...quote, source: source.name };
    } catch {
      // adapters resolve null on failure; a throw is treated the same way
    }
  }
  return { error: `${chain.map((s) => s.name).join(", ")} unavailable` };
}

export async function fetchQuotes(
  symbols: Array<{ symbol: string; kind: string }>,
): Promise<Map<string, ResolvedQuote | { error: string }>> {
  const out = new Map<string, ResolvedQuote | { error: string }>();
  await Promise.all(
    symbols.map(async ({ symbol, kind }) => {
      const chain = kind === "crypto" ? CRYPTO_CHAIN : STOCK_CHAIN;
      out.set(symbol, await resolve(chain, (s) => s.quote(symbol)));
    }),
  );
  return out;
}

export async function fetchFx(
  pairs: string[],
): Promise<Map<string, ResolvedQuote | { error: string }>> {
  const out = new Map<string, ResolvedQuote | { error: string }>();
  await Promise.all(
    pairs.map(async (pair) => {
      out.set(pair, await resolve(FX_CHAIN, (s) => s.fx(pair)));
    }),
  );
  return out;
}
