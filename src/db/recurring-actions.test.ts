import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import {
  performCreateRule,
  performUpdateRule,
  performSetActive,
} from "@/db/recurring";
import type { RecurringRuleValue } from "@/lib/recurring-form";

let a: SupabaseClient, b: SupabaseClient;
let acctId: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  const { data, error } = await a
    .from("accounts")
    .insert({ name: "Maybank", type: "bank" })
    .select()
    .single();
  if (error) throw error;
  acctId = data!.id;
}, 30_000);

const baseRule = (over: Partial<RecurringRuleValue> = {}): RecurringRuleValue => ({
  name: "Rent",
  type: "expense",
  amount_sen: 150_000,
  variable: false,
  account_id: acctId,
  transfer_account_id: null,
  category_id: null,
  freq: "monthly",
  day_of_month: 1,
  weekday: null,
  month_of_year: null,
  ...over,
});

describe("performCreateRule", () => {
  it("sets next_run to the first occurrence strictly after the passed today", async () => {
    const result = await performCreateRule(a, baseRule(), "2026-08-15");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data } = await a.from("recurring_rules").select("next_run, active").eq("id", result.id).single();
    expect(data!.next_run).toBe("2026-09-01");
    expect(data!.next_run > "2026-08-15").toBe(true);
    expect(data!.active).toBe(true);
  });

  it("today exactly on the target day still advances strictly past it", async () => {
    const result = await performCreateRule(a, baseRule({ day_of_month: 15 }), "2026-08-15");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data } = await a.from("recurring_rules").select("next_run").eq("id", result.id).single();
    expect(data!.next_run).toBe("2026-09-15");
  });
});

describe("performUpdateRule", () => {
  // nextRunAfter's monthly/yearly branches always land in the *following*
  // period (they don't compare against `after`'s day-of-month — see
  // src/lib/recurring.ts), so day 20 with "today" = Aug 15 resolves to
  // Sep 20, not Aug 20. This matches its use in materializeDueRules, where
  // `after` is always a prior fire date, not an arbitrary "today".
  it("re-derives next_run from the (possibly new) cadence", async () => {
    const created = await performCreateRule(a, baseRule({ day_of_month: 1 }), "2026-08-15");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await performUpdateRule(
      a,
      created.id,
      baseRule({ name: "Rent (revised)", day_of_month: 20 }),
      "2026-08-15",
    );
    expect(updated).toEqual({ ok: true, id: created.id });

    const { data } = await a
      .from("recurring_rules")
      .select("name, day_of_month, next_run")
      .eq("id", created.id)
      .single();
    expect(data!.name).toBe("Rent (revised)");
    expect(data!.day_of_month).toBe(20);
    expect(data!.next_run).toBe("2026-09-20");
  });
});

describe("performSetActive (archive / unarchive)", () => {
  it("archive flips active to false; unarchive flips it back", async () => {
    const created = await performCreateRule(a, baseRule(), "2026-08-15");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const archived = await performSetActive(a, created.id, false);
    expect(archived).toEqual({});
    const { data: afterArchive } = await a
      .from("recurring_rules")
      .select("active")
      .eq("id", created.id)
      .single();
    expect(afterArchive!.active).toBe(false);

    const unarchived = await performSetActive(a, created.id, true);
    expect(unarchived).toEqual({});
    const { data: afterUnarchive } = await a
      .from("recurring_rules")
      .select("active")
      .eq("id", created.id)
      .single();
    expect(afterUnarchive!.active).toBe(true);
  });
});

/**
 * Plan 9 Q26: the symmetric half of Plan 8 ruling 2. Archiving an account is
 * refused while an ACTIVE rule uses it, so the only way a rule and an
 * archived account meet is an INACTIVE rule whose account was archived later
 * — and re-activating it must refuse, naming both, until it is re-pointed.
 */
describe("performSetActive(true) refuses while a leg's account is archived (Plan 9 Q26)", () => {
  const archiveAccount = async (id: string) => {
    const { error } = await a.from("accounts").update({ archived: true }).eq("id", id);
    if (error) throw error;
  };
  const activeOf = async (id: string) => (await a.from("recurring_rules").select("active").eq("id", id).single()).data!.active;

  it("names the rule and the archived account; the rule stays inactive; re-pointed, it re-activates", async () => {
    const old = (await a.from("accounts").insert({ name: "Old AmBank", type: "bank" }).select().single()).data!.id;
    const created = await performCreateRule(a, baseRule({ account_id: old }), "2026-08-15");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await performSetActive(a, created.id, false)).toEqual({});
    await archiveAccount(old);

    expect(await performSetActive(a, created.id, true)).toEqual({
      error: "Can't reactivate Rent — Old AmBank is archived. Re-point the rule first.",
    });
    expect(await activeOf(created.id)).toBe(false);

    // Deactivating (or leaving it off) is never blocked by the account.
    expect(await performSetActive(a, created.id, false)).toEqual({});
    // Re-pointed at a live account, the same call succeeds.
    const moved = await performUpdateRule(a, created.id, baseRule({ account_id: acctId }), "2026-08-15");
    expect(moved.ok).toBe(true);
    expect(await performSetActive(a, created.id, true)).toEqual({});
    expect(await activeOf(created.id)).toBe(true);
  });

  it("checks the transfer leg too, and names both when both are archived", async () => {
    const from = (await a.from("accounts").insert({ name: "Old From", type: "bank" }).select().single()).data!.id;
    const to = (await a.from("accounts").insert({ name: "Old TnG", type: "ewallet" }).select().single()).data!.id;
    const created = await performCreateRule(
      a,
      baseRule({ name: "Top-up", type: "transfer", account_id: acctId, transfer_account_id: to, category_id: null }),
      "2026-08-15",
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await performSetActive(a, created.id, false)).toEqual({});
    await archiveAccount(to);
    expect(await performSetActive(a, created.id, true)).toEqual({
      error: "Can't reactivate Top-up — Old TnG is archived. Re-point the rule first.",
    });
    const both = await performUpdateRule(
      a,
      created.id,
      baseRule({ name: "Top-up", type: "transfer", account_id: from, transfer_account_id: to, category_id: null }),
      "2026-08-15",
    );
    expect(both.ok).toBe(true);
    await archiveAccount(from);
    expect(await performSetActive(a, created.id, true)).toEqual({
      error: "Can't reactivate Top-up — Old From and Old TnG are archived. Re-point the rule first.",
    });
    expect(await activeOf(created.id)).toBe(false);
  });
});

describe("RLS isolation", () => {
  it("user B sees none of user A's recurring rules", async () => {
    const created = await performCreateRule(a, baseRule(), "2026-08-15");
    expect(created.ok).toBe(true);

    const { data } = await b.from("recurring_rules").select();
    expect(data).toEqual([]);
  });
});
