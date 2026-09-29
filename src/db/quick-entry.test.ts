import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers, adminClient } from "@/db/test-clients";
import { performQuickEntry } from "@/lib/quick-entry";

let a: SupabaseClient, b: SupabaseClient;
let aId: string, bId: string;
let tngAcct: string, maybankAcct: string;
let grabCat: string;
let bAcct: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  aId = (await a.auth.getUser()).data.user!.id;
  bId = (await b.auth.getUser()).data.user!.id;

  tngAcct = (
    await a.from("accounts").insert({ name: "TnG eWallet", type: "ewallet" }).select().single()
  ).data!.id;
  maybankAcct = (
    await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single()
  ).data!.id;

  await a.rpc("seed_default_categories");
  const aCats = (await a.from("categories").select("id, name")).data! as Array<{
    id: string;
    name: string;
  }>;
  grabCat = aCats.find((c) => c.name === "Grab")!.id;
  const eatingOutCat = aCats.find((c) => c.name === "Eating out")!.id;

  await a.from("parser_aliases").insert({ phrase: "mamak", category_id: eatingOutCat });
  await a
    .from("user_settings")
    .upsert({ default_account_id: maybankAcct }, { onConflict: "user_id" });

  // User B: one account and one transaction that must survive untouched.
  bAcct = (await b.from("accounts").insert({ name: "B bank", type: "bank" }).select().single())
    .data!.id;
  const { error: bTxErr } = await b.from("transactions").insert({
    type: "expense",
    amount_sen: 500,
    account_id: bAcct,
    date: "2026-08-16",
    note: "b's own entry",
  });
  expect(bTxErr).toBeNull();
}, 30_000);

