import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMasked } from "@/test/render-money";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { CashflowChart } from "@/components/CashflowChart";

/**
 * Plan 9 Task 2 — the Bills page's Projected cash card: its four HTML-span
 * figures (spendable today, the start, the low point, the end) mask; the SVG
 * step path is a shape with no axis figures and stays.
 */
const props = {
  projection: {
    series: [
      { date: "2077-03-19", balance_sen: 123_456 },
      { date: "2077-03-21", balance_sen: 105_456 },
      { date: "2077-04-18", balance_sen: 755_456 },
    ],
    min_sen: 105_456,
    min_date: "2077-03-21",
    end_sen: 755_456,
    variable_occurrences: [],
    variable_total_sen: 0,
  },
  fromIso: "2077-03-19",
  toIso: "2077-04-18",
  windowDays: 30,
  spendableBaseSen: 123_456,
  spendableAccounts: ["Maybank"],
  excludedAccountCount: 0,
};

describe("CashflowChart", () => {
  it("shown: the four spans print their figures", () => {
    const html = renderToStaticMarkup(createElement(CashflowChart, props));
    expect(html).toContain("spendable today RM 1,234.56");
    expect(html).toContain("RM 1,054.56");
    expect(html).toContain("RM 7,554.56");
  });

  it("hidden: no figure survives; the step path is untouched", () => {
    const shown = renderToStaticMarkup(createElement(CashflowChart, props));
    const html = renderMasked(createElement(CashflowChart, props));
    expect(html).toContain(MASKED_MYR);
    const pathOf = (s: string) => s.match(/<path[^>]*d="([^"]*)"/)?.[1];
    expect(pathOf(html)).toBe(pathOf(shown));
    assertNoMoney(html, ["1,234.56", "1,054.56", "7,554.56"]);
  });
});
