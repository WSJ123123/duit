import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { makeTestUsers, adminClient } from "@/db/test-clients";

/**
 * Cross-table RLS isolation gate (Plan 1, Task 14).
 * For EVERY user-scoped table, user B must be fully blind to user A's data:
 * select → [], insert-as-A → error, update/delete of A's row → no effect.
 * Adding a table to the schema without extending USER_TABLES below should
 * feel loud — extend the literal list when you add a table.
 */

let a: SupabaseClient, b: SupabaseClient;
let aUserId: string;
let acctId: string, catId: string, txId: string;
let holdingId: string, assetId: string, liabilityId: string, bizId: string;
let fundId: string;
const rowIds: Record<string, string> = {};

type TableSpec = {
  table: string;
  /** Insert payload B attempts with A's user_id explicitly set. */
  insertAsA: () => Record<string, unknown>;
  /** Benign update payload for the update-A's-row leg. */
  update: Record<string, unknown>;
  /** Whether `authenticated` has a DELETE grant (docs/findings.md #1;
   *  archive/revoke-only tables have none by design). */
  hasDeleteGrant: boolean;
  /** Whether `authenticated` has an UPDATE grant (append-only logs have
   *  none by design). Defaults to true. */
  hasUpdateGrant?: boolean;
  /** PK column used to target A's row (defaults to "id"). */
  pk?: string;
  /** One-row-per-user tables where B seeds its own row: the select leg
   *  asserts A's row is invisible instead of a fully empty result. */
  bSeedsOwnRow?: boolean;
};

