import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getMonthTransactions } from "@/db/queries";

/**
 * Finding #19 on the Transactions page: its "This month" card is summed from
 * the month's list, so the list must see EVERY row past PostgREST's silent
 * 1000-row cap. 2077 fixture dates.
 */
let a: SupabaseClient;

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  const acct = (await a.from("accounts").insert({ name: "Month paging bank", type: "bank" }).select().single()).data!.id;
  const rows = Array.from({ length: 1100 }, (_, i) => ({
    type: "expense",
    amount_sen: i + 1,
    account_id: acct,
    date: `2077-05-${String((i % 28) + 1).padStart(2, "0")}`,
    note: i < 3 ? "needle row" : "month filler",
  }));
  const seed = await a.from("transactions").insert(rows);
  if (seed.error) throw seed.error;
  // Either side of the half-open range: never in the month.
  const outside = await a.from("transactions").insert([
    { type: "expense", amount_sen: 9_999_999, account_id: acct, date: "2077-04-30", note: "april" },
    { type: "expense", amount_sen: 9_999_999, account_id: acct, date: "2077-06-01", note: "june" },
  ]);
  if (outside.error) throw outside.error;
}, 60_000);

describe("getMonthTransactions", () => {
  it("returns every row of a month past the 1000-row cap, each once, newest first", async () => {
    const rows = await getMonthTransactions(a, { start: "2077-05-01", end: "2077-06-01" });
    expect(rows).toHaveLength(1100);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1100);
    expect(rows.reduce((sum, r) => sum + r.amount_sen, 0)).toBe((1100 * 1101) / 2);
    const dates = rows.map((r) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
  }, 60_000);

  it("narrows by note", async () => {
    const rows = await getMonthTransactions(a, { start: "2077-05-01", end: "2077-06-01", q: "needle" });
    expect(rows.map((r) => r.amount_sen).sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });
});
