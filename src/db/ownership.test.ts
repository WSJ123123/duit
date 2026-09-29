import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";

let a: SupabaseClient, b: SupabaseClient;
let aAcct: string, aCat: string, bAcct: string;
let aHolding: string, aBiz: string;
let bHolding: string, bAsset: string, bLiability: string, bBiz: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  aAcct = (await a.from("accounts").insert({ name: "Maybank", type: "bank" }).select().single()).data!.id;
  bAcct = (await b.from("accounts").insert({ name: "B bank", type: "bank" }).select().single()).data!.id;
  await a.rpc("seed_default_categories");
  aCat = (await a.from("categories").select().eq("name", "Food").single()).data!.id;
  aHolding = (await a.from("holdings").insert({ symbol: "CSPX", kind: "etf" }).select().single()).data!.id;
  aBiz = (await a.from("business_investments").insert({ name: "A biz" }).select().single()).data!.id;
  bHolding = (await b.from("holdings").insert({ symbol: "VWRA", kind: "etf" }).select().single()).data!.id;
  bAsset = (await b.from("manual_assets").insert({ name: "B EPF", kind: "epf" }).select().single()).data!.id;
  bLiability = (await b.from("liabilities").insert({ name: "B loan", kind: "loan" }).select().single()).data!.id;
  bBiz = (await b.from("business_investments").insert({ name: "B biz" }).select().single()).data!.id;
}, 30_000);

describe("cross-user references are impossible", () => {
  it("B cannot create a transaction on A's account", async () => {
    const { error } = await b.from("transactions")
      .insert({ type: "expense", amount_sen: 100, account_id: aAcct });
    expect(error).not.toBeNull(); // 23503 fk violation
  });
  it("B cannot categorize with A's category", async () => {
    const { error } = await b.from("transactions")
      .insert({ type: "expense", amount_sen: 100, account_id: bAcct, category_id: aCat });
    expect(error).not.toBeNull();
  });
  it("B cannot transfer into A's account", async () => {
    const { error } = await b.from("transactions")
      .insert({ type: "transfer", amount_sen: 100, account_id: bAcct, transfer_account_id: aAcct });
    expect(error).not.toBeNull();
  });
  it("B cannot alias to A's category or rule to A's account", async () => {
    const alias = await b.from("parser_aliases").insert({ phrase: "evil", category_id: aCat });
    expect(alias.error).not.toBeNull();
    const rule = await b.from("recurring_rules").insert({
      name: "evil", type: "expense", amount_sen: 100, account_id: aAcct,
      freq: "monthly", day_of_month: 1, next_run: "2026-09-01",
    });
    expect(rule.error).not.toBeNull();
  });
  it("B cannot allocate budget against A's category", async () => {
    const { error } = await b.from("budget_allocations")
      .insert({ month: "2026-09-01", category_id: aCat, planned_sen: 100 });
    expect(error).not.toBeNull(); // 23503 composite fk violation
  });
  it("B cannot log a budget change against A's category", async () => {
    const { error } = await b.from("budget_changes")
      .insert({ month: "2026-09-01", category_id: aCat, from_sen: 0, to_sen: 100 });
    expect(error).not.toBeNull();
  });
  it("A cannot create a trade pointing at B's holding or B's account", async () => {
    const trade = (holding_id: string, account_id: string) => ({
      holding_id, account_id, side: "buy", date: "2077-01-05",
      quantity_e8: 100_000_000, price_e8: 1, cash_delta_sen: 1,
    });
    const badHolding = await a.from("trades").insert(trade(bHolding, aAcct));
    expect(badHolding.error).not.toBeNull(); // 23503 composite fk violation
    const badAccount = await a.from("trades").insert(trade(aHolding, bAcct));
    expect(badAccount.error).not.toBeNull();
  });
  it("A cannot record a value against B's asset or liability", async () => {
    const asset = await a.from("manual_asset_values")
      .insert({ asset_id: bAsset, value_sen: 1, noted_on: "2077-03-01" });
    expect(asset.error).not.toBeNull();
    const liability = await a.from("liability_values")
      .insert({ liability_id: bLiability, balance_sen: 1, noted_on: "2077-03-01" });
    expect(liability.error).not.toBeNull();
  });
  it("A cannot create a business entry pointing at B's business or B's account", async () => {
    const badBiz = await a.from("business_investment_entries").insert({
      business_id: bBiz, kind: "contribution", amount_sen: 1,
      account_id: aAcct, date: "2077-02-01",
    });
    expect(badBiz.error).not.toBeNull();
    const badAccount = await a.from("business_investment_entries").insert({
      business_id: aBiz, kind: "contribution", amount_sen: 1,
      account_id: bAcct, date: "2077-02-01",
    });
    expect(badAccount.error).not.toBeNull();
  });
  it("A's own references still work end-to-end", async () => {
    const { error } = await a.from("transactions")
      .insert({ type: "expense", amount_sen: 100, account_id: aAcct, category_id: aCat });
    expect(error).toBeNull();

    const trade = await a.from("trades").insert({
      holding_id: aHolding, account_id: aAcct, side: "buy", date: "2077-01-05",
      quantity_e8: 100_000_000, price_e8: 1, cash_delta_sen: 1,
    });
    expect(trade.error).toBeNull();
    const entry = await a.from("business_investment_entries").insert({
      business_id: aBiz, kind: "contribution", amount_sen: 1,
      account_id: aAcct, date: "2077-02-01",
    });
    expect(entry.error).toBeNull();
  });
});
