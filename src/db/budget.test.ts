import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import {
  getBudgetMonth,
  getBudgetGlance,
  performSaveBudgetPlan,
  performAdjustAllocation,
  performMoveAllocation,
  performUpdateBenchmark,
  performUpdateCategoryTag,
} from "@/db/budget";

let a: SupabaseClient;
let b: SupabaseClient;
let bank: string;
let food: string, groceries: string, fun: string, oldStuff: string, salary: string;
let budgetFund: string, travelFund: string;

// Far-future fixture months: recurring-engine.test.ts runs materializeDueRules,
// which is global across users — a past-dated active rule here would be drained
// by that suite (and inflate its insert counts) whenever the files interleave.
// Budget queries take the month as a parameter, so future dates are equivalent.
const MAY = "2077-05";
const APRIL = "2077-04";

const logsFor = async (month: string) =>
  (await a.from("budget_changes").select().eq("month", `${month}-01`)).data!;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  bank = (await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single())
    .data!.id;
  food = (await a.from("categories")
    .insert({ name: "Food", kind: "expense", tag: "needs" }).select().single()).data!.id;
  groceries = (await a.from("categories")
    .insert({ name: "Groceries", kind: "expense", tag: "needs", parent_id: food })
    .select().single()).data!.id;
  fun = (await a.from("categories")
    .insert({ name: "Fun", kind: "expense", tag: "wants" }).select().single()).data!.id;
  oldStuff = (await a.from("categories")
    .insert({ name: "Old stuff", kind: "expense", tag: "wants", archived: true })
    .select().single()).data!.id;
  salary = (await a.from("categories")
    .insert({ name: "Salary", kind: "income" }).select().single()).data!.id;

  const txRes = await a.from("transactions").insert([
    // April (previous month): subcategory spend rolls up to Food.
    { type: "expense", amount_sen: 10_000, account_id: bank, category_id: groceries, date: "2077-04-08" },
    { type: "expense", amount_sen: 2_000, account_id: bank, category_id: fun, date: "2077-04-20" },
    // May (current month).
    { type: "expense", amount_sen: 3_000, account_id: bank, category_id: groceries, date: "2077-05-03" },
    { type: "expense", amount_sen: 4_000, account_id: bank, category_id: food, date: "2077-05-05" },
    { type: "expense", amount_sen: 1_500, account_id: bank, category_id: fun, date: "2077-05-07" },
    { type: "expense", amount_sen: 900, account_id: bank, date: "2077-05-09" }, // uncategorized
    { type: "expense", amount_sen: 5_000, account_id: bank, category_id: oldStuff, date: "2077-05-11" },
    { type: "income", amount_sen: 200_000, account_id: bank, category_id: salary, date: "2077-05-01" },
  ]);
  if (txRes.error) throw txRes.error;

  // ---- Plan 7 rulings 4/7/9a: funds behind the Savings & funds row --------
  // Separate inserts (a PostgREST batch pads missing keys with NULL, which
  // would defeat `archived`'s NOT NULL default).
  const emergency = await a.from("funds")
    .insert({ name: "Budget fund", kind: "emergency", monthly_contribution_sen: 40_000, priority: 1 })
    .select().single();
  if (emergency.error) throw emergency.error;
  budgetFund = emergency.data.id;
  const travel = await a.from("funds")
    .insert({ name: "Budget travel", kind: "goal", monthly_contribution_sen: 20_000, priority: 2 })
    .select().single();
  if (travel.error) throw travel.error;
  travelFund = travel.data.id;
  const retired = await a.from("funds")
    .insert({ name: "Budget old", kind: "sinking", monthly_contribution_sen: 90_000, archived: true })
    .select().single();
  if (retired.error) throw retired.error;

  // Ruling 10: the STORED row for the month wins over monthly_contribution_sen,
  // so this card and the waterfall cannot describe the same month differently.
  const contribRes = await a.from("fund_contributions")
    .insert({ fund_id: budgetFund, month: `${MAY}-01`, amount_sen: 45_000 });
  if (contribRes.error) throw contribRes.error;

  // Ruling 7: a fund-paid expense in May — off `fun`'s limit, still in the
  // month's expense total (and therefore still inside the set-aside).
  const drawRes = await a.from("transactions")
    .insert({ type: "expense", amount_sen: 2_000, account_id: bank, category_id: fun, date: "2077-05-13", fund_id: budgetFund });
  if (drawRes.error) throw drawRes.error;

  // Active monthly income rule: expected-income default for unplanned months.
  const ruleRes = await a.from("recurring_rules").insert({
    name: "Payday", type: "income", amount_sen: 300_000, account_id: bank,
    category_id: salary, freq: "monthly", day_of_month: 25, next_run: "2077-05-25",
  });
  if (ruleRes.error) throw ruleRes.error;
}, 30_000);

