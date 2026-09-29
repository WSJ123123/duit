import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, makeTestUsers } from "@/db/test-clients";
import {
  getInvestments,
  performSaveTrade,
  performDeleteTrade,
  performCreateHolding,
  performUpdateHolding,
  performArchiveHolding,
  performUnarchiveHolding,
  performDeleteHolding,
  performSetHoldingsDisplay,
} from "@/db/portfolio";
import { getMonthStats, getIncomeVsExpense } from "@/db/stats";
import { getBudgetMonth } from "@/db/budget";

/**
 * Investments read/write layer against 2077-dated fixtures (binding
 * convention); "today" is a parameter, never the clock. Global prices /
 * fx_rates keys are SUITE-UNIQUE (T5P-prefixed symbols, fictional currency
 * "QQD" / pair "QQDMYR") — see snapshots.test.ts's header for why.
 *
 * User A worked numbers (hand-computed):
 *   T5PQQD (etf, QQD, fx 2.00):
 *     buy  2077-01-10 10 @ 2.00 fees 50c  → cost 2050c
 *     sell 2077-02-10  4 @ 3.00 fees 10c  → gross 1200, removed 820,
 *                                           realized 370c; qty 6, cost 1230c
 *     avg 2.05 (205_000_000 e8); price row 3.00 → value 1800c → 3600 sen;
 *     unrealized 570c → 1140 sen; cost 2460 sen; realized YTD 740 sen.
 *   T5PARCH (stock, MYR, ARCHIVED, open position): buy 2 @ RM5 → cost 1000;
 *     price RM6 (as_of 2077-05-30 → STALE for today 2077-06-01) → value 1200,
 *     unrealized 200. Listed (archived-with-position, ruling 9 spirit).
 *   T5PFLAT (stock, MYR, ARCHIVED, sold out): realized 100 — must NOT be
 *     listed and must NOT leak into totals.
 *   T5POVR (stock, MYR): buy 5 @ RM1, sell 3 @ RM1 → qty 2, realized 0,
 *     value 200. The oversell-mutation target.
 *   Cash (ruling 19): Moomoo brokerage 1_000_000 −4_100+2_390 −1_000
 *     −100+200 −500+300 = 997_190; Maybank (bank) is NOT investment cash.
 *   totals (listed rows only): value 5000, cost 3660, unrealized 1340,
 *     realized YTD 740. portfolio_total 1_002_190.
 *   pct_tenths (largest remainder over holdings + cash, total 1000):
 *     T5PQQD 4, T5PARCH 1, T5POVR 0, cash 995.
 *
 * User B pins percentage exactness where naive rounding fails: two RM100
 * holdings + RM100 brokerage cash (thirds) → 334 / 333 / 333 = 1000.
 */
const TODAY = "2077-06-01";

let a: SupabaseClient;
let b: SupabaseClient;
let admin: SupabaseClient;
let brokA: string; // Moomoo
let h1: string; // T5PQQD
let h2: string; // T5PARCH
let h3: string; // T5PFLAT (archived, zero position, has trades)
let h4: string; // T5POVR
let ovrBuyId: string;

