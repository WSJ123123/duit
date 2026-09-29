import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { makeTestUsers } from "@/db/test-clients";
import { getMonthStats, getIncomeVsExpense, getTodayTotal } from "@/db/stats";
import { getBudgetMonth } from "@/db/budget";
import { performUpsert } from "@/lib/transactions";
import { performReconcile } from "@/lib/reconcile";

/**
 * Ruling 7 trend guard (rule 16 extended, pinned): transactions belonging to
 * non-MYR accounts NEVER enter income/expense trends, budget math or the
 * set-aside derivation — their sen are not MYR sen. The UI offers only
 * transfer + reconcile on such accounts; the action layer rejects manual
 * income/expense outright.
 *
 * 2077 dates; account currency "ZTD" is fictional but needs NO fx_rates row
 * (the guard keys on currency alone) — no global-table keys touched.
 */

let a: SupabaseClient;
let bankId: string;
let ztdId: string;
let foodId: string;
let salaryId: string;
let fundId: string;

beforeAll(async () => {
  ({ a } = await makeTestUsers());

  const bank = await a.from("accounts")
    .insert({ name: "Guard bank", type: "bank", starting_balance_sen: 100_000 })
    .select().single();
  if (bank.error) throw bank.error;
  bankId = bank.data.id;

  const ztd = await a.from("accounts")
    .insert({ name: "ZTD broker", type: "brokerage", currency: "ZTD", starting_balance_sen: 0 })
    .select().single();
  if (ztd.error) throw ztd.error;
  ztdId = ztd.data.id;

  const cats = await a.from("categories")
    .insert([
      { name: "Guard food", kind: "expense" },
      { name: "Guard salary", kind: "income" },
    ])
    .select();
  if (cats.error) throw cats.error;
  const byName = new Map(cats.data.map((c) => [c.name, c.id as string]));
  foodId = byName.get("Guard food")!;
  salaryId = byName.get("Guard salary")!;

  // MYR book for 2077-06: income 20_000, expense 10_000.
  const myr = await a.from("transactions").insert([
    { type: "income", amount_sen: 20_000, account_id: bankId, category_id: salaryId, date: "2077-06-03" },
    { type: "expense", amount_sen: 10_000, account_id: bankId, category_id: foodId, date: "2077-06-05" },
  ]);
  if (myr.error) throw myr.error;

  // ZTD-account rows the trends must NOT see: reconcile deltas both ways
  // (the only income/expense shape a non-MYR account can carry) and a
  // cross-currency transfer in.
  // (separate inserts: a PostgREST batch pads missing keys with NULL, which
  // would defeat the source/received_sen column defaults)
  const ztdRows = await a.from("transactions").insert([
    { type: "income", amount_sen: 8_888, account_id: ztdId, category_id: salaryId, source: "reconcile", date: "2077-06-07" },
    { type: "expense", amount_sen: 888, account_id: ztdId, category_id: foodId, source: "reconcile", date: "2077-06-08" },
  ]);
  if (ztdRows.error) throw ztdRows.error;
  const ztdTransfer = await a.from("transactions").insert({
    type: "transfer", amount_sen: 4_420, received_sen: 1_000,
    account_id: bankId, transfer_account_id: ztdId, date: "2077-06-09",
  });
  if (ztdTransfer.error) throw ztdTransfer.error;

  const fund = await a.from("funds")
    .insert({ name: "Guard fund", kind: "sinking" })
    .select().single();
  if (fund.error) throw fund.error;
  fundId = fund.data.id;
}, 30_000);

