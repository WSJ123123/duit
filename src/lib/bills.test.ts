import { describe, it, expect } from "vitest";
import {
  enumerateOccurrences,
  classifyOccurrences,
  projectBalance,
  dueSoon,
  recoverRecordedOccurrences,
  type AccountLike,
  type BillRule,
  type Occurrence,
  type RecordedTxLike,
} from "@/lib/bills";

/**
 * Plan 7 Task 5 — pure bills/cashflow math. Every date is a parameter; there
 * is no clock in this file or in the module under test.
 */

const BASE_RULE: BillRule = {
  id: "rule-base",
  name: "Rule",
  type: "expense",
  amount_sen: 10_000,
  variable: false,
  account_id: "acct-bank",
  transfer_account_id: null,
  category_id: null,
  freq: "monthly",
  day_of_month: 1,
  weekday: null,
  month_of_year: null,
  next_run: "2026-09-01",
  active: true,
};

function rule(over: Partial<BillRule>): BillRule {
  return { ...BASE_RULE, ...over };
}

/**
 * A recorded transaction, the columns ruling 11's exact match reads. Q11a
 * added `id` and `amount_sen`: the row now renders what was ACTUALLY paid,
 * with the rule's template amount beside it only when the two differ.
 */
function recTx(recurring_rule_id: string, date: string, amount_sen = 0): RecordedTxLike {
  return { id: `tx-${recurring_rule_id}-${date}`, recurring_rule_id, date, amount_sen };
}

const ACCOUNTS: AccountLike[] = [
  { id: "acct-bank", name: "Maybank", currency: "MYR", archived: false },
  { id: "acct-ewallet", name: "TnG eWallet", currency: "MYR", archived: false },
  { id: "acct-brokerage", name: "Rakuten", currency: "MYR", archived: false },
  { id: "acct-usd", name: "IBKR USD", currency: "USD", archived: false },
  { id: "acct-old", name: "Closed CIMB", currency: "MYR", archived: true },
];

const SPENDABLE = ["acct-bank", "acct-ewallet"];

function dates(occurrences: Occurrence[]): string[] {
  return occurrences.map((o) => o.date);
}

