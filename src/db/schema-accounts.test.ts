import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";

let a: SupabaseClient, b: SupabaseClient;
beforeAll(async () => ({ a, b } = await makeTestUsers()), 30_000);

describe("accounts + categories schema", () => {
  it("creates and reads own account", async () => {
    const { data, error } = await a
      .from("accounts")
      .insert({ name: "Maybank", type: "bank", starting_balance_sen: 100_000 })
      .select()
      .single();
    expect(error).toBeNull();
    expect(data!.starting_balance_sen).toBe(100_000);
  });

  it("user B cannot see user A's accounts (RLS)", async () => {
    const { data } = await b.from("accounts").select();
    expect(data).toEqual([]);
  });

  it("user B cannot insert rows for user A (RLS)", async () => {
    const { data: aAcct } = await a.from("accounts").select().limit(1).single();
    const { error } = await b
      .from("accounts")
      .insert({ name: "evil", type: "bank", user_id: aAcct!.user_id });
    expect(error).not.toBeNull();
  });

  it("seed_default_categories is idempotent and scoped", async () => {
    await a.rpc("seed_default_categories");
    await a.rpc("seed_default_categories"); // second call: no dupes
    const { data: cats } = await a.from("categories").select();
    const food = cats!.filter((c) => c.name === "Food");
    expect(food).toHaveLength(1);
    expect(cats!.some((c) => c.name === "Eating out")).toBe(true);
    const { data: bCats } = await b.from("categories").select();
    expect(bCats).toEqual([]); // B unaffected
  });

  it("rejects bad account type", async () => {
    const { error } = await a.from("accounts").insert({ name: "x", type: "wallet" });
    expect(error).not.toBeNull();
  });
});
