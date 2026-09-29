import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, makeTestUsers } from "@/db/test-clients";
import {
  getNetWorth,
  getNetWorthGlance,
  getAllocation,
  performSetManualAssetValue,
  performCreateManualAsset,
  performArchiveManualAsset,
  performUnarchiveManualAsset,
  performCreateLiability,
  performArchiveLiability,
  performUnarchiveLiability,
  performSetLiabilityBalance,
  performRecordLiabilityPayment,
  performUpdateLiability,
  performCreateBusiness,
  performArchiveBusiness,
  performUnarchiveBusiness,
  performSaveBusinessEntry,
  performDeleteBusinessEntry,
  performSelectAllocationPreset,
  performUpdateAllocationPreset,
  performSetAllocationBucket,
} from "@/db/networth";
import { getMonthStats, getIncomeVsExpense } from "@/db/stats";
import { getBudgetMonth } from "@/db/budget";
import { PRESET_DEFAULTS } from "@/lib/allocation";
import { projectPayoff } from "@/lib/debt";

/**
 * Plan 8 ruling 1's partial-failure fixture: the same session client, except
 * that every `liability_values` upsert fails — the transaction half lands,
 * the balance half does not, which is exactly the documented partial path.
 * Relies on the real write being a bare awaited `.upsert()` on
 * `liability_values`: a future `.select()` chain would surface here as a
 * TypeError, not as the simulated outage.
 */
function failingBalanceWrites(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== "liability_values") return builder;
        return new Proxy(builder, {
          get(b, p, r) {
            if (p !== "upsert") return Reflect.get(b, p, r);
            return () =>
              Promise.resolve({
                data: null,
                error: { message: "simulated outage", code: "XX000", details: "", hint: "" },
              });
          },
        });
      };
    },
  });
}

/**
 * Net worth / allocation layer against 2077-dated fixtures; "today" is a
 * parameter. Global price/fx keys are SUITE-UNIQUE (T5N-prefixed symbols,
 * MYR-only holdings here — no fx rows needed).
 *
 * User N worked numbers (hand-computed, at the post-beforeAll state):
 *   accounts: NW Bank 200_000 −1_000 (trade) −100_000 +20_000 (business)
 *     −8_000 (expenses) = 111_000; Old (ARCHIVED) 5_000; Empty (archived) 0;
 *     NW Brok (brokerage) 50_000 → accounts_sen 166_000.
 *   holdings: T5NWH 1 unit, price RM12 as_of 2077-05-30 (STALE) → 1_200.
 *   business: Kedai invested 100_000, returned 20_000, valuation 150_000;
 *     Closed (ARCHIVED) valuation 9_999 — listed, never counted.
 *   manual: EPF 900 → 1_000 (latest 2077-04-01); OldCar (ARCHIVED) 777.
 *   liabilities: T5N Loan 500_000 (positive).
 *   total = 166_000 + 1_200 + 150_000 + 1_000 − 500_000 = −181_800.
 *   snapshots (admin-seeded): 2077-04-30 → −300_000, 2077-05-31 → −225_000;
 *   delta vs prev month = −181_800 − (−225_000) = 43_200.
 *
 * Ordering matters: read assertions run before the mutation tests (payments,
 * value upserts and business entries move the very numbers the reads pin).
 */
const TODAY = "2077-06-01";

let n: SupabaseClient;
let admin: SupabaseClient;
let userId: string;
let nwBank: string;
let nwBrok: string;
let nwhId: string;
let epfId: string;
let loanId: string;
let kedaiId: string;
let debtCatId: string;

