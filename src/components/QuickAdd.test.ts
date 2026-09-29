import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { renderMasked, renderShown } from "@/test/render-money";
import { assertNoMoney, findMoney, surfacesFromMarkup } from "@/test/no-money";
import type { EnrichedTxRow } from "@/lib/tx-display";

// Save and the offline flush call `router.refresh()`; outside an App Router
// context `useRouter` has nothing to read, so it is stubbed for the render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { QuickAdd, PendingRow } = await import("@/components/QuickAdd");
type QuickAddProps = Parameters<typeof QuickAdd>[0];

/**
 * Plan 9 Task 2 — Quick Add under the amounts mask (ruling 4's boundary,
 * mockup v8 §15): `Today`, the month total, the budget glance and every Recent
 * row mask; the parse echo (the preview line, the big amount and the Save
 * button's figure) is the figure being typed and never masks. Owner ruling
 * Q33: the echo prints NO figure until an amount has been typed.
 */
const TODAY = "2077-03-19";

const recent: EnrichedTxRow = {
  id: "0d4c9f3a-2b1e-5c6d-8e7f-a1b2c3d4e5f6",
  type: "expense",
  amount_sen: 450,
  account_id: "acct-mb",
  transfer_account_id: null,
  received_sen: null,
  category_id: "cat-food",
  date: TODAY,
  note: "Kopi",
  source: "nl",
  needs_review: false,
  expected_back_sen: 0,
  fund_id: null,
  paid_sen: 0,
  splits: [],
  accountName: "Maybank",
  accountCurrency: "MYR",
  transferAccountName: null,
  categoryName: "Food",
};

const props = (initialText: string): QuickAddProps => ({
  ctx: {
    aliases: [],
    accounts: [{ id: "acct-mb", name: "Maybank" }],
    categories: [{ id: "cat-food", name: "Food", kind: "expense" }],
    default_account_id: "acct-mb",
  },
  initialText,
  todayStr: TODAY,
  yesterdayStr: "2077-03-18",
  todaySpendSen: 3_240,
  monthSpendSen: 200_120,
  budgetGlance: { allocated_total_sen: 300_000, spent_total_sen: 200_120 },
  usageTx: [],
  recentRows: [recent],
  accounts: [{ id: "acct-mb", name: "Maybank", currency: "MYR", archived: false }],
  categories: [{ id: "cat-food", name: "Food", kind: "expense", archived: false }],
});

// Today, month spent, the glance's `left` (3,000.00 − 2,001.20) and the Recent row.
const AT_REST = ["32.40", "2,001.20", "998.80", "4.50"];

const render = (hidden: boolean | null, initialText = "") => {
  const el = createElement(QuickAdd, props(initialText));
  return hidden === null ? renderToStaticMarkup(el) : hidden ? renderMasked(el) : renderShown(el);
};

describe("QuickAdd — shown (the provider-less default)", () => {
  it("prints Today, the month total, the glance and the Recent row", () => {
    const html = render(null);
    expect(html).toContain("RM 32.40");
    expect(html).toContain("RM 2,001.20");
    expect(html).toContain("RM 998.80");
    expect(html).toContain("RM 4.50");
  });

  it("Q33: at rest the echo prints no figure — no `0.00` with an empty input", () => {
    expect(render(null)).not.toContain("0.00");
    expect(render(false)).not.toContain("0.00");
  });

  it("Q33: text without an amount still prints no figure in the echo", () => {
    const html = render(null, "kopi");
    expect(html).not.toContain("0.00");
    expect(html).toContain("Type an amount…");
  });
});

describe("QuickAdd — amounts hidden (ruling 4's boundary pinned)", () => {
  it("at rest: no figure survives the mask", () => {
    const html = render(true);
    expect(html).toContain(MASKED_MYR);
    assertNoMoney(html, AT_REST);
  });

  it("with a parse in flight: the echo carries the typed figure while Today stays masked", () => {
    const html = render(true, "12.50 kopi");
    const found = findMoney(surfacesFromMarkup(html), AT_REST);
    // Only the typed figure is on screen: the preview line and the Save button.
    expect(found.prefixed.length).toBeGreaterThan(0);
    expect(new Set(found.prefixed)).toEqual(new Set(["RM 12.50"]));
    expect(new Set(found.bare)).toEqual(new Set(["12.50"]));
    expect(found.seeded).toEqual([]);
    expect(html).toContain("Save — RM 12.50");
    expect(html).toMatch(/Today <b[^>]*>RM ••••<\/b>/);
  });
});

describe("QuickAdd — the in-flight `saving…` row (owner ruling Q37)", () => {
  const entry = (isExpense: boolean) =>
    createElement(PendingRow, {
      entry: { clientId: "client-1", label: "Kopi", amount_sen: 1_250, isExpense, pending: true },
    });

  it("shown: prints the figure (income keeps its `+`)", () => {
    expect(renderShown(entry(true))).toContain("−RM 12.50");
    expect(renderShown(entry(false))).toContain("+RM 12.50");
  });

  it("hidden: masks like every Recent row; the sign and `saving…` stay", () => {
    const expense = renderMasked(entry(true));
    expect(expense).toContain(`−${MASKED_MYR}`);
    expect(expense).toContain("saving…");
    assertNoMoney(expense, ["12.50"]);
    const income = renderMasked(entry(false));
    expect(income).toContain(`+${MASKED_MYR}`);
    assertNoMoney(income, ["12.50"]);
  });
});
