import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { performArchiveAccount } from "@/db/accounts";

/**
 * Plan 8 ruling 2: an account with an ACTIVE recurring rule on either leg
 * cannot be archived — the refusal names the rules, in the Recurring settings
 * page's order (by name), so the owner can find and deactivate or re-point
 * them. An account whose only rules are inactive archives normally.
 *
 * 2077 fixture dates (house convention): the rules stay undue for the global
 * materializer. performSetAccountCurrency's tests live in
 * src/db/fx-transfers.test.ts and stay there.
 */

let a: SupabaseClient;
let b: SupabaseClient;
let ruled: string; // source leg of two active rules
let dest: string; // destination leg of one of them
let quiet: string; // one INACTIVE rule only

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  const mk = async (name: string) => {
    const res = await a.from("accounts").insert({ name, type: "bank" }).select("id").single();
    if (res.error) throw res.error;
    return res.data.id as string;
  };
  ruled = await mk("Ruled bank");
  dest = await mk("TnG");
  quiet = await mk("Quiet bank");

  // Same keys on every row (a missing key arrives as null). Inserted OUT of
  // name order on purpose: the message follows the settings page's order,
  // not insertion order.
  const rules = await a.from("recurring_rules").insert([
    { name: "TnG top-up", type: "transfer", amount_sen: 10_000, account_id: ruled, transfer_account_id: dest, freq: "monthly", day_of_month: 1, next_run: "2077-10-01", active: true },
    { name: "Rent", type: "expense", amount_sen: 150_000, account_id: ruled, transfer_account_id: null, freq: "monthly", day_of_month: 1, next_run: "2077-10-01", active: true },
    { name: "Old gym", type: "expense", amount_sen: 9_900, account_id: quiet, transfer_account_id: null, freq: "monthly", day_of_month: 5, next_run: "2077-10-05", active: false },
  ]);
  if (rules.error) throw rules.error;
}, 30_000);

describe("performArchiveAccount — Plan 8 ruling 2", () => {
  it("refuses while active rules use the account, naming them in settings order", async () => {
    const res = await performArchiveAccount(a, ruled);
    expect(res).toEqual({
      ok: false,
      error: "Archive blocked: 2 active rules use this account — Rent, TnG top-up. Deactivate or re-point them first.",
    });
    const row = await a.from("accounts").select("archived").eq("id", ruled).single();
    expect(row.data!.archived).toBe(false);
  });

  it("counts the TRANSFER leg too, with the singular wording", async () => {
    const res = await performArchiveAccount(a, dest);
    expect(res).toEqual({
      ok: false,
      error: "Archive blocked: 1 active rule uses this account — TnG top-up. Deactivate or re-point it first.",
    });
    const row = await a.from("accounts").select("archived").eq("id", dest).single();
    expect(row.data!.archived).toBe(false);
  });

  it("archives normally when the account's only rule is inactive", async () => {
    expect(await performArchiveAccount(a, quiet)).toEqual({ ok: true });
    const row = await a.from("accounts").select("archived").eq("id", quiet).single();
    expect(row.data!.archived).toBe(true);
  });

  it("archives normally once the blocking rules are deactivated", async () => {
    const off = await a.from("recurring_rules").update({ active: false }).eq("account_id", ruled);
    if (off.error) throw off.error;
    expect(await performArchiveAccount(a, ruled)).toEqual({ ok: true });
    const row = await a.from("accounts").select("archived").eq("id", ruled).single();
    expect(row.data!.archived).toBe(true);
  });

  it("RLS: another user's account is not found, never archived", async () => {
    expect(await performArchiveAccount(b, dest)).toEqual({ ok: false, error: "account not found" });
    const row = await a.from("accounts").select("archived").eq("id", dest).single();
    expect(row.data!.archived).toBe(false);
  });

  it("rejects a malformed id before any query", async () => {
    const res = await performArchiveAccount(a, "not-a-uuid");
    expect(res.ok).toBe(false);
  });
});
