import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { makeTestUsers } from "@/db/test-clients";
import { performUpsert, performUpdate } from "@/lib/transactions";
import { performSetAccountCurrency } from "@/db/accounts";

/**
 * Task 5: cross-currency transfers (both legs, received_sen storage shape b)
 * and the account-currency edit guard. 2077 dates. Account currency "ZXD" is
 * fictional and needs no fx_rates row — balances use the user-entered
 * received amount, never a rate. The currency-edit guard tests use curated
 * codes (USD/SGD) because the action validates against the curated list;
 * account rows are user-scoped, so no global-table keys are touched.
 */

let a: SupabaseClient;
let bankId: string;
let zxdId: string;

async function balance(accountId: string): Promise<number> {
  const { data, error } = await a
    .from("account_balances")
    .select("balance_sen")
    .eq("account_id", accountId)
    .single();
  if (error) throw error;
  return Number(data.balance_sen);
}

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  const bank = await a.from("accounts")
    .insert({ name: "FX bank", type: "bank", starting_balance_sen: 100_000 })
    .select().single();
  if (bank.error) throw bank.error;
  bankId = bank.data.id;

  const zxd = await a.from("accounts")
    .insert({ name: "ZXD broker", type: "brokerage", currency: "ZXD", starting_balance_sen: 0 })
    .select().single();
  if (zxd.error) throw zxd.error;
  zxdId = zxd.data.id;
}, 30_000);

