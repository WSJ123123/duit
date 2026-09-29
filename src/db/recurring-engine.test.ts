import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, makeTestUsers } from "@/db/test-clients";
import { materializeDueRules } from "@/lib/recurring";
import { recordNowTxId } from "@/lib/bills";
import { recordNowNotice } from "@/lib/bills-display";
import { performUpsert } from "@/lib/transactions";

let a: SupabaseClient;
let admin: SupabaseClient;
let acctId: string;
let ruleId: string;

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  admin = adminClient();
  // Drain rules left due by earlier (aborted) runs: materializeDueRules is
  // global across users, so leftovers would inflate this run's counts.
  await materializeDueRules(admin, "2026-08-15");
  const { data } = await a
    .from("accounts")
    .insert({ name: "Maybank", type: "bank" })
    .select()
    .single();
  acctId = data!.id;
  const { data: rule, error } = await a
    .from("recurring_rules")
    .insert({
      name: "Rent",
      type: "expense",
      amount_sen: 150_000,
      account_id: acctId,
      freq: "monthly",
      day_of_month: 1,
      next_run: "2026-07-01",
    })
    .select()
    .single();
  expect(error).toBeNull();
  ruleId = rule!.id;
}, 30_000);

describe("materializeDueRules", () => {
  it("catches up all due occurrences and advances next_run", async () => {
    const { inserted } = await materializeDueRules(admin, "2026-08-15");
    expect(inserted).toBe(2);

    const { data: txs } = await a
      .from("transactions")
      .select("date, source, needs_review, recurring_rule_id, amount_sen, type, fund_id, note")
      .eq("recurring_rule_id", ruleId)
      .order("date");
    expect(txs).toHaveLength(2);
    expect(txs!.map((t) => t.date)).toEqual(["2026-07-01", "2026-08-01"]);
    for (const t of txs!) {
      expect(t.source).toBe("recurring");
      expect(t.needs_review).toBe(false);
      expect(t.recurring_rule_id).toBe(ruleId);
      expect(t.amount_sen).toBe(150_000);
      expect(t.type).toBe("expense");
      // Plan 8 (Session-13 smoke Info): the rule's name is the note, matching
      // `Record now` — a cron-materialised row is never a blank line.
      expect(t.note).toBe("Rent");
      // Ruling 7: the materializer never writes a fund tag — a recurring rule
      // has no fund column and this row literal has no fund key.
      expect(t.fund_id).toBeNull();
    }

    const { data: rule } = await a
      .from("recurring_rules")
      .select("next_run")
      .eq("id", ruleId)
      .single();
    expect(rule!.next_run).toBe("2026-09-01");
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const { inserted } = await materializeDueRules(admin, "2026-08-15");
    expect(inserted).toBe(0);

    const { data: txs } = await a
      .from("transactions")
      .select("id")
      .eq("recurring_rule_id", ruleId);
    expect(txs).toHaveLength(2);
  });

  it("variable rules materialize with needs_review true", async () => {
    const { data: rule, error } = await a
      .from("recurring_rules")
      .insert({
        name: "Electricity",
        type: "expense",
        amount_sen: 20_000,
        variable: true,
        account_id: acctId,
        freq: "monthly",
        day_of_month: 1,
        next_run: "2026-08-01",
      })
      .select()
      .single();
    expect(error).toBeNull();

    const { inserted } = await materializeDueRules(admin, "2026-08-15");
    expect(inserted).toBe(1);

    const { data: txs } = await a
      .from("transactions")
      .select("date, needs_review")
      .eq("recurring_rule_id", rule!.id);
    expect(txs).toHaveLength(1);
    expect(txs![0]!.date).toBe("2026-08-01");
    expect(txs![0]!.needs_review).toBe(true);
  });

  /**
   * Plan 7 ruling 14's pin, and it lives HERE rather than in
   * src/db/bills.test.ts on purpose: `materializeDueRules` is global across
   * users, so calling it from a second suite would drain the fixtures of
   * every other DB suite that interleaves with it. This file already owns the
   * global call (and drains for it in beforeAll), so the comparison is made
   * against a row the real materializer actually wrote.
   */
  it("writes exactly the id `Record now` computes for the same occurrence", async () => {
    const { data: rule, error } = await a
      .from("recurring_rules")
      .insert({
        name: "Broadband",
        type: "expense",
        amount_sen: 13_900,
        account_id: acctId,
        freq: "monthly",
        day_of_month: 3,
        next_run: "2026-08-03",
      })
      .select()
      .single();
    expect(error).toBeNull();

    await materializeDueRules(admin, "2026-08-15");

    const { data: txs } = await a
      .from("transactions")
      .select("id, date")
      .eq("recurring_rule_id", rule!.id);
    expect(txs).toHaveLength(1);
    expect(txs![0]!.id).toBe(recordNowTxId(rule!.id as string, "2026-08-03"));
  });
});

