import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMasked } from "@/test/render-money";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { ActivityList } from "@/components/ActivityList";
import type { EnrichedTxRow } from "@/lib/tx-display";

/**
 * Plan 9 Task 2 — the mobile Activity list (mockup v8 §15 phone 2): the day
 * header total and every row mask; states (the `review` pill) and the
 * income row's `+` stay.
 */
const TODAY = "2077-03-19";

const row = (over: Partial<EnrichedTxRow>): EnrichedTxRow => ({
  id: "0d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
  type: "expense",
  amount_sen: 2_790,
  account_id: "acct-mb",
  transfer_account_id: null,
  received_sen: null,
  category_id: "cat-food",
  date: TODAY,
  note: "Grab",
  source: "nl",
  needs_review: true,
  expected_back_sen: 0,
  fund_id: null,
  paid_sen: 0,
  splits: [],
  accountName: "Maybank",
  accountCurrency: "MYR",
  transferAccountName: null,
  categoryName: "Transport",
  ...over,
});

const rows = [
  row({}),
  row({ id: "1d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6", type: "income", amount_sen: 25_000, note: "Salary", needs_review: false }),
];

const props = {
  rows,
  todayStr: TODAY,
  yesterdayStr: "2077-03-18",
  accounts: [{ id: "acct-mb", name: "Maybank", currency: "MYR", archived: false }],
  categories: [{ id: "cat-food", name: "Food", kind: "expense" as const, archived: false }],
  emptyLabel: "No transactions this month.",
};

describe("ActivityList", () => {
  it("shown: day total and rows print their figures", () => {
    const html = renderToStaticMarkup(createElement(ActivityList, props));
    expect(html).toContain("RM 27.90");
    expect(html).toContain("+RM 250.00");
  });

  it("hidden: no figure survives; the review pill and the income `+` stay", () => {
    const html = renderMasked(createElement(ActivityList, props));
    expect(html).toContain(MASKED_MYR);
    expect(html).toContain(">review<");
    expect(html).toContain(`+${MASKED_MYR}`);
    assertNoMoney(html, ["27.90", "250.00"]);
  });
});
