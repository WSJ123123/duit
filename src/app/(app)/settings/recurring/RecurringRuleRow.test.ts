import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";
import { RecurringRuleRow } from "./RecurringRuleRow";

/**
 * Plan 9 Task 3b — Settings › Recurring: a rule's amount masks at rest
 * (ruling 4, "recurring rules' amounts"); `variable`, the cadence, the
 * account, `Next …` and the state pill stay. The inline edit form's amount is
 * an input value and is never masked.
 */
const rule = {
  id: "rule-1",
  name: "Internet",
  type: "expense" as const,
  amount_sen: 18_000,
  variable: false,
  account_id: "acct-1",
  transfer_account_id: null,
  category_id: "cat-1",
  freq: "monthly" as const,
  day_of_month: 5,
  weekday: null,
  month_of_year: null,
};
const props = { rule, active: true, accountName: "Maybank", nextRun: "5 Jul", accounts: [], categories: [] };

describe("RecurringRuleRow", () => {
  it("shown: the rule's amount prints", () => {
    expect(renderToStaticMarkup(createElement(RecurringRuleRow, props))).toContain("RM 180.00");
  });

  it("hidden: the amount masks; cadence, account, next run and state stay", () => {
    const html = renderMasked(createElement(RecurringRuleRow, props));
    expect(html).toContain(MASKED_MYR);
    expect(html).toContain("Maybank");
    expect(html).toContain("Next 5 Jul");
    expect(html).toContain("Active");
    assertNoMoney(html, ["180.00"]);
  });

  it("hidden: a variable rule still reads `variable`", () => {
    const html = renderMasked(createElement(RecurringRuleRow, { ...props, rule: { ...rule, variable: true } }));
    expect(html).toContain(">variable<");
    assertNoMoney(html, ["180.00"]);
  });
});