/**
 * Ruling 16: the materializer writes with the ADMIN client, outside the action
 * layer's `applyCurrencyRules`, so it carries its own currency guard. A rule's
 * `amount_sen` was entered as MYR; materializing it into a foreign-currency
 * account would mint corrupt minor units, so the rule is SKIPPED and its
 * `next_run` left where it was — the occurrence then shows up as `blocked`
 * under the Bills page's *Needs attention* (ruling 11a), which is what
 * satisfies rule 15.
 *
 * `skipped` is asserted with `some(...)`, never by exact array: the
 * materializer is global across users and a skipped rule never advances, so
 * non-MYR rules left by earlier test runs stay in the due set forever. That is
 * the intended behavior, and it inflates nothing — a skipped rule inserts
 * nothing, so the `inserted` counts above stay exact.
 */
describe("materializeDueRules — ruling 16 currency guard", () => {
  let fxAcctId: string;
  let fxRuleId: string;
  let myrRuleId: string;

  beforeAll(async () => {
    const fxAcct = await a
      .from("accounts")
      .insert({ name: "ZQR broker", type: "brokerage", currency: "ZQR" })
      .select()
      .single();
    if (fxAcct.error) throw fxAcct.error;
    fxAcctId = fxAcct.data.id;

    const fxRule = await a
      .from("recurring_rules")
      .insert({
        name: "Foreign subscription",
        type: "expense",
        amount_sen: 4_900,
        account_id: fxAcctId,
        freq: "monthly",
        day_of_month: 10,
        next_run: "2026-08-10",
      })
      .select()
      .single();
    if (fxRule.error) throw fxRule.error;
    fxRuleId = fxRule.data.id;

    const myrRule = await a
      .from("recurring_rules")
      .insert({
        name: "Gym",
        type: "expense",
        amount_sen: 12_000,
        account_id: acctId,
        freq: "monthly",
        day_of_month: 10,
        next_run: "2026-08-10",
      })
      .select()
      .single();
    if (myrRule.error) throw myrRule.error;
    myrRuleId = myrRule.data.id;
  }, 30_000);

  it("skips the non-MYR rule, leaves its next_run untouched, and materializes the MYR rule in the same run", async () => {
    const { inserted, skipped } = await materializeDueRules(admin, "2026-08-15");
    expect(inserted).toBe(1); // the MYR rule only
    expect(skipped.some((s) => s.includes(fxRuleId))).toBe(true);
    expect(skipped.some((s) => s.includes(myrRuleId))).toBe(false);

    const { data: txs } = await a
      .from("transactions")
      .select("id")
      .eq("recurring_rule_id", fxRuleId);
    expect(txs).toHaveLength(0);

    const { data: stale } = await a
      .from("recurring_rules")
      .select("next_run")
      .eq("id", fxRuleId)
      .single();
    expect(stale!.next_run).toBe("2026-08-10"); // advanced nothing

    const { data: advanced } = await a
      .from("recurring_rules")
      .select("next_run")
      .eq("id", myrRuleId)
      .single();
    expect(advanced!.next_run).toBe("2026-09-10");
  });

  it("stays idempotent on a double fire: nothing inserted, the skip repeats", async () => {
    const { inserted, skipped } = await materializeDueRules(admin, "2026-08-15");
    expect(inserted).toBe(0);
    expect(skipped.some((s) => s.includes(fxRuleId))).toBe(true);

    const { data: txs } = await a
      .from("transactions")
      .select("id")
      .eq("recurring_rule_id", fxRuleId);
    expect(txs).toHaveLength(0);
    const { data: stale } = await a
      .from("recurring_rules")
      .select("next_run")
      .eq("id", fxRuleId)
      .single();
    expect(stale!.next_run).toBe("2026-08-10");
  });

  it("skips a transfer rule whose RECEIVING leg is the non-MYR account", async () => {
    const rule = await a
      .from("recurring_rules")
      .insert({
        name: "Monthly top-up",
        type: "transfer",
        amount_sen: 50_000,
        account_id: acctId,
        transfer_account_id: fxAcctId,
        freq: "monthly",
        day_of_month: 12,
        next_run: "2026-08-12",
      })
      .select()
      .single();
    if (rule.error) throw rule.error;

    const { inserted, skipped } = await materializeDueRules(admin, "2026-08-15");
    expect(inserted).toBe(0);
    expect(skipped.some((s) => s.includes(rule.data.id as string))).toBe(true);

    const { data: txs } = await a
      .from("transactions")
      .select("id")
      .eq("recurring_rule_id", rule.data.id);
    expect(txs).toHaveLength(0);
    const { data: stale } = await a
      .from("recurring_rules")
      .select("next_run")
      .eq("id", rule.data.id)
      .single();
    expect(stale!.next_run).toBe("2026-08-12");
  });
});

/**
 * Q13: `Record now` for a scheduled TRANSFER — ruling 14's mechanism, one more
 * row type, the same write path. The occurrence's id is the materializer's
 * exact uuid, so whichever of `Record now` and the cron writes second is the
 * 23505 no-op: one row, both legs moved once, `next_run` advanced. Lives here
 * for the same reason as the uuid pin above — this file owns the global
 * materializer call.
 */
