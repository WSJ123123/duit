import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { getBills } from "@/db/bills";
import { recordNowTxId } from "@/lib/bills";

/**
 * Plan 7 Task 5 — the bills query layer (rulings 11 / 11a / 12 / 14).
 *
 * 2077 fixture dates (house convention): `materializeDueRules` is global
 * across users, so past-dated fixtures in other suites must never interact
 * with these — and this suite deliberately never CALLS the materializer for
 * the same reason (see the note on the uuid pin below).
 *
 * The fixture carries every axis a wrong filter would hide behind:
 * a non-MYR account of a SPENDABLE type (Wise USD, a bank), an archived MYR
 * bank, three healthy MYR accounts of non-spendable types (brokerage / EPF /
 * other), a variable rule, an inactive rule, a rule drawn on a healthy
 * non-spendable MYR account, transfers in all three boundary shapes, and a
 * recorded occurrence sitting inside the starting balance.
 */

let a: SupabaseClient;
let b: SupabaseClient;

const TODAY = "2077-03-19";
const TO = "2077-04-18";

let maybank: string, tng: string, rakuten: string, wise: string, oldCimb: string;
let netflixRule: string, insuranceRule: string, waterRule: string, brokerFeeRule: string;
let carFund: string;
let usdRule: string, oldRule: string, autoInvestRule: string;

async function newAccount(
  client: SupabaseClient,
  row: { name: string; type: string; currency?: string; starting_balance_sen?: number; archived?: boolean },
): Promise<string> {
  const { data, error } = await client.from("accounts").insert(row).select("id").single();
  if (error) throw error;
  return data!.id as string;
}

