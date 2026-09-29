import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import type { Waterfall } from "@/lib/funds";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";

// The rows archive/unarchive and then `router.refresh()`; stubbed outside an
// App Router context.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { FundsTable } = await import("@/components/FundsTable");
const { SavingsWaterfall, WaterfallStepsMobile } = await import("@/components/SavingsWaterfall");
const { ApplyMonthButton } = await import("@/components/FundDialogs");
const { ArchivedFundLine } = await import("@/components/ArchivedFundsMobile");
type FundRow = import("@/db/funds").FundRow;

/**
 * Plan 9 Task 3b — the Goals page's components under the amounts mask. Every
 * figure at rest masks (table cells, the sub-line's `× RM x avg` and the
 * fund-paid disclosure, the status pill's `behind RM x/mo`, the waterfall's
 * lines and totals, the mobile cards, the Apply banner, archived rows);
 * months, percentages, counts, dates and pills without a figure stay.
 */
const TODAY = "2077-06-15";
/** Tags stripped: a server-rendered mask is `<MoneyText>`'s aria-labelled span. */
const plain = (html: string) => html.replace(/<[^>]+>/g, "");
const AVG_SEN = 300_000; // RM 3,000.00
const FUND_PAID_SEN = 11_100; // RM 111.00

const fund = (over: Partial<FundRow> = {}): FundRow => ({
  id: "f-em",
  name: "Emergency",
  kind: "emergency",
  target_sen: null,
  target_months: 6,
  target_date: null,
  monthly_contribution_sen: 50_000,
  priority: 1,
  archived: false,
  balance_sen: 1_234_500,
  resolved_target_sen: 1_800_000,
  progress_pct: 68,
  status: "behind",
  behind_by_sen: 7_777,
  required_monthly_sen: null,
  contribution_sen: 50_000,
  contribution_applied: false,
  ...over,
});

const emergency = fund();
const japan = fund({
  id: "f-jp",
  name: "Japan trip",
  kind: "goal",
  target_months: null,
  target_sen: 600_000,
  resolved_target_sen: 600_000,
  target_date: "2078-03-01",
  balance_sen: -20_000,
  progress_pct: 0,
  status: "over_drawn",
  behind_by_sen: 0,
  contribution_sen: 25_000,
});
const laptop = fund({
  id: "f-lt",
  name: "Laptop",
  kind: "sinking",
  target_months: null,
  resolved_target_sen: null,
  target_date: "2077-12-01",
  balance_sen: 40_000,
  progress_pct: null,
  status: "on_track",
  contribution_sen: 12_300,
});

const SEEDED = [
  "12,345.00",
  "18,000.00",
  "500.00",
  "77.77",
  "3,000.00",
  "111.00",
  "200.00",
  "6,000.00",
  "250.00",
  "123.00",
  "400.00",
  "12,145.00",
];

describe("FundsTable", () => {
  const props = {
    funds: [emergency, japan],
    archivedFunds: [],
    month: "2077-06",
    avgMonthlyExpenseSen: AVG_SEN,
    avgMonthlyFundPaidExpenseSen: FUND_PAID_SEN,
    todayIso: TODAY,
    drawnThisMonth: [],
    totalSavedSen: 1_214_500,
  };

  it("shown: cells, sub-line, pill and total print their figures", () => {
    const html = renderToStaticMarkup(createElement(FundsTable, props));
    expect(html).toContain("RM 12,345.00");
    expect(html).toContain("RM 18,000.00");
    expect(html).toContain("6.0 × RM 3,000.00 avg · RM 111.00/mo of that was paid from funds");
    expect(html).toContain("behind RM 77.77/mo");
    expect(html).toContain("over-drawn RM 200.00");
    expect(html).toContain("RM 12,145.00");
  });

  it("hidden: every figure masks; months, percent, counts and pills stay", () => {
    const html = renderMasked(createElement(FundsTable, props));
    expect(html).toContain(`6.0 × ${MASKED_MYR} avg · ${MASKED_MYR}/mo of that was paid from funds`);
    expect(html).toContain(`behind ${MASKED_MYR}/mo`);
    expect(html).toContain(`over-drawn ${MASKED_MYR}`);
    expect(html).toContain("68%");
    expect(html).toContain("Total saved · 2 active funds");
    assertNoMoney(html, SEEDED);
  });
});