async function insertAccount(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string> {
  const res = await client.from("accounts").insert(row).select().single();
  if (res.error) throw res.error;
  return res.data.id as string;
}

async function insertHolding(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string> {
  const res = await client.from("holdings").insert(row).select().single();
  if (res.error) throw res.error;
  return res.data.id as string;
}

async function insertTrade(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<string> {
  const res = await client.from("trades").insert(row).select().single();
  if (res.error) throw res.error;
  return res.data.id as string;
}

async function tradeCount(client: SupabaseClient, holding_id: string): Promise<number> {
  const res = await client
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("holding_id", holding_id);
  if (res.error) throw res.error;
  return res.count ?? 0;
}

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  admin = adminClient();

  // ---- user A ----
  brokA = await insertAccount(a, {
    name: "Moomoo", type: "brokerage", starting_balance_sen: 1_000_000,
  });
  await insertAccount(a, { name: "Maybank", type: "bank", starting_balance_sen: 500_000 });

  h1 = await insertHolding(a, { symbol: "T5PQQD", kind: "etf", currency: "QQD" });
  await insertTrade(a, {
    holding_id: h1, account_id: brokA, side: "buy", date: "2077-01-10",
    quantity_e8: 1_000_000_000, price_e8: 200_000_000, fees_cent: 50, cash_delta_sen: 4_100,
  });
  await insertTrade(a, {
    holding_id: h1, account_id: brokA, side: "sell", date: "2077-02-10",
    quantity_e8: 400_000_000, price_e8: 300_000_000, fees_cent: 10, cash_delta_sen: 2_390,
  });

  h2 = await insertHolding(a, {
    symbol: "T5PARCH", kind: "stock", currency: "MYR", archived: true,
  });
  await insertTrade(a, {
    holding_id: h2, account_id: brokA, side: "buy", date: "2077-01-15",
    quantity_e8: 200_000_000, price_e8: 500_000_000, cash_delta_sen: 1_000,
  });

  h3 = await insertHolding(a, {
    symbol: "T5PFLAT", kind: "stock", currency: "MYR", archived: true,
  });
  await insertTrade(a, {
    holding_id: h3, account_id: brokA, side: "buy", date: "2077-01-20",
    quantity_e8: 100_000_000, price_e8: 100_000_000, cash_delta_sen: 100,
  });
  await insertTrade(a, {
    holding_id: h3, account_id: brokA, side: "sell", date: "2077-01-25",
    quantity_e8: 100_000_000, price_e8: 200_000_000, cash_delta_sen: 200,
  });

  h4 = await insertHolding(a, { symbol: "T5POVR", kind: "stock", currency: "MYR" });
  ovrBuyId = await insertTrade(a, {
    holding_id: h4, account_id: brokA, side: "buy", date: "2077-03-05",
    quantity_e8: 500_000_000, price_e8: 100_000_000, cash_delta_sen: 500,
  });
  await insertTrade(a, {
    holding_id: h4, account_id: brokA, side: "sell", date: "2077-03-20",
    quantity_e8: 300_000_000, price_e8: 100_000_000, cash_delta_sen: 300,
  });

  // ---- user B (percentage exactness) ----
  const brokB = await insertAccount(b, {
    name: "MMF", type: "brokerage", starting_balance_sen: 10_000,
  });
  for (const symbol of ["T5PCTA", "T5PCTB"]) {
    const id = await insertHolding(b, { symbol, kind: "stock", currency: "MYR" });
    await insertTrade(b, {
      holding_id: id, account_id: brokB, side: "buy", date: "2077-01-05",
      quantity_e8: 100_000_000, price_e8: 10_000_000_000, cash_delta_sen: 0,
    });
  }

  // ---- global reference data (service-role writes; suite-unique keys) ----
  const pr = await admin.from("prices").upsert([
    { symbol: "T5PQQD", currency: "QQD", price_e8: 300_000_000, as_of: "2077-05-31", source: "test" },
    { symbol: "T5PARCH", currency: "MYR", price_e8: 600_000_000, as_of: "2077-05-30", source: "test" },
    { symbol: "T5PFLAT", currency: "MYR", price_e8: 900_000_000, as_of: "2077-05-31", source: "test" },
    { symbol: "T5POVR", currency: "MYR", price_e8: 100_000_000, as_of: "2077-05-31", source: "test" },
    { symbol: "T5PCTA", currency: "MYR", price_e8: 10_000_000_000, as_of: "2077-05-31", source: "test" },
    { symbol: "T5PCTB", currency: "MYR", price_e8: 10_000_000_000, as_of: "2077-05-31", source: "test" },
  ], { onConflict: "symbol" });
  if (pr.error) throw pr.error;
  const fx = await admin.from("fx_rates").upsert(
    { pair: "QQDMYR", rate_e8: 200_000_000, as_of: "2077-05-31", source: "test" },
    { onConflict: "pair" },
  );
  if (fx.error) throw fx.error;
}, 30_000);

describe("getInvestments — reads", () => {
  it("derives position, avg cost, valuation and P/L from trades (hand-computed)", async () => {
    const inv = await getInvestments(a, TODAY);
    const row = inv.holdings.find((h) => h.symbol === "T5PQQD")!;
    expect(row.position.quantity_e8).toBe(600_000_000);
    expect(row.position.cost_cent).toBe(1_230);
    expect(row.position.avg_cost_e8).toBe(205_000_000);
    expect(row.position.realized_cent).toBe(370);
    expect(row.price).toEqual({
      price_e8: 300_000_000, as_of: "2077-05-31", stale: false, manual: false,
    });
    expect(row.value_sen).toBe(3_600);
    expect(row.unrealized_cent).toBe(570);
    expect(row.unrealized_sen).toBe(1_140);
    expect(inv.fx.get("QQDMYR")).toEqual({ rate_e8: 200_000_000, as_of: "2077-05-31" });
  });

  it("lists archived-with-position, drops flat archived, totals only listed rows", async () => {
    const inv = await getInvestments(a, TODAY);
    expect(inv.holdings.map((h) => h.symbol)).toEqual(["T5PQQD", "T5PARCH", "T5POVR"]);
    const arch = inv.holdings.find((h) => h.symbol === "T5PARCH")!;
    expect(arch.archived).toBe(true);
    expect(arch.value_sen).toBe(1_200);
    expect(arch.price!.stale).toBe(true); // as_of 2077-05-30 < prev KL day
    // T5PFLAT's realized 100c must not leak into the YTD figure.
    expect(inv.totals).toEqual({
      value_sen: 5_000, cost_sen: 3_660, unrealized_sen: 1_340, realized_ytd_sen: 740,
    });
  });

  it("exposes archived+zero-position holdings separately, with their trade count (Task 3 disclosure)", async () => {
    const inv = await getInvestments(a, TODAY);
    // T5PARCH is archived WITH a position — it stays in `holdings`, not here.
    expect(inv.archivedHoldings.map((h) => h.symbol)).toEqual(["T5PFLAT"]);
    expect(inv.archivedHoldings[0]).toEqual({ id: h3, symbol: "T5PFLAT", kind: "stock", tradeCount: 2 });
  });

  it("groups by kind with subtotals; cash = non-archived brokerage balances (ruling 19)", async () => {
    const inv = await getInvestments(a, TODAY);
    expect(inv.cash.value_sen).toBe(997_190);
    expect(inv.cash.accounts).toEqual([
      { name: "Moomoo", balance_sen: 997_190, currency: "MYR", myr_sen: 997_190 },
    ]);
    expect(inv.portfolio_total_sen).toBe(1_002_190);
    expect(inv.groups).toEqual([
      { kind: "etf", value_sen: 3_600, pct_tenths: 4, holding_ids: [h1] },
      { kind: "stock", value_sen: 1_400, pct_tenths: 1, holding_ids: [h2, h4] },
    ]);
    expect(inv.holdings.map((h) => h.pct_tenths)).toEqual([4, 1, 0]);
    expect(inv.cash.pct_tenths).toBe(995);
    const sum = inv.holdings.reduce((s, h) => s + h.pct_tenths, 0) + inv.cash.pct_tenths;
    expect(sum).toBe(1_000);
  });

  it("percentage column sums to exactly 1000 tenths where naive rounding would not", async () => {
    const inv = await getInvestments(b, TODAY);
    expect(inv.portfolio_total_sen).toBe(30_000);
    // Thirds: naive one-decimal rounding gives 33.3 + 33.3 + 33.3 = 99.9.
    expect(inv.holdings.map((h) => h.pct_tenths)).toEqual([334, 333]);
    expect(inv.cash.pct_tenths).toBe(333);
    expect(inv.groups).toEqual([
      {
        kind: "stock", value_sen: 20_000, pct_tenths: 667,
        holding_ids: inv.holdings.map((h) => h.id),
      },
    ]);
  });

  it("lists all trades newest first with symbol and account name", async () => {
    const inv = await getInvestments(a, TODAY);
    expect(inv.trades).toHaveLength(7);
    expect(inv.trades[0]!.symbol).toBe("T5POVR");
    expect(inv.trades[0]!.date).toBe("2077-03-20");
    expect(inv.trades[0]!.account_name).toBe("Moomoo");
    expect(inv.trades[6]!.symbol).toBe("T5PQQD");
    expect(inv.trades[6]!.holding_currency).toBe("QQD");
    const accountNames = inv.accounts.map((x) => x.name).sort();
    expect(accountNames).toEqual(["Maybank", "Moomoo"]);
  });

  it("a trades-only month never enters income/expense or budget math (rule 16)", async () => {
    const stats = await getMonthStats(a, "2077-01");
    expect(stats.income_sen).toBe(0);
    expect(stats.expense_sen).toBe(0);
    expect(stats.spend_by_category.size).toBe(0);
    const trend = await getIncomeVsExpense(a, 3, "2077-03-15");
    expect(trend).toHaveLength(3);
    for (const m of trend) {
      expect(m.income_sen).toBe(0);
      expect(m.expense_sen).toBe(0);
    }
    const budget = await getBudgetMonth(a, "2077-01");
    expect(budget.totals.income_sen).toBe(0);
    expect(budget.totals.expense_sen).toBe(0);
    expect(budget.rows.every((r) => r.spent_sen === 0)).toBe(true);
    expect(budget.unbudgeted).toEqual([]);
  });
});

describe("saveTrade / deleteTrade — oversell validation before any write", () => {
  it("rejects a sell exceeding the held quantity; nothing written", async () => {
    const before = await tradeCount(a, h4);
    const res = await performSaveTrade(a, {
      id: randomUUID(), holding_id: h4, account_id: brokA, side: "sell",
      date: "2077-04-01", quantity_e8: 300_000_000, price_e8: 100_000_000,
      fees_cent: 0, cash_delta_sen: 300,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exceeds held quantity/);
    expect(await tradeCount(a, h4)).toBe(before);
  });

  it("rejects a mid-sequence oversell (sell dated before the buy)", async () => {
    const before = await tradeCount(a, h4);
    const res = await performSaveTrade(a, {
      id: randomUUID(), holding_id: h4, account_id: brokA, side: "sell",
      date: "2077-03-01", quantity_e8: 100_000_000, price_e8: 100_000_000,
      fees_cent: 0, cash_delta_sen: 100,
    });
    expect(res.ok).toBe(false);
    expect(await tradeCount(a, h4)).toBe(before);
  });

  it("creates then edits by the same client UUID; an oversell edit leaves the row untouched", async () => {
    const id = randomUUID();
    const base = {
      id, holding_id: h4, account_id: brokA, side: "sell" as const,
      date: "2077-04-01", price_e8: 100_000_000, fees_cent: 0,
    };
    const created = await performSaveTrade(a, { ...base, quantity_e8: 100_000_000, cash_delta_sen: 100 });
    expect(created).toEqual({ ok: true });
    expect(await tradeCount(a, h4)).toBe(3);

    const edited = await performSaveTrade(a, { ...base, quantity_e8: 200_000_000, cash_delta_sen: 200 });
    expect(edited).toEqual({ ok: true });
    expect(await tradeCount(a, h4)).toBe(3);
    const row = await a.from("trades").select("quantity_e8").eq("id", id).single();
    expect(row.data!.quantity_e8).toBe(200_000_000);

    const oversell = await performSaveTrade(a, { ...base, quantity_e8: 300_000_000, cash_delta_sen: 300 });
    expect(oversell.ok).toBe(false);
    const after = await a.from("trades").select("quantity_e8").eq("id", id).single();
    expect(after.data!.quantity_e8).toBe(200_000_000);
  });

  it("rejects deleting a buy that funds later sells; row survives", async () => {
    const before = await tradeCount(a, h4);
    const res = await performDeleteTrade(a, ovrBuyId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/exceeds held quantity/);
    expect(await tradeCount(a, h4)).toBe(before);
    const still = await a.from("trades").select("id").eq("id", ovrBuyId);
    expect(still.data).toHaveLength(1);
  });

  it("deletes a trade whose removal keeps the chronology valid", async () => {
    const trades = await a.from("trades")
      .select("id").eq("holding_id", h4).eq("date", "2077-04-01");
    const res = await performDeleteTrade(a, trades.data![0]!.id as string);
    expect(res).toEqual({ ok: true });
    expect(await tradeCount(a, h4)).toBe(2);
  });
});

describe("holding writes", () => {
  it("creates, rejects a duplicate symbol visibly, archives", async () => {
    const created = await performCreateHolding(a, {
      symbol: "T5PNEW", kind: "stock", currency: "MYR",
    });
    expect(created.ok).toBe(true);
    const dup = await performCreateHolding(a, {
      symbol: "T5PNEW", kind: "stock", currency: "MYR",
    });
    expect(dup.ok).toBe(false);
    const row = await a.from("holdings").select("id").eq("symbol", "T5PNEW").single();
    const archived = await performArchiveHolding(a, row.data!.id as string);
    expect(archived).toEqual({ ok: true });
    const check = await a.from("holdings").select("archived").eq("symbol", "T5PNEW").single();
    expect(check.data!.archived).toBe(true);
  });

  it("rejects switching to manual pricing without a manual price", async () => {
    const res = await performUpdateHolding(a, h4, { price_source: "manual" });
    expect(res.ok).toBe(false);
  });
});

describe("unarchive / zero-trade delete (Task 3 — holding lifecycle trap closure)", () => {
  it("unarchive flips visibility: leaves the disclosure and rejoins its group", async () => {
    const created = await performCreateHolding(a, { symbol: "T5PUNA", kind: "stock", currency: "MYR" });
    expect(created).toEqual({ ok: true });
    const row = await a.from("holdings").select("id").eq("symbol", "T5PUNA").single();
    const id = row.data!.id as string;

    await performArchiveHolding(a, id);
    let inv = await getInvestments(a, TODAY);
    expect(inv.holdings.some((h) => h.id === id)).toBe(false);
    expect(inv.archivedHoldings.find((h) => h.id === id)).toEqual({
      id, symbol: "T5PUNA", kind: "stock", tradeCount: 0,
    });

    const unarchived = await performUnarchiveHolding(a, id);
    expect(unarchived).toEqual({ ok: true });
    inv = await getInvestments(a, TODAY);
    expect(inv.holdings.some((h) => h.id === id)).toBe(true);
    expect(inv.archivedHoldings.some((h) => h.id === id)).toBe(false);
  });

  it("rejects unarchiving/deleting a holding that does not exist, visibly", async () => {
    const res = await performUnarchiveHolding(a, randomUUID());
    expect(res).toEqual({ ok: false, error: "holding not found" });
    const del = await performDeleteHolding(a, randomUUID());
    expect(del).toEqual({ ok: false, error: "holding not found" });
  });

  it("rejects deleting an archived holding that has trades — nothing deleted (archive remains the only path)", async () => {
    const before = await tradeCount(a, h3);
    const res = await performDeleteHolding(a, h3);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/trade/i);
    const still = await a.from("holdings").select("id").eq("id", h3);
    expect(still.data).toHaveLength(1);
    expect(await tradeCount(a, h3)).toBe(before);
  });

  it("re-checks the trade count SERVER-SIDE inside the action — a trade landing after the client's read still blocks delete; zero trades deletes and frees the symbol", async () => {
    const created = await performCreateHolding(a, { symbol: "T5PRACE", kind: "stock", currency: "MYR" });
    expect(created).toEqual({ ok: true });
    const row = await a.from("holdings").select("id").eq("symbol", "T5PRACE").single();
    const id = row.data!.id as string;
    await performArchiveHolding(a, id);

    // Simulate a trade landing between the client's "0 trades" read and the
    // delete request reaching the server — the action must recheck itself,
    // not trust a stale client-side count.
    await insertTrade(a, {
      holding_id: id, account_id: brokA, side: "buy", date: "2077-04-10",
      quantity_e8: 100_000_000, price_e8: 100_000_000, cash_delta_sen: 100,
    });
    const raced = await performDeleteHolding(a, id);
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.error).toMatch(/trade/i);
    const stillThere = await a.from("holdings").select("id").eq("id", id);
    expect(stillThere.data).toHaveLength(1);

    // Remove the trade — now the zero-trade delete succeeds and the symbol
    // becomes creatable again (the trap this task closes).
    const delTrades = await a.from("trades").delete().eq("holding_id", id);
    expect(delTrades.error).toBeNull();
    const deleted = await performDeleteHolding(a, id);
    expect(deleted).toEqual({ ok: true });
    const gone = await a.from("holdings").select("id").eq("id", id);
    expect(gone.data).toHaveLength(0);

    const recreated = await performCreateHolding(a, { symbol: "T5PRACE", kind: "stock", currency: "MYR" });
    expect(recreated).toEqual({ ok: true });
  });
});