async function newRule(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await a
    .from("recurring_rules")
    .insert({ freq: "monthly", ...row })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());

  maybank = await newAccount(a, { name: "Maybank", type: "bank", starting_balance_sen: 500_000 });
  tng = await newAccount(a, { name: "TnG eWallet", type: "ewallet", starting_balance_sen: 50_000 });
  await newAccount(a, { name: "Cash", type: "cash", starting_balance_sen: 10_000 });
  rakuten = await newAccount(a, { name: "Rakuten", type: "brokerage", starting_balance_sen: 900_000 });
  await newAccount(a, { name: "EPF", type: "epf", starting_balance_sen: 1_000_000 });
  await newAccount(a, { name: "Odds & ends", type: "other", starting_balance_sen: 7_000 });
  // A non-MYR account of a SPENDABLE type — the axis a currency-blind filter
  // would sum straight into the base.
  wise = await newAccount(a, { name: "Wise USD", type: "bank", currency: "USD", starting_balance_sen: 30_000 });
  oldCimb = await newAccount(a, {
    name: "Old CIMB",
    type: "bank",
    starting_balance_sen: 20_000,
    archived: true,
  });

  const bills = (
    await a.from("categories").insert({ name: "Bills", kind: "expense" }).select("id").single()
  ).data!.id as string;
  const salaryCat = (
    await a.from("categories").insert({ name: "Salary", kind: "income" }).select("id").single()
  ).data!.id as string;

  waterRule = await newRule({
    name: "Water",
    type: "expense",
    amount_sen: 4_000,
    account_id: maybank,
    category_id: bills,
    day_of_month: 10,
    next_run: "2077-03-10",
  });
  netflixRule = await newRule({
    name: "Subscriptions",
    type: "expense",
    amount_sen: 5_500,
    account_id: maybank,
    category_id: bills,
    day_of_month: 15,
    next_run: "2077-03-15",
  });
  insuranceRule = await newRule({
    name: "Insurance",
    type: "expense",
    amount_sen: 21_000,
    variable: true,
    account_id: maybank,
    category_id: bills,
    day_of_month: 20,
    next_run: "2077-03-20",
  });
  brokerFeeRule = await newRule({
    name: "Broker fee",
    type: "expense",
    amount_sen: 1_500,
    account_id: rakuten,
    day_of_month: 23,
    next_run: "2077-03-23",
  });
  autoInvestRule = await newRule({
    name: "Auto-invest",
    type: "transfer",
    amount_sen: 100_000,
    account_id: maybank,
    transfer_account_id: rakuten,
    day_of_month: 25,
    next_run: "2077-03-25",
  });
  await newRule({
    name: "Wallet top-up",
    type: "transfer",
    amount_sen: 5_000,
    account_id: maybank,
    transfer_account_id: tng,
    day_of_month: 26,
    next_run: "2077-03-26",
  });
  await newRule({
    name: "Dividend sweep",
    type: "transfer",
    amount_sen: 8_000,
    account_id: rakuten,
    transfer_account_id: maybank,
    day_of_month: 27,
    next_run: "2077-03-27",
  });
  await newRule({
    name: "Salary",
    type: "income",
    amount_sen: 520_000,
    account_id: maybank,
    category_id: salaryCat,
    day_of_month: 28,
    next_run: "2077-03-28",
  });
  await newRule({
    name: "Rent",
    type: "expense",
    amount_sen: 145_000,
    account_id: maybank,
    category_id: bills,
    day_of_month: 1,
    next_run: "2077-04-01",
  });
  usdRule = await newRule({
    name: "US subscription",
    type: "expense",
    amount_sen: 3_000,
    account_id: wise,
    day_of_month: 12,
    next_run: "2077-03-12",
  });
  oldRule = await newRule({
    name: "Old standing order",
    type: "expense",
    amount_sen: 2_000,
    account_id: oldCimb,
    day_of_month: 22,
    next_run: "2077-03-22",
  });
  await newRule({
    name: "Retired gym",
    type: "expense",
    amount_sen: 9_999,
    account_id: maybank,
    day_of_month: 5,
    next_run: "2077-03-05",
    active: false,
  });

  // Ruling 7 (F3): `Record now` opens the ordinary form WITH the fund picker,
  // so a scheduled bill really can be paid from a fund. Tagging the already-
  // recorded occurrence rather than adding a new transaction keeps every other
  // figure in this fixture untouched (the balance already carries it).
  carFund = (
    await a
      .from("funds")
      .insert({ name: "Car insurance & road tax", kind: "sinking" })
      .select("id")
      .single()
  ).data!.id as string;

  // The recorded occurrence: written at exactly the id `Record now` builds,
  // so the flip to `recorded ✓` is proved through the real id, not a stub.
  const { error: txErr } = await a.from("transactions").insert({
    id: recordNowTxId(netflixRule, "2077-03-15"),
    type: "expense",
    amount_sen: 5_500,
    account_id: maybank,
    category_id: bills,
    date: "2077-03-15",
    source: "recurring",
    recurring_rule_id: netflixRule,
    fund_id: carFund,
  });
  expect(txErr).toBeNull();

  // ⚠ The axis that makes `fund_paid`'s `fund_id is not null` filter
  // DETECTABLE. With only the tagged row above, replacing that filter with the
  // whole recorded set is a no-op and the suite stays green — the seventh time
  // in this plan a fixture missing an axis hid something. Rule-linked and
  // inside the window (so it reaches the same read), dated off the rule's
  // CURRENT grid (13 Mar is not a Broker-fee date; before its `next_run`, so
  // since question 12 it surfaces as a RECOVERED Paid row rather than
  // flipping an enumerated occurrence) and drawn on the non-spendable
  // Rakuten, so it moves no money figure in this file.
  const { error: untaggedErr } = await a.from("transactions").insert({
    type: "expense",
    amount_sen: 3_300,
    account_id: rakuten,
    date: "2077-03-13",
    source: "recurring",
    recurring_rule_id: brokerFeeRule,
  });
  expect(untaggedErr).toBeNull();
}, 60_000);

describe("getBills — the spendable base (ruling 12)", () => {
  it("sums only non-archived MYR bank/ewallet/cash accounts, and names them", async () => {
    const data = await getBills(a, TODAY);
    // 500,000 (Maybank, less the 5,500 recorded bill already inside it)
    // + 50,000 (TnG) + 10,000 (Cash). Brokerage, EPF, other, the USD bank and
    // the archived bank are all out.
    expect(data.spendable_base_sen).toBe(554_500);
    expect(data.spendable_accounts).toEqual(["Maybank", "TnG eWallet", "Cash"]);
    expect(data.excluded_account_count).toBe(4);
  });
});

