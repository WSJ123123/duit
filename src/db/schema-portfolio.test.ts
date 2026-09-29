import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { makeTestUsers, adminClient } from "@/db/test-clients";

let a: SupabaseClient;
let admin: SupabaseClient;
let aUserId: string;
let acctId: string;
let holdingId: string;
let bizId: string;

/** The local stack's DB container: `supabase_db_<project_id>` from
 *  supabase/config.toml, overridable with SUPABASE_DB_CONTAINER. */
const dbContainer =
  process.env.SUPABASE_DB_CONTAINER ??
  `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))?.[1] ?? "duit"}`;

/** Catalog checks (reloptions, proacl) go straight to the local DB container. */
const psql = (sql: string): string =>
  execSync(
    `docker exec ${dbContainer} psql -U postgres -d postgres -tAc ${JSON.stringify(sql)}`,
  ).toString().trim();

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  admin = adminClient();
  const acct = await a.from("accounts")
    .insert({ name: "Broker cash", type: "bank" }).select().single();
  if (acct.error) throw acct.error;
  acctId = acct.data.id;
  aUserId = acct.data.user_id;

  const holding = await a.from("holdings")
    .insert({ symbol: "CSPX", name: "iShares S&P 500", kind: "etf", currency: "USD" })
    .select().single();
  if (holding.error) throw holding.error;
  holdingId = holding.data.id;

  const biz = await a.from("business_investments")
    .insert({ name: "Kedai runcit" }).select().single();
  if (biz.error) throw biz.error;
  bizId = biz.data.id;
}, 30_000);

describe("holdings", () => {
  it("creates a holding and rejects a duplicate (user_id, symbol)", async () => {
    const first = await a.from("holdings")
      .insert({ symbol: "VWRA", kind: "etf", currency: "USD" }).select().single();
    expect(first.error).toBeNull();
    expect(first.data!.price_source).toBe("auto");
    const dupe = await a.from("holdings").insert({ symbol: "VWRA", kind: "etf" });
    expect(dupe.error).not.toBeNull();
  });

  it("rejects price_source='manual' without manual_price_e8", async () => {
    const bad = await a.from("holdings")
      .insert({ symbol: "ASNB", kind: "stock", price_source: "manual" });
    expect(bad.error).not.toBeNull();
    const good = await a.from("holdings")
      .insert({ symbol: "ASNB2", kind: "stock", price_source: "manual", manual_price_e8: 100_000_000 })
      .select().single();
    expect(good.error).toBeNull();
  });
});

describe("trades", () => {
  const trade = (overrides: Record<string, unknown>) => ({
    holding_id: holdingId, account_id: acctId, side: "buy", date: "2077-01-05",
    quantity_e8: 100_000_000, price_e8: 4_500_000_000, cash_delta_sen: 20_000,
    ...overrides,
  });

  it("rejects zero and negative quantity_e8; accepts a positive buy", async () => {
    for (const bad of [0, -100_000_000]) {
      const { error } = await a.from("trades").insert(trade({ quantity_e8: bad }));
      expect(error).not.toBeNull();
    }
    const ok = await a.from("trades").insert(trade({})).select().single();
    expect(ok.error).toBeNull();
    expect(ok.data!.fees_cent).toBe(0);
  });

  it("rejects a negative cash_delta_sen (side carries the sign)", async () => {
    const { error } = await a.from("trades").insert(trade({ cash_delta_sen: -1 }));
    expect(error).not.toBeNull();
  });
});

describe("manual asset / liability value histories", () => {
  it("same-day asset value upserts rather than duplicates", async () => {
    const asset = await a.from("manual_assets")
      .insert({ name: "EPF", kind: "epf" }).select().single();
    expect(asset.error).toBeNull();
    const assetId = asset.data!.id;

    const first = await a.from("manual_asset_values")
      .upsert({ asset_id: assetId, value_sen: 1_000_000, noted_on: "2077-03-01" },
        { onConflict: "user_id,asset_id,noted_on" });
    expect(first.error).toBeNull();
    const again = await a.from("manual_asset_values")
      .upsert({ asset_id: assetId, value_sen: 2_000_000, noted_on: "2077-03-01" },
        { onConflict: "user_id,asset_id,noted_on" });
    expect(again.error).toBeNull();

    const rows = await a.from("manual_asset_values").select().eq("asset_id", assetId);
    expect(rows.data).toHaveLength(1);
    expect(rows.data![0].value_sen).toBe(2_000_000);
  });

  it("same-day liability balance upserts rather than duplicates", async () => {
    const liab = await a.from("liabilities")
      .insert({ name: "PTPTN", kind: "ptptn", interest_rate_bp: 100 }).select().single();
    expect(liab.error).toBeNull();
    const liabId = liab.data!.id;

    const first = await a.from("liability_values")
      .upsert({ liability_id: liabId, balance_sen: 3_000_000, noted_on: "2077-03-01" },
        { onConflict: "user_id,liability_id,noted_on" });
    expect(first.error).toBeNull();
    const again = await a.from("liability_values")
      .upsert({ liability_id: liabId, balance_sen: 2_900_000, noted_on: "2077-03-01" },
        { onConflict: "user_id,liability_id,noted_on" });
    expect(again.error).toBeNull();

    const rows = await a.from("liability_values").select().eq("liability_id", liabId);
    expect(rows.data).toHaveLength(1);
    expect(rows.data![0].balance_sen).toBe(2_900_000);
  });
});

