/**
 * Per-user net-worth snapshot assembly for the daily cron (admin client).
 * Composes the SAME pure libs the Net Worth pages use — portfolio.ts for
 * holdings valuation, networth.ts for business/latest-value math — so the
 * cron and the pages can never disagree on the numbers.
 *
 * Composition rules:
 * - accounts: the account_balances view summed over ALL accounts, archived
 *   included (ruling 9); may be negative.
 * - holdings: non-archived only; position × effective price (manual wins,
 *   ruling 11) × FX (sen per minor unit ×1e8; MYR = identity). A holding
 *   with no usable price or FX row contributes 0 until the next successful
 *   fetch — stale rows in prices/fx_rates are used as-is (ruling 10).
 * - business / manual assets / liabilities: non-archived items only;
 *   businessStats value and latestValues per item. Liabilities positive.
 * - The upsert is idempotent on (user_id, date) — double-fire converges.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  effectivePriceE8,
  holdingValueSen,
  positionFromTrades,
  type TradeLike,
} from "@/lib/portfolio";
import {
  businessStats,
  latestValues,
  netWorthTotal,
  accountsTotalMyrSen,
  type NetWorthParts,
} from "@/lib/networth";

const FX_IDENTITY_E8 = 100_000_000;

type Db = SupabaseClient;

async function rows<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Task 5 (ruling 7): non-MYR account balances convert at their <CUR>MYR
 *  rate via the SAME pure helper the pages use (accountsTotalMyrSen); a
 *  never-fetched account currency is EXCLUDED until a rate lands — matching
 *  getNetWorth exactly (ruling 12 parity). */
async function accountsSen(admin: Db, userId: string): Promise<number> {
  const [accounts, balances] = await Promise.all([
    rows<{ id: string; currency: string }>(
      admin.from("accounts").select("id, currency").eq("user_id", userId),
    ),
    rows<{ account_id: string; balance_sen: number }>(
      admin.from("account_balances").select("account_id, balance_sen").eq("user_id", userId),
    ),
  ]);
  const balanceById = new Map(balances.map((b) => [b.account_id, Number(b.balance_sen)]));
  const pairs = [...new Set(accounts.filter((a) => a.currency !== "MYR").map((a) => `${a.currency}MYR`))];
  const fx = pairs.length
    ? await rows<{ pair: string; rate_e8: number }>(
        admin.from("fx_rates").select("pair, rate_e8").in("pair", pairs),
      )
    : [];
  return accountsTotalMyrSen(
    accounts.map((a) => ({ balance_sen: balanceById.get(a.id) ?? 0, currency: a.currency })),
    new Map(fx.map((r) => [r.pair, r.rate_e8])),
  ).total_sen;
}

async function holdingsSen(admin: Db, userId: string): Promise<number> {
  const holdings = await rows<{
    id: string;
    symbol: string;
    currency: string;
    price_source: string;
    manual_price_e8: number | null;
  }>(
    admin
      .from("holdings")
      .select("id, symbol, currency, price_source, manual_price_e8")
      .eq("user_id", userId)
      .eq("archived", false),
  );
  if (holdings.length === 0) return 0;

  const trades = await rows<TradeLike & { holding_id: string }>(
    admin
      .from("trades")
      .select("holding_id, side, date, quantity_e8, price_e8, fees_cent")
      .eq("user_id", userId),
  );
  const byHolding = new Map<string, TradeLike[]>();
  for (const t of trades) {
    const list = byHolding.get(t.holding_id) ?? [];
    list.push(t);
    byHolding.set(t.holding_id, list);
  }

  const prices = await rows<{ symbol: string; price_e8: number }>(
    admin.from("prices").select("symbol, price_e8").in("symbol", holdings.map((h) => h.symbol)),
  );
  const priceBySymbol = new Map(prices.map((p) => [p.symbol, p]));

  const pairs = [...new Set(holdings.filter((h) => h.currency !== "MYR").map((h) => `${h.currency}MYR`))];
  const fx = pairs.length
    ? await rows<{ pair: string; rate_e8: number }>(
        admin.from("fx_rates").select("pair, rate_e8").in("pair", pairs),
      )
    : [];
  const fxByPair = new Map(fx.map((r) => [r.pair, r.rate_e8]));

  let total = 0;
  for (const h of holdings) {
    const position = positionFromTrades(byHolding.get(h.id) ?? []);
    if (position.quantity_e8 === 0) continue;
    const price = effectivePriceE8(h, priceBySymbol.get(h.symbol) ?? null);
    const fxE8 = h.currency === "MYR" ? FX_IDENTITY_E8 : fxByPair.get(`${h.currency}MYR`);
    if (price === null || fxE8 === undefined) continue; // no data yet → 0 until a fetch lands
    total += holdingValueSen(position.quantity_e8, price, fxE8);
  }
  return total;
}