describe("SavingsWaterfall (desktop) and WaterfallStepsMobile", () => {
  const waterfall: Waterfall = {
    steps: [
      {
        step: 1,
        key: "emergency",
        funds: [{ id: "f-em", name: "Emergency", planned_sen: 50_000, status: "behind", behind_by_sen: 7_777 }],
        planned_sen: 50_000,
        funded_sen: 50_000,
        shortfall_sen: 0,
        first_shortfall: false,
      },
      {
        step: 2,
        key: "dated",
        funds: [
          { id: "f-jp", name: "Japan trip", planned_sen: 25_000, status: "over_drawn", behind_by_sen: 0 },
          { id: "f-lt", name: "Laptop", planned_sen: 12_300, status: "on_track", behind_by_sen: 0 },
        ],
        planned_sen: 37_300,
        funded_sen: 37_300,
        shortfall_sen: 0,
        first_shortfall: false,
      },
      { step: 3, key: "open", funds: [], planned_sen: 0, funded_sen: 0, shortfall_sen: 0, first_shortfall: false },
      { step: 4, key: "invest", funds: [], planned_sen: 0, funded_sen: 0, shortfall_sen: 0, first_shortfall: false },
    ],
    planned_total_sen: 87_300,
    leftover_sen: 40_000,
  };
  const desktop = {
    waterfall,
    funds: [emergency, japan, laptop],
    envelope_sen: 127_300,
    month_planned: true,
    monthLabel: "June",
    avgMonthlyExpenseSen: AVG_SEN,
    todayIso: TODAY,
  };
  const mobile = { funds: [emergency, japan, laptop], leftoverSen: 40_000, avgMonthlyExpenseSen: AVG_SEN, todayIso: TODAY };
  const WF_SEEDED = [...SEEDED, "1,273.00", "873.00", "400.00"];

  it("shown: the envelope line, step lines, step figures and the footer print", () => {
    const html = renderToStaticMarkup(createElement(SavingsWaterfall, desktop));
    expect(html).toContain("June savings envelope RM 1,273.00 · RM 873.00 to funds");
    expect(html).toContain("RM 12,345.00 of RM 18,000.00");
    expect(html).toContain("Japan trip RM 250.00 · Laptop RM 123.00");
    expect(html).toContain("RM 400.00");
  });

  it("hidden: every desktop figure masks; months and the step structure stay", () => {
    const html = renderMasked(createElement(SavingsWaterfall, desktop));
    expect(plain(html)).toContain(`Japan trip ${MASKED_MYR} · Laptop ${MASKED_MYR}`);
    expect(html).toContain("of 6.0 months");
    expect(html).toContain("June envelope");
    assertNoMoney(html, WF_SEEDED);
  });

  it("shown: the mobile cards print each contribution, the card line and the leftover", () => {
    const html = renderToStaticMarkup(createElement(WaterfallStepsMobile, mobile));
    expect(html).toContain("RM 500.00");
    expect(html).toContain("behind RM 77.77/mo");
    expect(html).toContain("RM 400.00");
  });

  it("hidden: every mobile figure masks; the order and status words stay", () => {
    const html = renderMasked(createElement(WaterfallStepsMobile, mobile));
    expect(html).toContain("1 · Emergency");
    expect(plain(html)).toContain(`behind ${MASKED_MYR}/mo`);
    expect(html).toContain("4 · Invest the rest");
    assertNoMoney(html, WF_SEEDED);
  });
});

describe("ApplyMonthButton (mobile card) and the archived fund line", () => {
  const card = { month: "2077-06", monthLabel: "June", variant: "card" as const, plannedSen: 87_300, fundsCount: 3, envelopeSen: 127_300 };

  it("shown: the planned figure and the envelope print", () => {
    const html = renderToStaticMarkup(createElement(ApplyMonthButton, card));
    expect(html).toContain("RM 873.00");
    expect(html).toContain("envelope RM 1,273.00");
  });

  it("hidden: both mask; the fund count stays", () => {
    const html = renderMasked(createElement(ApplyMonthButton, card));
    expect(html).toContain(`3 funds · not applied yet · envelope ${MASKED_MYR}`);
    assertNoMoney(html, ["873.00", "1,273.00"]);
  });

  it("hidden: an archived fund keeps its row and its `saved` word, the balance masks", () => {
    const html = renderMasked(createElement(ArchivedFundLine, { fund: fund({ archived: true }) }));
    expect(html).toContain(`${MASKED_MYR} saved`);
    expect(html).toContain("Unarchive");
    assertNoMoney(html, SEEDED);
  });
});