describe("enumerateOccurrences", () => {
  it("seeds the walk from next_run — a mid-month window keeps the day-15 occurrence", () => {
    // T1: nextRunAfter("2026-09-01") on a day-15 monthly rule returns
    // 2026-10-15, so a walk seeded at the window start loses 15 Sep entirely.
    const r = rule({ id: "r15", day_of_month: 15, next_run: "2026-09-15" });
    const out = enumerateOccurrences([r], "2026-09-01", "2026-09-30");
    expect(dates(out)).toEqual(["2026-09-15"]);
  });

  it("walks forward to the window when next_run is behind it", () => {
    const r = rule({ id: "r15", day_of_month: 15, next_run: "2026-06-15" });
    const out = enumerateOccurrences([r], "2026-09-01", "2026-10-31");
    expect(dates(out)).toEqual(["2026-09-15", "2026-10-15"]);
  });

  it("keeps occurrences that are already overdue when the window starts before today", () => {
    const r = rule({ id: "r15", day_of_month: 15, next_run: "2026-08-15" });
    const out = enumerateOccurrences([r], "2026-08-15", "2026-09-30");
    expect(dates(out)).toEqual(["2026-08-15", "2026-09-15"]);
  });

  it("clamps a day-31 monthly rule to each month's last day", () => {
    const r = rule({ id: "r31", day_of_month: 31, next_run: "2026-08-31" });
    const out = enumerateOccurrences([r], "2026-08-01", "2026-11-30");
    expect(dates(out)).toEqual(["2026-08-31", "2026-09-30", "2026-10-31", "2026-11-30"]);
  });

  it("walks a weekly rule by its weekday", () => {
    const r = rule({ id: "rw", freq: "weekly", day_of_month: null, weekday: 1, next_run: "2026-09-07" });
    const out = enumerateOccurrences([r], "2026-09-01", "2026-09-30");
    expect(dates(out)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  });

  it("includes a yearly rule inside the window and excludes one outside it", () => {
    const inside = rule({
      id: "ry-in",
      freq: "yearly",
      day_of_month: 14,
      month_of_year: 3,
      next_run: "2027-03-14",
    });
    const outside = rule({
      id: "ry-out",
      freq: "yearly",
      day_of_month: 14,
      month_of_year: 3,
      next_run: "2028-03-14",
    });
    const out = enumerateOccurrences([inside, outside], "2027-01-01", "2027-12-31");
    expect(out.map((o) => o.rule_id)).toEqual(["ry-in"]);
    expect(dates(out)).toEqual(["2027-03-14"]);
  });

  it("excludes an inactive rule entirely", () => {
    const active = rule({ id: "on", next_run: "2026-09-01" });
    const inactive = rule({ id: "off", next_run: "2026-09-01", active: false });
    const out = enumerateOccurrences([active, inactive], "2026-09-01", "2026-09-30");
    expect(out.map((o) => o.rule_id)).toEqual(["on"]);
  });

  it("contributes nothing when next_run is already past the window end", () => {
    const r = rule({ id: "later", next_run: "2027-01-01" });
    expect(enumerateOccurrences([r], "2026-09-01", "2026-09-30")).toEqual([]);
  });

  it("returns nothing for an empty window with no rules at all", () => {
    expect(enumerateOccurrences([], "2026-09-01", "2026-09-30")).toEqual([]);
  });

  it("carries the rule's payload onto every occurrence", () => {
    const r = rule({
      id: "rent",
      name: "Rent",
      amount_sen: 145_000,
      variable: true,
      category_id: "cat-bills",
      transfer_account_id: null,
      next_run: "2026-09-01",
    });
    const [first] = enumerateOccurrences([r], "2026-09-01", "2026-09-30");
    expect(first).toEqual({
      rule_id: "rent",
      name: "Rent",
      type: "expense",
      amount_sen: 145_000,
      variable: true,
      account_id: "acct-bank",
      transfer_account_id: null,
      category_id: "cat-bills",
      date: "2026-09-01",
    });
  });

  it("sorts every rule's occurrences into one ascending list", () => {
    const a = rule({ id: "a", name: "A", day_of_month: 20, next_run: "2026-09-20" });
    const b = rule({ id: "b", name: "B", day_of_month: 5, next_run: "2026-09-05" });
    const out = enumerateOccurrences([a, b], "2026-09-01", "2026-10-10");
    expect(dates(out)).toEqual(["2026-09-05", "2026-09-20", "2026-10-05"]);
  });

  it("caps a malformed rule's walk instead of looping forever", () => {
    // A weekly rule whose next_run is a decade stale still terminates.
    const r = rule({ id: "stale", freq: "weekly", day_of_month: null, weekday: 1, next_run: "2016-09-05" });
    const out = enumerateOccurrences([r], "2026-09-01", "2026-09-30");
    expect(dates(out)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
  });
});

describe("recoverRecordedOccurrences", () => {
  // The cron shape (Session 12 Question 12, owner-ruled fixed): the
  // materializer wrote the occurrence and advanced `next_run` past it, so
  // enumeration — which seeds at `next_run` — can never see it again. The
  // transaction itself carries the exact (rule, date) pair, so the occurrence
  // is recovered from it and renders `recorded ✓` instead of vanishing.
  it("recovers a cron-materialized occurrence from its transaction", () => {
    const rent = rule({
      id: "rent",
      name: "Rent",
      amount_sen: 180_000,
      day_of_month: 19,
      next_run: "2026-09-19", // the cron advanced past 2026-08-19 this morning
    });
    const recovered = recoverRecordedOccurrences(
      [rent],
      [recTx("rent", "2026-08-19")],
      "2026-08-19",
      "2026-09-18",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      rule_id: "rent",
      name: "Rent",
      type: "expense",
      amount_sen: 180_000,
      account_id: "acct-bank",
      date: "2026-08-19",
    });
  });

  // Q11a: the row a Paid bill renders is the money that ACTUALLY left, not
  // the rule's template — a variable bill is variable precisely because the
  // two differ. The recovered shape carries both, plus the transaction's id
  // so the row can point at it.
  it("carries the recorded transaction's actual amount and its id (Q11a)", () => {
    const rent = rule({ id: "rent", name: "Rent", amount_sen: 180_000, day_of_month: 19, next_run: "2026-09-19" });
    const recovered = recoverRecordedOccurrences(
      [rent],
      [recTx("rent", "2026-08-19", 175_500)],
      "2026-08-19",
      "2026-09-18",
    );
    expect(recovered[0]).toMatchObject({
      amount_sen: 180_000, // the template the rule holds — unchanged
      recorded_amount_sen: 175_500, // what was actually paid
      recorded_tx_id: "tx-rent-2026-08-19",
    });
  });

  it("never duplicates an occurrence enumeration still reaches (date >= next_run)", () => {
    // The `Record now` shape: the transaction exists but `next_run` has not
    // advanced yet, so the occurrence is still enumerated and classified
    // `recorded` there. Recovery must stay empty or the row would render twice.
    const rent = rule({ id: "rent", day_of_month: 19, next_run: "2026-08-19" });
    const recovered = recoverRecordedOccurrences(
      [rent],
      [recTx("rent", "2026-08-19")],
      "2026-08-19",
      "2026-09-18",
    );
    expect(recovered).toHaveLength(0);
  });

  it("ignores transactions outside the window, on unknown rules, and on inactive rules", () => {
    const rent = rule({ id: "rent", day_of_month: 19, next_run: "2026-09-19" });
    const paused = rule({ id: "paused", day_of_month: 5, next_run: "2026-09-05", active: false });
    const recovered = recoverRecordedOccurrences(
      [rent, paused],
      [
        recTx("rent", "2026-07-19"), // before the window
        recTx("gone", "2026-08-19"), // rule not in the set
        recTx("paused", "2026-08-05"), // inactive rule
      ],
      "2026-08-01",
      "2026-08-31",
    );
    expect(recovered).toHaveLength(0);
  });

  it("dedupes on (rule, date) and returns the (date, name, id) total order", () => {
    const a = rule({ id: "a", name: "Water", day_of_month: 10, next_run: "2026-09-10" });
    const b = rule({ id: "b", name: "Power", day_of_month: 10, next_run: "2026-09-10" });
    const recovered = recoverRecordedOccurrences(
      [a, b],
      [
        recTx("a", "2026-08-10"),
        recTx("a", "2026-08-10"), // duplicate pair
        recTx("b", "2026-08-10"),
      ],
      "2026-08-01",
      "2026-08-31",
    );
    expect(recovered.map((o) => o.rule_id)).toEqual(["b", "a"]); // Power < Water
  });

  it("recovers a materialized transfer occurrence with its type intact", () => {
    const sweep = rule({
      id: "sweep",
      name: "ASM sweep",
      type: "transfer",
      transfer_account_id: "acct-brokerage",
      day_of_month: 1,
      next_run: "2026-09-01",
    });
    const recovered = recoverRecordedOccurrences(
      [sweep],
      [recTx("sweep", "2026-08-01")],
      "2026-08-01",
      "2026-08-31",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ type: "transfer", transfer_account_id: "acct-brokerage" });
  });
});