async function businessSen(admin: Db, userId: string): Promise<number> {
  const businesses = await rows<{ id: string }>(
    admin.from("business_investments").select("id").eq("user_id", userId).eq("archived", false),
  );
  if (businesses.length === 0) return 0;
  const entries = await rows<{
    business_id: string;
    kind: string;
    amount_sen: number;
    date: string;
    created_at: string;
  }>(
    admin
      .from("business_investment_entries")
      .select("business_id, kind, amount_sen, date, created_at")
      .eq("user_id", userId),
  );
  let total = 0;
  for (const b of businesses) {
    total += businessStats(entries.filter((e) => e.business_id === b.id)).value_sen;
  }
  return total;
}

function sumLatest(
  items: Array<{ id: string }>,
  history: Array<{ item_id: string; value_sen: number; noted_on: string; created_at: string }>,
): number {
  const latest = latestValues(history);
  return items.reduce((sum, i) => sum + (latest.get(i.id) ?? 0), 0);
}

async function manualAssetsSen(admin: Db, userId: string): Promise<number> {
  const items = await rows<{ id: string }>(
    admin.from("manual_assets").select("id").eq("user_id", userId).eq("archived", false),
  );
  if (items.length === 0) return 0;
  const values = await rows<{ asset_id: string; value_sen: number; noted_on: string; created_at: string }>(
    admin
      .from("manual_asset_values")
      .select("asset_id, value_sen, noted_on, created_at")
      .eq("user_id", userId),
  );
  return sumLatest(items, values.map((v) => ({ ...v, item_id: v.asset_id })));
}

async function liabilitiesSen(admin: Db, userId: string): Promise<number> {
  const items = await rows<{ id: string }>(
    admin.from("liabilities").select("id").eq("user_id", userId).eq("archived", false),
  );
  if (items.length === 0) return 0;
  const values = await rows<{ liability_id: string; balance_sen: number; noted_on: string; created_at: string }>(
    admin
      .from("liability_values")
      .select("liability_id, balance_sen, noted_on, created_at")
      .eq("user_id", userId),
  );
  return sumLatest(
    items,
    values.map((v) => ({ item_id: v.liability_id, value_sen: v.balance_sen, noted_on: v.noted_on, created_at: v.created_at })),
  );
}

export async function snapshotParts(admin: Db, userId: string): Promise<NetWorthParts> {
  const [accounts_sen, holdings_sen, business_sen, manual_assets_sen, liabilities_sen] =
    await Promise.all([
      accountsSen(admin, userId),
      holdingsSen(admin, userId),
      businessSen(admin, userId),
      manualAssetsSen(admin, userId),
      liabilitiesSen(admin, userId),
    ]);
  return netWorthTotal({ accounts_sen, holdings_sen, business_sen, manual_assets_sen, liabilities_sen });
}

/** Upsert the user's snapshot for the given KL date — idempotent (rule 14). */
export async function writeSnapshot(admin: Db, userId: string, dateIso: string): Promise<void> {
  const parts = await snapshotParts(admin, userId);
  const { error } = await admin.from("net_worth_snapshots").upsert(
    {
      user_id: userId,
      date: dateIso,
      accounts_sen: parts.accounts_sen,
      holdings_sen: parts.holdings_sen,
      business_sen: parts.business_sen,
      manual_assets_sen: parts.manual_assets_sen,
      liabilities_sen: parts.liabilities_sen,
    },
    { onConflict: "user_id,date" },
  );
  if (error) throw new Error(error.message);
}
