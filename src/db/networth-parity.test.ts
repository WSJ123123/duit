import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, makeTestUsers } from "@/db/test-clients";
import { snapshotParts } from "@/db/snapshots";
import { getNetWorth, getAllocation } from "@/db/networth";
import { getInvestments } from "@/db/portfolio";

/**
 * Ruling 12 (Plan 6, binding): ONE fixture — accounts incl. a non-MYR
 * brokerage account, holdings, business entries, manual values, liabilities,
 * plus a cross-currency transfer — fed through BOTH compositions:
 *   - the cron's snapshot assembly (src/db/snapshots.ts, admin client)
 *   - the page's getNetWorth (src/db/networth.ts, RLS session client)
 * The five parts must match EXACTLY. 2077 dates; fictional currency "ZPD"
 * (fx row 4.00) and "ZPX" (never fetched → excluded on both sides) — this
 * suite owns its global fx_rates keys.
 */

let a: SupabaseClient;
let admin: SupabaseClient;
let userId: string;

const DATE = "2077-06-01";

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  admin = adminClient();

  const bank = await a.from("accounts")
    .insert({ name: "Parity bank", type: "bank", starting_balance_sen: 50_000 })
    .select().single();
  if (bank.error) throw bank.error;
  const bankId = bank.data.id as string;
  userId = bank.data.user_id as string;

  const old = await a.from("accounts")
    .insert({ name: "Parity old", type: "bank", starting_balance_sen: 5_000, archived: true });
  if (old.error) throw old.error;

  const zpd = await a.from("accounts")
    .insert({ name: "ZPD broker", type: "brokerage", currency: "ZPD", starting_balance_sen: 10_000 })
    .select().single();
  if (zpd.error) throw zpd.error;
  const zpdId = zpd.data.id as string;

  const zpx = await a.from("accounts")
    .insert({ name: "ZPX broker", type: "brokerage", currency: "ZPX", starting_balance_sen: 999 });
  if (zpx.error) throw zpx.error;

  const fx = await admin.from("fx_rates").upsert(
    { pair: "ZPDMYR", rate_e8: 400_000_000, as_of: "2077-05-31", source: "test" },
    { onConflict: "pair" },
  );
  if (fx.error) throw fx.error;

  // cross-currency transfer: RM 44.20 out of the bank, ZPD 10.00 arrives
  const tr = await a.from("transactions").insert({
    type: "transfer", amount_sen: 4_420, received_sen: 1_000,
    account_id: bankId, transfer_account_id: zpdId, date: "2077-01-15",
  });
  if (tr.error) throw tr.error;

  // manual-priced MYR holding: 10 units, manual RM 2.50 → 2_500 sen
  const h = await a.from("holdings")
    .insert({
      symbol: "T5PAR", kind: "stock", currency: "MYR",
      price_source: "manual", manual_price_e8: 250_000_000,
    })
    .select().single();
  if (h.error) throw h.error;
  const buy = await a.from("trades").insert({
    holding_id: h.data.id, account_id: bankId, side: "buy", date: "2077-01-05",
    quantity_e8: 1_000_000_000, price_e8: 200_000_000, cash_delta_sen: 2_000,
  });
  if (buy.error) throw buy.error;

  // business: contribution out of the bank + a later valuation
  const biz = await a.from("business_investments")
    .insert({ name: "Parity biz" }).select().single();
  if (biz.error) throw biz.error;
  const entries = await a.from("business_investment_entries").insert([
    { business_id: biz.data.id, kind: "contribution", amount_sen: 10_000, account_id: bankId, date: "2077-01-10" },
    { business_id: biz.data.id, kind: "valuation", amount_sen: 20_000, date: "2077-02-01" },
  ]);
  if (entries.error) throw entries.error;

  const asset = await a.from("manual_assets")
    .insert({ name: "Parity EPF", kind: "epf" }).select().single();
  if (asset.error) throw asset.error;
  const av = await a.from("manual_asset_values")
    .insert({ asset_id: asset.data.id, value_sen: 100_000, noted_on: "2077-04-01" });
  if (av.error) throw av.error;

  const liab = await a.from("liabilities")
    .insert({ name: "Parity loan", kind: "loan" }).select().single();
  if (liab.error) throw liab.error;
  const lv = await a.from("liability_values")
    .insert({ liability_id: liab.data.id, balance_sen: 30_000, noted_on: "2077-04-01" });
  if (lv.error) throw lv.error;
}, 30_000);

describe("ruling 12 — snapshot assembly vs getNetWorth parity", () => {
  it("the five parts match exactly for the identical fixture", async () => {
    const cron = await snapshotParts(admin, userId);
    const page = await getNetWorth(a, DATE);

    // Expected by hand:
    // bank: 50_000 − 2_000 (buy) − 10_000 (contribution) − 4_420 (transfer out) = 33_580
    // archived: 5_000 · ZPD: (10_000 + 1_000 received) × 4.00 = 44_000
    // ZPX: EXCLUDED (no rate row yet)
    const expected = {
      accounts_sen: 82_580,
      holdings_sen: 2_500,
      business_sen: 20_000,
      manual_assets_sen: 100_000,
      liabilities_sen: 30_000,
    };

    expect({
      accounts_sen: cron.accounts_sen,
      holdings_sen: cron.holdings_sen,
      business_sen: cron.business_sen,
      manual_assets_sen: cron.manual_assets_sen,
      liabilities_sen: cron.liabilities_sen,
    }).toEqual(expected);
    expect({
      accounts_sen: page.parts.accounts_sen,
      holdings_sen: page.parts.holdings_sen,
      business_sen: page.parts.business_sen,
      manual_assets_sen: page.parts.manual_assets_sen,
      liabilities_sen: page.parts.liabilities_sen,
    }).toEqual(expected);
    expect(cron.total_sen).toBe(page.parts.total_sen);
  });

  it("the page names the excluded currency for its warn line", async () => {
    const page = await getNetWorth(a, DATE);
    expect(page.fx_missing).toEqual(["ZPX"]);
  });

  it("allocation pot buckets convert the non-MYR cashlike account (ruling 7)", async () => {
    const alloc = await getAllocation(a, DATE);
    // bank 33_580 · cashlike = ZPD 44_000 (ZPX excluded: no rate) ·
    // equities = the listed holding 2_500. Archived accounts stay out.
    expect(alloc.buckets).toEqual({
      bank_sen: 33_580,
      cashlike_sen: 44_000,
      equities_sen: 2_500,
      pot_sen: 80_080,
    });
  });

  it("investments Cash · MMF row reads converted MYR; native amounts stay named", async () => {
    const inv = await getInvestments(a, DATE);
    expect(inv.cash.value_sen).toBe(44_000); // ZPD 110.00 × 4.00; ZPX excluded
    const zpd = inv.cash.accounts.find((c) => c.currency === "ZPD");
    expect(zpd).toMatchObject({ balance_sen: 11_000, myr_sen: 44_000 });
    const zpx = inv.cash.accounts.find((c) => c.currency === "ZPX");
    expect(zpx).toMatchObject({ balance_sen: 999, myr_sen: null });
    expect(inv.portfolio_total_sen).toBe(46_500); // 2_500 holdings + 44_000 cash
  });
});
