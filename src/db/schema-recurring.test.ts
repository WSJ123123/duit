import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";

let a: SupabaseClient, b: SupabaseClient;
let acctId: string;
beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  const { data } = await a.from("accounts")
    .insert({ name: "Maybank", type: "bank" }).select().single();
  acctId = data!.id;
}, 30_000);

it("creates monthly rule; enforces day_of_month", async () => {
  const ok = await a.from("recurring_rules").insert({
    name: "Rent", type: "expense", amount_sen: 150_000, account_id: acctId,
    freq: "monthly", day_of_month: 1, next_run: "2026-09-01",
  });
  expect(ok.error).toBeNull();
  const bad = await a.from("recurring_rules").insert({
    name: "Bad", type: "expense", amount_sen: 100, account_id: acctId,
    freq: "monthly", next_run: "2026-09-01",
  });
  expect(bad.error).not.toBeNull();
});

it("alias unique per user; RLS blind across users", async () => {
  const first = await a.from("parser_aliases").insert({ phrase: "mamak" });
  expect(first.error).toBeNull();
  const dupe = await a.from("parser_aliases").insert({ phrase: "mamak" });
  expect(dupe.error!.code).toBe("23505");
  for (const t of ["recurring_rules", "parser_aliases", "api_tokens"]) {
    const { data } = await b.from(t).select();
    expect(data).toEqual([]);
  }
});
