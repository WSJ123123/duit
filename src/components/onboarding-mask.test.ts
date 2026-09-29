import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { OnboardingRuleLine, FirstShortcutEntry } = await import("@/components/OnboardingWizard");

/**
 * Plan 9 Task 3b — the onboarding wizard's two text figures (ruling 6
 * excludes `/onboarding` from the route walk: its figure-bearing steps need
 * interaction, so they are pinned here). Step 4's rule row and step 6's
 * first-Shortcut-entry line mask; cadence, type, category and note stay.
 */
const rule = {
  id: "rule-1",
  name: "Rent",
  type: "expense" as const,
  amount_sen: 150_000,
  variable: false,
  account_id: "acct-1",
  transfer_account_id: null,
  category_id: "cat-1",
  freq: "monthly" as const,
  day_of_month: 1,
  weekday: null,
  month_of_year: null,
  next_run: "2077-07-01",
};
const entry = { amount_sen: 1_250, type: "expense", note: "kopi", date: "2077-06-15", categoryName: "Food" };

describe("OnboardingWizard — step 4 rule row", () => {
  it("shown: the cadence and the amount print", () => {
    expect(renderToStaticMarkup(createElement(OnboardingRuleLine, { rule }))).toContain("RM 1,500.00");
  });

  it("hidden: the amount masks; the name and cadence stay", () => {
    const html = renderMasked(createElement(OnboardingRuleLine, { rule }));
    expect(html).toContain("Rent");
    expect(html).toContain(` · ${MASKED_MYR}`);
    assertNoMoney(html, ["1,500.00"]);
  });
});

describe("OnboardingWizard — step 6 first Shortcut entry", () => {
  it("shown: type, amount, category and note print", () => {
    expect(renderToStaticMarkup(createElement(FirstShortcutEntry, { entry }))).toContain(
      "expense · RM 12.50 · Food · kopi",
    );
  });

  it("hidden: the amount masks; the rest of the line stays", () => {
    const html = renderMasked(createElement(FirstShortcutEntry, { entry }));
    expect(html).toContain(`expense · ${MASKED_MYR} · Food · kopi`);
    assertNoMoney(html, ["12.50"]);
  });
});
