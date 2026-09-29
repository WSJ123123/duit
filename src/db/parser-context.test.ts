import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers, adminClient } from "@/db/test-clients";
import { loadParserContext } from "@/db/parser-context";

let a: SupabaseClient, b: SupabaseClient;
let aId: string;
let aActiveAcct: string, aArchivedAcct: string;
let bActiveAcct: string;
let aActiveCat: string, aArchivedCat: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  aId = (await a.auth.getUser()).data.user!.id;

  aActiveAcct = (await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single())
    .data!.id;
  aArchivedAcct = (
    await a.from("accounts").insert({ name: "Old CIMB", type: "bank" }).select().single()
  ).data!.id;
  await a.from("accounts").update({ archived: true }).eq("id", aArchivedAcct);
  // Task 5 (ruling 7): non-MYR accounts never enter the parser vocabulary —
  // quick entries are income/expense and those accounts take neither.
  const fErr = (
    await a.from("accounts").insert({ name: "Zq Broker", type: "brokerage", currency: "ZQC" })
  ).error;
  if (fErr) throw fErr;

  bActiveAcct = (await b.from("accounts").insert({ name: "B bank", type: "bank" }).select().single())
    .data!.id;

  await a.rpc("seed_default_categories");
  const aCats = (await a.from("categories").select("id, name")).data!;
  aActiveCat = aCats.find((c: { name: string }) => c.name === "Groceries")!.id;
  aArchivedCat = aCats.find((c: { name: string }) => c.name === "Food")!.id;
  await a.from("categories").update({ archived: true }).eq("id", aArchivedCat);

  await b.rpc("seed_default_categories");

  await a.from("parser_aliases").insert({ phrase: "mamak", category_id: aActiveCat });
  await b.from("parser_aliases").insert({ phrase: "evil-phrase" });

  await a.from("user_settings").upsert(
    { default_account_id: aActiveAcct },
    { onConflict: "user_id" },
  );
}, 30_000);

describe("loadParserContext", () => {
  it("via the RLS session client: A's unarchived accounts/categories, aliases, default account", async () => {
    const ctx = await loadParserContext(a, aId);

    expect(ctx.accounts.map((x) => x.id).sort()).toEqual([aActiveAcct].sort());
    expect(ctx.accounts.every((x) => "name" in x)).toBe(true);
    expect(ctx.accounts.some((x) => x.id === aArchivedAcct)).toBe(false);

    expect(ctx.categories.some((x) => x.id === aActiveCat)).toBe(true);
    expect(ctx.categories.some((x) => x.id === aArchivedCat)).toBe(false);
    expect(ctx.categories.every((x) => "kind" in x)).toBe(true);

    expect(ctx.aliases).toEqual([{ phrase: "mamak", category_id: aActiveCat, account_id: null }]);
    expect(ctx.default_account_id).toBe(aActiveAcct);
  });

  it("via the admin (service-role) client: identical result, still scoped to A only", async () => {
    const sessionCtx = await loadParserContext(a, aId);
    const adminCtx = await loadParserContext(adminClient(), aId);
    expect(adminCtx).toEqual(sessionCtx);

    // Nothing of B's leaked in.
    expect(adminCtx.accounts.some((x) => x.id === bActiveAcct)).toBe(false);
    expect(adminCtx.aliases.some((al) => al.phrase === "evil-phrase")).toBe(false);
  });

  it("returns null default_account_id when the user has no user_settings row", async () => {
    const bId = (await b.auth.getUser()).data.user!.id;
    const ctx = await loadParserContext(b, bId);
    expect(ctx.default_account_id).toBeNull();
  });
});