describe("getBills — classification and the five lists", () => {
  it("partitions every occurrence into exactly one list", async () => {
    const data = await getBills(a, TODAY);
    expect(data.from).toBe("2077-03-10");
    expect(data.to).toBe(TO);
    expect(data.has_active_rules).toBe(true);

    expect(data.overdue.map((o) => [o.name, o.date])).toEqual([["Water", "2077-03-10"]]);
    // Broker fee 13 Mar is the RECOVERED shape (question 12): a rule-linked
    // transaction dated before its rule's `next_run`, unreachable by
    // enumeration, rebuilt from the transaction itself. Its date is off the
    // rule's CURRENT grid — which is exactly what a materialized occurrence
    // looks like after the rule's schedule is edited — and both writers of
    // `recurring_rule_id` only ever write genuine occurrence dates, so a Paid
    // row is the honest rendering.
    // Q11a: the pin carries the ACTUAL figure too — the recovered Broker fee
    // row's transaction is RM 33 against a RM 15 template, so an
    // implementation that kept rendering the rule's amount fails here.
    expect(data.recorded.map((o) => [o.name, o.date, o.recorded_amount_sen])).toEqual([
      ["Broker fee", "2077-03-13", 3_300],
      ["Subscriptions", "2077-03-15", 5_500],
    ]);
    expect(data.upcoming.map((o) => [o.name, o.date])).toEqual([
      ["Insurance", "2077-03-20"],
      ["Broker fee", "2077-03-23"],
      ["Salary", "2077-03-28"],
      ["Rent", "2077-04-01"],
      ["Water", "2077-04-10"],
      ["Subscriptions", "2077-04-15"],
    ]);
    expect(data.transfers.map((t) => [t.name, t.date, t.state])).toEqual([
      ["Auto-invest", "2077-03-25", "upcoming"],
      ["Wallet top-up", "2077-03-26", "upcoming"],
      ["Dividend sweep", "2077-03-27", "upcoming"],
    ]);
    expect(data.blocked.map((o) => [o.name, o.date])).toEqual([
      ["US subscription", "2077-03-12"],
      ["Old standing order", "2077-03-22"],
      ["US subscription", "2077-04-12"],
    ]);

    const total =
      data.upcoming.length +
      data.overdue.length +
      data.recorded.length +
      data.blocked.length +
      data.transfers.length;
    expect(total).toBe(15); // 14 enumerated + the recovered Broker fee row
  });

  it("names the reason a blocked rule needs attention, and which kind it is (ruling 11a)", async () => {
    const data = await getBills(a, TODAY);
    const usd = data.blocked.find((o) => o.rule_id === usdRule)!;
    expect(usd.reason).toContain("USD");
    expect(usd.reason).toContain("Wise USD");
    // The cron's currency guard skips it, so it is not going to happen.
    expect(usd.cron_materializes).toBe(false);

    const old = data.blocked.find((o) => o.rule_id === oldRule)!;
    expect(old.reason).toContain("archived");
    // The cron's guard tests currency, NOT `archived` — this one is recorded
    // every month and the money really leaves.
    expect(old.cron_materializes).toBe(true);
  });

  it("resolves account and category names for every row", async () => {
    const data = await getBills(a, TODAY);
    const insurance = data.upcoming.find((o) => o.rule_id === insuranceRule)!;
    expect(insurance.account_name).toBe("Maybank");
    expect(insurance.category_name).toBe("Bills");
    expect(insurance.variable).toBe(true);
    const transfer = data.transfers.find((t) => t.rule_id === autoInvestRule)!;
    expect(transfer.transfer_account_name).toBe("Rakuten");
    expect(transfer.crosses_spendable).toBe(true);
    // Q13: the transfer row carries the id `Record now` writes — the
    // materializer's — and, unrecorded, points at no transaction yet.
    expect(transfer.record_id).toBe(recordNowTxId(autoInvestRule, "2077-03-25"));
    expect(transfer.recorded_tx_id).toBeNull();
    const inside = data.transfers.find((t) => t.name === "Wallet top-up")!;
    expect(inside.crosses_spendable).toBe(false);
  });

  it("widens the window when windowDays grows", async () => {
    const data = await getBills(a, TODAY, 60);
    expect(data.to).toBe("2077-05-18");
    expect(data.upcoming.some((o) => o.rule_id === insuranceRule && o.date === "2077-04-20")).toBe(true);
  });
});

