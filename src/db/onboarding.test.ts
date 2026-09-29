import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { performHasShortcutEntry } from "@/db/onboarding";

let a: SupabaseClient, b: SupabaseClient;
let aAccountId: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  aAccountId = (
    await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single()
  ).data!.id;
}, 30_000);

describe("performHasShortcutEntry", () => {
  it("returns false when no shortcut-sourced transaction exists", async () => {
    expect(await performHasShortcutEntry(a)).toBe(false);
  });

  it("returns true once a shortcut-sourced transaction is inserted", async () => {
    const { error } = await a.from("transactions").insert({
      type: "expense",
      amount_sen: 1200,
      account_id: aAccountId,
      source: "shortcut",
    });
    expect(error).toBeNull();
    expect(await performHasShortcutEntry(a)).toBe(true);
  });

  it("ignores non-shortcut sources", async () => {
    const { a: c } = await makeTestUsers();
    const acct = (
      await c.from("accounts").insert({ name: "Cash", type: "cash" }).select().single()
    ).data!.id;
    const { error } = await c.from("transactions").insert({
      type: "expense",
      amount_sen: 500,
      account_id: acct,
      source: "manual",
    });
    expect(error).toBeNull();
    expect(await performHasShortcutEntry(c)).toBe(false);
  });

  it("does not leak across users (RLS)", async () => {
    expect(await performHasShortcutEntry(b)).toBe(false);
  });
});