describe("classifyOccurrences", () => {
  const today = "2026-08-19";

  it("assigns each occurrence exactly one of the four states", () => {
    const occurrences = enumerateOccurrences(
      [
        rule({ id: "subs", name: "Subscriptions", amount_sen: 5_500, day_of_month: 15, next_run: "2026-08-15" }),
        rule({ id: "ins", name: "Insurance", amount_sen: 21_000, day_of_month: 20, next_run: "2026-08-20" }),
        rule({ id: "late", name: "Water", amount_sen: 4_000, day_of_month: 10, next_run: "2026-08-10" }),
        rule({
          id: "usd",
          name: "US subscription",
          amount_sen: 3_000,
          account_id: "acct-usd",
          day_of_month: 12,
          next_run: "2026-08-12",
        }),
      ],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(
      occurrences,
      [recTx("subs", "2026-08-15")],
      ACCOUNTS,
      today,
    );

    expect(result.recorded.map((o) => o.rule_id)).toEqual(["subs"]);
    expect(result.overdue.map((o) => o.rule_id)).toEqual(["late"]);
    expect(result.upcoming.map((o) => o.rule_id)).toEqual(["ins"]);
    expect(result.blocked.map((o) => o.rule_id)).toEqual(["usd"]);

    // Exactly one state each — the four groups partition the input.
    const total =
      result.recorded.length + result.overdue.length + result.upcoming.length + result.blocked.length;
    expect(total).toBe(occurrences.length);
  });

  // Q11a, the other half: an occurrence enumeration still reaches (the
  // `Record now` shape, where next_run has not advanced yet) carries the same
  // pair, so both recorded lists render identically.
  it("a recorded occurrence carries the transaction's actual amount and id (Q11a)", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "subs", amount_sen: 5_500, day_of_month: 15, next_run: "2026-08-15" })],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [recTx("subs", "2026-08-15", 6_120)], ACCOUNTS, today);
    expect(result.recorded[0]).toMatchObject({
      amount_sen: 5_500,
      recorded_amount_sen: 6_120,
      recorded_tx_id: "tx-subs-2026-08-15",
    });
  });

  it("an unrecorded occurrence carries no recorded figure to render (Q11a)", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "subs", amount_sen: 5_500, day_of_month: 15, next_run: "2026-08-15" })],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.recorded).toHaveLength(0);
    expect(result.overdue[0]).not.toHaveProperty("recorded_amount_sen");
  });

  it("treats today's occurrence as upcoming, not overdue", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "now", day_of_month: 19, next_run: "2026-08-19" })],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.upcoming).toHaveLength(1);
    expect(result.overdue).toHaveLength(0);
  });

  it("matches `recorded` exactly on (rule, date) — never on amount or a nearby date", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "subs", amount_sen: 5_500, day_of_month: 15, next_run: "2026-08-15" })],
      "2026-08-01",
      "2026-08-31",
    );
    const wrongDate = classifyOccurrences(
      occurrences,
      [recTx("subs", "2026-08-14")],
      ACCOUNTS,
      today,
    );
    expect(wrongDate.recorded).toHaveLength(0);
    expect(wrongDate.overdue.map((o) => o.date)).toEqual(["2026-08-15"]);

    const wrongRule = classifyOccurrences(
      occurrences,
      [recTx("other", "2026-08-15")],
      ACCOUNTS,
      today,
    );
    expect(wrongRule.recorded).toHaveLength(0);
  });

  it("blocks a rule whose destination leg is non-MYR, and names the reason", () => {
    const occurrences = enumerateOccurrences(
      [
        rule({
          id: "topup",
          name: "USD top-up",
          type: "transfer",
          transfer_account_id: "acct-usd",
          next_run: "2026-08-25",
        }),
      ],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toContain("USD");
    expect(result.blocked[0]!.reason).toContain("IBKR USD");
  });

  it("blocks a rule on an archived account", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "old", account_id: "acct-old", next_run: "2026-08-25" })],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toContain("archived");
  });

  // The two axes ruling 11a lumped together. `materializeDueRules` skips on
  // currency and on an unresolvable id, and NOT on `archived` — so an archived
  // MYR rule's money really moves and the projection has to see it.
  it("says the cron WILL still materialize an archived-MYR-account rule", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "old", account_id: "acct-old", next_run: "2026-08-25" })],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.blocked[0]!.cron_materializes).toBe(true);
  });

  it("says the cron will NOT materialize a non-MYR or unresolvable leg", () => {
    const nonMyr = classifyOccurrences(
      enumerateOccurrences(
        [rule({ id: "usd", account_id: "acct-usd", next_run: "2026-08-25" })],
        "2026-08-01",
        "2026-08-31",
      ),
      [],
      ACCOUNTS,
      today,
    );
    expect(nonMyr.blocked[0]!.cron_materializes).toBe(false);

    const ghost = classifyOccurrences(
      enumerateOccurrences(
        [rule({ id: "ghost", account_id: "acct-missing", next_run: "2026-08-25" })],
        "2026-08-01",
        "2026-08-31",
      ),
      [],
      ACCOUNTS,
      today,
    );
    expect(ghost.blocked[0]!.cron_materializes).toBe(false);
  });

  it("an archived leg does NOT make a rule materializable when the other leg is non-MYR", () => {
    // The enumeration trap: source archived (pass 2's axis), destination
    // non-MYR (pass 1's). The cron skips the whole rule, so cron_materializes
    // must be false — and the reason names the leg that actually stops it.
    const occurrences = enumerateOccurrences(
      [
        rule({
          id: "both",
          type: "transfer",
          account_id: "acct-old",
          transfer_account_id: "acct-usd",
          next_run: "2026-08-25",
        }),
      ],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.cron_materializes).toBe(false);
    expect(result.blocked[0]!.reason).toContain("IBKR USD");
  });

  it("blocks an occurrence whose account cannot be resolved rather than dropping it", () => {
    const occurrences = enumerateOccurrences(
      [rule({ id: "ghost", account_id: "acct-missing", next_run: "2026-08-25" })],
      "2026-08-01",
      "2026-08-31",
    );
    const result = classifyOccurrences(occurrences, [], ACCOUNTS, today);
    expect(result.blocked).toHaveLength(1);
    expect(result.upcoming).toHaveLength(0);
  });

  it("blocked beats overdue, and recorded beats blocked", () => {
    const pastNonMyr = enumerateOccurrences(
      [rule({ id: "usd", account_id: "acct-usd", day_of_month: 10, next_run: "2026-08-10" })],
      "2026-08-01",
      "2026-08-15",
    );
    expect(classifyOccurrences(pastNonMyr, [], ACCOUNTS, today).blocked).toHaveLength(1);
    expect(classifyOccurrences(pastNonMyr, [], ACCOUNTS, today).overdue).toHaveLength(0);

    const recordedNonMyr = classifyOccurrences(
      pastNonMyr,
      [recTx("usd", "2026-08-10")],
      ACCOUNTS,
      today,
    );
    expect(recordedNonMyr.recorded).toHaveLength(1);
    expect(recordedNonMyr.blocked).toHaveLength(0);
  });
});