describe("performQuickEntry", () => {
  it("'grab 18 tng': confident row with parsed account + category, exact message", async () => {
    const result = await performQuickEntry(adminClient(), {
      userId: aId,
      text: "grab 18 tng",
      todayIso: "2026-08-16",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.status).toBe(200);
    expect(result.needs_review).toBe(false);
    expect(result.message).toBe("✓ RM 18.00 · Grab · TnG eWallet");

    const { data: row } = await adminClient()
      .from("transactions")
      .select("*")
      .eq("id", result.transaction_id)
      .single();
    expect(row).toMatchObject({
      user_id: aId,
      type: "expense",
      amount_sen: 1800,
      account_id: tngAcct,
      category_id: grabCat,
      date: "2026-08-16",
      note: "grab 18 tng",
      source: "shortcut",
      needs_review: false,
    });
  });

  it("'blorp 45': unmatched category saved for review on the default account", async () => {
    const result = await performQuickEntry(adminClient(), {
      userId: aId,
      text: "blorp 45",
      todayIso: "2026-08-16",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.needs_review).toBe(true);
    expect(result.message).toBe("Saved for review · RM 45.00");

    const { data: row } = await adminClient()
      .from("transactions")
      .select("*")
      .eq("id", result.transaction_id)
      .single();
    expect(row).toMatchObject({
      user_id: aId,
      amount_sen: 4500,
      account_id: maybankAcct,
      category_id: null,
      source: "shortcut",
      needs_review: true,
    });
  });

  it("'mcd': no parseable amount -> 422 no_amount, nothing inserted", async () => {
    const before = await adminClient()
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", aId);

    const result = await performQuickEntry(adminClient(), {
      userId: aId,
      text: "mcd",
      todayIso: "2026-08-16",
    });
    expect(result).toEqual({ ok: false, status: 422, error: "no_amount" });

    const after = await adminClient()
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", aId);
    expect(after.count).toBe(before.count);
  });

  it("double-fire with the same clientId: exactly one row, same transaction_id", async () => {
    const clientId = randomUUID();
    const args = {
      userId: aId,
      text: "mamak 12",
      clientId,
      todayIso: "2026-08-16",
    };

    const first = await performQuickEntry(adminClient(), args);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.transaction_id).toBe(clientId);
    expect(first.needs_review).toBe(false);
    expect(first.message).toBe("✓ RM 12.00 · Eating out · Maybank");

    const second = await performQuickEntry(adminClient(), args);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.status).toBe(200);
    expect(second.transaction_id).toBe(clientId);
    expect(second.needs_review).toBe(false);
    expect(second.message).toBe("✓ RM 12.00 · Eating out · Maybank");

    const { count } = await adminClient()
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("id", clientId);
    expect(count).toBe(1);
  });

  it("user with no accounts at all -> 422 no_account; first-account fallback is oldest created_at", async () => {
    const admin = adminClient();
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: `test-${randomUUID()}@test.local`,
      password: "test-password-123!",
      email_confirm: true,
    });
    expect(cErr).toBeNull();
    const cId = created!.user!.id;

    const noAccount = await performQuickEntry(admin, {
      userId: cId,
      text: "teh 5",
      todayIso: "2026-08-16",
    });
    expect(noAccount).toEqual({ ok: false, status: 422, error: "no_account" });

    // Two accounts, no user_settings default: fallback picks the OLDEST created_at.
    await admin.from("accounts").insert({
      user_id: cId,
      name: "Newer",
      type: "bank",
      created_at: "2026-01-02T00:00:00Z",
    });
    const { data: older } = await admin
      .from("accounts")
      .insert({
        user_id: cId,
        name: "Older",
        type: "cash",
        created_at: "2026-01-01T00:00:00Z",
      })
      .select()
      .single();

    const result = await performQuickEntry(admin, {
      userId: cId,
      text: "blorp 5",
      todayIso: "2026-08-16",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.needs_review).toBe(true);

    const { data: row } = await admin
      .from("transactions")
      .select("account_id")
      .eq("id", result.transaction_id)
      .single();
    expect(row!.account_id).toBe(older!.id);
  });

  it("ruling 7: an alias pointing at a non-MYR account reroutes to a MYR account for review", async () => {
    // A ZQC brokerage account with an alias phrase aimed straight at it —
    // quick entries are income/expense, which non-MYR accounts never take;
    // the entry must land on a MYR account flagged for review, never dropped
    // and never denominated into the foreign book.
    const zq = await a
      .from("accounts")
      .insert({ name: "Zqx Broker", type: "brokerage", currency: "ZQC" })
      .select()
      .single();
    expect(zq.error).toBeNull();
    const aliasErr = (
      await a.from("parser_aliases").insert({ phrase: "zqxbroker", account_id: zq.data!.id })
    ).error;
    expect(aliasErr).toBeNull();

    const result = await performQuickEntry(adminClient(), {
      userId: aId,
      text: "coffee 12 zqxbroker",
      todayIso: "2026-08-16",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.needs_review).toBe(true);

    const { data: row } = await adminClient()
      .from("transactions")
      .select("account_id, needs_review")
      .eq("id", result.transaction_id)
      .single();
    expect(row!.needs_review).toBe(true);
    expect(row!.account_id).not.toBe(zq.data!.id);
    expect([tngAcct, maybankAcct]).toContain(row!.account_id);
  });

  /**
   * Ruling 7's last clause: the NL parser, /api/quick-entry and the iOS
   * Shortcut NEVER set fund_id. The parser stays deterministic and keyword-
   * free of funds; tagging is a deliberate act on a form. Two ways this
   * could break, both pinned: a fund's NAME appearing in the entry text, and
   * a caller smuggling a fund-shaped field through the payload.
   */
  it("ruling 7: quick entry never tags a fund — not by name, not by payload field", async () => {
    const fund = await a.from("funds").insert({ name: "mamak", kind: "sinking" }).select().single();
    expect(fund.error).toBeNull();

    const args = {
      userId: aId,
      text: "mamak 9 tng", // "mamak" is BOTH an alias phrase and the fund's name
      clientId: randomUUID(),
      todayIso: "2026-08-16",
      // A fund-shaped field on the payload: performQuickEntry builds its row
      // literal and has no fund key, so this must reach nothing.
      fundId: fund.data!.id as string,
    };
    const result = await performQuickEntry(adminClient(), args as unknown as Parameters<typeof performQuickEntry>[1]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const { data: row } = await adminClient()
      .from("transactions")
      .select("fund_id")
      .eq("id", result.transaction_id)
      .single();
    expect(row!.fund_id).toBeNull();
  });

  it("user B's data untouched throughout (service-client discipline)", async () => {
    const admin = adminClient();
    const tx = await admin
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", bId);
    expect(tx.count).toBe(1);
    const accts = await admin
      .from("accounts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", bId);
    expect(accts.count).toBe(1);
  });
});