describe("getBills — the projection (rulings 11a / 12)", () => {
  it("steps only on upcoming and overdue occurrences, and only across the spendable boundary", async () => {
    const data = await getBills(a, TODAY);
    // Hand-computed running balance from 554,500 on 19 Mar:
    //   19 Mar  −4,000   Water, overdue — clamped to today   → 550,500
    //   20 Mar  −21,000  Insurance                            → 529,500
    //   23 Mar   0       Broker fee: drawn on Rakuten, which is not
    //                    spendable cash — enumerated, classified, no step
    //   25 Mar  −100,000 Auto-invest: Maybank → Rakuten, crosses OUT → 429,500
    //   26 Mar   0       Wallet top-up: Maybank → TnG, inside the set
    //   27 Mar  +8,000   Dividend sweep: Rakuten → Maybank, crosses IN → 437,500
    //   28 Mar  +520,000 Salary                                → 957,500
    //    1 Apr  −145,000 Rent                                  → 812,500
    //   10 Apr  −4,000   Water                                 → 808,500
    //   15 Apr  −5,500   Subscriptions                         → 803,000
    expect(data.projection.series).toEqual([
      { date: "2077-03-19", balance_sen: 554_500 },
      { date: "2077-03-19", balance_sen: 550_500 },
      { date: "2077-03-20", balance_sen: 529_500 },
      { date: "2077-03-25", balance_sen: 429_500 },
      { date: "2077-03-27", balance_sen: 437_500 },
      { date: "2077-03-28", balance_sen: 957_500 },
      { date: "2077-04-01", balance_sen: 812_500 },
      { date: "2077-04-10", balance_sen: 808_500 },
      { date: "2077-04-15", balance_sen: 803_000 },
      { date: "2077-04-18", balance_sen: 803_000 },
    ]);
    expect(data.projection.min_sen).toBe(429_500);
    expect(data.projection.min_date).toBe("2077-03-25");

    // Double-count regression: the 15 Mar Subscriptions occurrence is already
    // inside the starting balance, so counting it again would land the low
    // point at 424,000.
    expect(data.projection.min_sen).not.toBe(424_000);
  });

  it("an expense on an ARCHIVED account counts as money leaving but never steps spendable cash", async () => {
    const data = await getBills(a, TODAY);
    // "Old standing order" draws on the archived Old CIMB. The cron records it
    // (its guard tests currency, not `archived`), so the 2,000 is real money
    // and belongs in the window total — but Old CIMB is not part of the
    // spendable base, so the spendable-cash series cannot move for it.
    const old = data.blocked.find((o) => o.rule_id === oldRule)!;
    expect(old.cron_materializes).toBe(true);
    expect(data.projection.series.some((p) => p.date === "2077-03-22")).toBe(false);
  });

  it("discloses the variable rules inside the projection", async () => {
    const data = await getBills(a, TODAY);
    expect(data.projection.variable_occurrences.map((o) => o.rule_id)).toEqual([insuranceRule]);
    expect(data.projection.variable_total_sen).toBe(21_000);
  });
});

describe("getBills — strip totals and the Due soon payload", () => {
  it("counts every bill the cron will record, and excludes only the ones it will not", async () => {
    const data = await getBills(a, TODAY);
    // 4,000 + 21,000 + 1,500 + 145,000 + 4,000 + 5,500 = 181,000 from the
    // visible lists, PLUS the blocked-but-materialized Old standing order
    // (2,000, on the archived Old CIMB — the cron records it every month).
    // Only the US subscription (3,000 × 2, non-MYR) is genuinely out.
    expect(data.due_window_sen).toBe(183_000);
    expect(data.due_window_count).toBe(7);
    expect(data.due_window_count).toBe(
      data.upcoming.filter((o) => o.type === "expense").length +
        data.overdue.length +
        data.blocked.filter((o) => o.type === "expense" && o.cron_materializes).length,
    );
    expect(data.due_window_variable_count).toBe(1);
    expect(data.income_window_sen).toBe(520_000);
    expect(data.income_window_count).toBe(1);
    expect(data.overdue_sen).toBe(4_000);
    expect(data.net_window_sen).toBe(337_000);

    // 4,000 (Water, 10 Mar — overdue, and its own date is what the 7-day
    // cutoff tests; the projection is the only thing that clamps it to today)
    // + 21,000 (20 Mar) + 2,000 (22 Mar) + 1,500 (23 Mar).
    expect(data.due_7_sen).toBe(28_500);
    expect(data.due_7_count).toBe(4);
  });

  it("builds the dashboard payload from the same filtered set", async () => {
    const data = await getBills(a, TODAY);
    expect(data.due_soon.count).toBe(4);
    expect(data.due_soon.total_sen).toBe(28_500);
    expect(data.due_soon.next_income?.name).toBe("Salary");
    expect(data.due_soon.bills.some((o) => o.type === "transfer")).toBe(false);
    // The dashboard card and the page strip read the same set, always.
    expect(data.due_soon.total_sen).toBe(data.due_7_sen);
  });

  it("F1: a blocked Due-soon row carries its reason so it never reads as an ordinary bill", async () => {
    const data = await getBills(a, TODAY);
    // Old standing order is blocked-but-materialized, so it is IN the total —
    // and therefore has to be able to say why it needs attention. Ruling 11a
    // applies on the dashboard exactly as it does on /bills.
    const blockedRow = data.due_soon.bills.find((o) => o.rule_id === oldRule)!;
    expect(blockedRow.blocked_reason).toContain("archived");
    // …and every ordinary row says nothing, so the marker means something.
    for (const row of data.due_soon.bills) {
      if (row.rule_id === oldRule) continue;
      expect(row.blocked_reason).toBeNull();
    }
    expect(data.due_soon.next_income!.blocked_reason).toBeNull();
  });

  it("F1: the card's blocked marker matches the Needs-attention row's reason exactly", async () => {
    const data = await getBills(a, TODAY);
    const card = data.due_soon.bills.find((o) => o.rule_id === oldRule)!;
    const page = data.blocked.find((o) => o.rule_id === oldRule && o.date === card.date)!;
    // Two surfaces, one string — they can never describe the same rule
    // differently, which is the whole reason the reason is carried and not
    // re-derived per surface.
    expect(card.blocked_reason).toBe(page.reason);
  });

  it("F2: the Overdue tile's count and amount come from ONE set", async () => {
    const data = await getBills(a, TODAY);
    expect(data.overdue_sen).toBe(4_000);
    expect(data.overdue_count).toBe(1);
    // The pair is derived from the same array, so it holds by construction:
    // every past-dated live bill, counted and summed together.
    const pastDated = [
      ...data.overdue,
      ...data.blocked.filter((o) => o.type === "expense" && o.cron_materializes),
    ].filter((o) => o.date < TODAY);
    expect(data.overdue_count).toBe(pastDated.length);
    expect(data.overdue_sen).toBe(pastDated.reduce((t, o) => t + o.amount_sen, 0));
  });
});

