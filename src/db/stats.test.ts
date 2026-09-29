import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getMonthStats, getTodayTotal, getIncomeVsExpense } from "@/db/stats";
import { avgMonthlyExpenseSen } from "@/db/networth";
import { fetchAllPages, IN_CHUNK } from "@/db/paging";
import { spendByCategory, type SplitLike } from "@/lib/stats";

let a: SupabaseClient;
let b: SupabaseClient;
let bank: string, wallet: string, foreign: string;
let food: string, fun: string, salary: string;
let activeFund: string, archivedFund: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  bank = (await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single()).data!.id;
  wallet = (await a.from("accounts").insert({ name: "TnG", type: "ewallet" }).select().single()).data!.id;
  // Ruling 8 axis: a non-MYR account whose sen are NOT MYR sen. Present in the
  // fixture so a fund filter applied in the wrong order (before the trend
  // guard) shows up here rather than in production.
  foreign = (await a.from("accounts")
    .insert({ name: "ZSA broker", type: "brokerage", currency: "ZSA" })
    .select().single()).data!.id;
  food = (await a.from("categories").insert({ name: "Food", kind: "expense" }).select().single()).data!.id;
  fun = (await a.from("categories").insert({ name: "Fun", kind: "expense" }).select().single()).data!.id;
  salary = (await a.from("categories").insert({ name: "Salary", kind: "income" }).select().single()).data!.id;

  // RM300 dinner, RM240 expected back, split RM100 food / RM200 fun.
  // Parent's own category (food) must be ignored in favor of the splits.
  const dinner = (await a
    .from("transactions")
    .insert({
      type: "expense",
      amount_sen: 30_000,
      expected_back_sen: 24_000,
      account_id: bank,
      category_id: food,
      date: "2026-03-10",
    })
    .select()
    .single()).data!;
  const splitsRes = await a.from("transaction_splits").insert([
    { transaction_id: dinner.id, category_id: food, amount_sen: 10_000 },
    { transaction_id: dinner.id, category_id: fun, amount_sen: 20_000 },
  ]);
  if (splitsRes.error) throw splitsRes.error;

  const txRes = await a.from("transactions").insert([
    { type: "expense", amount_sen: 5_000, account_id: bank, category_id: food, date: "2026-03-12" },
    { type: "expense", amount_sen: 700, account_id: wallet, date: "2026-03-12" }, // uncategorized
    { type: "income", amount_sen: 100_000, account_id: bank, category_id: salary, date: "2026-03-01" },
    { type: "transfer", amount_sen: 20_000, account_id: bank, transfer_account_id: wallet, date: "2026-03-12" },
    { type: "expense", amount_sen: 1_000, account_id: bank, category_id: food, date: "2026-02-15" }, // prior month
    { type: "expense", amount_sen: 9_999, account_id: bank, category_id: food, date: "2026-04-01" }, // next month
  ]);
  if (txRes.error) throw txRes.error;

  // ---- Plan 7 ruling 7: fund-paid spending ------------------------------
  // Separate inserts: a PostgREST batch pads missing keys with NULL, which
  // would defeat `archived`'s NOT NULL default (trend-guard.test.ts's note).
  const activeRes = await a.from("funds").insert({ name: "Stats fund", kind: "sinking" }).select().single();
  if (activeRes.error) throw activeRes.error;
  activeFund = activeRes.data.id;
  const archivedRes = await a.from("funds")
    .insert({ name: "Stats archived fund", kind: "sinking", archived: true })
    .select().single();
  if (archivedRes.error) throw archivedRes.error;
  archivedFund = archivedRes.data.id;

  const taggedRes = await a.from("transactions").insert([
    // Categorised draw — must leave `food`'s bucket, stay in expense_sen.
    { type: "expense", amount_sen: 2_500, account_id: bank, category_id: food, date: "2026-03-12", fund_id: activeFund },
    // Uncategorised draw — the null key of spend_by_category must not carry it.
    { type: "expense", amount_sen: 300, account_id: wallet, date: "2026-03-12", fund_id: activeFund },
    // Ruling 9a: a tag to an ARCHIVED fund is excluded exactly the same way.
    { type: "expense", amount_sen: 1_200, account_id: bank, category_id: fun, date: "2026-03-20", fund_id: archivedFund },
    // Trend guard first, fund exclusion second: a tagged row on a non-MYR
    // account is invisible to ALL of these numbers, fund_spend_sen included.
    { type: "expense", amount_sen: 9_900, account_id: foreign, category_id: food, date: "2026-03-12", fund_id: activeFund },
  ]);
  if (taggedRes.error) throw taggedRes.error;

  // Ruling 6 forbids this combination through the action layer — which is
  // exactly why the fixture writes it DIRECTLY: `fund_spend_sen` must be NET
  // for a row the validator never saw. Nothing in the schema forbids it (the
  // table CHECK is `fund_id is null or type = 'expense'`, blind to
  // expected_back_sen), so ruling 7's identity has to hold on its own terms
  // rather than by trusting ruling 6 to have been enforced everywhere.
  // Without this row, swapping `netExpenseSen` for `amount_sen` in
  // getMonthStats leaves the ENTIRE suite green (verified 2026-08-20).
  const reimbursedDraw = await a.from("transactions").insert({
    type: "expense",
    amount_sen: 4_000,
    expected_back_sen: 1_500,
    account_id: bank,
    category_id: food,
    date: "2026-03-12",
    fund_id: activeFund,
  });
  if (reimbursedDraw.error) throw reimbursedDraw.error;
}, 30_000);