describe("getBudgetMonth — unplanned month", () => {
  it("rolls up spend, falls back to rules income, prev null", async () => {
    const data = await getBudgetMonth(a, MAY);
    expect(data.month).toBe(MAY);
    expect(data.planned).toBe(false);
    expect(data.expected_income_sen).toBe(300_000); // from the active rule
    expect(data.prev).toBeNull(); // April not planned yet

    const foodRow = data.rows.find((r) => r.category_id === food)!;
    expect(foodRow.spent_sen).toBe(7_000); // 3000 sub + 4000 direct, rolled up
    expect(foodRow.prev_spent_sen).toBe(10_000); // April sub spend rolled up
    expect(foodRow.prev_allocated_sen).toBe(0);
    expect(foodRow.allocated_sen).toBe(0);
    expect(foodRow.tag).toBe("needs");

    const funRow = data.rows.find((r) => r.category_id === fun)!;
    // Ruling 7: the 2000 fund-paid draw on `fun` is NOT against its limit.
    expect(funRow.spent_sen).toBe(1_500);
    expect(funRow.prev_spent_sen).toBe(2_000);

    // Archived category with spend still renders — money never disappears.
    const oldRow = data.rows.find((r) => r.category_id === oldStuff)!;
    expect(oldRow.archived).toBe(true);
    expect(oldRow.spent_sen).toBe(5_000);

    expect(data.rows).toHaveLength(3);
    expect(data.unbudgeted).toEqual([
      { category_id: null, name: "Uncategorized", spent_sen: 900 },
    ]);
    expect(data.totals).toEqual({
      allocated_sen: 0,
      spent_sen: 13_500, // sum of visible rows (the fund draw is in none of them)
      income_sen: 200_000,
      expense_sen: 16_400, // includes unbudgeted 900 AND the 2000 fund draw
      fund_spend_sen: 2_000,
    });
    expect(data.savings).toEqual({
      planned_sen: 0,
      allocated_sen: 0,
      set_aside_sen: 183_600, // 200_000 − 16_400 — derivation unchanged
      // v6 §9 middle fragment: ACTIVE funds only (ruling 9a), stored row wins.
      funds: [
        { id: budgetFund, name: "Budget fund", contribution_sen: 45_000 },
        { id: travelFund, name: "Budget travel", contribution_sen: 20_000 },
      ],
    });
    expect(data.change_count).toBe(0);
    expect(data.benchmark).toEqual({ needs_pct: 50, wants_pct: 30, savings_pct: 20 });
  });

  it("PIN (ruling 7's identity) holds through the budget layer", async () => {
    const data = await getBudgetMonth(a, MAY);
    const rowSpend = data.rows.reduce((sum, r) => sum + r.spent_sen, 0);
    const unbudgeted = data.unbudgeted.reduce((sum, u) => sum + u.spent_sen, 0);
    // rows + unbudgeted is exactly Σ spend_by_category (rolled up), so adding
    // fund_spend_sen must land on expense_sen — the claim `Paid from funds`
    // makes on the page.
    expect(rowSpend + unbudgeted + data.totals.fund_spend_sen).toBe(data.totals.expense_sen);
  });

  it("getBudgetGlance is null when the month is unplanned", async () => {
    expect(await getBudgetGlance(a, MAY)).toBeNull();
  });
});

