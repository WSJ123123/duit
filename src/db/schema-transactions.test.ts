import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { makeTestUsers } from "@/db/test-clients";

let a: SupabaseClient, b: SupabaseClient;
let acctId: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  const { data } = await a.from("accounts")
    .insert({ name: "TnG", type: "ewallet" }).select().single();
  acctId = data!.id;
}, 30_000);

describe("transactions schema", () => {
  it("accepts a client-generated UUID and is idempotent on retry", async () => {
    const id = randomUUID();
    const row = { id, type: "expense", amount_sen: 1250, account_id: acctId };
    const first = await a.from("transactions").insert(row);
    expect(first.error).toBeNull();
    const retry = await a.from("transactions").insert(row); // duplicate pk
    expect(retry.error!.code).toBe("23505"); // caller treats as success
  });

  it("rejects transfer without destination and expense with one", async () => {
    const noDest = await a.from("transactions")
      .insert({ type: "transfer", amount_sen: 100, account_id: acctId });
    expect(noDest.error).not.toBeNull();
    const badDest = await a.from("transactions")
      .insert({ type: "expense", amount_sen: 100, account_id: acctId, transfer_account_id: acctId });
    expect(badDest.error).not.toBeNull();
  });

  it("rejects expected_back greater than amount", async () => {
    const { error } = await a.from("transactions")
      .insert({ type: "expense", amount_sen: 100, account_id: acctId, expected_back_sen: 200 });
    expect(error).not.toBeNull();
  });

  it("RLS: B sees nothing, cannot attach to A's transaction", async () => {
    const { data } = await b.from("transactions").select();
    expect(data).toEqual([]);
    const { data: aTx } = await a.from("transactions").select().limit(1).single();
    const { error } = await b.from("reimbursement_payments")
      .insert({ transaction_id: aTx!.id, account_id: acctId, amount_sen: 10 });
    expect(error).not.toBeNull();
  });
});
