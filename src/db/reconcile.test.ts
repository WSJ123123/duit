import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { performReconcile } from "@/lib/reconcile";

let a: SupabaseClient;
let acctId: string;
let catId: string;

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  const { data: acct, error: acctErr } = await a
    .from("accounts")
    .insert({ name: "Maybank", type: "bank", starting_balance_sen: 20_000 })
    .select()
    .single();
  if (acctErr) throw acctErr;
  acctId = acct!.id;

  // Exercise the view math: 20_000 + 5_000 - 250 = 24_750.
  const { error: txErr } = await a.from("transactions").insert([
    { type: "income", amount_sen: 5_000, account_id: acctId, note: "salary" },
    { type: "expense", amount_sen: 250, account_id: acctId, note: "coffee" },
  ]);
  if (txErr) throw txErr;

  const { data: cat, error: catErr } = await a
    .from("categories")
    .insert({ name: "Interest", kind: "income" })
    .select()
    .single();
  if (catErr) throw catErr;
  catId = cat!.id;
}, 30_000);

describe("account reconciliation via adjustment transactions", () => {
  it("reconciling 24_750 to '248.64' inserts an income adjustment of 114", async () => {
    const result = await performReconcile(a, acctId, "248.64", catId);
    expect(result).toEqual({ ok: true });

    const { data, error } = await a
      .from("transactions")
      .select("type, amount_sen, account_id, category_id, source, note")
      .eq("source", "reconcile");
    if (error) throw error;
    expect(data).toEqual([
      {
        type: "income",
        amount_sen: 114,
        account_id: acctId,
        category_id: catId,
        source: "reconcile",
        note: "Reconciled to RM 248.64",
      },
    ]);
  });

  it("the balances view now yields the stated balance 24_864", async () => {
    const { data, error } = await a
      .from("account_balances")
      .select("balance_sen")
      .eq("account_id", acctId)
      .single();
    if (error) throw error;
    expect(Number(data!.balance_sen)).toBe(24_864);
  });

  it("reconciling again to the same balance inserts nothing", async () => {
    const result = await performReconcile(a, acctId, "248.64", catId);
    expect(result).toEqual({ ok: true });

    const { count, error } = await a
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("source", "reconcile");
    if (error) throw error;
    expect(count).toBe(1);
  });
});