describe("getBills — Record now (ruling 14)", () => {
  it("carries the deterministic occurrence id on every bill row", async () => {
    const data = await getBills(a, TODAY);
    const insurance = data.upcoming.find((o) => o.rule_id === insuranceRule)!;
    expect(insurance.record_id).toBe(recordNowTxId(insuranceRule, "2077-03-20"));
  });

  it("flips an occurrence to recorded when a transaction exists at that exact id and date", async () => {
    const data = await getBills(a, TODAY);
    expect(data.recorded.map((o) => o.rule_id)).toContain(netflixRule);
    expect(data.upcoming.some((o) => o.rule_id === netflixRule && o.date === "2077-03-15")).toBe(false);
    expect(data.overdue.some((o) => o.rule_id === netflixRule)).toBe(false);
  });

  it("does not match a transaction on a neighbouring date (no fuzzy matching, ever)", async () => {
    const { error } = await a.from("transactions").insert({
      type: "expense",
      amount_sen: 4_000,
      account_id: maybank,
      date: "2077-03-09",
      source: "manual",
      recurring_rule_id: waterRule,
    });
    expect(error).toBeNull();
    const data = await getBills(a, TODAY);
    expect(data.overdue.map((o) => [o.rule_id, o.date])).toEqual([[waterRule, "2077-03-10"]]);
    expect(data.recorded.some((o) => o.rule_id === waterRule)).toBe(false);
    await a.from("transactions").delete().eq("recurring_rule_id", waterRule).eq("date", "2077-03-09");
  });
});

describe("getBills — a user with no rules at all", () => {
  it("returns the empty state without a fabricated series", async () => {
    const data = await getBills(b, TODAY);
    expect(data.has_active_rules).toBe(false);
    expect(data.upcoming).toEqual([]);
    expect(data.overdue).toEqual([]);
    expect(data.blocked).toEqual([]);
    expect(data.transfers).toEqual([]);
    expect(data.spendable_base_sen).toBe(0);
    expect(data.projection.series).toEqual([
      { date: TODAY, balance_sen: 0 },
      { date: TO, balance_sen: 0 },
    ]);
    expect(data.due_window_sen).toBe(0);
  });
});

