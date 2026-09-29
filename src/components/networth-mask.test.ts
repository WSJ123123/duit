import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";

// The dialogs refresh through the router; stubbed outside an App Router context.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
// `DialogShell` portals into `document.body`, which a static render lacks —
// rendered in place so the dialog's sub-lines reach the markup.
vi.mock("@/components/Portal", () => ({ Portal: ({ children }: { children: ReactNode }) => children }));

const { LiabilityActionsDialog } = await import("@/components/ManualItemDialogs");
const { EntryRow } = await import("@/components/BusinessDialogs");
const { NetWorthChart } = await import("@/components/NetWorthChart");

/**
 * Plan 9 Task 3a — the Net Worth page's client components under the amounts
 * mask. Dialog sub-lines and the plan preview mask; dialog inputs do not
 * (ruling 4 — an input's value, including a prefilled amount).
 */
const TODAY = "2077-06-15";

const liability = (plannedPaymentSen: number) => ({
  liabilityId: "liab-1",
  liabilityName: "Car loan",
  prefillAmountSen: 85_000,
  prefillCategoryId: null,
  latestNotedOn: "2077-06-01",
  balanceSen: 3_840_000,
  interestRateBp: 350,
  plannedPaymentSen,
  accounts: [{ id: "acct-mb", name: "Maybank" }],
  categories: [{ id: "cat-loan", name: "Loan" }],
  todayStr: TODAY,
  onClose: () => {},
});

describe("LiabilityActionsDialog — Plan payment", () => {
  it("shown: the balance/minimum sub-line and the preview print their figures", () => {
    const html = renderToStaticMarkup(
      createElement(LiabilityActionsDialog, { ...liability(100_000), initialMode: "plan" }),
    );
    expect(html).toContain("balance RM 38,400.00 · 3.50% · minimum RM 850.00/mo");
    expect(html).toMatch(/Pays off <b>[A-Z][a-z]{2} \d{4}<\/b> · \d+ months · RM [\d,]+\.\d{2} interest/);
  });

  it("hidden (on track): the sub-line and preview mask; the planned input keeps its figure", () => {
    const html = renderMasked(createElement(LiabilityActionsDialog, { ...liability(100_000), initialMode: "plan" }));
    expect(html).toContain(`balance ${MASKED_MYR} · 3.50% · minimum ${MASKED_MYR}/mo`);
    expect(html).toContain(`${MASKED_MYR} interest`);
    expect(html).toMatch(/value="1,?000\.00"/);
    assertNoMoney(html, ["38,400.00", "850.00", "1,000.00"]);
  });

  it("hidden (never): the required payment masks, the month stays", () => {
    const html = renderMasked(createElement(LiabilityActionsDialog, { ...liability(100), initialMode: "plan" }));
    expect(html).toContain("never at this rate · ");
    expect(html).toMatch(new RegExp(`${MASKED_MYR}/mo would clear it by [A-Z][a-z]{2} \\d{4}`));
    assertNoMoney(html, ["38,400.00", "850.00"]);
  });

  it("hidden (Record payment): the prefilled amount input keeps its figure, nothing else prints one", () => {
    const html = renderMasked(createElement(LiabilityActionsDialog, { ...liability(0), initialMode: "payment" }));
    expect(html).toContain('value="850.00"');
    assertNoMoney(html, ["38,400.00"]);
  });
});

describe("Business EntryRow", () => {
  const entry = {
    id: "be-1",
    kind: "contribution" as const,
    amount_sen: 250_000,
    account_id: "acct-mb",
    account_name: "Maybank",
    date: "2077-05-02",
    note: "seed round",
  };
  const props = { entry, businessId: "biz-1", businessName: "Kedai", accounts: [], todayStr: TODAY };

  it("shown: the entry amount prints", () => {
    expect(renderToStaticMarkup(createElement(EntryRow, props))).toContain("RM 2,500.00");
  });

  it("hidden: the entry amount masks; date and account stay", () => {
    const html = renderMasked(createElement(EntryRow, props));
    expect(html).toContain(MASKED_MYR);
    expect(html).toContain("Maybank");
    assertNoMoney(html, ["2,500.00"]);
  });
});

describe("NetWorthChart", () => {
  it("shown: with no history the live total prints", () => {
    const html = renderToStaticMarkup(
      createElement(NetWorthChart, { snapshots: [], todayIso: TODAY, liveTotalSen: 12_345_678 }),
    );
    expect(html).toContain("RM 123,456.78");
  });

  it("hidden: the live total masks; a drawn line carries no figure", () => {
    const empty = renderMasked(createElement(NetWorthChart, { snapshots: [], todayIso: TODAY, liveTotalSen: 12_345_678 }));
    expect(empty).toContain(MASKED_MYR);
    assertNoMoney(empty, ["123,456.78"]);
    const snapshots = [
      { date: "2077-04-01", total_sen: 11_000_000 },
      { date: "2077-05-01", total_sen: 11_500_000 },
    ];
    const line = renderMasked(createElement(NetWorthChart, { snapshots, todayIso: TODAY, liveTotalSen: 12_345_678 }));
    expect(line).toContain("<polyline");
    assertNoMoney(line, ["123,456.78", "110,000.00", "115,000.00"]);
  });
});
