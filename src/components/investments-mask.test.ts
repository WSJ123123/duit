import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";
import type { HoldingRow, InvestmentsData, TradeRow } from "@/db/portfolio";
import type { AllocationData } from "@/db/networth";

// The holding/trade/allocation writes refresh through the router; stubbed.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { HoldingsTable } = await import("@/components/HoldingsTable");
const { RecentTradesCard } = await import("@/components/TradeSheet");
const { AllocationPlan } = await import("@/components/AllocationPlan");
const { AllocStrip } = await import("@/components/AllocStrip");

/**
 * Plan 9 Task 3a — the Investments page's client components (and the Budget
 * page's AllocStrip) under the amounts mask. `formatCcy` figures keep their
 * currency code (`USD ••••` — a state, not a magnitude); quantities, FX
 * rates, percentages and months are not money and sit in `data-not-money`
 * where they print decimals (ruling 3).
 */
const TODAY = "2077-03-19";

const holding = (over: Partial<HoldingRow> & Pick<HoldingRow, "id" | "symbol" | "currency">): HoldingRow => ({
  name: over.symbol,
  kind: "stock",
  price_source: "auto",
  manual_price_e8: null,
  target_pct: null,
  archived: false,
  position: { quantity_e8: 0, cost_cent: 0, avg_cost_e8: 0, realized_cent: 0 },
  price: null,
  value_sen: 0,
  value_cent: 0,
  unrealized_cent: 0,
  unrealized_sen: 0,
  pct_tenths: 0,
  ...over,
});

// MYR: 10.25 units @ avg RM 9.00, price RM 9.45 → RM 96.86, P/L + RM 4.61.
const myr = holding({
  id: "h-myr",
  symbol: "MAYBANK",
  currency: "MYR",
  position: { quantity_e8: 1_025_000_000, cost_cent: 9_225, avg_cost_e8: 900_000_000, realized_cent: 0 },
  price: { price_e8: 945_000_000, as_of: "2077-03-18", stale: false, manual: false },
  value_sen: 9_686,
  value_cent: 9_686,
  unrealized_cent: 461,
  unrealized_sen: 461,
  pct_tenths: 385,
});
// USD: 2.25 units @ avg USD 128.40, price USD 139.75 → USD 314.44 / RM 1,389.82.
const usd = holding({
  id: "h-usd",
  symbol: "VWRA",
  kind: "etf",
  currency: "USD",
  position: { quantity_e8: 225_000_000, cost_cent: 28_890, avg_cost_e8: 12_840_000_000, realized_cent: 0 },
  price: { price_e8: 13_975_000_000, as_of: "2077-03-18", stale: false, manual: false },
  value_sen: 138_982,
  value_cent: 31_444,
  unrealized_cent: 2_554,
  unrealized_sen: 11_289,
  pct_tenths: 615,
});

const tableProps = (display: "myr" | "native") => ({
  holdings: [myr, usd],
  archivedHoldings: [],
  groups: [
    { kind: "stock", value_sen: 9_686, pct_tenths: 385, holding_ids: ["h-myr"] },
    { kind: "etf", value_sen: 138_982, pct_tenths: 615, holding_ids: ["h-usd"] },
  ],
  cash: {
    value_sen: 500_000,
    pct_tenths: 0,
    accounts: [
      { name: "Moomoo", balance_sen: 500_000, currency: "MYR", myr_sen: 500_000 },
      { name: "IBKR", balance_sen: 123_456, currency: "USD", myr_sen: null },
    ],
  } satisfies InvestmentsData["cash"],
  display,
});

const HOLDING_FIGURES = [
  "9.00", "9.45", "96.86", "4.61", "128.40", "139.75", "1,389.82", "314.44", "112.89", "25.54", "5,000.00", "1,234.56",
];

