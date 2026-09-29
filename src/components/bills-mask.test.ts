import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BillsTable, BillsList, type BillFormOptions } from "@/components/BillsTable";
import type { BillRow, RecordedBillRow } from "@/db/bills";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";

/**
 * Plan 9 Task 3b — the Bills list (desktop table, mobile cards) under the
 * amounts mask: the amount cell, an income row's `+ RM x` (the `+` stays —
 * direction, ruling 4) and ruling 4's named `template RM 180.00` suffix all
 * mask; dates, names, accounts, pills and `Record now` stay.
 */
const TODAY = "2077-03-19";
/** Tags stripped: a server-rendered mask is `<Money>`'s aria-labelled span. */
const plain = (html: string) => html.replace(/<[^>]+>/g, "");

const base: BillRow = {
  rule_id: "rule-elec",
  name: "Electricity",
  type: "expense",
  amount_sen: 18_000,
  variable: true,
  account_id: "acct-bank",
  transfer_account_id: null,
  category_id: "cat-bills",
  date: "2077-03-10",
  account_name: "Maybank",
  transfer_account_name: null,
  category_name: "Bills",
  record_id: "1d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
};
const recorded: RecordedBillRow = { ...base, recorded_amount_sen: 17_550, recorded_tx_id: "0d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6" };
const salary: BillRow = {
  ...base,
  rule_id: "rule-salary",
  name: "Salary",
  type: "income",
  amount_sen: 654_321,
  variable: false,
  category_name: "Salary",
  date: "2077-03-25",
};
const form: BillFormOptions = {
  accounts: [{ id: "acct-bank", name: "Maybank", currency: "MYR", archived: false }],
  categories: [{ id: "cat-bills", name: "Bills", kind: "expense", archived: false }],
  funds: [],
  todayStr: TODAY,
};
const props = { upcoming: [salary], overdue: [], recorded: [recorded], todayIso: TODAY, form };
const SEEDED = ["180.00", "175.50", "6,543.21"];

describe("BillsTable (desktop)", () => {
  it("shown: the paid amount, its template suffix and the income row print", () => {
    const html = renderToStaticMarkup(createElement(BillsTable, props));
    expect(html).toContain("RM 175.50");
    expect(html).toContain("template RM 180.00");
    expect(html).toContain("+ RM 6,543.21");
  });

  it("hidden: every figure masks; the `+`, `template`, names and Record now stay", () => {
    const html = renderMasked(createElement(BillsTable, props));
    const text = plain(html);
    expect(text).toContain(`template ${MASKED_MYR}`);
    expect(text).toContain(`+ ${MASKED_MYR}`);
    expect(text).toContain("Electricity");
    expect(html).toContain(">Record now<");
    assertNoMoney(html, SEEDED);
  });
});

describe("BillsList (mobile)", () => {
  it("shown: the card amounts and the template suffix print", () => {
    const html = renderToStaticMarkup(createElement(BillsList, props));
    expect(html).toContain("RM 175.50");
    expect(html).toContain(" · template RM 180.00");
    expect(html).toContain("+ RM 6,543.21");
  });

  it("hidden: every figure masks; the functional line keeps its words", () => {
    const html = renderMasked(createElement(BillsList, props));
    const text = plain(html);
    expect(text).toContain(`recorded ✓ · template ${MASKED_MYR}`);
    expect(text).toContain(`+ ${MASKED_MYR}`);
    assertNoMoney(html, SEEDED);
  });
});