describe("performSaveBudgetPlan — first save pins planned", () => {
  it("saves April: planned_sen === allocated_sen === saved values", async () => {
    const result = await performSaveBudgetPlan(a, APRIL, {
      expected_income_sen: 250_000,
      savings_sen: 50_000,
      allocations: [
        { category_id: food, allocated_sen: 60_000 },
        { category_id: fun, allocated_sen: 20_000 },
      ],
    });
    expect(result).toEqual({ ok: true });

    const data = await getBudgetMonth(a, APRIL);
    expect(data.planned).toBe(true);
    expect(data.expected_income_sen).toBe(250_000);
    expect(data.savings.planned_sen).toBe(50_000);
    expect(data.savings.allocated_sen).toBe(50_000);
    const foodRow = data.rows.find((r) => r.category_id === food)!;
    expect(foodRow.planned_sen).toBe(60_000);
    expect(foodRow.allocated_sen).toBe(60_000);
    const funRow = data.rows.find((r) => r.category_id === fun)!;
    expect(funRow.planned_sen).toBe(20_000);
    expect(funRow.allocated_sen).toBe(20_000);
    expect(data.change_count).toBe(0);
    expect(await logsFor(APRIL)).toHaveLength(0);
  });

  it("May now sees April as prev (copy-prefill source)", async () => {
    const data = await getBudgetMonth(a, MAY);
    expect(data.prev).toEqual({ expected_income_sen: 250_000, savings_allocated_sen: 50_000 });
    expect(data.rows.find((r) => r.category_id === food)!.prev_allocated_sen).toBe(60_000);
    expect(data.rows.find((r) => r.category_id === fun)!.prev_allocated_sen).toBe(20_000);
  });

  it("rejects a malformed month", async () => {
    const result = await performSaveBudgetPlan(a, "2077-5", {
      expected_income_sen: 0, savings_sen: 0, allocations: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe("performSaveBudgetPlan — planned month (May)", () => {
  it("first save of May: rows, unbudgeted precision, glance", async () => {
    const result = await performSaveBudgetPlan(a, MAY, {
      expected_income_sen: 300_000,
      savings_sen: 40_000,
      allocations: [
        { category_id: food, allocated_sen: 70_000 },
        { category_id: oldStuff, allocated_sen: 6_000 },
      ],
    });
    expect(result).toEqual({ ok: true });

    const data = await getBudgetMonth(a, MAY);
    expect(data.planned).toBe(true);
    expect(data.expected_income_sen).toBe(300_000);

    // Active parent with spend but NO allocation: normal row, allocated 0 —
    // not unbudgeted.
    const funRow = data.rows.find((r) => r.category_id === fun)!;
    expect(funRow.allocated_sen).toBe(0);
    expect(funRow.planned_sen).toBe(0);
    expect(funRow.spent_sen).toBe(1_500);
    expect(data.unbudgeted).toEqual([
      { category_id: null, name: "Uncategorized", spent_sen: 900 },
    ]);

    // Archived but allocated stays visible.
    const oldRow = data.rows.find((r) => r.category_id === oldStuff)!;
    expect(oldRow.archived).toBe(true);
    expect(oldRow.allocated_sen).toBe(6_000);

    // Savings excluded from the category-allocation total.
    expect(data.totals.allocated_sen).toBe(76_000);
    expect(data.totals.spent_sen).toBe(13_500);
    expect(data.change_count).toBe(0);

    // Glance: spent = the month's total net expense (hero contract) — the
    // 2000 fund draw is in it, exactly as it is in totals.expense_sen.
    expect(await getBudgetGlance(a, MAY)).toEqual({
      allocated_total_sen: 76_000,
      spent_total_sen: 16_400,
    });
  });

  it("re-save updates allocated only, planned untouched, logs the changed rows", async () => {
    const result = await performSaveBudgetPlan(a, MAY, {
      expected_income_sen: 310_000,
      savings_sen: 45_000,
      allocations: [
        { category_id: food, allocated_sen: 80_000 },
        { category_id: oldStuff, allocated_sen: 6_000 }, // unchanged → no log
      ],
    });
    expect(result).toEqual({ ok: true });

    const data = await getBudgetMonth(a, MAY);
    expect(data.expected_income_sen).toBe(310_000);
    expect(data.savings.planned_sen).toBe(40_000); // pinned at first save
    expect(data.savings.allocated_sen).toBe(45_000);
    const foodRow = data.rows.find((r) => r.category_id === food)!;
    expect(foodRow.planned_sen).toBe(70_000); // pinned at first save
    expect(foodRow.allocated_sen).toBe(80_000);

    const logs = await logsFor(MAY);
    expect(logs).toHaveLength(2); // exactly the changed rows
    const foodLog = logs.find((l) => l.category_id === food)!;
    expect({ from: foodLog.from_sen, to: foodLog.to_sen }).toEqual({ from: 70_000, to: 80_000 });
    const savingsLog = logs.find((l) => l.category_id === null)!;
    expect({ from: savingsLog.from_sen, to: savingsLog.to_sen }).toEqual({ from: 40_000, to: 45_000 });
    expect(data.change_count).toBe(2);
  });
});

describe("performAdjustAllocation", () => {
  it("updates one row and logs one change", async () => {
    const result = await performAdjustAllocation(a, MAY, food, 90_000);
    expect(result).toEqual({ ok: true });
    const data = await getBudgetMonth(a, MAY);
    expect(data.rows.find((r) => r.category_id === food)!.allocated_sen).toBe(90_000);
    expect(data.rows.find((r) => r.category_id === food)!.planned_sen).toBe(70_000);
    const logs = await logsFor(MAY);
    expect(logs).toHaveLength(3);
    expect(logs.some((l) => l.from_sen === 80_000 && l.to_sen === 90_000)).toBe(true);
  });

  it("null category targets the savings envelope", async () => {
    const result = await performAdjustAllocation(a, MAY, null, 47_000);
    expect(result).toEqual({ ok: true });
    const data = await getBudgetMonth(a, MAY);
    expect(data.savings.allocated_sen).toBe(47_000);
    expect(data.savings.planned_sen).toBe(40_000);
    const logs = await logsFor(MAY);
    expect(logs).toHaveLength(4);
    expect(
      logs.some((l) => l.category_id === null && l.from_sen === 45_000 && l.to_sen === 47_000),
    ).toBe(true);
  });

  it("errors on an unplanned month", async () => {
    const result = await performAdjustAllocation(a, "2077-06", null, 1_000);
    expect(result.ok).toBe(false);
  });
});

describe("performMoveAllocation", () => {
  it("moves between envelopes via the rpc, logging both sides", async () => {
    const result = await performMoveAllocation(a, MAY, food, oldStuff, 10_000);
    expect(result).toEqual({ ok: true });
    const data = await getBudgetMonth(a, MAY);
    expect(data.rows.find((r) => r.category_id === food)!.allocated_sen).toBe(80_000);
    expect(data.rows.find((r) => r.category_id === oldStuff)!.allocated_sen).toBe(16_000);
    const logs = await logsFor(MAY);
    expect(logs).toHaveLength(6);
    expect(logs.some((l) => l.category_id === food && l.from_sen === 90_000 && l.to_sen === 80_000)).toBe(true);
    expect(logs.some((l) => l.category_id === oldStuff && l.from_sen === 6_000 && l.to_sen === 16_000)).toBe(true);
  });

  it("overdraw surfaces the DB error and changes nothing", async () => {
    const result = await performMoveAllocation(a, MAY, oldStuff, food, 999_999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    const data = await getBudgetMonth(a, MAY);
    expect(data.rows.find((r) => r.category_id === food)!.allocated_sen).toBe(80_000);
    expect(data.rows.find((r) => r.category_id === oldStuff)!.allocated_sen).toBe(16_000);
    expect(await logsFor(MAY)).toHaveLength(6); // no half-logged move
  });
});

describe("performUpdateBenchmark", () => {
  it("writes needs/wants; savings is derived", async () => {
    const result = await performUpdateBenchmark(a, 60, 25);
    expect(result).toEqual({ ok: true });
    const data = await getBudgetMonth(a, MAY);
    expect(data.benchmark).toEqual({ needs_pct: 60, wants_pct: 25, savings_pct: 15 });
  });

  it("rejects a split summing past 100", async () => {
    const result = await performUpdateBenchmark(a, 70, 40);
    expect(result.ok).toBe(false);
  });
});

describe("performUpdateCategoryTag", () => {
  it("re-tags an expense category", async () => {
    const result = await performUpdateCategoryTag(a, fun, "needs");
    expect(result).toEqual({ ok: true });
    const { data } = await a.from("categories").select("tag").eq("id", fun).single();
    expect(data!.tag).toBe("needs");
  });

  it("rejects income categories", async () => {
    const result = await performUpdateCategoryTag(a, salary, "needs");
    expect(result.ok).toBe(false);
  });
});

describe("RLS isolation", () => {
  it("user B sees an unplanned, empty month", async () => {
    const data = await getBudgetMonth(b, MAY);
    expect(data.planned).toBe(false);
    expect(data.rows).toHaveLength(0);
    expect(data.unbudgeted).toHaveLength(0);
    expect(data.totals).toEqual({ allocated_sen: 0, spent_sen: 0, income_sen: 0, expense_sen: 0, fund_spend_sen: 0 });
    expect(data.savings.funds).toEqual([]); // A's funds are not B's
    expect(await getBudgetGlance(b, MAY)).toBeNull();
  });
});