describe("getBills — Paid from a fund (ruling 7, v6 §8 Watch row)", () => {
  it("counts rule-linked, fund-tagged bills already recorded inside the window", async () => {
    const data = await getBills(a, TODAY);
    // 5,500, NOT 8,800: the fixture's other recorded rule-linked transaction
    // (3,300, untagged) sits in the same read and must be filtered out. That
    // is what makes `fund_id is not null` detectable here at all.
    expect(data.fund_paid_sen).toBe(5_500);
    expect(data.fund_paid_count).toBe(1);
    // It is a disclosure of money already spent, not a second subtraction:
    // the recorded occurrence is still out of the projection and the totals.
    expect(data.projection.min_sen).toBe(429_500);
    expect(data.due_window_sen).toBe(183_000);
  });

  it("ignores a fund-tagged expense that is not a bill", async () => {
    const { error } = await a.from("transactions").insert({
      type: "expense",
      amount_sen: 9_900,
      account_id: maybank,
      date: "2077-03-18",
      source: "manual",
      fund_id: carFund,
    });
    expect(error).toBeNull();
    const data = await getBills(a, TODAY);
    expect(data.fund_paid_sen).toBe(5_500);
    await a.from("transactions").delete().eq("date", "2077-03-18").eq("amount_sen", 9_900);
  });

  it("ignores a fund-paid bill dated outside the window", async () => {
    const { error } = await a.from("transactions").insert({
      id: recordNowTxId(insuranceRule, "2077-06-20"),
      type: "expense",
      amount_sen: 7_700,
      account_id: maybank,
      date: "2077-06-20",
      source: "recurring",
      recurring_rule_id: insuranceRule,
      fund_id: carFund,
    });
    expect(error).toBeNull();
    const data = await getBills(a, TODAY);
    expect(data.fund_paid_sen).toBe(5_500);
    await a.from("transactions").delete().eq("id", recordNowTxId(insuranceRule, "2077-06-20"));
  });

  it("F7 PIN: a recorded rule-linked bill with NO fund tag is excluded", async () => {
    const data = await getBills(a, TODAY);
    // Dropping the `fund_id is not null` filter would pull the untagged 3,300
    // in and report 8,800 across 2 — a `Paid from a fund` figure counting
    // money no fund paid.
    expect(data.fund_paid_sen).not.toBe(8_800);
    expect(data.fund_paid_count).not.toBe(2);
  });

  it("is zero for a user with no fund-paid bills", async () => {
    const data = await getBills(b, TODAY);
    expect(data.fund_paid_sen).toBe(0);
    expect(data.fund_paid_count).toBe(0);
  });
});

/**
 * The reproduction Task 7 was routed to fix. Ruling 11a dropped EVERY blocked
 * occurrence from the projection under the reasoning "blocked is not going to
 * happen" — true on the currency axis, where ruling 16's guard skips the rule
 * and leaves `next_run` stale, and false on the archived axis, which that
 * guard never tests. Both axes are present here on purpose: a fixture missing
 * one of them cannot fail on it.
 */