describe("holdings display + fx payload (Plan 6 Task 4)", () => {
  it("exposes value_cent (holding-currency value) alongside value_sen for native display", async () => {
    const inv = await getInvestments(a, TODAY);
    const row = inv.holdings.find((h) => h.symbol === "T5PQQD")!;
    expect(row.value_cent).toBe(1_800); // 6 × 3.00 = QQD 18.00
    expect(row.value_sen).toBe(3_600); // unchanged MYR figure
  });

  it("holdings_display defaults to 'myr'; performSetHoldingsDisplay persists 'native' and rejects junk", async () => {
    const before = await getInvestments(b, TODAY);
    expect(before.holdings_display).toBe("myr");

    const set = await performSetHoldingsDisplay(b, "native");
    expect(set).toEqual({ ok: true });
    const after = await getInvestments(b, TODAY);
    expect(after.holdings_display).toBe("native");

    const bad = await performSetHoldingsDisplay(b, "usd" as never);
    expect(bad.ok).toBe(false);
  });

  it("fx map gains <CUR>MYR pairs for non-MYR account currencies (cross-rate feed)", async () => {
    // B's holdings are all MYR, so this pair can only arrive via the
    // account-currency enumeration. Suite-unique fictional code (QQZ).
    const fxUp = await admin.from("fx_rates").upsert(
      { pair: "QQZMYR", rate_e8: 150_000_000, as_of: "2077-05-31", source: "test" },
      { onConflict: "pair" },
    );
    expect(fxUp.error).toBeNull();
    await insertAccount(b, { name: "Wise QQZ", type: "bank", currency: "QQZ" });

    const inv = await getInvestments(b, TODAY);
    expect(inv.fx.get("QQZMYR")).toEqual({ rate_e8: 150_000_000, as_of: "2077-05-31" });
  });
});
