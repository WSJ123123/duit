import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, makeTestUsers } from "@/db/test-clients";
import { writeSnapshot } from "@/db/snapshots";

/**
 * Snapshot assembly against 2077-dated fixtures (binding convention);
 * "today" is parameterized, never read from the clock. Worked holding
 * example is the portfolio.ts header one: 16.2 × 139.75 × 4.42 →
 * 1_000_666 sen. The priced holding uses a fictional currency code "ZZD"
 * (fx pair "ZZDMYR") rather than "USD"/"USDMYR" so this suite owns its
 * global prices/fx_rates keys — rls.test.ts also seeds "USDMYR" for its
 * shared-read RLS test, and prices/fx_rates have no user_id to scope by,
 * so overlapping keys race across parallel test files.
 */
let a: SupabaseClient;
let admin: SupabaseClient;
let userId: string;
let acct1: string;
let assetId: string;

const DATE = "2077-06-01";

async function insertHolding(
  row: Record<string, unknown>,
): Promise<string> {
  const res = await a.from("holdings").insert(row).select().single();
  if (res.error) throw res.error;
  return res.data.id as string;
}

async function buy(
  holding_id: string,
  quantity_e8: number,
  price_e8: number,
  cash_delta_sen: number,
): Promise<void> {
  const res = await a.from("trades").insert({
    holding_id, account_id: acct1, side: "buy", date: "2077-01-05",
    quantity_e8, price_e8, cash_delta_sen,
  });
  if (res.error) throw res.error;
}

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  admin = adminClient();

  // accounts: acct1 active (starting 100_000), acct2 ARCHIVED (starting
  // 5_000) — ruling 9: snapshots sum ALL accounts, archived included.
  const r1 = await a.from("accounts")
    .insert({ name: "Broker cash", type: "bank", starting_balance_sen: 100_000 })
    .select().single();
  if (r1.error) throw r1.error;
  acct1 = r1.data.id;
  userId = r1.data.user_id;
  const r2 = await a.from("accounts")
    .insert({ name: "Old bank", type: "bank", starting_balance_sen: 5_000, archived: true });
  if (r2.error) throw r2.error;

  // Task 5 (ruling 7): non-MYR accounts. acct3 is ZZD-denominated (rate row
  // exists: 4.42) → its 10_000 minor units convert to 44_200 sen; acct4 is
  // "ZZQ" with NO fx row (never fetched) → EXCLUDED from accounts_sen until
  // a rate lands — honest gap, never a fabricated rate.
  const r3 = await a.from("accounts")
    .insert({ name: "ZZD broker", type: "brokerage", currency: "ZZD", starting_balance_sen: 10_000 });
  if (r3.error) throw r3.error;
  const r4 = await a.from("accounts")
    .insert({ name: "ZZQ broker", type: "brokerage", currency: "ZZQ", starting_balance_sen: 7_777 });
  if (r4.error) throw r4.error;

  // holdings: auto-priced ZZD ETF (the worked example; fictional currency
  // so this suite owns its fx_rates/prices keys — see header comment),
  // manual-priced MYR (manual price must beat a conflicting prices row),
  // auto with NO price row (values at 0 until a fetch succeeds), and an
  // archived one (excluded).
  const h1 = await insertHolding({ symbol: "T4VWRA", kind: "etf", currency: "ZZD" });
  await buy(h1, 1_620_000_000, 13_975_000_000, 40_000);
  const h2 = await insertHolding({
    symbol: "T4MAN", kind: "stock", currency: "MYR",
    price_source: "manual", manual_price_e8: 250_000_000,
  });
  await buy(h2, 1_000_000_000, 200_000_000, 0);
  const h3 = await insertHolding({ symbol: "T4NOPX", kind: "stock", currency: "USD" });
  await buy(h3, 100_000_000, 100_000_000, 0);
  const h4 = await insertHolding({ symbol: "T4ARCH", kind: "stock", currency: "MYR", archived: true });
  await buy(h4, 100_000_000, 100_000_000, 0);

  // global reference data (service-role writes)
  const pr = await admin.from("prices").upsert([
    { symbol: "T4VWRA", currency: "ZZD", price_e8: 13_975_000_000, as_of: "2077-05-31", source: "test" },
    { symbol: "T4MAN", currency: "MYR", price_e8: 999_999_999, as_of: "2077-05-31", source: "test" },
    { symbol: "T4ARCH", currency: "MYR", price_e8: 100_000_000, as_of: "2077-05-31", source: "test" },
  ], { onConflict: "symbol" });
  if (pr.error) throw pr.error;
  const fx = await admin.from("fx_rates").upsert(
    { pair: "ZZDMYR", rate_e8: 442_000_000, as_of: "2077-05-31", source: "test" },
    { onConflict: "pair" },
  );
  if (fx.error) throw fx.error;

  // manual asset with a superseded value; an archived asset (excluded)
  const asset = await a.from("manual_assets")
    .insert({ name: "EPF", kind: "epf" }).select().single();
  if (asset.error) throw asset.error;
  assetId = asset.data.id;
  await a.from("manual_asset_values").insert([
    { asset_id: assetId, value_sen: 900_000, noted_on: "2077-03-01" },
    { asset_id: assetId, value_sen: 1_000_000, noted_on: "2077-04-01" },
  ]);
  const dead = await a.from("manual_assets")
    .insert({ name: "Sold car", kind: "vehicle", archived: true }).select().single();
  await a.from("manual_asset_values")
    .insert({ asset_id: dead.data!.id, value_sen: 777, noted_on: "2077-03-01" });

  // liability with a superseded balance
  const liab = await a.from("liabilities")
    .insert({ name: "PTPTN", kind: "ptptn" }).select().single();
  if (liab.error) throw liab.error;
  await a.from("liability_values").insert([
    { liability_id: liab.data.id, balance_sen: 3_000_000, noted_on: "2077-03-01" },
    { liability_id: liab.data.id, balance_sen: 2_900_000, noted_on: "2077-04-01" },
  ]);

  // business: contribution 100_000 out of acct1 + a later valuation; an
  // archived business (excluded)
  const biz = await a.from("business_investments")
    .insert({ name: "Kedai" }).select().single();
  if (biz.error) throw biz.error;
  await a.from("business_investment_entries").insert([
    { business_id: biz.data.id, kind: "contribution", amount_sen: 100_000, account_id: acct1, date: "2077-01-10" },
    { business_id: biz.data.id, kind: "valuation", amount_sen: 500_000, date: "2077-02-01" },
  ]);
  const deadBiz = await a.from("business_investments")
    .insert({ name: "Closed", archived: true }).select().single();
  await a.from("business_investment_entries").insert(
    { business_id: deadBiz.data!.id, kind: "valuation", amount_sen: 9_999_999, date: "2077-02-01" },
  );
}, 30_000);