describe("getBills — ruling 11a's two axes against the cron's actual guard", () => {
  async function withRule<T>(row: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const id = await newRule(row);
    try {
      return await fn();
    } finally {
      // Rule 18: recurring rules archive, never hard-delete (there is no
      // DELETE grant). An inactive rule contributes no occurrences at all.
      const { error } = await a.from("recurring_rules").update({ active: false }).eq("id", id);
      expect(error).toBeNull();
    }
  }

  it("an archived-MYR-account transfer MOVES the low point — the cron really records it", async () => {
    const before = await getBills(a, TODAY);
    expect(before.projection.min_sen).toBe(429_500);

    await withRule(
      {
        name: "Standing order to Old CIMB",
        type: "transfer",
        amount_sen: 30_000,
        account_id: maybank,
        transfer_account_id: oldCimb,
        day_of_month: 24,
        next_run: "2077-03-24",
      },
      async () => {
        const data = await getBills(a, TODAY);
        const row = data.blocked.find((o) => o.name === "Standing order to Old CIMB")!;
        // Ruling 11a's other clause still holds: it is under Needs attention,
        // never in the ordinary upcoming/transfer lists.
        expect(row.cron_materializes).toBe(true);
        expect(row.reason).toContain("Old CIMB is archived");
        expect(data.upcoming.some((o) => o.name === "Standing order to Old CIMB")).toBe(false);
        expect(data.transfers.some((t) => t.name === "Standing order to Old CIMB")).toBe(false);

        // RM 300 leaves Maybank on 24 Mar for an account outside the spendable
        // set, so every point from there on drops by exactly that and no more.
        expect(data.projection.series.find((p) => p.date === "2077-03-24")?.balance_sen).toBe(499_500);
        expect(data.projection.min_sen).toBe(399_500);
        expect(data.projection.min_date).toBe("2077-03-25");
        expect(data.projection.min_sen).toBe(before.projection.min_sen - 30_000);
      },
    );

    const after = await getBills(a, TODAY);
    expect(after.projection.min_sen).toBe(429_500);
  });

  it("F2: a PAST-dated archived-account bill lands in BOTH halves of the Overdue tile", async () => {
    // The axis the shared fixture cannot arm: its archived-account rule is
    // dated 22 Mar, in the future, so a renderer counting `classified.overdue`
    // while summing `live` still agreed by accident. Here it cannot — the
    // reviewer's probe showed "1 past its date" beside two items' money.
    const before = await getBills(a, TODAY);
    expect(before.overdue_sen).toBe(4_000);
    expect(before.overdue_count).toBe(1);

    await withRule(
      {
        name: "Old direct debit",
        type: "expense",
        amount_sen: 7_000,
        account_id: oldCimb,
        day_of_month: 17,
        next_run: "2077-03-17",
      },
      async () => {
        const data = await getBills(a, TODAY);
        const row = data.blocked.find((o) => o.name === "Old direct debit" && o.date === "2077-03-17")!;
        expect(row.cron_materializes).toBe(true);
        // Both halves move together, by the same one occurrence.
        expect(data.overdue_count).toBe(2);
        expect(data.overdue_sen).toBe(11_000);
        // It is still never an ordinary row.
        expect(data.overdue.some((o) => o.name === "Old direct debit")).toBe(false);
        expect(data.upcoming.some((o) => o.name === "Old direct debit")).toBe(false);
      },
    );

    const after = await getBills(a, TODAY);
    expect(after.overdue_count).toBe(1);
    expect(after.overdue_sen).toBe(4_000);
  });

  it("a non-MYR transfer does NOT move the low point — the cron skips it", async () => {
    await withRule(
      {
        name: "USD top-up",
        type: "transfer",
        amount_sen: 45_000,
        account_id: maybank,
        transfer_account_id: wise,
        day_of_month: 24,
        next_run: "2077-03-24",
      },
      async () => {
        const data = await getBills(a, TODAY);
        const row = data.blocked.find((o) => o.name === "USD top-up")!;
        expect(row.cron_materializes).toBe(false);
        expect(row.reason).toContain("Wise USD");
        expect(data.projection.min_sen).toBe(429_500);
        expect(data.projection.series.some((p) => p.date === "2077-03-24")).toBe(false);
      },
    );
  });
});

describe("getBills — a bill on a healthy non-spendable MYR account", () => {
  it("stays in the list and in the strip total, but never steps the series", async () => {
    const data = await getBills(a, TODAY);
    const fee = data.upcoming.find((o) => o.rule_id === brokerFeeRule)!;
    expect(fee.account_name).toBe("Rakuten");
    expect(fee.type).toBe("expense");
    expect(data.projection.series.some((p) => p.date === "2077-03-23")).toBe(false);
  });
});

/**
 * Session 12, architect question 12 (owner-ruled fixed 2026-08-31): the cron
 * shape. `materializeDueRules` writes the occurrence AND advances `next_run`
 * past it, so enumeration — seeded at `next_run` — can never see it again.
 * Before the fix the row VANISHED from the page at the moment the bill was
 * paid; smoke item 6's "confirm it shows recorded ✓" could not pass. The
 * recovery path rebuilds it from its transaction, and the pin below is the
 * strongest one available: the advance must be INVISIBLE — the entire
 * `getBills` payload byte-identical before and after.
 */