describe("getMonthStats", () => {
  it("returns hand-computed sen values for the month", async () => {
    const stats = await getMonthStats(a, "2026-03");
    expect(stats.month).toBe("2026-03");
    // dinner nets to 6000 split 2000/4000; groceries 5000 food; 700 uncategorized.
    // The three fund-tagged rows (2500 food, 300 uncategorized, 1200 fun) are
    // NOT here — ruling 7 keeps fund-paid spend out of the category budget.
    expect(stats.spend_by_category.get(food)).toBe(7_000);
    expect(stats.spend_by_category.get(fun)).toBe(4_000);
    expect(stats.spend_by_category.get(null)).toBe(700);
    expect(stats.spend_by_category.size).toBe(3);
    // ...but the cash really left, so every total below KEEPS them:
    // 6000 + 5000 + 700 + 2500 + 300 + 1200 + 2500(net of the reimbursed
    // draw); transfer, income and the non-MYR row excluded.
    expect(stats.expense_sen).toBe(18_200);
    expect(stats.income_sen).toBe(100_000);
    // NET, not gross: 2500 + 300 + 1200 + (4000 − 1500). Gross would be 8000.
    expect(stats.fund_spend_sen).toBe(6_500);
  });

  it("PIN (ruling 7's identity): Σ spend_by_category (null key included) + fund_spend_sen === expense_sen", async () => {
    const stats = await getMonthStats(a, "2026-03");
    let categorised = 0;
    for (const sen of stats.spend_by_category.values()) categorised += sen;
    expect(categorised + stats.fund_spend_sen).toBe(stats.expense_sen);
  });

  it("PIN (ruling 9a): a tag to an ARCHIVED fund is excluded from the budget too", async () => {
    const stats = await getMonthStats(a, "2026-03");
    // The archived fund's 1200 sits on `fun`; if `archived` leaked into the
    // filter, `fun` would read 5200 and fund_spend_sen 5300.
    expect(stats.spend_by_category.get(fun)).toBe(4_000);
    expect(stats.fund_spend_sen).toBe(6_500);
  });

  it("PIN (rulings 7 + 8): a tagged row on a non-MYR account reaches none of these numbers", async () => {
    const stats = await getMonthStats(a, "2026-03");
    // The ZSA row is 9900 tagged to the ACTIVE fund. Every number below would
    // move if the fund split ran before the trend guard.
    expect(stats.fund_spend_sen).toBe(6_500);
    expect(stats.expense_sen).toBe(18_200);
    expect(stats.spend_by_category.get(food)).toBe(7_000);
  });

  it("months with no fund-paid spending report fund_spend_sen 0", async () => {
    expect((await getMonthStats(a, "2026-02")).fund_spend_sen).toBe(0);
  });
});

describe("getTodayTotal", () => {
  it("nets only the given day's expenses — fund-paid ones included", async () => {
    // 5000 + 700 + 2500 + 300 + 2500(netted); transfer and non-MYR excluded.
    expect(await getTodayTotal(a, "2026-03-12")).toBe(11_000);
    expect(await getTodayTotal(a, "2026-03-10")).toBe(6_000); // dinner netted
    expect(await getTodayTotal(a, "2026-03-11")).toBe(0);
    expect(await getTodayTotal(a, "2026-03-20")).toBe(1_200); // archived-fund draw
  });
});

describe("getIncomeVsExpense", () => {
  it("returns the last N months oldest-first with netted expenses", async () => {
    const out = await getIncomeVsExpense(a, 3, "2026-03-12");
    expect(out).toEqual([
      { month: "2026-01", income_sen: 0, expense_sen: 0 },
      { month: "2026-02", income_sen: 0, expense_sen: 1_000 },
      // fund-paid spend stays in the trend — the cash left the account
      { month: "2026-03", income_sen: 100_000, expense_sen: 18_200 },
    ]);
  });
});

describe("RLS isolation", () => {
  it("user B sees empty/zero stats", async () => {
    const stats = await getMonthStats(b, "2026-03");
    expect(stats.spend_by_category.size).toBe(0);
    expect(stats.expense_sen).toBe(0);
    expect(stats.income_sen).toBe(0);
    expect(stats.fund_spend_sen).toBe(0);
    expect(await getTodayTotal(b, "2026-03-12")).toBe(0);
    expect(await getIncomeVsExpense(b, 2, "2026-03-12")).toEqual([
      { month: "2026-02", income_sen: 0, expense_sen: 0 },
      { month: "2026-03", income_sen: 0, expense_sen: 0 },
    ]);
  });
});