describe("trend guard — non-MYR account sen never enter MYR math", () => {
  it("getMonthStats: income, expense and spend-by-category see only MYR-account rows", async () => {
    const stats = await getMonthStats(a, "2077-06");
    expect(stats.income_sen).toBe(20_000); // not 28_888
    expect(stats.expense_sen).toBe(10_000); // not 10_888
    expect(stats.spend_by_category).toEqual(new Map([[foodId, 10_000]]));
  });

  it("getIncomeVsExpense trend excludes them too", async () => {
    const months = await getIncomeVsExpense(a, 1, "2077-06-15");
    expect(months).toEqual([{ month: "2077-06", income_sen: 20_000, expense_sen: 10_000 }]);
  });

  it("PIN: a non-MYR account's reconcile delta moves no daily total", async () => {
    // 2077-06-08 carries ONLY the ZTD reconcile expense.
    expect(await getTodayTotal(a, "2077-06-08")).toBe(0);
  });

  it("PIN: budget month + set-aside derivation are untouched by ZTD rows", async () => {
    const budget = await getBudgetMonth(a, "2077-06");
    expect(budget.totals.income_sen).toBe(20_000);
    expect(budget.totals.expense_sen).toBe(10_000);
    // set-aside = max(0, income − expense) over MYR rows only
    expect(budget.savings.set_aside_sen).toBe(10_000);
    const food = budget.rows.find((r) => r.category_id === foodId);
    expect(food?.spent_sen).toBe(10_000);
  });
});

describe("action guard — manual income/expense rejected on non-MYR accounts", () => {
  it("rejects a manual expense with a visible error", async () => {
    const result = await performUpsert(a, {
      id: randomUUID(),
      type: "expense",
      amount: "12.34",
      accountId: ztdId,
      categoryId: foodId,
      date: "2077-06-10",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/transfer|reconcil/i);
  });

  it("rejects a manual income the same way", async () => {
    const result = await performUpsert(a, {
      id: randomUUID(),
      type: "income",
      amount: "12.34",
      accountId: ztdId,
      categoryId: salaryId,
      date: "2077-06-10",
    });
    expect(result.ok).toBe(false);
  });

  /**
   * Ruling 8: a `fund_id` may only sit on an expense whose ACCOUNT is MYR —
   * a non-MYR account's amount_sen are that currency's minor units and would
   * corrupt the fund balance. The table CHECK cannot see the account's
   * currency, so `applyCurrencyRules` (the choke point for the two form/action
   * write paths) must.
   */
  it("ruling 8: rejects a fund-tagged expense on a non-MYR account", async () => {
    const result = await performUpsert(a, {
      id: randomUUID(),
      type: "expense",
      amount: "12.34",
      accountId: ztdId,
      categoryId: foodId,
      date: "2077-06-11",
      fundId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/MYR/);
  });

  it("ruling 8 PIN: the reconcile exemption does NOT carry a fund through", async () => {
    // `source: "reconcile"` is the one thing that lets an expense onto a
    // non-MYR account. If the fund check rode on the existing guard instead
    // of standing on its own, this row would be written and the fund's
    // balance would be wrong by 1234 ZTD minor units for ever.
    const id = randomUUID();
    const result = await performUpsert(a, {
      id,
      type: "expense",
      amount: "12.34",
      accountId: ztdId,
      categoryId: foodId,
      date: "2077-06-11",
      source: "reconcile",
      fundId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/MYR/);
    const { data } = await a.from("transactions").select("id").eq("id", id);
    expect(data).toEqual([]); // nothing written
  });

  it("ruling 8: the same tagged expense on the MYR account is accepted", async () => {
    const id = randomUUID();
    // 2077-07, so none of the 2077-06 assertions above can move.
    const result = await performUpsert(a, {
      id,
      type: "expense",
      amount: "12.34",
      accountId: bankId,
      categoryId: foodId,
      date: "2077-07-02",
      fundId,
    });
    expect(result).toEqual({ ok: true, id, created: true });
    const { data } = await a.from("transactions").select("fund_id").eq("id", id).single();
    expect(data!.fund_id).toBe(fundId);
  });

  it("reconciliation stays allowed (its adjustment carries source 'reconcile')", async () => {
    // ZTD balance: 0 + 1_000 (received) + 8_888 − 888 = 9_000 → stating
    // 100.00 inserts a 1_000 reconcile income.
    const result = await performReconcile(a, ztdId, "100.00", salaryId);
    expect(result).toEqual({ ok: true });
    const { data } = await a.from("account_balances").select("balance_sen").eq("account_id", ztdId).single();
    expect(Number(data!.balance_sen)).toBe(10_000);
    // ...and the adjustment note speaks the ACCOUNT's currency, not RM.
    const noteRes = await a
      .from("transactions")
      .select("note")
      .eq("account_id", ztdId)
      .like("note", "Reconciled%")
      .single();
    expect(noteRes.data!.note).toBe("Reconciled to ZTD 100.00");
  });
});