describe("getBills — a cron-materialized occurrence stays recorded (question 12)", () => {
  it("advancing next_run past a recorded occurrence changes NOTHING the page renders", async () => {
    // Before: the 15 Mar Subscriptions transaction is matched by enumeration
    // (next_run still 2077-03-15) and classified `recorded`.
    const before = await getBills(a, TODAY);
    expect(before.recorded.map((o) => [o.rule_id, o.date])).toContainEqual([
      netflixRule,
      "2077-03-15",
    ]);

    // The cron's advance: next_run steps to the next occurrence.
    const { error } = await a
      .from("recurring_rules")
      .update({ next_run: "2077-04-15" })
      .eq("id", netflixRule);
    expect(error).toBeNull();
    try {
      // After: enumeration starts at 2077-04-15 and cannot reach 15 Mar; the
      // recovery path rebuilds it from the transaction. Everything — recorded,
      // upcoming, projection, strip, Due soon — is byte-identical.
      const after = await getBills(a, TODAY);
      expect(after).toEqual(before);
    } finally {
      const { error: restoreErr } = await a
        .from("recurring_rules")
        .update({ next_run: "2077-03-15" })
        .eq("id", netflixRule);
      expect(restoreErr).toBeNull();
    }
  });

  it("a cron-materialized TRANSFER keeps its row too, state `recorded`, and stops stepping the series", async () => {
    // The materializer's own write shape for Auto-invest on 25 Mar: the
    // deterministic id, then next_run advanced past it. The 100,000 leaves
    // Maybank FOR REAL (it is inside the balances now), so the projection must
    // not subtract it again — and the row must still be on the page.
    const txId = recordNowTxId(autoInvestRule, "2077-03-25");
    const { error: txErr } = await a.from("transactions").insert({
      id: txId,
      type: "transfer",
      amount_sen: 100_000,
      account_id: maybank,
      transfer_account_id: rakuten,
      date: "2077-03-25",
      source: "recurring",
      recurring_rule_id: autoInvestRule,
    });
    expect(txErr).toBeNull();
    const { error: advErr } = await a
      .from("recurring_rules")
      .update({ next_run: "2077-04-25" })
      .eq("id", autoInvestRule);
    expect(advErr).toBeNull();
    try {
      const data = await getBills(a, TODAY);
      expect(data.transfers.map((t) => [t.name, t.date, t.state])).toContainEqual([
        "Auto-invest",
        "2077-03-25",
        "recorded",
      ]);
      // Q13: a recorded transfer row points at its transaction, as a Paid
      // bill row does (Q11a), so the page can link to it.
      expect(
        data.transfers.find((t) => t.rule_id === autoInvestRule && t.date === "2077-03-25")!.recorded_tx_id,
      ).toBe(txId);
      // Already inside the starting balance (Maybank is down 100,000), so the
      // series must not step for it on 25 Mar — the double-count trap, on the
      // transfer axis this time.
      expect(data.spendable_base_sen).toBe(454_500);
      expect(data.projection.series.some((p) => p.date === "2077-03-25")).toBe(false);
      // The low point VALUE is unchanged — the 100,000 left the balance up
      // front instead of stepping on 25 Mar, and the two trajectories coincide
      // from there — but it now lands at 20 Mar (Insurance), not 25 Mar.
      // Counting the recorded transfer again would read 329,500.
      expect(data.projection.min_sen).toBe(429_500);
      expect(data.projection.min_date).toBe("2077-03-20");
    } finally {
      const { error: delErr } = await a.from("transactions").delete().eq("id", txId);
      expect(delErr).toBeNull();
      const { error: restoreErr } = await a
        .from("recurring_rules")
        .update({ next_run: "2077-03-25" })
        .eq("id", autoInvestRule);
      expect(restoreErr).toBeNull();
    }
  });
});

/**
 * Q11a: a Paid row showed the RULE's template amount, so a variable bill —
 * the whole reason `Record now` keeps the amount editable — reported a figure
 * that was never paid. `src/db/bills.ts` already fetched the matched
 * transaction's `amount_sen` for the fund disclosure and dropped it before
 * the row was built; the row now carries it, and its id.
 */
describe("getBills — a Paid row shows what was actually paid (Q11a)", () => {
  it("the recovered shape carries the transaction's amount and id, not the template", async () => {
    const data = await getBills(a, TODAY);
    const brokerFee = data.recorded.find((o) => o.rule_id === brokerFeeRule)!;
    expect(brokerFee.amount_sen).toBe(1_500); // the rule's template, untouched
    expect(brokerFee.recorded_amount_sen).toBe(3_300); // what actually left
    expect(brokerFee.recorded_tx_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the enumerated shape does too — a recorded VARIABLE bill reports its real figure", async () => {
    const txId = recordNowTxId(insuranceRule, "2077-03-20");
    const { error } = await a.from("transactions").insert({
      id: txId,
      type: "expense",
      amount_sen: 18_750,
      account_id: maybank,
      date: "2077-03-20",
      source: "recurring",
      recurring_rule_id: insuranceRule,
    });
    expect(error).toBeNull();
    try {
      const data = await getBills(a, TODAY);
      const row = data.recorded.find((o) => o.rule_id === insuranceRule)!;
      expect(row.variable).toBe(true);
      expect(row.amount_sen).toBe(21_000);
      expect(row.recorded_amount_sen).toBe(18_750);
      expect(row.recorded_tx_id).toBe(txId);
    } finally {
      const { error: delErr } = await a.from("transactions").delete().eq("id", txId);
      expect(delErr).toBeNull();
    }
  });
});
