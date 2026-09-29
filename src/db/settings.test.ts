import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getImportMappings, getSettings, performUpdateSettings, saveImportMapping } from "@/db/settings";
import type { ImportMapping } from "@/lib/import";

let a: SupabaseClient, b: SupabaseClient;
let aAcct: string, bAcct: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  aAcct = (await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single()).data!.id;
  bAcct = (await b.from("accounts").insert({ name: "B bank", type: "bank" }).select().single()).data!.id;
}, 30_000);

describe("user_settings", () => {
  it("getSettings returns defaults when no row exists", async () => {
    const settings = await getSettings(a);
    expect(settings).toEqual({ show_tips: true, default_account_id: null, onboarded_at: null });
  });

  it("performUpdateSettings upserts and getSettings reads it back", async () => {
    const result = await performUpdateSettings(a, { showTips: false, defaultAccountId: aAcct });
    expect(result).toEqual({ ok: true });

    const settings = await getSettings(a);
    expect(settings.show_tips).toBe(false);
    expect(settings.default_account_id).toBe(aAcct);
    expect(settings.onboarded_at).toBeNull();
  });

  it("B cannot see A's settings row (RLS)", async () => {
    const settings = await getSettings(b);
    // B has no row of their own, so defaults come back — not A's values.
    expect(settings).toEqual({ show_tips: true, default_account_id: null, onboarded_at: null });
  });

  it("B cannot set A's account as default_account_id (composite FK violation)", async () => {
    const result = await performUpdateSettings(b, { defaultAccountId: aAcct });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("23503");
  });

  it("B setting their own account as default succeeds", async () => {
    const result = await performUpdateSettings(b, { defaultAccountId: bAcct });
    expect(result).toEqual({ ok: true });
    const settings = await getSettings(b);
    expect(settings.default_account_id).toBe(bAcct);
  });
});

/**
 * Plan 9 Task 4 / Standing check 3: the demo account's stored Maybank mapping
 * was written under Plan 8's schema — exactly these five keys. Ruling 7 adds
 * `header_line` and `saved_at` as OPTIONAL keys; `getImportMappings` drops an
 * entry that fails zod and `saveImportMapping` persists the drop on the next
 * save, so a schema mistake here would erase the owner's mapping. Pinned on
 * the stored JSON itself, not on the schema alone.
 */
describe("import_mappings — a Plan-8-shaped stored entry still parses (ruling 7, Standing check 3)", () => {
  const plan8 = {
    date_col: 0,
    date_format: "DD/MM/YYYY",
    description_col: 1,
    amount: { kind: "pair", debit_col: 2, credit_col: 3 },
    note_col: null,
  } as const;

  it("reads a stored entry without the new keys to exactly itself, one with them, and drops a negative header_line alone", async () => {
    const stored = {
      [aAcct]: plan8,
      "acct-new": { ...plan8, header_line: 3, saved_at: "2077-09-21T00:00:00.000Z" },
      "acct-bad": { ...plan8, header_line: -1 },
    };
    const up = await a.from("user_settings").upsert({ import_mappings: stored }, { onConflict: "user_id" });
    if (up.error) throw up.error;
    const mappings = await getImportMappings(a);
    expect(mappings[aAcct]).toEqual(plan8);
    expect(mappings["acct-new"]).toEqual({ ...plan8, header_line: 3, saved_at: "2077-09-21T00:00:00.000Z" });
    expect(mappings["acct-bad"]).toBeUndefined();
  });

  it("saveImportMapping keeps header_line, stamps saved_at (ISO), and refuses a negative header_line", async () => {
    const saved = await saveImportMapping(a, aAcct, { ...plan8, header_line: 3 });
    expect(saved).toEqual({ ok: true });
    const after = (await getImportMappings(a))[aAcct]!;
    expect(after).toEqual({ ...plan8, header_line: 3, saved_at: expect.any(String) });
    expect(after.saved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await saveImportMapping(a, aAcct, { ...plan8, header_line: -1 } as ImportMapping)).toEqual({ ok: false, error: "invalid import mapping" });
    expect((await getImportMappings(a))[aAcct]).toEqual(after);
  });
});