const USER_TABLES: TableSpec[] = [
  {
    table: "accounts",
    insertAsA: () => ({ name: "evil", type: "bank", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "categories",
    insertAsA: () => ({ name: "evil", kind: "expense", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "transactions",
    insertAsA: () => ({
      type: "expense", amount_sen: 100, account_id: acctId, user_id: aUserId,
    }),
    update: { note: "hacked" },
    hasDeleteGrant: true,
  },
  {
    table: "transaction_splits",
    insertAsA: () => ({
      transaction_id: txId, category_id: catId, amount_sen: 100, user_id: aUserId,
    }),
    update: { amount_sen: 999 },
    hasDeleteGrant: true,
  },
  {
    table: "reimbursement_payments",
    insertAsA: () => ({
      transaction_id: txId, account_id: acctId, amount_sen: 10, user_id: aUserId,
    }),
    update: { note: "hacked" },
    hasDeleteGrant: true,
  },
  {
    table: "recurring_rules",
    insertAsA: () => ({
      name: "evil", type: "expense", amount_sen: 100, account_id: acctId,
      freq: "monthly", day_of_month: 1, next_run: "2026-09-01", user_id: aUserId,
    }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "parser_aliases",
    insertAsA: () => ({ phrase: "evil-phrase", user_id: aUserId }),
    update: { phrase: "hacked" },
    hasDeleteGrant: true,
  },
  {
    table: "api_tokens",
    insertAsA: () => ({ token_hash: randomBytes(32).toString("hex"), user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "budget_months",
    insertAsA: () => ({ month: "2026-10-01", user_id: aUserId }),
    update: { expected_income_sen: 999 },
    hasDeleteGrant: false,
  },
  {
    table: "budget_allocations",
    insertAsA: () => ({ month: "2026-10-01", category_id: catId, user_id: aUserId }),
    update: { planned_sen: 999 },
    hasDeleteGrant: false,
  },
  {
    table: "budget_changes",
    insertAsA: () => ({ month: "2026-09-01", from_sen: 0, to_sen: 100, user_id: aUserId }),
    update: { to_sen: 999 },
    hasDeleteGrant: false,
    hasUpdateGrant: false,
  },
  {
    // DELETE granted in phase 3.1 (Plan 6 ruling 5: zero-trade hard-delete);
    // RLS must still make A's holdings untouchable by B.
    table: "holdings",
    insertAsA: () => ({ symbol: "EVIL", kind: "stock", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: true,
  },
  {
    table: "trades",
    insertAsA: () => ({
      holding_id: holdingId, account_id: acctId, side: "buy", date: "2077-01-05",
      quantity_e8: 100_000_000, price_e8: 1, cash_delta_sen: 1, user_id: aUserId,
    }),
    update: { note: "hacked" },
    hasDeleteGrant: true,
  },
  {
    table: "manual_assets",
    insertAsA: () => ({ name: "evil", kind: "other", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "manual_asset_values",
    insertAsA: () => ({
      asset_id: assetId, value_sen: 1, noted_on: "2077-05-01", user_id: aUserId,
    }),
    update: { value_sen: 999 },
    hasDeleteGrant: true,
  },
  {
    table: "liabilities",
    insertAsA: () => ({ name: "evil", kind: "other", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "liability_values",
    insertAsA: () => ({
      liability_id: liabilityId, balance_sen: 1, noted_on: "2077-05-01", user_id: aUserId,
    }),
    update: { balance_sen: 999 },
    hasDeleteGrant: true,
  },
  {
    table: "business_investments",
    insertAsA: () => ({ name: "evil", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "business_investment_entries",
    insertAsA: () => ({
      business_id: bizId, kind: "contribution", amount_sen: 1,
      account_id: acctId, date: "2077-05-01", user_id: aUserId,
    }),
    update: { note: "hacked" },
    hasDeleteGrant: true,
  },
  {
    table: "allocation_presets",
    insertAsA: () => ({
      key: "growth", bank_pct: 10, cashlike_pct: 20, equities_pct: 70, user_id: aUserId,
    }),
    update: { bank_pct: 99 },
    hasDeleteGrant: false,
  },
  {
    // Archive-only (Plan 7 ruling 2): a fund is referenced by contributions
    // and by tagged transactions, so it never hard-deletes.
    table: "funds",
    insertAsA: () => ({ name: "evil", kind: "sinking", user_id: aUserId }),
    update: { name: "hacked" },
    hasDeleteGrant: false,
  },
  {
    table: "fund_contributions",
    insertAsA: () => ({
      fund_id: fundId, month: "2077-08-01", amount_sen: 1, user_id: aUserId,
    }),
    update: { amount_sen: 999 },
    hasDeleteGrant: true,
  },
  {
    // Never deleted (Plan 8 ruling 19): `undone_at` is a batch's archive.
    table: "import_batches",
    insertAsA: () => ({
      account_id: acctId, filename: "evil.csv",
      content_sha256: randomBytes(32).toString("hex"), row_count: 1, user_id: aUserId,
    }),
    update: { skipped_count: 999 },
    hasDeleteGrant: false,
  },
  {
    // Read-only for the API even toward one's own rows (service-role writes);
    // the owner-side write block is proven in its own describe below.
    table: "net_worth_snapshots",
    insertAsA: () => ({
      user_id: aUserId, date: "2077-06-02", accounts_sen: 0, holdings_sen: 0,
      business_sen: 0, manual_assets_sen: 0, liabilities_sen: 0,
    }),
    update: { accounts_sen: 999 },
    hasDeleteGrant: false,
    hasUpdateGrant: false,
  },
  {
    table: "user_settings",
    pk: "user_id",
    bSeedsOwnRow: true,
    insertAsA: () => ({ user_id: aUserId, show_tips: false }),
    update: { show_tips: false },
    hasDeleteGrant: false,
  },
];

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());

  // Seed one row per table as user A (same shapes as the Tasks 3-5 suites).
  const acct = await a.from("accounts")
    .insert({ name: "Maybank", type: "bank", starting_balance_sen: 100_000 })
    .select().single();
  if (acct.error) throw acct.error;
  acctId = acct.data.id;
  aUserId = acct.data.user_id;
  rowIds["accounts"] = acctId;

  const cat = await a.from("categories")
    .insert({ name: "Food", kind: "expense" }).select().single();
  if (cat.error) throw cat.error;
  catId = cat.data.id;
  rowIds["categories"] = catId;

  const tx = await a.from("transactions")
    .insert({ type: "expense", amount_sen: 1250, account_id: acctId })
    .select().single();
  if (tx.error) throw tx.error;
  txId = tx.data.id;
  rowIds["transactions"] = txId;

  const split = await a.from("transaction_splits")
    .insert({ transaction_id: txId, category_id: catId, amount_sen: 1250 })
    .select().single();
  if (split.error) throw split.error;
  rowIds["transaction_splits"] = split.data.id;

  const reimb = await a.from("reimbursement_payments")
    .insert({ transaction_id: txId, account_id: acctId, amount_sen: 10 })
    .select().single();
  if (reimb.error) throw reimb.error;
  rowIds["reimbursement_payments"] = reimb.data.id;

  const rule = await a.from("recurring_rules")
    .insert({
      name: "Rent", type: "expense", amount_sen: 150_000, account_id: acctId,
      freq: "monthly", day_of_month: 1, next_run: "2026-09-01",
    })
    .select().single();
  if (rule.error) throw rule.error;
  rowIds["recurring_rules"] = rule.data.id;

  const alias = await a.from("parser_aliases")
    .insert({ phrase: "mamak" }).select().single();
  if (alias.error) throw alias.error;
  rowIds["parser_aliases"] = alias.data.id;

  const token = await a.from("api_tokens")
    .insert({ token_hash: randomBytes(32).toString("hex") }).select().single();
  if (token.error) throw token.error;
  rowIds["api_tokens"] = token.data.id;

  const bm = await a.from("budget_months")
    .insert({ month: "2026-09-01", expected_income_sen: 500_000 }).select().single();
  if (bm.error) throw bm.error;
  rowIds["budget_months"] = bm.data.id;

  const alloc = await a.from("budget_allocations")
    .insert({ month: "2026-09-01", category_id: catId, planned_sen: 30_000 })
    .select().single();
  if (alloc.error) throw alloc.error;
  rowIds["budget_allocations"] = alloc.data.id;

  const change = await a.from("budget_changes")
    .insert({ month: "2026-09-01", category_id: catId, from_sen: 0, to_sen: 100 })
    .select().single();
  if (change.error) throw change.error;
  rowIds["budget_changes"] = change.data.id;

  // user_settings: one row per user (PK = user_id). Seed both users so the
  // select leg proves RLS filters A's row out rather than the table being empty.
  const settingsA = await a.from("user_settings")
    .upsert({ show_tips: true }).select().single();
  if (settingsA.error) throw settingsA.error;
  rowIds["user_settings"] = settingsA.data.user_id;

  const settingsB = await b.from("user_settings")
    .upsert({ show_tips: true }).select().single();
  if (settingsB.error) throw settingsB.error;

  // Phase-3 rows (2077 fixture dates per the clock-free convention).
  const holding = await a.from("holdings")
    .insert({ symbol: "CSPX", kind: "etf", currency: "USD" }).select().single();
  if (holding.error) throw holding.error;
  holdingId = holding.data.id;
  rowIds["holdings"] = holdingId;

  const trade = await a.from("trades")
    .insert({
      holding_id: holdingId, account_id: acctId, side: "buy", date: "2077-01-05",
      quantity_e8: 100_000_000, price_e8: 4_500_000_000, cash_delta_sen: 20_000,
    }).select().single();
  if (trade.error) throw trade.error;
  rowIds["trades"] = trade.data.id;

  const asset = await a.from("manual_assets")
    .insert({ name: "EPF", kind: "epf" }).select().single();
  if (asset.error) throw asset.error;
  assetId = asset.data.id;
  rowIds["manual_assets"] = assetId;

  const assetValue = await a.from("manual_asset_values")
    .insert({ asset_id: assetId, value_sen: 1_000_000, noted_on: "2077-03-01" })
    .select().single();
  if (assetValue.error) throw assetValue.error;
  rowIds["manual_asset_values"] = assetValue.data.id;

  const liability = await a.from("liabilities")
    .insert({ name: "PTPTN", kind: "ptptn" }).select().single();
  if (liability.error) throw liability.error;
  liabilityId = liability.data.id;
  rowIds["liabilities"] = liabilityId;

  const liabilityValue = await a.from("liability_values")
    .insert({ liability_id: liabilityId, balance_sen: 3_000_000, noted_on: "2077-03-01" })
    .select().single();
  if (liabilityValue.error) throw liabilityValue.error;
  rowIds["liability_values"] = liabilityValue.data.id;

  const biz = await a.from("business_investments")
    .insert({ name: "Kedai runcit" }).select().single();
  if (biz.error) throw biz.error;
  bizId = biz.data.id;
  rowIds["business_investments"] = bizId;

  const bizEntry = await a.from("business_investment_entries")
    .insert({
      business_id: bizId, kind: "contribution", amount_sen: 10_000,
      account_id: acctId, date: "2077-02-01",
    }).select().single();
  if (bizEntry.error) throw bizEntry.error;
  rowIds["business_investment_entries"] = bizEntry.data.id;

  const preset = await a.from("allocation_presets")
    .insert({ key: "balanced", bank_pct: 5, cashlike_pct: 50, equities_pct: 45 })
    .select().single();
  if (preset.error) throw preset.error;
  rowIds["allocation_presets"] = preset.data.id;

  // Phase-4 rows (funds + their monthly earmark).
  const fund = await a.from("funds")
    .insert({ name: "Emergency", kind: "emergency", target_months: 6 })
    .select().single();
  if (fund.error) throw fund.error;
  fundId = fund.data.id;
  rowIds["funds"] = fundId;

  const contribution = await a.from("fund_contributions")
    .insert({ fund_id: fundId, month: "2077-07-01", amount_sen: 50_000 })
    .select().single();
  if (contribution.error) throw contribution.error;
  rowIds["fund_contributions"] = contribution.data.id;

  // Plan-8 row (one import batch against A's account).
  const batch = await a.from("import_batches")
    .insert({
      account_id: acctId, filename: "maybank-2077-01.csv",
      content_sha256: randomBytes(32).toString("hex"), row_count: 1,
    }).select().single();
  if (batch.error) throw batch.error;
  rowIds["import_batches"] = batch.data.id;

  // Service-role seeds: A's snapshot + shared market reference rows.
  const admin = adminClient();
  const snapshot = await admin.from("net_worth_snapshots")
    .insert({
      user_id: aUserId, date: "2077-06-01", accounts_sen: 100_000, holdings_sen: 0,
      business_sen: 0, manual_assets_sen: 0, liabilities_sen: 0,
    }).select().single();
  if (snapshot.error) throw snapshot.error;
  rowIds["net_worth_snapshots"] = snapshot.data.id;

  const price = await admin.from("prices")
    .upsert({ symbol: "CSPX", currency: "USD", price_e8: 4_500_000_000, as_of: "2077-01-05", source: "test" })
    .select().single();
  if (price.error) throw price.error;

  const fx = await admin.from("fx_rates")
    .upsert({ pair: "USDMYR", rate_e8: 470_000_000, as_of: "2077-01-05", source: "test" })
    .select().single();
  if (fx.error) throw fx.error;
}, 30_000);

describe("RLS isolation: user B is blind to user A's data", () => {
  for (const spec of USER_TABLES) {
    const pk = spec.pk ?? "id";
    describe(spec.table, () => {
      if (spec.bSeedsOwnRow) {
        it("B select → only B's own row (A's row invisible)", async () => {
          const { data, error } = await b.from(spec.table).select();
          expect(error).toBeNull();
          expect(data).toHaveLength(1);
          expect(data![0][pk]).not.toBe(rowIds[spec.table]);
        });
      } else {
        it("B select → empty", async () => {
          const { data, error } = await b.from(spec.table).select();
          expect(error).toBeNull();
          expect(data).toEqual([]);
        });
      }

      it("B insert with A's user_id → error", async () => {
        const { error } = await b.from(spec.table).insert(spec.insertAsA());
        expect(error).not.toBeNull();
      });

      if (spec.hasUpdateGrant ?? true) {
        it("B update targeting A's row → 0 rows affected", async () => {
          const { data, error } = await b.from(spec.table)
            .update(spec.update).eq(pk, rowIds[spec.table]).select();
          expect(error).toBeNull();
          expect(data).toEqual([]);
        });
      } else {
        it("B update → 42501 (no UPDATE grant: append-only log)", async () => {
          const { error } = await b.from(spec.table)
            .update(spec.update).eq(pk, rowIds[spec.table]).select();
          expect(error?.code).toBe("42501");
        });
      }

      if (spec.hasDeleteGrant) {
        it("B delete targeting A's row → 0 rows affected", async () => {
          const { data, error } = await b.from(spec.table)
            .delete().eq(pk, rowIds[spec.table]).select();
          expect(error).toBeNull();
          expect(data).toEqual([]);
        });
      } else {
        it("B delete → 42501 (no DELETE grant: archive/revoke-only)", async () => {
          const { error } = await b.from(spec.table)
            .delete().eq(pk, rowIds[spec.table]).select();
          expect(error?.code).toBe("42501");
        });
      }
    });
  }

  describe("account_balances view (read-only)", () => {
    it("B select → empty", async () => {
      const { data, error } = await b.from("account_balances").select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe("net_worth_snapshots is read-only even for its owner (service-role writes)", () => {
    it("A reads own snapshot; B sees none of A's", async () => {
      const own = await a.from("net_worth_snapshots").select();
      expect(own.error).toBeNull();
      expect(own.data).toHaveLength(1);
    });

    it("A insert/update/delete → 42501 (select-only grant)", async () => {
      const ins = await a.from("net_worth_snapshots").insert({
        user_id: aUserId, date: "2077-06-03", accounts_sen: 0, holdings_sen: 0,
        business_sen: 0, manual_assets_sen: 0, liabilities_sen: 0,
      });
      expect(ins.error?.code).toBe("42501");
      const upd = await a.from("net_worth_snapshots")
        .update({ accounts_sen: 1 }).eq("id", rowIds["net_worth_snapshots"]);
      expect(upd.error?.code).toBe("42501");
      const del = await a.from("net_worth_snapshots")
        .delete().eq("id", rowIds["net_worth_snapshots"]);
      expect(del.error?.code).toBe("42501");
    });
  });

  describe("prices / fx_rates (global reference: shared read, service-role write)", () => {
    it("both users read the same rows", async () => {
      for (const client of [a, b]) {
        const price = await client.from("prices").select().eq("symbol", "CSPX").single();
        expect(price.error).toBeNull();
        expect(price.data!.price_e8).toBe(4_500_000_000);
        const fx = await client.from("fx_rates").select().eq("pair", "USDMYR").single();
        expect(fx.error).toBeNull();
        expect(fx.data!.rate_e8).toBe(470_000_000);
      }
    });

    it("neither user can insert/update/delete → 42501", async () => {
      for (const client of [a, b]) {
        const ins = await client.from("prices").insert({
          symbol: "EVIL", currency: "MYR", price_e8: 1, as_of: "2077-01-05", source: "evil",
        });
        expect(ins.error?.code).toBe("42501");
        const upd = await client.from("prices")
          .update({ price_e8: 1 }).eq("symbol", "CSPX");
        expect(upd.error?.code).toBe("42501");
        const del = await client.from("fx_rates").delete().eq("pair", "USDMYR");
        expect(del.error?.code).toBe("42501");
      }
    });
  });

  describe("rate_limits (service-role only: no grants, no policies)", () => {
    it("select → 42501 for both users (no table grant)", async () => {
      for (const client of [a, b]) {
        const { error } = await client.from("rate_limits").select();
        expect(error?.code).toBe("42501");
      }
    });

    it("rpc bump_rate_limit → error for both users (execute revoked)", async () => {
      for (const client of [a, b]) {
        const { error } = await client.rpc("bump_rate_limit", {
          p_key: "x", p_window_start: new Date().toISOString(),
        });
        expect(error).not.toBeNull();
      }
    });
  });
});
