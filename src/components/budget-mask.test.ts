import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMasked } from "@/test/render-money";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import type { BudgetMonthData } from "@/db/budget";

// Month switcher / Cancel / Save navigate through the router; stubbed.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
// `AllocStrip` is on Task 3's sweep list (its own file); it is stubbed here so
// this test pins exactly the figures Task 2 owns in BudgetTable.
vi.mock("@/components/AllocStrip", () => ({ AllocStrip: () => null }));

const { BudgetTable } = await import("@/components/BudgetTable");
const { BudgetMobile } = await import("@/components/BudgetMobile");

/**
 * Plan 9 Task 2 — the Budget page (desktop table + mobile) under the amounts
 * mask, plus Q19: the `Paid from funds` line carries the Dashboard's
 * `· incl. archived funds` suffix, through the same helper (`fundSpendLine`).
 */
const data: BudgetMonthData = {
  month: "2077-03",
  planned: true,
  expected_income_sen: 800_000,
  savings: {
    planned_sen: 100_000,
    allocated_sen: 120_000,
    set_aside_sen: 45_600,
    funds: [{ id: "fund-em", name: "Emergency", contribution_sen: 30_000 }],
  },
  rows: [
    {
      category_id: "cat-food",
      name: "Food",
      tag: "needs",
      archived: false,
      prev_spent_sen: 61_234,
      prev_allocated_sen: 50_000,
      planned_sen: 50_000,
      allocated_sen: 54_321,
      spent_sen: 43_210,
    },
    {
      category_id: "cat-fun",
      name: "Fun",
      tag: "wants",
      archived: false,
      prev_spent_sen: 9_000,
      prev_allocated_sen: 10_000,
      planned_sen: 10_000,
      allocated_sen: 10_000,
      spent_sen: 12_345,
    },
  ],
  unbudgeted: [{ category_id: null, name: "Uncategorized", spent_sen: 7_777 }],
  prev: { expected_income_sen: 800_000, savings_allocated_sen: 100_000 },
  totals: { allocated_sen: 64_321, spent_sen: 55_555, income_sen: 800_000, expense_sen: 76_432, fund_spend_sen: 21_098 },
  change_count: 2,
  benchmark: { needs_pct: 50, wants_pct: 30, savings_pct: 20 },
};

const SEEDED = ["543.21", "432.10", "612.34", "123.45", "77.77", "210.98", "1,200.00", "456.00", "300.00"];

const tableProps = (isPast: boolean) => ({
  month: "2077-03",
  monthLabel: "March 2077",
  monthName: "March",
  prevMonthName: "February",
  prevMonthAbbrev: "Feb",
  prevLink: null,
  nextLink: null,
  isPast,
  data,
});

const mobileProps = {
  month: "2077-03",
  monthName: "March",
  monthOptions: [{ value: "2077-03", label: "March 2077" }],
  data,
  isPast: false,
  todayStr: "2077-03-19",
  bannerVisible: false,
  bannerHref: "/budget?month=2077-04",
  bannerNextMonthName: "April",
  bannerCurrentMonthName: "March",
  bannerOpenDateLabel: "25 Mar",
};


describe("BudgetTable", () => {
  it("shown: rows print their figures; Q19 — `Paid from funds RM x · incl. archived funds`", () => {
    const html = renderToStaticMarkup(createElement(BudgetTable, tableProps(false)));
    expect(html).toContain("RM 543.21");
    expect(html).toContain("RM 432.10");
    expect(html).toContain("Paid from funds RM 210.98 · incl. archived funds");
  });

  it("hidden (track): no figure survives the mask", () => {
    const html = renderMasked(createElement(BudgetTable, tableProps(false)));
    expect(html).toContain(MASKED_MYR);
    expect(html).toContain(`Paid from funds ${MASKED_MYR} · incl. archived funds`);
    assertNoMoney(html, SEEDED);
  });

  it("hidden (review): planned / adjusted / actual mask", () => {
    const html = renderMasked(createElement(BudgetTable, tableProps(true)));
    assertNoMoney(html, SEEDED);
  });

  it("hidden (edit): the allocation inputs keep their figures, nothing else prints one", () => {
    const html = renderMasked(createElement(BudgetTable, { ...tableProps(false), startInEdit: true }));
    expect(html).toContain('value="543.21"');
    assertNoMoney(html, ["432.10", "612.34", "77.77", "210.98"]);
  });
});

describe("BudgetMobile", () => {
  it("shown: the hero and rows print their figures; Q19 suffix on the funds line", () => {
    const html = renderToStaticMarkup(createElement(BudgetMobile, mobileProps));
    expect(html).toContain("RM 432.10");
    expect(html).toContain("/ 543.21");
    expect(html).toContain("Paid from funds RM 210.98 · incl. archived funds");
  });

  it("hidden: no figure survives the mask", () => {
    const html = renderMasked(createElement(BudgetMobile, mobileProps));
    expect(html).toContain(MASKED_MYR);
    assertNoMoney(html, SEEDED);
  });
});