beforeAll(async () => {
  ({ a: n } = await makeTestUsers());
  admin = adminClient();

  const bank = await n.from("accounts")
    .insert({ name: "NW Bank", type: "bank", starting_balance_sen: 200_000 })
    .select().single();
  if (bank.error) throw bank.error;
  nwBank = bank.data.id;
  userId = bank.data.user_id;
  await n.from("accounts").insert([
    { name: "Old", type: "bank", starting_balance_sen: 5_000, archived: true },
    { name: "Empty", type: "bank", starting_balance_sen: 0, archived: true },
  ]);
  const brok = await n.from("accounts")
    .insert({ name: "NW Brok", type: "brokerage", starting_balance_sen: 50_000 })
    .select().single();
  if (brok.error) throw brok.error;
  nwBrok = brok.data.id;

  const cat = await n.from("categories")
    .insert({ name: "Debt", kind: "expense", tag: "needs" }).select().single();
  if (cat.error) throw cat.error;
  debtCatId = cat.data.id;

  // Ordinary expenses (2077-01, 2077-02) — the allocation avg-expense source.
  const tx = await n.from("transactions").insert([
    { type: "expense", amount_sen: 3_000, account_id: nwBank, category_id: debtCatId, date: "2077-01-05" },
    { type: "expense", amount_sen: 5_000, account_id: nwBank, category_id: debtCatId, date: "2077-02-05" },
  ]);
  if (tx.error) throw tx.error;

  const h = await n.from("holdings")
    .insert({ symbol: "T5NWH", kind: "stock", currency: "MYR" }).select().single();
  if (h.error) throw h.error;
  nwhId = h.data.id;
  const t = await n.from("trades").insert({
    holding_id: nwhId, account_id: nwBank, side: "buy", date: "2077-01-12",
    quantity_e8: 100_000_000, price_e8: 1_000_000_000, cash_delta_sen: 1_000,
  });
  if (t.error) throw t.error;
  const pr = await admin.from("prices").upsert(
    { symbol: "T5NWH", currency: "MYR", price_e8: 1_200_000_000, as_of: "2077-05-30", source: "test" },
    { onConflict: "symbol" },
  );
  if (pr.error) throw pr.error;

  const epf = await n.from("manual_assets")
    .insert({ name: "EPF", kind: "epf" }).select().single();
  if (epf.error) throw epf.error;
  epfId = epf.data.id;
  await n.from("manual_asset_values").insert([
    { asset_id: epfId, value_sen: 900, noted_on: "2077-02-01" },
    { asset_id: epfId, value_sen: 1_000, noted_on: "2077-04-01" },
  ]);
  const oldCar = await n.from("manual_assets")
    .insert({ name: "OldCar", kind: "vehicle", archived: true }).select().single();
  await n.from("manual_asset_values")
    .insert({ asset_id: oldCar.data!.id, value_sen: 777, noted_on: "2077-01-01" });

  const loan = await n.from("liabilities")
    .insert({ name: "T5N Loan", kind: "loan", interest_rate_bp: 450, minimum_payment_sen: 30_000 })
    .select().single();
  if (loan.error) throw loan.error;
  loanId = loan.data.id;
  await n.from("liability_values")
    .insert({ liability_id: loanId, balance_sen: 500_000, noted_on: "2077-01-02" });

  const kedai = await n.from("business_investments")
    .insert({ name: "Kedai", note: "T6 kopitiam stake" }).select().single();
  if (kedai.error) throw kedai.error;
  kedaiId = kedai.data.id;
  await n.from("business_investment_entries").insert([
    { business_id: kedaiId, kind: "contribution", amount_sen: 100_000, account_id: nwBank, date: "2077-01-10" },
    { business_id: kedaiId, kind: "return", amount_sen: 20_000, account_id: nwBank, date: "2077-02-10" },
    // Two valuations — the LATER date must win value_sen and valued_on.
    { business_id: kedaiId, kind: "valuation", amount_sen: 140_000, date: "2077-02-15" },
    { business_id: kedaiId, kind: "valuation", amount_sen: 150_000, date: "2077-03-01" },
  ]);
  const closed = await n.from("business_investments")
    .insert({ name: "Closed", archived: true }).select().single();
  await n.from("business_investment_entries").insert(
    { business_id: closed.data!.id, kind: "valuation", amount_sen: 9_999, date: "2077-01-01" },
  );

  const snaps = await admin.from("net_worth_snapshots").upsert([
    { user_id: userId, date: "2077-04-30", accounts_sen: 0, holdings_sen: 0, business_sen: 0, manual_assets_sen: 0, liabilities_sen: 300_000 },
    { user_id: userId, date: "2077-05-31", accounts_sen: 0, holdings_sen: 0, business_sen: 0, manual_assets_sen: 0, liabilities_sen: 225_000 },
  ], { onConflict: "user_id,date" });
  if (snaps.error) throw snaps.error;
}, 30_000);

