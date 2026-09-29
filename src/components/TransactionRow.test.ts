import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { renderMasked, renderShown } from "@/test/render-money";
import { assertNoMoney } from "@/test/no-money";
import type { EnrichedTxRow } from "@/lib/tx-display";

// Delete calls `router.refresh()`; stubbed outside an App Router context.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { TransactionRows } = await import("@/components/TransactionRow");

/**
 * Plan 9 Task 2 — the desktop Transactions rows. The amount cell masks, and
 * the reimbursement pill (`RM 12.00/30.00 paid back` — one prefix, two bare
 * figures, outside the prefixed grammar) is rebuilt from `<Money bare>` parts
 * so it masks too (ruling 3).
 */
const TODAY = "2077-03-19";
const tx: EnrichedTxRow = {
  id: "0d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
  type: "expense",
  amount_sen: 8_765,
  account_id: "acct-mb",
  transfer_account_id: null,
  received_sen: null,
  category_id: "cat-food",
  date: TODAY,
  note: "Dinner",
  source: "manual",
  needs_review: false,
  expected_back_sen: 3_000,
  fund_id: null,
  paid_sen: 1_200,
  splits: [],
  accountName: "Maybank",
  accountCurrency: "MYR",
  transferAccountName: null,
  categoryName: "Food",
};

const props = {
  rows: [tx],
  todayStr: TODAY,
  yesterdayStr: "2077-03-18",
  accounts: [{ id: "acct-mb", name: "Maybank", currency: "MYR", archived: false }],
  categories: [{ id: "cat-food", name: "Food", kind: "expense" as const, archived: false }],
  emptyLabel: "No transactions this month.",
};

const tbody = (hidden: boolean | null) => {
  const el = createElement("table", null, createElement("tbody", null, createElement(TransactionRows, props)));
  return hidden === null ? renderToStaticMarkup(el) : hidden ? renderMasked(el) : renderShown(el);
};

describe("TransactionRows", () => {
  it("shown: the amount and the reimbursement pill read as before", () => {
    const html = tbody(null);
    expect(html).toContain("−RM 87.65");
    expect(html).toContain("RM 12.00/30.00 paid back");
  });

  it("hidden: no figure survives — the pill keeps its shape with both figures masked", () => {
    const html = tbody(true);
    expect(html).toContain(`−${MASKED_MYR}`);
    expect(html).toMatch(/RM <span role="img" aria-label="amount hidden">••••<\/span>\/<span role="img" aria-label="amount hidden">••••<\/span> paid back/);
    assertNoMoney(html, ["87.65", "12.00", "30.00"]);
  });
});
