import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";

/**
 * Plan 7 Task 1: the funds schema's own guarantees (ruling 2).
 * Error CODES are pinned, not just "an error happened": 23514 check,
 * 23503 foreign key, 23505 unique.
 */

let a: SupabaseClient;
let b: SupabaseClient;
let acctId: string;
let transferAcctId: string;
let bAcctId: string;
let aFundId: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());

  const acct = await a.from("accounts")
    .insert({ name: "Maybank", type: "bank" }).select().single();
  if (acct.error) throw acct.error;
  acctId = acct.data.id;

  const transferAcct = await a.from("accounts")
    .insert({ name: "TNG eWallet", type: "ewallet" }).select().single();
  if (transferAcct.error) throw transferAcct.error;
  transferAcctId = transferAcct.data.id;

  const bAcct = await b.from("accounts")
    .insert({ name: "B's bank", type: "bank" }).select().single();
  if (bAcct.error) throw bAcct.error;
  bAcctId = bAcct.data.id;

  const fund = await a.from("funds")
    .insert({ name: "Car insurance", kind: "sinking", target_sen: 120_000 })
    .select().single();
  if (fund.error) throw fund.error;
  aFundId = fund.data.id;
}, 30_000);

describe("funds: a target has exactly one shape, or none (ruling 3)", () => {
  it("rejects target_sen and target_months set together", async () => {
    const { error } = await a.from("funds").insert({
      name: "Two targets", kind: "emergency", target_sen: 500_000, target_months: 6,
    });
    expect(error?.code).toBe("23514");
  });

  it("rejects target_months on a non-emergency fund", async () => {
    for (const kind of ["sinking", "goal"]) {
      const { error } = await a.from("funds")
        .insert({ name: `Months on ${kind}`, kind, target_months: 6 });
      expect(error?.code).toBe("23514");
    }
  });

  it("accepts target_months on an emergency fund", async () => {
    const { data, error } = await a.from("funds")
      .insert({ name: "Emergency", kind: "emergency", target_months: 6 })
      .select().single();
    expect(error).toBeNull();
    expect(data!.target_months).toBe(6);
    expect(data!.target_sen).toBeNull();
  });

  it("accepts target_sen alone on a sinking fund, with an independent target_date", async () => {
    const { data, error } = await a.from("funds")
      .insert({ name: "Road tax", kind: "sinking", target_sen: 90_000, target_date: "2077-12-01" })
      .select().single();
    expect(error).toBeNull();
    expect(data!.target_sen).toBe(90_000);
    expect(data!.target_date).toBe("2077-12-01");
    expect(data!.target_months).toBeNull();
  });

  it("lands its defaults: contribution 0, priority 0, not archived", async () => {
    const { data, error } = await a.from("funds")
      .insert({ name: "Travel", kind: "goal" }).select().single();
    expect(error).toBeNull();
    expect(data!.monthly_contribution_sen).toBe(0);
    expect(data!.priority).toBe(0);
    expect(data!.archived).toBe(false);
    expect(data!.target_sen).toBeNull();
  });

  it("allows two funds to share a name (ruling 9a: no unique on name)", async () => {
    const { error } = await a.from("funds")
      .insert({ name: "Car insurance", kind: "sinking" });
    expect(error).toBeNull();
  });
});

describe("fund_contributions", () => {
  it("rejects a month that is not the first of the month", async () => {
    const { error } = await a.from("fund_contributions")
      .insert({ fund_id: aFundId, month: "2077-03-15", amount_sen: 10_000 });
    expect(error?.code).toBe("23514");
  });

  it("accepts a first-of-month contribution", async () => {
    const { data, error } = await a.from("fund_contributions")
      .insert({ fund_id: aFundId, month: "2077-03-01", amount_sen: 10_000 })
      .select().single();
    expect(error).toBeNull();
    expect(data!.amount_sen).toBe(10_000);
  });

  it("rejects an omitted amount_sen rather than earmarking RM 0", async () => {
    // No column default (ruling 2). Ruling 4's `on conflict do nothing` would
    // make a silently-defaulted 0 row PERMANENT for that (fund, month).
    const { error } = await a.from("fund_contributions")
      .insert({ fund_id: aFundId, month: "2077-04-01" });
    expect(error?.code).toBe("23502");
  });

  it("rejects a second contribution for the same (fund, month)", async () => {
    const first = await a.from("fund_contributions")
      .insert({ fund_id: aFundId, month: "2077-05-01", amount_sen: 10_000 });
    expect(first.error).toBeNull();
    const second = await a.from("fund_contributions")
      .insert({ fund_id: aFundId, month: "2077-05-01", amount_sen: 20_000 });
    expect(second.error?.code).toBe("23505");
  });
});

describe("transactions.fund_id (ruling 7: expense-only, own funds only)", () => {
  const tx = (overrides: Record<string, unknown>) => ({
    type: "expense", amount_sen: 5_000, account_id: acctId, date: "2077-04-01",
    ...overrides,
  });

  it("rejects a fund_id on an income row", async () => {
    const { error } = await a.from("transactions")
      .insert(tx({ type: "income", fund_id: aFundId }));
    expect(error?.code).toBe("23514");
  });

  it("rejects a fund_id on a transfer row", async () => {
    const { error } = await a.from("transactions").insert(tx({
      type: "transfer", transfer_account_id: transferAcctId, fund_id: aFundId,
    }));
    expect(error?.code).toBe("23514");
  });

  it("accepts a fund_id on an expense row, and defaults it to null", async () => {
    const tagged = await a.from("transactions")
      .insert(tx({ fund_id: aFundId })).select().single();
    expect(tagged.error).toBeNull();
    expect(tagged.data!.fund_id).toBe(aFundId);

    const untagged = await a.from("transactions").insert(tx({})).select().single();
    expect(untagged.error).toBeNull();
    expect(untagged.data!.fund_id).toBeNull();
  });

  it("rejects retyping a tagged expense into an income or a transfer", async () => {
    // The CHECK is re-evaluated on UPDATE, so Task 4's "editing a tagged expense
    // into another type is an explicit act" has a database-level backstop even
    // if every layer above it is bypassed.
    const tagged = await a.from("transactions")
      .insert(tx({ fund_id: aFundId })).select().single();
    expect(tagged.error).toBeNull();

    const toIncome = await a.from("transactions")
      .update({ type: "income" }).eq("id", tagged.data!.id);
    expect(toIncome.error?.code).toBe("23514");

    const toTransfer = await a.from("transactions")
      .update({ type: "transfer", transfer_account_id: transferAcctId })
      .eq("id", tagged.data!.id);
    expect(toTransfer.error?.code).toBe("23514");
  });

  it("composite FK rejects another user's fund_id", async () => {
    const { error } = await b.from("transactions").insert({
      type: "expense", amount_sen: 5_000, account_id: bAcctId,
      date: "2077-04-01", fund_id: aFundId,
    });
    expect(error?.code).toBe("23503");
  });
});