describe("getNetWorth — reads", () => {
  it("assembles live parts: archived accounts count, liabilities positive", async () => {
    const nw = await getNetWorth(n, TODAY);
    expect(nw.parts).toEqual({
      accounts_sen: 166_000,
      holdings_sen: 1_200,
      business_sen: 150_000,
      manual_assets_sen: 1_000,
      liabilities_sen: 500_000,
      total_sen: -181_800,
    });
  });

  it("splits every list into live rows plus a separate archived list (ruling 14)", async () => {
    const nw = await getNetWorth(n, TODAY);
    expect(nw.accounts.map((x) => x.name).sort()).toEqual(["NW Bank", "NW Brok"]);
    expect(nw.archived_accounts.map((x) => x.name).sort()).toEqual(["Empty", "Old"]);
    const old = nw.archived_accounts.find((x) => x.name === "Old")!;
    expect(old.archived).toBe(true);
    expect(old.balance_sen).toBe(5_000);
  });

  it("PIN ruling 14: a ZERO-valued archived item is still reachable, never invisible", async () => {
    // The trap Plan 6 had to close for holdings, closed here for the other
    // four lists: the old `!archived || value !== 0` filter made an archived
    // item worth nothing disappear from the page with no way back.
    const nw = await getNetWorth(n, TODAY);
    const empty = nw.archived_accounts.find((x) => x.name === "Empty")!;
    expect(empty.balance_sen).toBe(0);
    expect(empty.archived).toBe(true);
    // …and it stays OUT of the live list, so nothing zero-valued sneaks in.
    expect(nw.accounts.some((x) => x.name === "Empty")).toBe(false);
  });

  it("carries latest values with dates; archived items sit in their own list", async () => {
    const nw = await getNetWorth(n, TODAY);
    const epf = nw.manual_assets.find((x) => x.name === "EPF")!;
    expect(epf.value_sen).toBe(1_000);
    expect(epf.noted_on).toBe("2077-04-01");
    expect(nw.manual_assets.some((x) => x.name === "OldCar")).toBe(false);
    const oldCar = nw.archived_manual_assets.find((x) => x.name === "OldCar")!;
    expect(oldCar.archived).toBe(true);
    expect(oldCar.value_sen).toBe(777);
    const loan = nw.liabilities.find((x) => x.name === "T5N Loan")!;
    expect(loan.balance_sen).toBe(500_000);
    expect(loan.noted_on).toBe("2077-01-02");
    expect(loan.interest_rate_bp).toBe(450);
    expect(loan.minimum_payment_sen).toBe(30_000);
    expect(loan.last_payment_category_id).toBeNull();
  });

  it("businesses carry invested/returned/value; archived ones listed apart, never counted", async () => {
    const nw = await getNetWorth(n, TODAY);
    const kedai = nw.businesses.find((x) => x.name === "Kedai")!;
    expect(kedai).toMatchObject({
      invested_sen: 100_000, returned_sen: 20_000, value_sen: 150_000, archived: false,
    });
    expect(nw.businesses.some((x) => x.name === "Closed")).toBe(false);
    const closed = nw.archived_businesses.find((x) => x.name === "Closed")!;
    expect(closed.archived).toBe(true);
    expect(closed.value_sen).toBe(9_999);
    // parts.business_sen (asserted above) is 150_000 — Closed excluded.
  });

  it("businesses carry the free-text note and the latest valuation's date", async () => {
    const nw = await getNetWorth(n, TODAY);
    const kedai = nw.businesses.find((x) => x.name === "Kedai")!;
    expect(kedai.note).toBe("T6 kopitiam stake");
    // Latest valuation by date wins (2077-03-01 over 2077-02-15) — same
    // tie-break as businessStats, so valued_on always dates value_sen.
    expect(kedai.valued_on).toBe("2077-03-01");
    const closed = nw.archived_businesses.find((x) => x.name === "Closed")!;
    expect(closed.note).toBe("");
    expect(closed.valued_on).toBe("2077-01-01");
  });

  it("businesses carry their entries newest-first with account names for cash kinds", async () => {
    const nw = await getNetWorth(n, TODAY);
    const kedai = nw.businesses.find((x) => x.name === "Kedai")!;
    expect(
      kedai.entries.map((e) => ({
        kind: e.kind, amount_sen: e.amount_sen, date: e.date,
        account_name: e.account_name, note: e.note,
      })),
    ).toEqual([
      { kind: "valuation", amount_sen: 150_000, date: "2077-03-01", account_name: null, note: "" },
      { kind: "valuation", amount_sen: 140_000, date: "2077-02-15", account_name: null, note: "" },
      { kind: "return", amount_sen: 20_000, date: "2077-02-10", account_name: "NW Bank", note: "" },
      { kind: "contribution", amount_sen: 100_000, date: "2077-01-10", account_name: "NW Bank", note: "" },
    ]);
    for (const e of kedai.entries) expect(typeof e.id).toBe("string");
  });

  it("snapshot series, delta vs previous month, price staleness", async () => {
    const nw = await getNetWorth(n, TODAY);
    expect(nw.snapshots).toEqual([
      { date: "2077-04-30", total_sen: -300_000 },
      { date: "2077-05-31", total_sen: -225_000 },
    ]);
    expect(nw.delta_vs_prev_month_sen).toBe(43_200);
    expect(nw.price_staleness).toEqual({ any_stale: true, oldest_as_of: "2077-05-30" });
  });

  it("glance projects the same numbers with a snapshot spark, and carries fx_missing (ruling 19)", async () => {
    const glance = await getNetWorthGlance(n, TODAY);
    expect(glance).toEqual({
      total_sen: -181_800,
      delta_sen: 43_200,
      spark: [-300_000, -225_000],
      // Every account here is MYR, so the honest-gap line stays quiet — the
      // field existing at all is the point: the dashboard total can no longer
      // silently omit a balance the /net-worth page discloses.
      fx_missing: [],
      // Plan 8 ruling 10: the /more row's "· debts RM x", lifted from the
      // parts getNetWorth already computed — a type change, not a query.
      liabilities_sen: 500_000,
    });
  });

  it("glance names an account currency with no fx row yet (ruling 19)", async () => {
    // Its OWN user: accounts archive and never hard-delete (rule 18), and an
    // archived account still counts in parts (ruling 9), so a never-fetched
    // currency added to `n` could not be undone for the tests below it.
    // Suite-unique fictional code, never fetched by any adapter — the exact
    // shape of the window between creating an account and the next cron.
    const { a: fresh } = await makeTestUsers();
    const created = await fresh
      .from("accounts")
      .insert({ name: "T5N ZQQ", type: "bank", currency: "ZQQ", starting_balance_sen: 12_345 })
      .select()
      .single();
    expect(created.error).toBeNull();

    const glance = await getNetWorthGlance(fresh, TODAY);
    expect(glance!.fx_missing).toEqual(["ZQQ"]);
    // …and the omitted balance really is out of the total it discloses.
    expect(glance!.total_sen).toBe(0);
    const nw = await getNetWorth(fresh, TODAY);
    expect(glance!.fx_missing).toEqual(nw.fx_missing);
  }, 30_000);
});

/**
 * Plan 8 Task 4, ruling 9: the payoff projection is DERIVED from the rows
 * getNetWorth already loads — the latest balance, the liability's rates, and
 * the EARLIEST liability_values row for progress — and nothing moves because
 * of it. The byte-identity test below is the ruling's last sentence made
 * executable: setting a planned payment changes the projection and nothing
 * else the page or the cron reads.
 */
