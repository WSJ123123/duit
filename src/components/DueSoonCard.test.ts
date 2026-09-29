import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMasked } from "@/test/render-money";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { DueSoonCard } from "@/components/DueSoonCard";
import type { DueSoonRow } from "@/db/bills";

/** Plan 9 Task 2 — the Dashboard's Due soon card under the amounts mask. */
const bill: DueSoonRow = {
  rule_id: "rule-water",
  name: "Water",
  type: "expense",
  amount_sen: 18_000,
  variable: false,
  account_id: "acct-mb",
  transfer_account_id: null,
  category_id: "cat-bills",
  date: "2077-03-21",
  account_name: "Maybank",
  transfer_account_name: null,
  category_name: "Bills",
  record_id: "1d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
  blocked_reason: null,
};
const income: DueSoonRow = { ...bill, rule_id: "rule-pay", name: "Salary", type: "income", amount_sen: 650_000 };

const props = {
  dueSoon: { bills: [bill], total_sen: 18_000, count: 1, next_income: income },
  projection: {
    series: [{ date: "2077-03-19", balance_sen: 123_456 }],
    min_sen: 105_456,
    min_date: "2077-03-21",
    end_sen: 755_456,
    variable_occurrences: [],
    variable_total_sen: 0,
  },
  todayIso: "2077-03-19",
};

describe("DueSoonCard", () => {
  it("shown: total, rows, income and the low point print their figures", () => {
    const html = renderToStaticMarkup(createElement(DueSoonCard, props));
    expect(html).toContain("RM 180.00");
    expect(html).toContain("+ RM 6,500.00");
    expect(html).toContain("RM 1,054.56");
  });

  it("hidden: no figure survives; the income `+` stays", () => {
    const html = renderMasked(createElement(DueSoonCard, props));
    expect(html).toContain(`+ <span role="img" aria-label="amount hidden">${MASKED_MYR}</span>`);
    assertNoMoney(html, ["180.00", "6,500.00", "1,054.56"]);
  });
});