describe("projectBalance", () => {
  const today = "2026-08-19";
  const from = "2026-08-19";
  const to = "2026-09-18";
  const START = 648_000;

  const RULES: BillRule[] = [
    rule({ id: "subs", name: "Subscriptions", amount_sen: 5_500, day_of_month: 15, next_run: "2026-08-15" }),
    rule({
      id: "ins",
      name: "Insurance",
      amount_sen: 21_000,
      variable: true,
      day_of_month: 20,
      next_run: "2026-08-20",
    }),
    rule({
      id: "salary",
      name: "Salary",
      type: "income",
      amount_sen: 520_000,
      day_of_month: 28,
      next_run: "2026-08-28",
    }),
    rule({ id: "rent", name: "Rent", amount_sen: 145_000, next_run: "2026-09-01" }),
    rule({
      id: "usd",
      name: "US subscription",
      amount_sen: 30_000,
      account_id: "acct-usd",
      day_of_month: 22,
      next_run: "2026-08-22",
    }),
  ];

  function consumed() {
    const occurrences = enumerateOccurrences(RULES, "2026-08-15", to);
    const classified = classifyOccurrences(
      occurrences,
      [recTx("subs", "2026-08-15")],
      ACCOUNTS,
      today,
    );
    return [...classified.overdue, ...classified.upcoming];
  }

  it("consumes only upcoming and overdue — recorded and blocked never step the series", () => {
    const projection = projectBalance(START, consumed(), SPENDABLE, from, to);

    // Hand-computed: 648,000 → −21,000 (20 Aug) → +520,000 (28 Aug)
    //                        → −145,000 (1 Sep) → −5,500 (15 Sep, the NEXT
    // Subscriptions occurrence — the 15 Aug one is recorded, this one is not,
    // which is what makes the exclusion per-occurrence and not per-rule).
    // Lowest point 627,000 on 20 Aug.
    expect(projection.series).toEqual([
      { date: "2026-08-19", balance_sen: 648_000 },
      { date: "2026-08-20", balance_sen: 627_000 },
      { date: "2026-08-28", balance_sen: 1_147_000 },
      { date: "2026-09-01", balance_sen: 1_002_000 },
      { date: "2026-09-15", balance_sen: 996_500 },
      { date: "2026-09-18", balance_sen: 996_500 },
    ]);
    expect(projection.min_sen).toBe(627_000);
    expect(projection.min_date).toBe("2026-08-20");
    expect(projection.end_sen).toBe(996_500);

    // The double-count regression: counting the recorded 5,500 would make the
    // low point 621,500, and the blocked 30,000 would make it 597,000.
    expect(projection.min_sen).not.toBe(621_500);
    expect(projection.min_sen).not.toBe(597_000);
  });

  it("discloses the variable rules it contains and their total", () => {
    const projection = projectBalance(START, consumed(), SPENDABLE, from, to);
    expect(projection.variable_occurrences.map((o) => o.rule_id)).toEqual(["ins"]);
    expect(projection.variable_total_sen).toBe(21_000);
  });

  it("puts income before a bill above the low point and after it below", () => {
    const before = projectBalance(
      100_000,
      [occ({ rule_id: "in", type: "income", amount_sen: 50_000, date: "2026-08-20" }), occ({ rule_id: "out", amount_sen: 120_000, date: "2026-08-25" })],
      SPENDABLE,
      from,
      to,
    );
    expect(before.min_sen).toBe(30_000);
    expect(before.min_date).toBe("2026-08-25");

    const after = projectBalance(
      100_000,
      [occ({ rule_id: "out", amount_sen: 120_000, date: "2026-08-20" }), occ({ rule_id: "in", type: "income", amount_sen: 50_000, date: "2026-08-25" })],
      SPENDABLE,
      from,
      to,
    );
    expect(after.min_sen).toBe(-20_000);
    expect(after.min_date).toBe("2026-08-20");
    expect(after.end_sen).toBe(30_000);
  });

  it("nets a transfer inside the spendable set to zero — it never double-counts", () => {
    const projection = projectBalance(
      100_000,
      [
        occ({
          rule_id: "move",
          type: "transfer",
          amount_sen: 50_000,
          account_id: "acct-bank",
          transfer_account_id: "acct-ewallet",
          date: "2026-08-25",
        }),
      ],
      SPENDABLE,
      from,
      to,
    );
    expect(projection.series).toEqual([
      { date: "2026-08-19", balance_sen: 100_000 },
      { date: "2026-09-18", balance_sen: 100_000 },
    ]);
    expect(projection.min_sen).toBe(100_000);
    expect(projection.min_date).toBe("2026-08-19");
  });

  it("steps the series when a transfer crosses the spendable boundary, in both directions", () => {
    const out = projectBalance(
      100_000,
      [
        occ({
          rule_id: "invest",
          type: "transfer",
          amount_sen: 50_000,
          account_id: "acct-bank",
          transfer_account_id: "acct-brokerage",
          date: "2026-08-25",
        }),
      ],
      SPENDABLE,
      from,
      to,
    );
    expect(out.min_sen).toBe(50_000);
    expect(out.min_date).toBe("2026-08-25");

    const back = projectBalance(
      100_000,
      [
        occ({
          rule_id: "withdraw",
          type: "transfer",
          amount_sen: 50_000,
          account_id: "acct-brokerage",
          transfer_account_id: "acct-bank",
          date: "2026-08-25",
        }),
      ],
      SPENDABLE,
      from,
      to,
    );
    expect(back.end_sen).toBe(150_000);
    expect(back.min_sen).toBe(100_000);
    expect(back.min_date).toBe("2026-08-19");
  });

  it("ignores an expense on a non-spendable account entirely", () => {
    const projection = projectBalance(
      100_000,
      [occ({ rule_id: "fee", amount_sen: 5_000, account_id: "acct-brokerage", date: "2026-08-25" })],
      SPENDABLE,
      from,
      to,
    );
    expect(projection.end_sen).toBe(100_000);
    expect(projection.series).toHaveLength(2);
  });

  it("steps an overdue occurrence at the window start — the money still has to leave", () => {
    const projection = projectBalance(
      100_000,
      [occ({ rule_id: "late", amount_sen: 4_000, date: "2026-08-10" })],
      SPENDABLE,
      from,
      to,
    );
    expect(projection.series[0]).toEqual({ date: "2026-08-19", balance_sen: 100_000 });
    expect(projection.series[1]).toEqual({ date: "2026-08-19", balance_sen: 96_000 });
    expect(projection.min_sen).toBe(96_000);
    expect(projection.min_date).toBe("2026-08-19");
  });

  it("reports the starting balance as the low point when nothing goes out", () => {
    const projection = projectBalance(
      500_000,
      [occ({ rule_id: "in", type: "income", amount_sen: 100_000, date: "2026-08-28" })],
      SPENDABLE,
      from,
      to,
    );
    expect(projection.min_sen).toBe(500_000);
    expect(projection.min_date).toBe("2026-08-19");
  });

  it("returns a flat two-point series for a window with no occurrences at all", () => {
    const projection = projectBalance(500_000, [], SPENDABLE, from, to);
    expect(projection.series).toEqual([
      { date: "2026-08-19", balance_sen: 500_000 },
      { date: "2026-09-18", balance_sen: 500_000 },
    ]);
    expect(projection.min_sen).toBe(500_000);
    expect(projection.min_date).toBe("2026-08-19");
    expect(projection.variable_occurrences).toEqual([]);
    expect(projection.variable_total_sen).toBe(0);
  });

  it("drops an occurrence beyond the window end", () => {
    const projection = projectBalance(
      500_000,
      [occ({ rule_id: "far", amount_sen: 100_000, date: "2026-12-01" })],
      SPENDABLE,
      from,
      to,
    );
    expect(projection.end_sen).toBe(500_000);
  });

  it("excludes a variable occurrence that has no effect on the series from the disclosure", () => {
    const projection = projectBalance(
      100_000,
      [
        occ({
          rule_id: "move",
          type: "transfer",
          variable: true,
          amount_sen: 50_000,
          account_id: "acct-bank",
          transfer_account_id: "acct-ewallet",
          date: "2026-08-25",
        }),
      ],
      SPENDABLE,
      from,
      to,
    );
    expect(projection.variable_occurrences).toEqual([]);
    expect(projection.variable_total_sen).toBe(0);
  });
});

