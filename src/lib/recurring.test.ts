import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { materializeDueRules, nextRunAfter } from "@/lib/recurring";

describe("nextRunAfter", () => {
  it("monthly day 31 clamps to month end, then un-clamps", () => {
    const rule = {
      freq: "monthly" as const,
      day_of_month: 31,
      weekday: null,
      month_of_year: null,
    };
    expect(nextRunAfter(rule, "2026-08-31")).toBe("2026-09-30");
    expect(nextRunAfter(rule, "2026-09-30")).toBe("2026-10-31");
  });

  it("monthly day 1 goes to the 1st of the next month", () => {
    const rule = {
      freq: "monthly" as const,
      day_of_month: 1,
      weekday: null,
      month_of_year: null,
    };
    expect(nextRunAfter(rule, "2026-07-01")).toBe("2026-08-01");
    expect(nextRunAfter(rule, "2026-12-01")).toBe("2027-01-01");
  });

  it("weekly Monday from a Saturday is the strictly next Monday", () => {
    const rule = {
      freq: "weekly" as const,
      day_of_month: null,
      weekday: 1,
      month_of_year: null,
    };
    expect(nextRunAfter(rule, "2026-08-15")).toBe("2026-08-17");
  });

  it("yearly Feb 29 clamps to Feb 28 in non-leap years", () => {
    const rule = {
      freq: "yearly" as const,
      day_of_month: 29,
      weekday: null,
      month_of_year: 2,
    };
    expect(nextRunAfter(rule, "2026-02-28")).toBe("2027-02-28");
  });
});

/**
 * Ruling 16's guard fails CLOSED: an account id the currency select did not
 * resolve is not MYR either, so the rule is skipped rather than materialized
 * blind. This is pinned against a stub client, not the local database, on
 * purpose — `recurring_rules.account_id` carries an FK and accounts are
 * archived rather than hard-deleted, so the state cannot be reached through
 * the real DB at all. The property is still worth holding: it is the
 * difference between skipping an unknown account and writing MYR sen into it.
 */
function stubAdmin(rules: unknown[], accounts: unknown[]) {
  const calls = { inserts: 0, updates: 0 };
  const query = (data: unknown) => {
    const q = {
      eq: () => q,
      lte: () => q,
      in: () => q,
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data, error: null }).then(resolve),
    };
    return q;
  };
  const admin = {
    from: (table: string) => ({
      select: () => query(table === "recurring_rules" ? rules : accounts),
      insert: () => {
        calls.inserts++;
        return Promise.resolve({ error: null });
      },
      update: () => {
        calls.updates++;
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

const dueRule = (id: string, accountId: string, transferAccountId: string | null) => ({
  id,
  user_id: "u1",
  type: transferAccountId === null ? "expense" : "transfer",
  amount_sen: 30_000,
  variable: false,
  account_id: accountId,
  transfer_account_id: transferAccountId,
  category_id: null,
  freq: "monthly",
  day_of_month: 1,
  weekday: null,
  month_of_year: null,
  next_run: "2026-08-01",
});

describe("materializeDueRules — ruling 16 fails closed on an unresolved account", () => {
  it("skips the rule on either leg, inserts nothing, advances nothing", async () => {
    const { admin, calls } = stubAdmin(
      [
        dueRule("rule-1", "ghost-source", null),
        dueRule("rule-2", "bank-myr", "ghost-destination"),
      ],
      [{ id: "bank-myr", currency: "MYR" }], // neither ghost id resolves
    );

    const { inserted, skipped } = await materializeDueRules(admin, "2026-08-15");

    expect(inserted).toBe(0);
    expect(calls.inserts).toBe(0);
    expect(calls.updates).toBe(0); // next_run advanced for nothing
    // wording matches blockReason in src/lib/bills.ts, per leg
    expect(skipped).toEqual([
      "rule-1: its account no longer exists",
      "rule-2: its destination account no longer exists",
    ]);
  });
});
