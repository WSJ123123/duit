import { describe, it, expect } from "vitest";
import { validateTransactionInput } from "@/lib/transactions";

const base = { type: "expense" as const, amount: "300.00", accountId: "acc-1", date: "2026-08-15" };

it("accepts expense with reimbursement expectation", () => {
  const r = validateTransactionInput({ ...base, expectedBack: "240.00" });
  expect(r.ok && r.value.expected_back_sen === 24_000).toBe(true);
});
it("rejects splits that do not sum", () => {
  const r = validateTransactionInput({ ...base, splits: [
    { categoryId: "c1", amount: "100.00" }, { categoryId: "c2", amount: "199.99" },
  ]});
  expect(r.ok).toBe(false);
});
it("accepts splits that sum exactly", () => {
  const r = validateTransactionInput({ ...base, splits: [
    { categoryId: "c1", amount: "100.00" }, { categoryId: "c2", amount: "200.00" },
  ]});
  expect(r.ok && r.splits.length === 2).toBe(true);
});
it("rejects transfer to same account / expense with destination", () => {
  expect(validateTransactionInput({ ...base, type: "transfer", transferAccountId: "acc-1" }).ok).toBe(false);
});
it("rejects unparseable amounts", () => {
  expect(validateTransactionInput({ ...base, amount: "12.345" }).ok).toBe(false);
});

/**
 * Plan 7 rulings 6 and 7 — the lib backstop under the table CHECK
 * (`fund_id is null or type = 'expense'`). Neither layer may drop a tag
 * silently: a rejected input is a visible error, never a quietly cleared
 * fund_id, because that would move a fund balance with no trace of why.
 */
describe("fund tagging (rulings 6, 7)", () => {
  const FUND = "fund-1";

  it("carries fundId onto the row as fund_id for a clean expense", () => {
    const r = validateTransactionInput({ ...base, fundId: FUND });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fund_id).toBe(FUND);
  });

  it("leaves fund_id null when no fund is chosen", () => {
    const r = validateTransactionInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fund_id).toBeNull();
  });

  it("rejects a fund on an income", () => {
    const r = validateTransactionInput({ type: "income", amount: "50.00", accountId: "acc-1", date: "2026-08-15", fundId: FUND });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expense/i);
  });

  it("rejects a fund on a transfer", () => {
    const r = validateTransactionInput({
      type: "transfer",
      amount: "50.00",
      accountId: "acc-1",
      transferAccountId: "acc-2",
      date: "2026-08-15",
      fundId: FUND,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expense/i);
  });

  it("PIN (ruling 6, Plan 8 Smoke Minor B): rejects a fund together with a non-zero expectedBack, naming the rule and the fix", () => {
    const r = validateTransactionInput({ ...base, fundId: FUND, expectedBack: "240.00" });
    expect(r.ok).toBe(false);
    // The same string performUpdate's merged-row guard (c) uses: the rule
    // (a fund can't pay an expense that has money owed back) and the fix.
    if (!r.ok) {
      expect(r.error).toBe(
        "A fund can't pay an expense that has money owed back — clear the expected-back amount first",
      );
    }
  });

  it("allows a fund with an explicit zero expectedBack (only a POSITIVE amount conflicts)", () => {
    const r = validateTransactionInput({ ...base, fundId: FUND, expectedBack: "0.00" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fund_id).toBe(FUND);
      expect(r.value.expected_back_sen).toBe(0);
    }
  });
});

/**
 * Plan 7 ruling 14 — `Record now`'s two carried fields. The link is
 * PROVENANCE, not a user-editable tag: the row omits the column entirely
 * unless the caller supplies it, so an ordinary edit cannot un-record a
 * materialized bill.
 */
describe("recurring link (ruling 14)", () => {
  const RULE = "0f7a4f22-6f3c-4c0e-9d84-2a1b3c4d5e6f";

  it("carries recurringRuleId onto the row as recurring_rule_id", () => {
    const r = validateTransactionInput({ ...base, recurringRuleId: RULE });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recurring_rule_id).toBe(RULE);
  });

  it("OMITS the column (does not null it) when no rule is given", () => {
    const r = validateTransactionInput(base);
    expect(r.ok).toBe(true);
    // `in` rather than `=== undefined`: an update statement built from this
    // row must not mention the column at all.
    if (r.ok) expect("recurring_rule_id" in r.value).toBe(false);
  });

  it("rejects a recurringRuleId that is not a uuid", () => {
    expect(validateTransactionInput({ ...base, recurringRuleId: "rule-1" }).ok).toBe(false);
  });

  it("carries the link on a transfer occurrence too", () => {
    const r = validateTransactionInput({
      type: "transfer",
      amount: "50.00",
      accountId: "acc-1",
      transferAccountId: "acc-2",
      date: "2026-08-15",
      recurringRuleId: RULE,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recurring_rule_id).toBe(RULE);
  });
});

/**
 * Plan 8 ruling 11: the batch tag is PROVENANCE like the recurring link —
 * set only by the import's commit, never by a form — so it takes the same
 * "absent ⇒ leave the column alone" shape.
 */
describe("import batch tag (Plan 8 ruling 11)", () => {
  const BATCH = "5c1e9a70-2b4d-4f6e-8a9b-0c1d2e3f4a5b";

  it("carries importBatchId onto the row as import_batch_id", () => {
    const r = validateTransactionInput({ ...base, importBatchId: BATCH, source: "import" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.import_batch_id).toBe(BATCH);
  });

  it("OMITS the column (does not null it) when no batch is given", () => {
    const r = validateTransactionInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect("import_batch_id" in r.value).toBe(false);
  });

  it("rejects an importBatchId that is not a uuid", () => {
    expect(validateTransactionInput({ ...base, importBatchId: "batch-1" }).ok).toBe(false);
  });
});