describe("Record now for scheduled transfers (Q13)", () => {
  // Each rule gets its own account pair: the two rules materialize in the
  // same cron run, so sharing a leg would fold one rule's money into the
  // other's "moved once" assertion.
  let sweepFrom: string, sweepTo: string, recordFirstRule: string;
  let topupFrom: string, topupTo: string, cronFirstRule: string;

  async function balanceOf(accountId: string): Promise<number> {
    const { data, error } = await a
      .from("account_balances")
      .select("balance_sen")
      .eq("account_id", accountId)
      .single();
    if (error) throw error;
    return Number(data!.balance_sen);
  }

  beforeAll(async () => {
    const newAccount = async (name: string) => {
      const { data, error } = await a.from("accounts").insert({ name, type: "bank" }).select("id").single();
      if (error) throw error;
      return data!.id as string;
    };
    sweepFrom = await newAccount("Q13 sweep from");
    sweepTo = await newAccount("Q13 sweep to");
    topupFrom = await newAccount("Q13 top-up from");
    topupTo = await newAccount("Q13 top-up to");

    const newTransferRule = async (
      name: string,
      amount_sen: number,
      next_run: string,
      legs: { from: string; to: string },
    ) => {
      const { data, error } = await a
        .from("recurring_rules")
        .insert({
          name,
          type: "transfer",
          amount_sen,
          account_id: legs.from,
          transfer_account_id: legs.to,
          freq: "monthly",
          day_of_month: Number(next_run.slice(8, 10)),
          next_run,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data!.id as string;
    };
    recordFirstRule = await newTransferRule("Savings sweep", 25_000, "2026-08-05", { from: sweepFrom, to: sweepTo });
    cronFirstRule = await newTransferRule("Broker top-up", 30_000, "2026-08-06", { from: topupFrom, to: topupTo });
  }, 30_000);

  it("Record now first: the cron's later fire is a no-op — one row, both legs moved once, next_run advanced", async () => {
    const id = recordNowTxId(recordFirstRule, "2026-08-05");
    const fromBefore = await balanceOf(sweepFrom);
    const toBefore = await balanceOf(sweepTo);

    const recorded = await performUpsert(a, {
      id,
      type: "transfer",
      amount: "250.00",
      accountId: sweepFrom,
      transferAccountId: sweepTo,
      date: "2026-08-05",
      note: "Savings sweep",
      recurringRuleId: recordFirstRule,
    });
    expect(recorded).toEqual({ ok: true, id, created: true });
    expect(await balanceOf(sweepFrom)).toBe(fromBefore - 25_000);
    expect(await balanceOf(sweepTo)).toBe(toBefore + 25_000);

    await materializeDueRules(admin, "2026-08-15");

    const { data: rows } = await a
      .from("transactions")
      .select("id, type, amount_sen, account_id, transfer_account_id")
      .eq("recurring_rule_id", recordFirstRule);
    expect(rows).toEqual([
      { id, type: "transfer", amount_sen: 25_000, account_id: sweepFrom, transfer_account_id: sweepTo },
    ]);
    expect(await balanceOf(sweepFrom)).toBe(fromBefore - 25_000);
    expect(await balanceOf(sweepTo)).toBe(toBefore + 25_000);

    const { data: rule } = await a
      .from("recurring_rules")
      .select("next_run")
      .eq("id", recordFirstRule)
      .single();
    expect(rule!.next_run).toBe("2026-09-05");
  });

  it("carries byte for byte the id the materializer writes for a transfer occurrence", async () => {
    // The run above materialized this rule's 6 Aug occurrence.
    const { data: txs } = await a
      .from("transactions")
      .select("id, type")
      .eq("recurring_rule_id", cronFirstRule);
    expect(txs).toHaveLength(1);
    expect(txs![0]!.type).toBe("transfer");
    expect(txs![0]!.id).toBe(recordNowTxId(cronFirstRule, "2026-08-06"));
  });

  it("cron first: Record now with an edited amount is created:false with the Q11b notice, and nothing moves twice", async () => {
    const id = recordNowTxId(cronFirstRule, "2026-08-06");
    // The rule's OWN legs — what `RecordNow` prefills from the occurrence row.
    const fromBefore = await balanceOf(topupFrom);
    const toBefore = await balanceOf(topupTo);

    const result = await performUpsert(a, {
      id,
      type: "transfer",
      amount: "312.00",
      accountId: topupFrom,
      transferAccountId: topupTo,
      date: "2026-08-06",
      note: "Broker top-up",
      recurringRuleId: cronFirstRule,
    });
    expect(result).toEqual({ ok: true, id, created: false });
    expect(recordNowNotice(result, "2026-08-06")).toEqual({
      text: "Already recorded — edit that entry to change the amount",
      href: `/transactions?month=2026-08#${id}`,
    });

    const { data: rows } = await a
      .from("transactions")
      .select("amount_sen")
      .eq("recurring_rule_id", cronFirstRule);
    expect(rows).toEqual([{ amount_sen: 30_000 }]);
    // The cron's fire already moved these two once; the no-op moves nothing.
    expect(await balanceOf(topupFrom)).toBe(fromBefore);
    expect(await balanceOf(topupTo)).toBe(toBefore);
  });
});
