import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getAccountsWithBalances } from "@/db/queries";

let a: SupabaseClient;
let bank: string, wallet: string;

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  bank = (await a.from("accounts").insert({ name: "Maybank", type: "bank", starting_balance_sen: 500_000 }).select().single()).data!.id;
  wallet = (await a.from("accounts").insert({ name: "TnG", type: "ewallet" }).select().single()).data!.id;
}, 30_000);

it("derives balances across all movement kinds", async () => {
  await a.from("transactions").insert([
    { type: "income", amount_sen: 620_000, account_id: bank },           // salary
    { type: "expense", amount_sen: 8_700, account_id: bank },            // petrol
    { type: "transfer", amount_sen: 10_000, account_id: bank, transfer_account_id: wallet },
    { type: "expense", amount_sen: 1_250, account_id: wallet },          // nasi lemak
  ]);
  // RM300 dinner from bank, RM240 expected back, RM160 repaid into wallet
  const dinner = (await a.from("transactions")
    .insert({ type: "expense", amount_sen: 30_000, account_id: bank, expected_back_sen: 24_000 })
    .select().single()).data!;
  await a.from("reimbursement_payments")
    .insert({ transaction_id: dinner.id, account_id: wallet, amount_sen: 16_000 });

  const rows = await getAccountsWithBalances(a);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.balance_sen]));
  // bank: 500000 +620000 −8700 −10000 −30000 = 1,071,300
  expect(byId[bank]).toBe(1_071_300);
  // wallet: 0 +10000 −1250 +16000 = 24,750
  expect(byId[wallet]).toBe(24_750);
});

describe("phase-3 cash flows (trades + business entries)", () => {
  let broker: string, bizAcct: string, cashOnly: string, holdingId: string, bizId: string;

  const balances = async () => {
    const rows = await getAccountsWithBalances(a);
    return Object.fromEntries(rows.map((r) => [r.id, r.balance_sen]));
  };

  beforeAll(async () => {
    broker = (await a.from("accounts")
      .insert({ name: "Broker cash", type: "bank", starting_balance_sen: 100_000 })
      .select().single()).data!.id;
    bizAcct = (await a.from("accounts")
      .insert({ name: "Biz cash", type: "bank", starting_balance_sen: 100_000 })
      .select().single()).data!.id;
    cashOnly = (await a.from("accounts")
      .insert({ name: "Txn only", type: "bank", starting_balance_sen: 50_000 })
      .select().single()).data!.id;
    await a.from("transactions")
      .insert({ type: "expense", amount_sen: 1_000, account_id: cashOnly });
    holdingId = (await a.from("holdings")
      .insert({ symbol: "CSPX", kind: "etf", currency: "USD" })
      .select().single()).data!.id;
    bizId = (await a.from("business_investments")
      .insert({ name: "Kedai runcit" }).select().single()).data!.id;
  }, 30_000);

  it("a buy reduces and a sell increases the linked account by exactly cash_delta_sen", async () => {
    const buy = await a.from("trades").insert({
      holding_id: holdingId, account_id: broker, side: "buy", date: "2077-01-05",
      quantity_e8: 100_000_000, price_e8: 4_500_000_000, cash_delta_sen: 42_000,
    });
    expect(buy.error).toBeNull();
    expect((await balances())[broker]).toBe(100_000 - 42_000);

    const sell = await a.from("trades").insert({
      holding_id: holdingId, account_id: broker, side: "sell", date: "2077-01-20",
      quantity_e8: 30_000_000, price_e8: 4_800_000_000, cash_delta_sen: 15_500,
    });
    expect(sell.error).toBeNull();
    // 100000 −42000 +15500 = 73,500
    expect((await balances())[broker]).toBe(73_500);
  });

  it("a business contribution reduces, a return increases, a valuation changes nothing", async () => {
    await a.from("business_investment_entries").insert({
      business_id: bizId, kind: "contribution", amount_sen: 20_000,
      account_id: bizAcct, date: "2077-02-01",
    });
    // 100000 −20000 = 80,000 (own account: independent of the trades case)
    expect((await balances())[bizAcct]).toBe(80_000);

    await a.from("business_investment_entries").insert({
      business_id: bizId, kind: "return", amount_sen: 5_000,
      account_id: bizAcct, date: "2077-02-15",
    });
    expect((await balances())[bizAcct]).toBe(85_000);

    const valuation = await a.from("business_investment_entries").insert({
      business_id: bizId, kind: "valuation", amount_sen: 999_999, date: "2077-02-20",
    });
    expect(valuation.error).toBeNull();
    expect((await balances())[bizAcct]).toBe(85_000);
  });

  it("a transactions-only account is unchanged by the new terms (regression pin)", async () => {
    // 50000 −1000 = 49,000: exactly the pre-phase-3 math
    expect((await balances())[cashOnly]).toBe(49_000);
  });
});

describe("phase-3.1 FX transfers (received_sen)", () => {
  it("destination credits coalesce(received_sen, amount_sen); source always debits amount_sen", async () => {
    const src = (await a.from("accounts")
      .insert({ name: "MYR src", type: "bank", starting_balance_sen: 100_000 })
      .select().single()).data!.id;
    const dst = (await a.from("accounts")
      .insert({ name: "SGD dst", type: "bank" }).select().single()).data!.id;

    // FX transfer: RM100 out, S$34-equivalent 3,400 minor units in
    await a.from("transactions").insert({
      type: "transfer", amount_sen: 10_000, received_sen: 3_400,
      account_id: src, transfer_account_id: dst,
    });
    // same-currency transfer: received_sen null → destination gets amount_sen
    await a.from("transactions").insert({
      type: "transfer", amount_sen: 5_000,
      account_id: src, transfer_account_id: dst,
    });

    const rows = await getAccountsWithBalances(a);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.balance_sen]));
    // src: 100000 −10000 −5000 = 85,000
    expect(byId[src]).toBe(85_000);
    // dst: 0 +3400 +5000 = 8,400
    expect(byId[dst]).toBe(8_400);
  });
});
