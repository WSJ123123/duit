import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getMonthTransactions, getMonthSplitsAndPayments } from "@/db/queries";
import { getOpenReimbursements } from "@/lib/reimbursements";
import { netExpenseSen, spendByCategory } from "@/lib/stats";

/**
 * Plan 9 ruling 10 (a) and (b): the Transactions page's split and
 * reimbursement-payment reads, and `getOpenReimbursements`, against 1,200
 * rows in ONE month for ONE user. PostgREST truncates an unbounded select at
 * 1000 rows with HTTP 200 and no flag (finding #19), so an unbounded read
 * here silently loses 200 splits, 200 payments and 200 open reimbursements
 * — the ruling-14 discipline: this ran RED against the whole-table reads
 * first (the failure is recorded in PROGRESS.md, Session 16, Task 5).
 *
 * Fixture (2077 dates): 1,200 expenses of RM 3.00 dated 2077-07-10, each
 * with RM 1.00 expected back, ONE split (the whole RM 3.00 on `cat`) and ONE
 * RM 0.50 payment; plus one identical row dated 2077-08-10 so the month
 * bound is visible.
 */
const N = 1200;
const START = "2077-07-01";
const END = "2077-08-01";

let c: SupabaseClient;
let cat: string;
let augustId: string;

beforeAll(async () => {
  ({ a: c } = await makeTestUsers());
  const acct = await c.from("accounts").insert({ name: "TxPage bank", type: "bank" }).select().single();
  if (acct.error) throw acct.error;
  const category = await c.from("categories").insert({ name: "TxPage cat", kind: "expense" }).select().single();
  if (category.error) throw category.error;
  cat = category.data.id;
  const row = (date: string) => ({
    type: "expense",
    amount_sen: 300,
    expected_back_sen: 100,
    account_id: acct.data.id,
    date,
    note: "txpage row",
  });
  const tx = await c
    .from("transactions")
    .insert([...Array.from({ length: N }, () => row("2077-07-10")), row("2077-08-10")])
    .select("id, date");
  if (tx.error) throw tx.error;
  augustId = tx.data.find((t) => t.date === "2077-08-10")!.id;
  const splits = await c
    .from("transaction_splits")
    .insert(tx.data.map((t) => ({ transaction_id: t.id, category_id: cat, amount_sen: 300 })));
  if (splits.error) throw splits.error;
  const payments = await c
    .from("reimbursement_payments")
    .insert(tx.data.map((t) => ({ transaction_id: t.id, account_id: acct.data.id, amount_sen: 50 })));
  if (payments.error) throw payments.error;
}, 120_000);

describe("getMonthSplitsAndPayments — bounded by the month, every row seen (ruling 10a)", () => {
  it("returns all 1,200 splits and 1,200 payments of the month, and none of the next month's", async () => {
    const { splits, payments } = await getMonthSplitsAndPayments(c, { start: START, end: END });
    expect(splits).toHaveLength(N); // a truncated read says 1000
    expect(payments).toHaveLength(N);
    expect(splits.some((s) => s.transaction_id === augustId)).toBe(false);
    expect(payments.some((p) => p.transaction_id === augustId)).toBe(false);
    expect(payments.reduce((sum, p) => sum + p.amount_sen, 0)).toBe(N * 50);
  });

  it("the page's totals off these reads match the fixture exactly", async () => {
    const [rows, { splits, payments }] = await Promise.all([
      getMonthTransactions(c, { start: START, end: END }),
      getMonthSplitsAndPayments(c, { start: START, end: END }),
    ]);
    expect(rows).toHaveLength(N);
    // Spent: 1,200 × (300 − 100) net; the split carries it all onto `cat`.
    expect(rows.reduce((sum, t) => sum + netExpenseSen(t), 0)).toBe(N * 200);
    expect(spendByCategory(rows, splits)).toEqual(new Map([[cat, N * 200]]));
    const paidByTx = new Map<string, number>();
    for (const p of payments) paidByTx.set(p.transaction_id, (paidByTx.get(p.transaction_id) ?? 0) + p.amount_sen);
    expect(rows.every((t) => paidByTx.get(t.id) === 50)).toBe(true);
  });
});

describe("getOpenReimbursements pages on a total order (ruling 10b)", () => {
  it("lists all 1,201 open rows, each with its payment counted", async () => {
    const open = await getOpenReimbursements(c);
    expect(open).toHaveLength(N + 1); // a truncated read says 1000
    expect(open.every((r) => r.paid_sen === 50 && r.owed_sen === 50)).toBe(true);
    expect(open[0]!.transaction_id).toBe(augustId); // newest first
  });
});