describe("debt payoff projection (Plan 8 Task 4, ruling 9)", () => {
  it("surfaces planned payment, first-recorded balance, payment rate and the projection per liability", async () => {
    const nw = await getNetWorth(n, TODAY);
    const loan = nw.liabilities.find((x) => x.name === "T5N Loan")!;
    expect(loan.planned_payment_sen).toBe(0);
    // Precedence: planned 0 → the minimum stands in.
    expect(loan.payment_rate_sen).toBe(30_000);
    expect(loan.first_recorded).toEqual({ balance_sen: 500_000, noted_on: "2077-01-02" });
    // Same pure function, same inputs — the card's initial render.
    expect(loan.projection).toEqual(projectPayoff(500_000, 450, 30_000, TODAY));
    expect(loan.projection!.status).toBe("on_track");
  });

  it("PIN: the five parts, the snapshot series and the delta are byte-identical across setting a planned payment; no row is written", async () => {
    const before = await getNetWorth(n, TODAY);
    const rowsBefore = await Promise.all([
      n.from("liability_values").select("id", { count: "exact", head: true }),
      n.from("transactions").select("id", { count: "exact", head: true }),
      admin.from("net_worth_snapshots").select("id", { count: "exact", head: true }).eq("user_id", userId),
    ]);

    const res = await performUpdateLiability(n, loanId, { planned_payment_sen: 40_000 });
    expect(res).toEqual({ ok: true });

    const after = await getNetWorth(n, TODAY);
    expect(after.parts).toEqual(before.parts);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.delta_vs_prev_month_sen).toBe(before.delta_vs_prev_month_sen);
    const rowsAfter = await Promise.all([
      n.from("liability_values").select("id", { count: "exact", head: true }),
      n.from("transactions").select("id", { count: "exact", head: true }),
      admin.from("net_worth_snapshots").select("id", { count: "exact", head: true }).eq("user_id", userId),
    ]);
    expect(rowsAfter.map((r) => r.count)).toEqual(rowsBefore.map((r) => r.count));

    // …and only the projection moved: planned now outranks the minimum.
    const loan = after.liabilities.find((x) => x.name === "T5N Loan")!;
    expect(loan.planned_payment_sen).toBe(40_000);
    expect(loan.payment_rate_sen).toBe(40_000);
    expect(loan.balance_sen).toBe(500_000);
    expect(loan.projection).toEqual(projectPayoff(500_000, 450, 40_000, TODAY));
  });

  it("rejects a negative planned payment with a visible message, nothing written", async () => {
    // Self-contained: compare against what was stored BEFORE the rejected
    // write, not against the figure the previous test happened to set.
    const stored = await n.from("liabilities").select("planned_payment_sen").eq("id", loanId).single();
    const res = await performUpdateLiability(n, loanId, { planned_payment_sen: -1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    const row = await n.from("liabilities").select("planned_payment_sen").eq("id", loanId).single();
    expect(row.data!.planned_payment_sen).toBe(stored.data!.planned_payment_sen);
  });

  it("a liability with no payment rate carries no projection; one with no history carries no first_recorded", async () => {
    const { a: fresh } = await makeTestUsers();
    const created = await performCreateLiability(fresh, {
      name: "T5N Bare",
      kind: "other",
      balance_sen: 12_300,
      noted_on: "2077-05-01",
    });
    expect(created).toEqual({ ok: true });
    const none = await performCreateLiability(fresh, { name: "T5N Empty", kind: "other" });
    expect(none).toEqual({ ok: true });
    const nw = await getNetWorth(fresh, TODAY);
    const bare = nw.liabilities.find((x) => x.name === "T5N Bare")!;
    expect(bare.payment_rate_sen).toBeNull();
    expect(bare.projection).toBeNull();
    expect(bare.first_recorded).toEqual({ balance_sen: 12_300, noted_on: "2077-05-01" });
    const empty = nw.liabilities.find((x) => x.name === "T5N Empty")!;
    expect(empty.first_recorded).toBeNull();
    expect(empty.projection).toBeNull();
  }, 30_000);

  it("an archived liability carries its rate and first-recorded balance but no projection (nothing renders it)", async () => {
    // Archive, never hard-delete (rule 18): the row stays reachable through
    // the archived list, so its inputs must still be there to unarchive
    // against — only the derived projection is skipped.
    const { a: fresh } = await makeTestUsers();
    const created = await performCreateLiability(fresh, {
      name: "T5N Shelved",
      kind: "loan",
      interest_rate_bp: 450,
      minimum_payment_sen: 30_000,
      balance_sen: 500_000,
      noted_on: "2077-01-02",
    });
    expect(created).toEqual({ ok: true });
    const id = (await fresh.from("liabilities").select("id").eq("name", "T5N Shelved").single()).data!.id;
    expect(await performArchiveLiability(fresh, id)).toEqual({ ok: true });
    const nw = await getNetWorth(fresh, TODAY);
    expect(nw.liabilities.find((x) => x.name === "T5N Shelved")).toBeUndefined();
    const shelved = nw.archived_liabilities.find((x) => x.name === "T5N Shelved")!;
    expect(shelved.archived).toBe(true);
    expect(shelved.payment_rate_sen).toBe(30_000);
    expect(shelved.first_recorded).toEqual({ balance_sen: 500_000, noted_on: "2077-01-02" });
    expect(shelved.projection).toBeNull();
  }, 30_000);
});

describe("getAllocation", () => {
  it("buckets, merged presets, selected key, equities rows, trailing-6-full-months expense", async () => {
    const over = await performUpdateAllocationPreset(n, "growth", {
      bank_pct: 7, cashlike_pct: 33, equities_pct: 60,
    });
    expect(over).toEqual({ ok: true });
    const sel = await performSelectAllocationPreset(n, "growth");
    expect(sel).toEqual({ ok: true });

    const alloc = await getAllocation(n, "2077-07-15");
    expect(alloc.buckets).toEqual({
      bank_sen: 111_000, cashlike_sen: 50_000, equities_sen: 1_200, pot_sen: 162_200,
    });
    expect(alloc.presets.growth).toEqual({ bank_pct: 7, cashlike_pct: 33, equities_pct: 60 });
    expect(alloc.presets.balanced).toEqual(PRESET_DEFAULTS.balanced);
    expect(alloc.presets.aggressive).toEqual(PRESET_DEFAULTS.aggressive);
    expect(alloc.selected).toBe("growth");
    expect(alloc.target_etf_pct).toBe(70);
    expect(alloc.equities_rows).toEqual([
      { id: nwhId, symbol: "T5NWH", kind: "stock", value_sen: 1_200, target_pct: null },
    ]);
    // Jan 3_000 + Feb 5_000 over six full months (Jan–Jun) → 1_333 (half-up).
    expect(alloc.avg_monthly_expense_sen).toBe(1_333);
  });

  it("divides by fewer months when history is younger than the window (ruling 14)", async () => {
    const alloc = await getAllocation(n, "2077-03-10");
    // Window Sep 2076 – Feb 2077; earliest transaction 2077-01 → divisor 2.
    expect(alloc.avg_monthly_expense_sen).toBe(4_000);
  });

  it("preset sum must equal 100", async () => {
    const res = await performUpdateAllocationPreset(n, "barbell", {
      bank_pct: 6, cashlike_pct: 50, equities_pct: 45,
    });
    expect(res.ok).toBe(false);
  });

  it("setAllocationBucket overrides the derived default", async () => {
    const res = await performSetAllocationBucket(n, nwBrok, "exclude");
    expect(res).toEqual({ ok: true });
    const alloc = await getAllocation(n, "2077-07-15");
    expect(alloc.buckets.cashlike_sen).toBe(0);
    expect(alloc.buckets.pot_sen).toBe(112_200);
  });
});

describe("manual asset / liability writes", () => {
  it("setManualAssetValue upserts on (item, day)", async () => {
    const first = await performSetManualAssetValue(n, epfId, 1_050, "2077-05-01");
    expect(first).toEqual({ ok: true });
    const second = await performSetManualAssetValue(n, epfId, 1_100, "2077-05-01");
    expect(second).toEqual({ ok: true });
    const rows = await n.from("manual_asset_values")
      .select("value_sen").eq("asset_id", epfId).eq("noted_on", "2077-05-01");
    expect(rows.data).toEqual([{ value_sen: 1_100 }]);
  });

  it("createManualAsset can record an initial value", async () => {
    const res = await performCreateManualAsset(n, {
      name: "FD", kind: "fd", value_sen: 5_000, noted_on: "2077-05-02",
    });
    expect(res).toEqual({ ok: true });
    const nw = await getNetWorth(n, TODAY);
    const fd = nw.manual_assets.find((x) => x.name === "FD")!;
    expect(fd.value_sen).toBe(5_000);
    expect(fd.noted_on).toBe("2077-05-02");
  });

  it("setLiabilityBalance upserts on (item, day)", async () => {
    const first = await performSetLiabilityBalance(n, loanId, 480_000, "2077-05-10");
    expect(first).toEqual({ ok: true });
    const second = await performSetLiabilityBalance(n, loanId, 470_000, "2077-05-10");
    expect(second).toEqual({ ok: true });
    const rows = await n.from("liability_values")
      .select("balance_sen").eq("liability_id", loanId).eq("noted_on", "2077-05-10");
    expect(rows.data).toEqual([{ balance_sen: 470_000 }]);
  });

  it("recordLiabilityPayment writes both halves; a re-fire with the same UUID converges (ruling 6)", async () => {
    const uuid = randomUUID();
    const input = {
      liability_id: loanId, account_id: nwBank, category_id: debtCatId,
      amount_sen: 50_000, date: "2077-05-15", client_uuid: uuid,
    };
    const first = await performRecordLiabilityPayment(n, input);
    expect(first).toEqual({ ok: true });

    const tx = await n.from("transactions").select().eq("id", uuid);
    expect(tx.data).toHaveLength(1);
    expect(tx.data![0]).toMatchObject({
      type: "expense", amount_sen: 50_000, account_id: nwBank,
      category_id: debtCatId, date: "2077-05-15",
    });
    // Current balance was 470_000 (set above) → payment steps it to 420_000.
    const val = await n.from("liability_values")
      .select("balance_sen").eq("liability_id", loanId).eq("noted_on", "2077-05-15");
    expect(val.data).toEqual([{ balance_sen: 420_000 }]);

    const second = await performRecordLiabilityPayment(n, input);
    expect(second).toEqual({ ok: true });
    const tx2 = await n.from("transactions").select("id").eq("id", uuid);
    expect(tx2.data).toHaveLength(1); // still one transaction
    const val2 = await n.from("liability_values")
      .select("balance_sen").eq("liability_id", loanId).eq("noted_on", "2077-05-15");
    expect(val2.data).toEqual([{ balance_sen: 420_000 }]); // NOT double-subtracted

    // The payment's category now prefills the liability (ruling 6).
    const nw = await getNetWorth(n, TODAY);
    const loan = nw.liabilities.find((x) => x.name === "T5N Loan")!;
    expect(loan.last_payment_category_id).toBe(debtCatId);
    expect(loan.balance_sen).toBe(420_000);
  });

  it("rejects a payment exceeding the tracked balance before any write", async () => {
    const res = await performRecordLiabilityPayment(n, {
      liability_id: loanId, account_id: nwBank, category_id: debtCatId,
      amount_sen: 999_999_999, date: "2077-05-16", client_uuid: randomUUID(),
    });
    expect(res.ok).toBe(false);
    const val = await n.from("liability_values")
      .select("id").eq("liability_id", loanId).eq("noted_on", "2077-05-16");
    expect(val.data).toEqual([]);
  });

  /**
   * Plan 8 ruling 1: a liability balance is MYR sen and a foreign account's
   * amount_sen are not — the payment account's currency is checked inside the
   * RLS session before either half is written (rule 16 as extended).
   */
  it("rejects a payment from a non-MYR account with nothing written (Plan 8 ruling 1)", async () => {
    const usd = await n.from("accounts")
      .insert({ name: "NW USD", type: "brokerage", currency: "USD", starting_balance_sen: 0 })
      .select().single();
    if (usd.error) throw usd.error;
    const uuid = randomUUID();
    const res = await performRecordLiabilityPayment(n, {
      liability_id: loanId, account_id: usd.data.id, category_id: debtCatId,
      amount_sen: 10_000, date: "2077-05-16", client_uuid: uuid,
    });
    expect(res).toEqual({ ok: false, error: "Liability payments are MYR-only — this account is in USD" });
    const tx = await n.from("transactions").select("id").eq("id", uuid);
    expect(tx.data).toEqual([]);
    const val = await n.from("liability_values")
      .select("id").eq("liability_id", loanId).eq("noted_on", "2077-05-16");
    expect(val.data).toEqual([]);
  });

  /**
   * Plan 8 ruling 1's retry contract. The dialog regenerates client_uuid on
   * ANY field change (ManualItemDialogs.tsx), so an EDITED retry after the
   * documented partial failure is a NEW entry — the old shape (one uuid across
   * the edit: an RM 500 expense sitting against an RM 300 liability step,
   * reported as success) is unreachable. The house has no component tests
   * (vitest includes src/**\/*.test.ts only), so this test plus the dialog's
   * comment are the pin: the second call carries its own uuid, and the step
   * follows that call's figure.
   */
  it("an edited retry after a failed balance write is a second entry whose step matches its own figure (Plan 8 ruling 1)", async () => {
    const u1 = randomUUID();
    const first = await performRecordLiabilityPayment(failingBalanceWrites(n), {
      liability_id: loanId, account_id: nwBank, category_id: debtCatId,
      amount_sen: 50_000, date: "2077-05-17", client_uuid: u1,
    });
    expect(first).toMatchObject({ ok: false, partial: true });
    // The promise holds for the SAME figures only — the message says so.
    if (!first.ok) expect(first.error).toContain("Retry with the same figures");
    // The expense half landed and stays visible (rule 15: never a silent drop)...
    const orphan = await n.from("transactions").select("amount_sen").eq("id", u1);
    expect(orphan.data).toEqual([{ amount_sen: 50_000 }]);
    // ...and the balance half did not.
    const none = await n.from("liability_values")
      .select("id").eq("liability_id", loanId).eq("noted_on", "2077-05-17");
    expect(none.data).toEqual([]);

    // The owner corrects the amount before retrying: a new uuid, a new entry.
    const u2 = randomUUID();
    const second = await performRecordLiabilityPayment(n, {
      liability_id: loanId, account_id: nwBank, category_id: debtCatId,
      amount_sen: 30_000, date: "2077-05-17", client_uuid: u2,
    });
    expect(second).toEqual({ ok: true });
    const both = await n.from("transactions")
      .select("id, amount_sen").in("id", [u1, u2]).order("amount_sen");
    expect(both.data).toEqual([{ id: u2, amount_sen: 30_000 }, { id: u1, amount_sen: 50_000 }]);
    // Latest balance was 420_000 (2077-05-15): the step is RM 300 — the
    // second call's own figure, not the orphan's RM 500 and not RM 800.
    const val = await n.from("liability_values")
      .select("balance_sen").eq("liability_id", loanId).eq("noted_on", "2077-05-17");
    expect(val.data).toEqual([{ balance_sen: 390_000 }]);
  });
});

describe("business entry writes (ruling 20)", () => {
  it("zod enforces the account-per-kind rule", async () => {
    const valuationWithAccount = await performSaveBusinessEntry(n, {
      id: randomUUID(), business_id: kedaiId, kind: "valuation",
      amount_sen: 1_000, account_id: nwBank, date: "2077-05-20",
    });
    expect(valuationWithAccount.ok).toBe(false);
    const contributionWithout = await performSaveBusinessEntry(n, {
      id: randomUUID(), business_id: kedaiId, kind: "contribution",
      amount_sen: 1_000, date: "2077-05-20",
    });
    expect(contributionWithout.ok).toBe(false);
  });

  it("creates then edits by client UUID; deleteBusinessEntry hard-deletes", async () => {
    const id = randomUUID();
    const created = await performSaveBusinessEntry(n, {
      id, business_id: kedaiId, kind: "contribution",
      amount_sen: 10_000, account_id: nwBank, date: "2077-05-21",
    });
    expect(created).toMatchObject({ ok: true });
    const edited = await performSaveBusinessEntry(n, {
      id, business_id: kedaiId, kind: "contribution",
      amount_sen: 12_000, account_id: nwBank, date: "2077-05-21",
    });
    expect(edited).toMatchObject({ ok: true });
    const rows = await n.from("business_investment_entries")
      .select("amount_sen").eq("id", id);
    expect(rows.data).toEqual([{ amount_sen: 12_000 }]);

    const deleted = await performDeleteBusinessEntry(n, id);
    expect(deleted).toMatchObject({ ok: true, cash: true });
    const gone = await n.from("business_investment_entries").select("id").eq("id", id);
    expect(gone.data).toEqual([]);
  });

  it("a month of only trades and business entries stays out of income/expense and budget math (rule 16 + ruling 20)", async () => {
    const t = await n.from("trades").insert({
      holding_id: nwhId, account_id: nwBank, side: "buy", date: "2077-04-12",
      quantity_e8: 100_000_000, price_e8: 1_000_000_000, cash_delta_sen: 1_000,
    });
    if (t.error) throw t.error;
    const e = await n.from("business_investment_entries").insert([
      { business_id: kedaiId, kind: "contribution", amount_sen: 5_000, account_id: nwBank, date: "2077-04-15" },
      { business_id: kedaiId, kind: "return", amount_sen: 2_000, account_id: nwBank, date: "2077-04-20" },
      { business_id: kedaiId, kind: "valuation", amount_sen: 160_000, date: "2077-04-25" },
    ]);
    if (e.error) throw e.error;

    const stats = await getMonthStats(n, "2077-04");
    expect(stats.income_sen).toBe(0);
    expect(stats.expense_sen).toBe(0);
    expect(stats.spend_by_category.size).toBe(0);
    const trend = await getIncomeVsExpense(n, 2, "2077-04-28");
    for (const m of trend) {
      expect(m.income_sen).toBe(0);
      expect(m.expense_sen).toBe(0);
    }
    const budget = await getBudgetMonth(n, "2077-04");
    expect(budget.totals.income_sen).toBe(0);
    expect(budget.totals.expense_sen).toBe(0);
    expect(budget.rows.every((r) => r.spent_sen === 0)).toBe(true);
    expect(budget.unbudgeted).toEqual([]);
  });

  it("a never-valued business reads valued_on null; its entry round-trips id, account and note", async () => {
    const biz = await n.from("business_investments")
      .insert({ name: "T6 NoVal" }).select().single();
    if (biz.error) throw biz.error;
    const entryId = randomUUID();
    const saved = await performSaveBusinessEntry(n, {
      id: entryId, business_id: biz.data.id, kind: "contribution",
      amount_sen: 4_000, account_id: nwBank, date: "2077-05-25", note: "T6 seed capital",
    });
    expect(saved).toMatchObject({ ok: true });

    const nw = await getNetWorth(n, TODAY);
    const noVal = nw.businesses.find((x) => x.name === "T6 NoVal")!;
    expect(noVal.valued_on).toBeNull();
    expect(noVal.value_sen).toBe(4_000); // at cost — Σ contributions
    expect(noVal.entries).toEqual([
      {
        id: entryId, kind: "contribution", amount_sen: 4_000,
        account_id: nwBank, account_name: "NW Bank",
        date: "2077-05-25", note: "T6 seed capital",
      },
    ]);
  });
});

describe("unarchive (Task 3, ruling 4 — archiving is reversible everywhere)", () => {
  it("unarchiveManualAsset flips archived back to false", async () => {
    const created = await performCreateManualAsset(n, { name: "T5N Watch", kind: "other" });
    expect(created).toEqual({ ok: true });
    const row = await n.from("manual_assets").select("id").eq("name", "T5N Watch").single();
    const id = row.data!.id as string;

    const archived = await performArchiveManualAsset(n, id);
    expect(archived).toEqual({ ok: true });
    expect((await n.from("manual_assets").select("archived").eq("id", id).single()).data!.archived).toBe(true);

    const unarchived = await performUnarchiveManualAsset(n, id);
    expect(unarchived).toEqual({ ok: true });
    expect((await n.from("manual_assets").select("archived").eq("id", id).single()).data!.archived).toBe(false);
  });

  it("unarchiveManualAsset on a missing id is a visible error", async () => {
    const res = await performUnarchiveManualAsset(n, randomUUID());
    expect(res).toEqual({ ok: false, error: "asset not found" });
  });

  it("unarchiveLiability flips archived back to false", async () => {
    const created = await performCreateLiability(n, { name: "T5N Card", kind: "credit_card" });
    expect(created).toEqual({ ok: true });
    const row = await n.from("liabilities").select("id").eq("name", "T5N Card").single();
    const id = row.data!.id as string;

    const archived = await performArchiveLiability(n, id);
    expect(archived).toEqual({ ok: true });
    expect((await n.from("liabilities").select("archived").eq("id", id).single()).data!.archived).toBe(true);

    const unarchived = await performUnarchiveLiability(n, id);
    expect(unarchived).toEqual({ ok: true });
    expect((await n.from("liabilities").select("archived").eq("id", id).single()).data!.archived).toBe(false);
  });

  it("unarchiveBusiness flips archived back to false", async () => {
    const created = await performCreateBusiness(n, { name: "T5N Biz" });
    expect(created).toEqual({ ok: true });
    const row = await n.from("business_investments").select("id").eq("name", "T5N Biz").single();
    const id = row.data!.id as string;

    const archived = await performArchiveBusiness(n, id);
    expect(archived).toEqual({ ok: true });
    expect((await n.from("business_investments").select("archived").eq("id", id).single()).data!.archived).toBe(true);

    const unarchived = await performUnarchiveBusiness(n, id);
    expect(unarchived).toEqual({ ok: true });
    expect((await n.from("business_investments").select("archived").eq("id", id).single()).data!.archived).toBe(false);
  });
});

/**
 * Plan 9 ruling 9 (Q18/Q28): a liability-payment retry can only ever
 * complete the SAME payment, server side. The retry path compares the stored
 * expense (amount, account, date) with the request before it writes
 * anything; an already-complete retry is an idempotent success on which the
 * balance guard must NOT run; a half-done retry finishes. Own liabilities so
 * the balances here owe nothing to the suite's order.
 */
describe("liability-payment retry guard (Plan 9 ruling 9)", () => {
  let retryLoan: string;
  let bank2: string;

  beforeAll(async () => {
    const loan = await n.from("liabilities").insert({ name: "T5N Retry Loan", kind: "loan" }).select().single();
    if (loan.error) throw loan.error;
    retryLoan = loan.data.id;
    const base = await n.from("liability_values").insert({ liability_id: retryLoan, balance_sen: 100_000, noted_on: "2077-06-01" });
    if (base.error) throw base.error;
    const b2 = await n.from("accounts").insert({ name: "NW Bank 2", type: "bank" }).select().single();
    if (b2.error) throw b2.error;
    bank2 = b2.data.id;
  });

  const balanceOn = async (liabilityId: string, date: string) => {
    const res = await n.from("liability_values").select("balance_sen").eq("liability_id", liabilityId).eq("noted_on", date);
    if (res.error) throw res.error;
    return res.data;
  };
  const txCount = async (uuid: string) => {
    const res = await n.from("transactions").select("id, amount_sen").eq("id", uuid);
    if (res.error) throw res.error;
    return res.data;
  };

  it("(i) value write fails, retry with a changed amount → refused naming the stored figure and account; liability unmoved, one transaction", async () => {
    const uuid = randomUUID();
    const first = await performRecordLiabilityPayment(failingBalanceWrites(n), {
      liability_id: retryLoan, account_id: nwBank, category_id: debtCatId,
      amount_sen: 40_000, date: "2077-06-10", client_uuid: uuid,
    });
    expect(first).toMatchObject({ ok: false, partial: true });

    const edited = await performRecordLiabilityPayment(n, {
      liability_id: retryLoan, account_id: nwBank, category_id: debtCatId,
      amount_sen: 30_000, date: "2077-06-10", client_uuid: uuid,
    });
    expect(edited).toEqual({
      ok: false,
      error: "RM 400.00 is already saved as this payment's expense from NW Bank — retry with the same figures, or delete that entry first",
    });
    expect(await balanceOn(retryLoan, "2077-06-10")).toEqual([]); // no step, nothing written
    expect(await txCount(uuid)).toEqual([{ id: uuid, amount_sen: 40_000 }]);
    const nw = await getNetWorth(n, TODAY);
    expect(nw.liabilities.find((x) => x.name === "T5N Retry Loan")!.balance_sen).toBe(100_000);
  });

  it("a retry from a different account is refused too, naming the STORED account", async () => {
    const uuid = randomUUID();
    const first = await performRecordLiabilityPayment(failingBalanceWrites(n), {
      liability_id: retryLoan, account_id: nwBank, category_id: debtCatId,
      amount_sen: 1_000, date: "2077-06-11", client_uuid: uuid,
    });
    expect(first).toMatchObject({ ok: false, partial: true });
    const moved = await performRecordLiabilityPayment(n, {
      liability_id: retryLoan, account_id: bank2, category_id: debtCatId,
      amount_sen: 1_000, date: "2077-06-11", client_uuid: uuid,
    });
    expect(moved).toEqual({
      ok: false,
      error: "RM 10.00 is already saved as this payment's expense from NW Bank — retry with the same figures, or delete that entry first",
    });
    expect(await balanceOn(retryLoan, "2077-06-11")).toEqual([]);
  });

  it("(ii) both writes landed, response lost, identical retry → ok, nothing written twice, balance stepped once (no balance guard on this path)", async () => {
    // An EXACT payoff: after the first call the balance is 0, so a guard run
    // on the retry would refuse RM 1,000.00 > RM 0.00 and loop forever.
    const uuid = randomUUID();
    const input = {
      liability_id: retryLoan, account_id: nwBank, category_id: debtCatId,
      amount_sen: 100_000, date: "2077-06-20", client_uuid: uuid,
    };
    expect(await performRecordLiabilityPayment(n, input)).toEqual({ ok: true });
    expect(await balanceOn(retryLoan, "2077-06-20")).toEqual([{ balance_sen: 0 }]);

    expect(await performRecordLiabilityPayment(n, input)).toEqual({ ok: true });
    expect(await txCount(uuid)).toHaveLength(1);
    expect(await balanceOn(retryLoan, "2077-06-20")).toEqual([{ balance_sen: 0 }]);
    const nw = await getNetWorth(n, TODAY);
    expect(nw.liabilities.find((x) => x.name === "T5N Retry Loan")!.balance_sen).toBe(0);
  });

  /**
   * Q46 (owner ruling 2026-09-29, "Also match the note"): amount, account and
   * date cannot bind a retry to the LIABILITY — the transaction row has no
   * liability column. The note the fresh path writes, `<liability> payment`,
   * is that bond: a same-uuid retry naming another liability must refuse.
   */
  it("a same-uuid retry naming a different liability is refused; neither liability moves, one transaction (Q46)", async () => {
    const loanA = await n.from("liabilities").insert({ name: "T5N Note Loan A", kind: "loan" }).select().single();
    if (loanA.error) throw loanA.error;
    const loanB = await n.from("liabilities").insert({ name: "T5N Note Loan B", kind: "loan" }).select().single();
    if (loanB.error) throw loanB.error;
    const bases = await n.from("liability_values").insert([
      { liability_id: loanA.data.id, balance_sen: 50_000, noted_on: "2077-06-01" },
      { liability_id: loanB.data.id, balance_sen: 80_000, noted_on: "2077-06-01" },
    ]);
    if (bases.error) throw bases.error;

    const uuid = randomUUID();
    const onA = await performRecordLiabilityPayment(n, {
      liability_id: loanA.data.id, account_id: nwBank, category_id: debtCatId,
      amount_sen: 10_000, date: "2077-06-28", client_uuid: uuid,
    });
    expect(onA).toEqual({ ok: true });
    expect(await balanceOn(loanA.data.id, "2077-06-28")).toEqual([{ balance_sen: 40_000 }]);

    const onB = await performRecordLiabilityPayment(n, {
      liability_id: loanB.data.id, account_id: nwBank, category_id: debtCatId,
      amount_sen: 10_000, date: "2077-06-28", client_uuid: uuid,
    });
    expect(onB).toEqual({
      ok: false,
      error: "RM 100.00 is already saved as this payment's expense from NW Bank — retry with the same figures, or delete that entry first",
    });
    expect(await balanceOn(loanB.data.id, "2077-06-28")).toEqual([]); // B unmoved
    expect(await balanceOn(loanA.data.id, "2077-06-28")).toEqual([{ balance_sen: 40_000 }]); // A unmoved
    expect(await txCount(uuid)).toHaveLength(1);
    const nw = await getNetWorth(n, TODAY);
    expect(nw.liabilities.find((x) => x.name === "T5N Note Loan A")!.balance_sen).toBe(40_000);
    expect(nw.liabilities.find((x) => x.name === "T5N Note Loan B")!.balance_sen).toBe(80_000);
  });

  it("(iii) exact-balance payoff, step lost, identical retry → the step lands, balance 0", async () => {
    const loan = await n.from("liabilities").insert({ name: "T5N Retry Loan 2", kind: "loan" }).select().single();
    if (loan.error) throw loan.error;
    const base = await n.from("liability_values").insert({ liability_id: loan.data.id, balance_sen: 25_000, noted_on: "2077-06-01" });
    if (base.error) throw base.error;

    const uuid = randomUUID();
    const input = {
      liability_id: loan.data.id, account_id: nwBank, category_id: debtCatId,
      amount_sen: 25_000, date: "2077-06-25", client_uuid: uuid,
    };
    const first = await performRecordLiabilityPayment(failingBalanceWrites(n), input);
    expect(first).toMatchObject({ ok: false, partial: true });
    expect(await balanceOn(loan.data.id, "2077-06-25")).toEqual([]);

    expect(await performRecordLiabilityPayment(n, input)).toEqual({ ok: true });
    expect(await txCount(uuid)).toHaveLength(1);
    expect(await balanceOn(loan.data.id, "2077-06-25")).toEqual([{ balance_sen: 0 }]);
    const nw = await getNetWorth(n, TODAY);
    expect(nw.liabilities.find((x) => x.name === "T5N Retry Loan 2")!.balance_sen).toBe(0);
  });
});
