import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { renderMasked, renderShown } from "@/test/render-money";
import { assertNoMoney } from "@/test/no-money";
import type { ExistingTx } from "@/components/TxFormSheet";

// Save calls `router.refresh()`; stubbed outside an App Router context.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { SheetForm } = await import("@/components/TxFormSheet");
type SheetFormProps = Parameters<typeof SheetForm>[0];

/**
 * Plan 9 Task 2 — the edit sheet under the amounts mask (ruling 4): the
 * prefilled amount INPUT is never masked (opening an edit sheet is a
 * deliberate act, and a masked input cannot be verified before Save); the
 * sheet's sub-lines — `Your share`, the fund draw line, the fund-return
 * warning — are dialog sub-lines and mask.
 */
const expense: ExistingTx = {
  id: "0d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
  type: "expense",
  amount_sen: 12_345,
  account_id: "acct-mb",
  transfer_account_id: null,
  received_sen: null,
  category_id: "cat-food",
  date: "2077-03-19",
  note: "Dinner",
  needs_review: false,
  expected_back_sen: 2_000,
  fund_id: "fund-em",
  splits: [],
};

const props = (tx: ExistingTx): SheetFormProps => ({
  mode: "edit",
  accounts: [{ id: "acct-mb", name: "Maybank", currency: "MYR", archived: false }],
  categories: [
    { id: "cat-food", name: "Food", kind: "expense", archived: false },
    { id: "cat-salary", name: "Salary", kind: "income", archived: false },
  ],
  fxRates: [],
  funds: [{ id: "fund-em", name: "Emergency", archived: false, balance_sen: 500_000 }],
  tx,
  todayStr: "2077-03-19",
  onClose: () => {},
});

const render = (hidden: boolean | null, tx: ExistingTx) => {
  const el = createElement(SheetForm, props(tx));
  return hidden === null ? renderToStaticMarkup(el) : hidden ? renderMasked(el) : renderShown(el);
};

describe("TxFormSheet edit sheet", () => {
  it("shown: Your share and the fund draw line print their figures", () => {
    const html = render(null, expense);
    expect(html).toContain("Your share: RM 103.45");
    expect(html).toContain("Draws RM 123.45 from the fund · balance RM 5,000.00 after this.");
  });

  it("hidden: the prefilled amount input keeps its figure, every sub-line masks", () => {
    const html = render(true, expense);
    // Ruling 4's input exemption, asserted explicitly.
    expect(html).toContain('value="123.45"');
    expect(html).toContain('value="20.00"');
    expect(html).toContain(`Your share: ${MASKED_MYR}`);
    assertNoMoney(html, ["103.45", "123.45", "5,000.00"]);
  });

  it("hidden: the fund-return warning on a retyped entry masks", () => {
    const shown = render(null, { ...expense, type: "income", category_id: "cat-salary", expected_back_sen: 0 });
    expect(shown).toContain("this will return");
    expect(shown).toContain("RM 123.45 to Emergency");
    const html = render(true, { ...expense, type: "income", category_id: "cat-salary", expected_back_sen: 0 });
    expect(html).toContain('value="123.45"');
    assertNoMoney(html, ["123.45"]);
  });
});