describe("HoldingsTable", () => {
  it("shown: prices, values, P/L and the native cash balance print as before", () => {
    const html = renderToStaticMarkup(createElement(HoldingsTable, tableProps("myr")));
    expect(html).toContain("RM 9.00");
    expect(html).toContain("USD 139.75");
    expect(html).toContain("RM 1,389.82");
    expect(html).toContain("+ RM 112.89");
    expect(html).toContain("IBKR (USD 1,234.56, no rate yet)");
    expect(html).toContain("10.25");
  });

  it("hidden (MYR display): every figure masks, currency codes and % stay, quantities are not money", () => {
    const html = renderMasked(createElement(HoldingsTable, tableProps("myr")));
    expect(html).toContain("USD ••••");
    expect(html).toContain(`+ ${MASKED_MYR}`);
    expect(html).toContain("IBKR (USD ••••, no rate yet)");
    expect(html).toContain("38.5%");
    expect(html).toMatch(/data-not-money="?[^>]*>10\.25</);
    assertNoMoney(html, HOLDING_FIGURES);
  });

  it("hidden (native display): native values and P/L mask with their code", () => {
    const html = renderMasked(createElement(HoldingsTable, tableProps("native")));
    expect(html).toContain("+ USD ••••");
    assertNoMoney(html, HOLDING_FIGURES);
  });
});

// A buy of 2.25 VWRA @ USD 128.40 + USD 1.50 fee, paid from a USD account.
const trade: TradeRow = {
  id: "t-1",
  holding_id: "h-usd",
  account_id: "acct-ibkr",
  side: "buy",
  date: "2077-03-10",
  quantity_e8: 225_000_000,
  price_e8: 12_840_000_000,
  fees_cent: 150,
  cash_delta_sen: 29_040,
  note: "",
  created_at: "2077-03-10T01:00:00Z",
  symbol: "VWRA",
  holding_currency: "USD",
  account_name: "IBKR",
};
const tradesProps = {
  trades: [trade],
  holdings: [usd],
  accounts: [{ id: "acct-ibkr", name: "IBKR", currency: "USD" }],
  fxRates: [],
  todayStr: TODAY,
};

describe("RecentTradesCard", () => {
  it("shown: the trade row reads as before (the fee keeps its bare figure)", () => {
    const html = renderToStaticMarkup(createElement(RecentTradesCard, tradesProps));
    expect(html).toMatch(/VWRA · (<[^>]+>)?2\.25(<\/span>)? @ USD 128\.40/);
    expect(html).toMatch(/USD 288\.90 \+ (<!-- -->)?1\.50(<!-- -->)? fee/);
    expect(html).toContain("USD 290.40");
  });

  it("hidden: price, gross, fee and cash mask; side, symbol and quantity stay", () => {
    const html = renderMasked(createElement(RecentTradesCard, tradesProps));
    expect(html).toContain("BUY");
    expect(html).toContain("USD ••••");
    expect(html).toMatch(/data-not-money="?[^>]*>2\.25</);
    assertNoMoney(html, ["128.40", "288.90", "1.50", "290.40"]);
  });
});

const allocation: AllocationData = {
  buckets: { bank_sen: 1_000_000, cashlike_sen: 1_500_000, equities_sen: 2_500_000, pot_sen: 5_000_000 },
  presets: {
    balanced: { bank_pct: 20, cashlike_pct: 40, equities_pct: 40 },
    growth: { bank_pct: 15, cashlike_pct: 25, equities_pct: 60 },
    aggressive: { bank_pct: 10, cashlike_pct: 10, equities_pct: 80 },
    barbell: { bank_pct: 10, cashlike_pct: 30, equities_pct: 60 },
  },
  selected: "balanced",
  target_etf_pct: 70,
  equities_rows: [
    { id: "h-usd", symbol: "VWRA", kind: "etf", value_sen: 1_800_000, target_pct: 60 },
    { id: "h-myr", symbol: "MAYBANK", kind: "stock", value_sen: 700_000, target_pct: null },
  ],
  avg_monthly_expense_sen: 300_000,
};
const reserve = { total_sen: 123_456, sub: "2 active funds · emergency 3.7 of 6.0 months" };

describe("AllocationPlan", () => {
  it("shown: the pot, the stress column, the ringgit plan and the reserve print", () => {
    const html = renderToStaticMarkup(createElement(AllocationPlan, { data: allocation, reserve }));
    expect(html).toContain("RM 50,000.00");
    expect(html).toContain("RM 1,234.56");
    expect(html).toContain("−RM 8,000.00"); // balanced: 40% of 50,000 × 40%
  });

  it("hidden: every figure masks; %, months and the reserve's sub-line stay", () => {
    const html = renderMasked(createElement(AllocationPlan, { data: allocation, reserve }));
    expect(html).toContain(`−${MASKED_MYR}`);
    expect(html).toContain("2 active funds · emergency 3.7 of 6.0 months");
    expect(html).toContain("40%");
    assertNoMoney(html, ["50,000.00", "1,234.56", "8,000.00", "10,000.00", "20,000.00"]);
  });
});

describe("AllocStrip", () => {
  const props = {
    expectedIncomeSen: 800_000,
    allocatedSen: 543_210,
    savingsSen: 120_000,
    unassignedSen: 136_790,
    editable: false,
    expectedIncomeInput: "8000.00",
    onExpectedIncomeChange: () => {},
  };

  it("shown: the four figures print", () => {
    const html = renderToStaticMarkup(createElement(AllocStrip, props));
    expect(html).toContain("RM 8,000.00");
    expect(html).toContain("RM 5,432.10");
  });

  it("hidden: all four mask", () => {
    const html = renderMasked(createElement(AllocStrip, props));
    expect(html).toContain(MASKED_MYR);
    assertNoMoney(html, ["8,000.00", "5,432.10", "1,200.00", "1,367.90"]);
  });

  it("hidden (editable): the expected-income input keeps its figure", () => {
    const html = renderMasked(createElement(AllocStrip, { ...props, editable: true }));
    expect(html).toContain('value="8000.00"');
    assertNoMoney(html, ["5,432.10", "1,200.00", "1,367.90"]);
  });
});