describe("writeSnapshot", () => {
  it("assembles the five parts from the same libs the pages use", async () => {
    await writeSnapshot(admin, userId, DATE);
    const { data } = await a.from("net_worth_snapshots").select().eq("date", DATE);
    expect(data).toHaveLength(1);
    const row = data![0]!;
    // 100_000 − 40_000 (buy) − 100_000 (business contribution) + 5_000
    // (archived acct) + 44_200 (ZZD 100.00 × 4.42, Task 5 conversion);
    // the ZZQ account (no fx row) is EXCLUDED until a rate lands.
    expect(row.accounts_sen).toBe(9_200);
    // 1_000_666 (worked example) + 2_500 (manual: 10 × RM 2.50); T4NOPX has
    // no price row → 0; T4ARCH archived → excluded
    expect(row.holdings_sen).toBe(1_003_166);
    expect(row.business_sen).toBe(500_000);
    expect(row.manual_assets_sen).toBe(1_000_000);
    expect(row.liabilities_sen).toBe(2_900_000); // stored positive
  });

  it("double-fire converges to one row and refreshes values (rule 14)", async () => {
    await writeSnapshot(admin, userId, DATE);
    await a.from("manual_asset_values")
      .insert({ asset_id: assetId, value_sen: 1_100_000, noted_on: "2077-05-01" });
    await writeSnapshot(admin, userId, DATE);
    const { data } = await a.from("net_worth_snapshots").select().eq("date", DATE);
    expect(data).toHaveLength(1);
    expect(data![0]!.manual_assets_sen).toBe(1_100_000);
  });
});