describe("cross-currency transfers — both legs carry their own amount", () => {
  it("writes received_sen and the view credits it on the destination", async () => {
    const id = randomUUID();
    const result = await performUpsert(a, {
      id,
      type: "transfer",
      amount: "44.20", // RM out of the bank
      received: "10.00", // ZXD 10.00 arrives
      accountId: bankId,
      transferAccountId: zxdId,
      date: "2077-03-01",
    });
    expect(result).toEqual({ ok: true, id, created: true });

    const { data } = await a.from("transactions").select("received_sen").eq("id", id).single();
    expect(data!.received_sen).toBe(1_000);
    expect(await balance(bankId)).toBe(95_580); // −4_420
    expect(await balance(zxdId)).toBe(1_000); // +received, not +amount
  });

  it("rejects a cross-currency transfer without a received amount — nothing written", async () => {
    const before = await balance(bankId);
    const result = await performUpsert(a, {
      id: randomUUID(),
      type: "transfer",
      amount: "10.00",
      accountId: bankId,
      transferAccountId: zxdId,
      date: "2077-03-02",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/received|arrived/i);
    expect(await balance(bankId)).toBe(before);
  });

  it("rejects a zero received amount", async () => {
    const result = await performUpsert(a, {
      id: randomUUID(),
      type: "transfer",
      amount: "10.00",
      received: "0.00",
      accountId: bankId,
      transferAccountId: zxdId,
      date: "2077-03-02",
    });
    expect(result.ok).toBe(false);
  });

  it("same-currency transfers stay unchanged: received_sen is stored null", async () => {
    const bank2 = await a.from("accounts")
      .insert({ name: "FX bank 2", type: "bank", starting_balance_sen: 0 })
      .select().single();
    if (bank2.error) throw bank2.error;
    const id = randomUUID();
    const result = await performUpsert(a, {
      id,
      type: "transfer",
      amount: "5.00",
      received: "9.99", // ignored — same currency, null = same-currency shape
      accountId: bankId,
      transferAccountId: bank2.data.id,
      date: "2077-03-03",
    });
    expect(result).toEqual({ ok: true, id, created: true });
    const { data } = await a.from("transactions").select("received_sen").eq("id", id).single();
    expect(data!.received_sen).toBeNull();
    expect(await balance(bank2.data.id)).toBe(500); // amount, both legs
  });

  it("editing a cross-currency transfer keeps both legs honest", async () => {
    const id = randomUUID();
    await performUpsert(a, {
      id,
      type: "transfer",
      amount: "8.84",
      received: "2.00",
      accountId: bankId,
      transferAccountId: zxdId,
      date: "2077-03-04",
    });
    const zxdBefore = await balance(zxdId);
    const result = await performUpdate(a, id, {
      type: "transfer",
      amount: "8.84",
      received: "2.10", // the broker actually credited 2.10
      accountId: bankId,
      transferAccountId: zxdId,
      date: "2077-03-04",
    });
    expect(result).toEqual({ ok: true, id });
    expect(await balance(zxdId)).toBe(zxdBefore + 10);
  });
});

describe("currency-edit guard — fixed once the account has any activity", () => {
  it("edits freely while the account is empty (brokerage, curated code)", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Empty broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result).toEqual({ ok: true });
    const { data } = await a.from("accounts").select("currency").eq("id", acct.data.id).single();
    expect(data!.currency).toBe("USD");
  });

  it("rejects after the first transaction (outgoing)", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Tx broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const tx = await a.from("transactions").insert({
      type: "expense", amount_sen: 100, account_id: acct.data.id, date: "2077-03-01",
    });
    if (tx.error) throw tx.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lock|activity|transaction/i);
  });

  it("an INCOMING transfer counts as activity too", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "In broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const tx = await a.from("transactions").insert({
      type: "transfer", amount_sen: 100, account_id: bankId,
      transfer_account_id: acct.data.id, date: "2077-03-01",
    });
    if (tx.error) throw tx.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
  });

  it("rejects after the first trade", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Trade broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const h = await a.from("holdings")
      .insert({ symbol: "T5GRD", kind: "stock", currency: "MYR" })
      .select().single();
    if (h.error) throw h.error;
    const trade = await a.from("trades").insert({
      holding_id: h.data.id, account_id: acct.data.id, side: "buy",
      date: "2077-03-01", quantity_e8: 100_000_000, price_e8: 100_000_000, cash_delta_sen: 100,
    });
    if (trade.error) throw trade.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
  });

  it("rejects after the first business entry", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Biz broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const biz = await a.from("business_investments")
      .insert({ name: "Guard biz" }).select().single();
    if (biz.error) throw biz.error;
    const entry = await a.from("business_investment_entries").insert({
      business_id: biz.data.id, kind: "contribution", amount_sen: 100,
      account_id: acct.data.id, date: "2077-03-01",
    });
    if (entry.error) throw entry.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
  });

  it("rejects after a reimbursement payback lands in the account", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Reimb broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    // the payback's parent expense lives on the bank; the sen land in acct
    const tx = await a.from("transactions").insert({
      id: randomUUID(), type: "expense", amount_sen: 500, account_id: bankId, date: "2077-03-05",
    }).select().single();
    if (tx.error) throw tx.error;
    const pay = await a.from("reimbursement_payments").insert({
      transaction_id: tx.data.id, account_id: acct.data.id, amount_sen: 500, date: "2077-03-06",
    });
    if (pay.error) throw pay.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lock|activity/i);
  });

  it("rejects while a recurring rule points at the account (paying leg)", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Rule broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const rule = await a.from("recurring_rules").insert({
      name: "Guard rule", type: "expense", amount_sen: 100,
      account_id: acct.data.id, freq: "monthly", day_of_month: 1, next_run: "2077-04-01",
    });
    if (rule.error) throw rule.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lock|activity/i);
  });

  it("rejects while a recurring transfer rule points at the account (receiving leg)", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Rule in broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const rule = await a.from("recurring_rules").insert({
      name: "Guard transfer rule", type: "transfer", amount_sen: 100,
      account_id: bankId, transfer_account_id: acct.data.id,
      freq: "monthly", day_of_month: 1, next_run: "2077-04-01",
    });
    if (rule.error) throw rule.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/lock|activity/i);
  });

  it("rejects while the starting balance is non-zero, accepts once it is zeroed (ruling 15)", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Funded broker", type: "brokerage", starting_balance_sen: 25_000 })
      .select().single();
    if (acct.error) throw acct.error;

    const blocked = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/starting balance/i);
    const { data: unchanged } = await a.from("accounts")
      .select("currency").eq("id", acct.data.id).single();
    expect(unchanged!.currency).toBe("MYR"); // nothing re-denominated

    const zeroed = await a.from("accounts")
      .update({ starting_balance_sen: 0 }).eq("id", acct.data.id);
    if (zeroed.error) throw zeroed.error;
    expect(await performSetAccountCurrency(a, acct.data.id, "USD")).toEqual({ ok: true });
  });

  it("names WHICH condition bit: the starting-balance reason is distinct from the activity reason", async () => {
    const funded = await a.from("accounts")
      .insert({ name: "Balance-locked broker", type: "brokerage", starting_balance_sen: 1 })
      .select().single();
    if (funded.error) throw funded.error;
    const active = await a.from("accounts")
      .insert({ name: "Activity-locked broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (active.error) throw active.error;
    const tx = await a.from("transactions").insert({
      type: "expense", amount_sen: 100, account_id: active.data.id, date: "2077-03-07",
    });
    if (tx.error) throw tx.error;

    const byBalance = await performSetAccountCurrency(a, funded.data.id, "USD");
    const byActivity = await performSetAccountCurrency(a, active.data.id, "USD");
    expect(byBalance.ok).toBe(false);
    expect(byActivity.ok).toBe(false);
    if (byBalance.ok || byActivity.ok) return;
    expect(byBalance.error).toMatch(/starting balance/i);
    expect(byBalance.error).not.toMatch(/already has activity/i);
    expect(byActivity.error).toMatch(/already has activity/i);
    expect(byActivity.error).not.toMatch(/starting balance/i);
  });

  it("when BOTH locks apply the activity reason wins — precedence, not accident", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Doubly-locked broker", type: "brokerage", starting_balance_sen: 7_500 })
      .select().single();
    if (acct.error) throw acct.error;
    const tx = await a.from("transactions").insert({
      type: "expense", amount_sen: 100, account_id: acct.data.id, date: "2077-03-09",
    });
    if (tx.error) throw tx.error;

    const result = await performSetAccountCurrency(a, acct.data.id, "USD");
    expect(result.ok).toBe(false);
    // The counts are checked before the starting balance ON PURPOSE: activity
    // is the wall the owner cannot get past, so naming the balance first
    // would send him at a condition whose removal still would not unlock the
    // account. Reorder the two checks and this test objects.
    if (!result.ok) {
      expect(result.error).toMatch(/already has activity/i);
      expect(result.error).not.toMatch(/starting balance/i);
    }
  });

  it("non-brokerage accounts cannot take a foreign currency", async () => {
    const result = await performSetAccountCurrency(a, bankId, "USD");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/brokerage/i);
  });

  it("only curated codes are accepted", async () => {
    const acct = await a.from("accounts")
      .insert({ name: "Code broker", type: "brokerage", starting_balance_sen: 0 })
      .select().single();
    if (acct.error) throw acct.error;
    const result = await performSetAccountCurrency(a, acct.data.id, "ZZZ");
    expect(result.ok).toBe(false);
  });
});