describe("business_investment_entries", () => {
  it("valuation with an account is rejected; cash kinds require an account", async () => {
    const valuationWithAccount = await a.from("business_investment_entries")
      .insert({ business_id: bizId, kind: "valuation", amount_sen: 500_000, account_id: acctId, date: "2077-02-01" });
    expect(valuationWithAccount.error).not.toBeNull();

    const contributionWithoutAccount = await a.from("business_investment_entries")
      .insert({ business_id: bizId, kind: "contribution", amount_sen: 100_000, date: "2077-02-01" });
    expect(contributionWithoutAccount.error).not.toBeNull();

    const contribution = await a.from("business_investment_entries")
      .insert({ business_id: bizId, kind: "contribution", amount_sen: 100_000, account_id: acctId, date: "2077-02-01" });
    expect(contribution.error).toBeNull();
    const valuation = await a.from("business_investment_entries")
      .insert({ business_id: bizId, kind: "valuation", amount_sen: 500_000, date: "2077-02-02" });
    expect(valuation.error).toBeNull();
  });
});

describe("allocation_presets", () => {
  it("rejects a pct split summing past 100 (6/50/45); accepts 5/50/45", async () => {
    const bad = await a.from("allocation_presets")
      .insert({ key: "balanced", bank_pct: 6, cashlike_pct: 50, equities_pct: 45 });
    expect(bad.error).not.toBeNull();
    const good = await a.from("allocation_presets")
      .insert({ key: "balanced", bank_pct: 5, cashlike_pct: 50, equities_pct: 45 })
      .select().single();
    expect(good.error).toBeNull();
  });
});

describe("net_worth_snapshots", () => {
  it("service role writes; unique (user_id, date) holds", async () => {
    const row = {
      user_id: aUserId, date: "2077-04-01", accounts_sen: 100_000,
      holdings_sen: 0, business_sen: 0, manual_assets_sen: 0, liabilities_sen: 0,
    };
    const first = await admin.from("net_worth_snapshots").insert(row);
    expect(first.error).toBeNull();
    const dupe = await admin.from("net_worth_snapshots")
      .insert({ ...row, accounts_sen: 200_000 });
    expect(dupe.error).not.toBeNull();
  });
});

describe("account_balances view", () => {
  it("remains security_invoker after the replace", () => {
    const opts = psql(
      "select reloptions from pg_class where oid = 'public.account_balances'::regclass",
    );
    expect(opts).toMatch(/security_invoker=(true|on)/);
  });
});

describe("Plan-1 function ACLs state their intent (finding #11)", () => {
  it("seed_default_categories: no PUBLIC/anon execute; authenticated keeps it", () => {
    const acl = psql("select proacl from pg_proc where proname = 'seed_default_categories'");
    expect(acl).toContain("authenticated=X");
    expect(acl).not.toContain("anon=");
    expect(acl).not.toMatch(/[{,]=X/); // bare `=X` entry = PUBLIC
  });

  it("touch_updated_at: owner-only (trigger-only function)", () => {
    const acl = psql("select proacl from pg_proc where proname = 'touch_updated_at'");
    expect(acl).toContain("postgres=X");
    expect(acl).not.toContain("authenticated=");
    expect(acl).not.toContain("anon=");
    expect(acl).not.toMatch(/[{,]=X/);
  });

  it("updated_at trigger still fires post-revoke", async () => {
    const tx = await a.from("transactions")
      .insert({ type: "expense", amount_sen: 100, account_id: acctId })
      .select().single();
    expect(tx.error).toBeNull();
    const upd = await a.from("transactions")
      .update({ note: "post-revoke touch" }).eq("id", tx.data!.id).select().single();
    expect(upd.error).toBeNull();
    expect(new Date(upd.data!.updated_at).getTime())
      .toBeGreaterThan(new Date(tx.data!.updated_at).getTime());
  });
});