describe("dueSoon", () => {
  const today = "2026-08-19";

  const occurrences: Occurrence[] = [
    occ({ rule_id: "late", name: "Water", amount_sen: 4_000, date: "2026-08-10" }),
    occ({ rule_id: "ins", name: "Insurance", amount_sen: 21_000, variable: true, date: "2026-08-20" }),
    occ({ rule_id: "salary", name: "Salary", type: "income", amount_sen: 520_000, date: "2026-08-28" }),
    occ({ rule_id: "rent", name: "Rent", amount_sen: 145_000, date: "2026-09-01" }),
    occ({
      rule_id: "move",
      name: "Auto-invest",
      type: "transfer",
      amount_sen: 50_000,
      transfer_account_id: "acct-brokerage",
      date: "2026-08-21",
    }),
  ];

  it("returns the bills inside the window, overdue included, and their total", () => {
    const payload = dueSoon(occurrences, today, 7);
    expect(payload.bills.map((b) => b.rule_id)).toEqual(["late", "ins"]);
    expect(payload.total_sen).toBe(25_000);
    expect(payload.count).toBe(2);
  });

  it("never counts a transfer as a bill", () => {
    const payload = dueSoon(occurrences, today, 7);
    expect(payload.bills.some((b) => b.type === "transfer")).toBe(false);
  });

  it("names the next expected income even when it falls outside the bill window", () => {
    const payload = dueSoon(occurrences, today, 7);
    expect(payload.next_income?.rule_id).toBe("salary");
  });

  it("is empty when nothing is due", () => {
    const payload = dueSoon([], today, 7);
    expect(payload.bills).toEqual([]);
    expect(payload.total_sen).toBe(0);
    expect(payload.count).toBe(0);
    expect(payload.next_income).toBeNull();
  });
});

function occ(over: Partial<Occurrence> & { rule_id: string; date: string }): Occurrence {
  return {
    name: over.rule_id,
    type: "expense",
    amount_sen: 1_000,
    variable: false,
    account_id: "acct-bank",
    transfer_account_id: null,
    category_id: null,
    ...over,
  };
}
