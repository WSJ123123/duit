import { describe, it, expect } from "vitest";
import {
  spendByCategory,
  incomeVsExpense,
  todayTotal,
  netExpenseSen,
  type TxLike,
  type SplitLike,
} from "@/lib/stats";

function tx(overrides: Partial<TxLike> & { id: string }): TxLike {
  return {
    type: "expense",
    amount_sen: 1_000,
    expected_back_sen: 0,
    category_id: null,
    date: "2026-08-15",
    ...overrides,
  };
}

describe("spendByCategory", () => {
  it("nets a split expense proportionally with integer-sen exactness (RM300 dinner)", () => {
    // 30000 sen, 24000 expected back → net 6000; splits 10000/20000 → 2000/4000
    const rows = [tx({ id: "dinner", amount_sen: 30_000, expected_back_sen: 24_000, category_id: "parent-cat" })];
    const splits: SplitLike[] = [
      { transaction_id: "dinner", category_id: "food", amount_sen: 10_000 },
      { transaction_id: "dinner", category_id: "drinks", amount_sen: 20_000 },
    ];
    const m = spendByCategory(rows, splits);
    expect(m.get("food")).toBe(2_000);
    expect(m.get("drinks")).toBe(4_000);
    // splits REPLACE the parent's category attribution
    expect(m.has("parent-cat")).toBe(false);
    // per-tx sum is EXACTLY amount − expected_back
    expect(m.get("food")! + m.get("drinks")!).toBe(6_000);
  });

  it("odd netting: last split absorbs the integer remainder (67 → 33/34)", () => {
    const rows = [tx({ id: "odd", amount_sen: 100, expected_back_sen: 33 })];
    const splits: SplitLike[] = [
      { transaction_id: "odd", category_id: "a", amount_sen: 50 },
      { transaction_id: "odd", category_id: "b", amount_sen: 50 },
    ];
    const m = spendByCategory(rows, splits);
    expect(m.get("a")).toBe(33); // floor(50 * 67 / 100)
    expect(m.get("b")).toBe(34); // 67 - 33: remainder absorbed by the last split
    expect(m.get("a")! + m.get("b")!).toBe(67);
  });

  it("excludes transfers and income entirely", () => {
    const rows = [
      tx({ id: "t", type: "transfer", amount_sen: 50_000 }),
      tx({ id: "i", type: "income", amount_sen: 620_000, category_id: "salary" }),
      tx({ id: "e", type: "expense", amount_sen: 1_000, category_id: "food" }),
    ];
    const m = spendByCategory(rows, []);
    expect([...m.keys()]).toEqual(["food"]);
    expect(m.get("food")).toBe(1_000);
  });

  it("attributes a split-less expense to its own category_id, preserving the null bucket", () => {
    const rows = [
      tx({ id: "e1", amount_sen: 1_200, category_id: "food" }),
      tx({ id: "e2", amount_sen: 800, category_id: "food" }),
      tx({ id: "e3", amount_sen: 700, category_id: null }),
    ];
    const m = spendByCategory(rows, []);
    expect(m.get("food")).toBe(2_000);
    expect(m.get(null)).toBe(700);
  });

  it("nets a split-less expense with expected_back under its own category", () => {
    const rows = [tx({ id: "e1", amount_sen: 30_000, expected_back_sen: 24_000, category_id: "food" })];
    const m = spendByCategory(rows, []);
    expect(m.get("food")).toBe(6_000);
  });

  it("ignores splits belonging to other (non-listed) transactions", () => {
    const rows = [tx({ id: "e1", amount_sen: 1_000, category_id: "food" })];
    const splits: SplitLike[] = [{ transaction_id: "other", category_id: "x", amount_sen: 999 }];
    const m = spendByCategory(rows, splits);
    expect(m.get("food")).toBe(1_000);
    expect(m.has("x")).toBe(false);
  });
});

describe("incomeVsExpense", () => {
  it("sums per month in the given order, netting expenses and excluding transfers", () => {
    const rows = [
      tx({ id: "jan-i", type: "income", amount_sen: 500_000, date: "2026-01-31" }),
      tx({ id: "jan-e", type: "expense", amount_sen: 8_700, date: "2026-01-05" }),
      tx({ id: "feb-e1", type: "expense", amount_sen: 30_000, expected_back_sen: 24_000, date: "2026-02-14" }),
      tx({ id: "feb-e2", type: "expense", amount_sen: 1_250, date: "2026-02-20" }),
      tx({ id: "feb-t", type: "transfer", amount_sen: 99_999, date: "2026-02-20" }),
      tx({ id: "mar-i", type: "income", amount_sen: 620_000, date: "2026-03-01" }),
      tx({ id: "apr-e", type: "expense", amount_sen: 5_000, date: "2026-04-01" }), // outside window
    ];
    const out = incomeVsExpense(rows, ["2026-01", "2026-02", "2026-03"]);
    expect(out).toEqual([
      { month: "2026-01", income_sen: 500_000, expense_sen: 8_700 },
      { month: "2026-02", income_sen: 0, expense_sen: 7_250 }, // 6000 net + 1250
      { month: "2026-03", income_sen: 620_000, expense_sen: 0 },
    ]);
  });
});

describe("todayTotal", () => {
  it("counts only todayIso's expense rows, netted; transfers/income excluded", () => {
    const rows = [
      tx({ id: "e1", amount_sen: 30_000, expected_back_sen: 24_000, date: "2026-08-15" }),
      tx({ id: "e2", amount_sen: 1_250, date: "2026-08-15" }),
      tx({ id: "i1", type: "income", amount_sen: 620_000, date: "2026-08-15" }),
      tx({ id: "t1", type: "transfer", amount_sen: 10_000, date: "2026-08-15" }),
      tx({ id: "e3", amount_sen: 9_999, date: "2026-08-14" }),
    ];
    expect(todayTotal(rows, "2026-08-15")).toBe(7_250);
  });
});

describe("netExpenseSen", () => {
  it("is amount − expected_back for expenses, 0 for income and transfers", () => {
    expect(netExpenseSen(tx({ id: "e", amount_sen: 30_000, expected_back_sen: 24_000 }))).toBe(6_000);
    expect(netExpenseSen(tx({ id: "i", type: "income", amount_sen: 5_000 }))).toBe(0);
    expect(netExpenseSen(tx({ id: "t", type: "transfer", amount_sen: 5_000 }))).toBe(0);
  });
});