describe("fetchTxRange pages past the 1000-row cap (Plan 8 ruling 14)", () => {
  // PostgREST truncates an unbounded select at 1000 rows with HTTP 200 and no
  // flag (finding #19). Every row here sits inside ONE month — one
  // fetchTxRange window — so an unpaged read drops 200 of them silently.
  let c: SupabaseClient;
  beforeAll(async () => {
    ({ a: c } = await makeTestUsers());
    const acct = await c.from("accounts").insert({ name: "Paging bank", type: "bank" }).select().single();
    if (acct.error) throw acct.error;
    const rows = Array.from({ length: 1200 }, () => ({
      type: "expense",
      amount_sen: 3,
      account_id: acct.data.id,
      date: "2077-05-10",
      note: "paging row",
    }));
    const ins = await c.from("transactions").insert(rows);
    if (ins.error) throw ins.error;
  }, 60_000);

  it("getMonthStats sums all 1,200 rows of one month exactly", async () => {
    const stats = await getMonthStats(c, "2077-05");
    expect(stats.expense_sen).toBe(3_600); // 1200 × 3; a truncated read says 3000
    expect(stats.spend_by_category.get(null)).toBe(3_600);
  });

  it("avgMonthlyExpenseSen is exact with the 1,200 rows in its window", async () => {
    // Window = the six months before 2077-06; the earliest row is in 2077-05,
    // so the divisor is 1 and the average IS the month's total.
    expect(await avgMonthlyExpenseSen(c, "2077-06-15")).toBe(3_600);
  });
});

/**
 * Plan 9 ruling 10c: `fetchSplitsFor` (private in src/db/stats.ts) read its
 * IN_CHUNK id chunks one after another; the chunks are independent, so it
 * now runs them under `Promise.all`. The old sequential helper is kept HERE
 * verbatim (from src/db/stats.ts at `6a3bb43`), and the month's
 * `spend_by_category` off the new shape is pinned EQUAL to what the old one
 * yields — at 250 expenses in one month, each split in two (three chunks).
 */
async function oldFetchSplitsFor(supabase: SupabaseClient, txIds: string[]): Promise<SplitLike[]> {
  const splits: SplitLike[] = [];
  for (let i = 0; i < txIds.length; i += IN_CHUNK) {
    const chunk = txIds.slice(i, i + IN_CHUNK);
    splits.push(
      ...(await fetchAllPages<SplitLike>((from, to) =>
        supabase
          .from("transaction_splits")
          .select("transaction_id, category_id, amount_sen")
          .in("transaction_id", chunk)
          .order("id")
          .range(from, to),
      )),
    );
  }
  return splits;
}

describe("getMonthStats splits read equals the old sequential chunk loop at 250 rows (Plan 9 ruling 10c)", () => {
  let c: SupabaseClient;
  let rows: Array<{ id: string; type: "expense"; amount_sen: number; expected_back_sen: number; category_id: string | null; date: string }>;

  beforeAll(async () => {
    ({ a: c } = await makeTestUsers());
    const acct = (await c.from("accounts").insert({ name: "Equality bank", type: "bank" }).select().single()).data!.id;
    const f = (await c.from("categories").insert({ name: "Eq food", kind: "expense" }).select().single()).data!.id;
    const t = (await c.from("categories").insert({ name: "Eq transport", kind: "expense" }).select().single()).data!.id;
    const ins = await c
      .from("transactions")
      .insert(
        Array.from({ length: 250 }, (_, i) => ({
          type: "expense",
          amount_sen: 1_000,
          expected_back_sen: i % 5 === 0 ? 200 : 0,
          account_id: acct,
          category_id: f,
          date: "2077-09-15",
          note: `eq ${i}`,
        })),
      )
      .select("id, type, amount_sen, expected_back_sen, category_id, date");
    if (ins.error) throw ins.error;
    rows = ins.data;
    const splits = await c.from("transaction_splits").insert(
      rows.flatMap((r) => [
        { transaction_id: r.id, category_id: f, amount_sen: 400 },
        { transaction_id: r.id, category_id: t, amount_sen: 600 },
      ]),
    );
    if (splits.error) throw splits.error;
  }, 60_000);

  it("spend_by_category off the parallel read equals the old sequential shape's, and the hand-computed figure", async () => {
    const oldSplits = await oldFetchSplitsFor(c, rows.map((r) => r.id));
    expect(oldSplits).toHaveLength(500);
    const expected = spendByCategory(rows, oldSplits);
    const stats = await getMonthStats(c, "2077-09");
    expect(stats.spend_by_category).toEqual(expected);
    // 50 rows net 800 (320 food / 480 transport, the last split absorbing the
    // remainder), 200 rows net 1000 (400 / 600).
    expect([...stats.spend_by_category.values()].reduce((s, v) => s + v, 0)).toBe(stats.expense_sen);
    expect(stats.expense_sen).toBe(50 * 800 + 200 * 1_000);
  });
});
