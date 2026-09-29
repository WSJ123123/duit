import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The rows dispatch `unarchiveFund` and then `router.refresh()`, exactly as
// the desktop table's archived rows do; outside an App Router context
// `useRouter` has nothing to read, so it is stubbed for the render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { ArchivedFundsMobile, ArchivedFundLine } = await import(
  "@/components/ArchivedFundsMobile"
);
type FundRow = import("@/db/funds").FundRow;

/**
 * Q9 (ruling 14's trap shape): archived funds were unreachable — and so
 * un-unarchivable — on the phone, because the `Archived (n)` disclosure lives
 * in the desktop-only FundsTable. The mobile Goals screen gets the same
 * disclosure, the same `Unarchive` action and the same revalidation set.
 */
const fund = (over: Partial<FundRow> = {}): FundRow => ({
  id: "f1",
  name: "Japan trip",
  kind: "goal",
  target_sen: null,
  target_months: null,
  target_date: null,
  monthly_contribution_sen: 0,
  priority: 1,
  archived: true,
  balance_sen: 120_000,
  resolved_target_sen: null,
  progress_pct: null,
  status: "on_track",
  behind_by_sen: 0,
  required_monthly_sen: null,
  contribution_sen: 0,
  contribution_applied: false,
  ...over,
});

describe("Q9 — archived funds disclosure on mobile Goals", () => {
  it("renders nothing when there are no archived funds", () => {
    expect(renderToStaticMarkup(createElement(ArchivedFundsMobile, { funds: [] }))).toBe("");
  });

  it("collapses behind the house `Archived (n)` link", () => {
    const html = renderToStaticMarkup(
      createElement(ArchivedFundsMobile, {
        funds: [fund(), fund({ id: "f2", name: "New laptop" })],
      }),
    );
    expect(html).toContain("Archived (2)");
    // Collapsed by default — the rows are behind the link, same as desktop.
    expect(html).not.toContain("Japan trip");
  });

  it("each row keeps its balance and offers Unarchive (ruling 9a)", () => {
    const html = renderToStaticMarkup(createElement(ArchivedFundLine, { fund: fund() }));
    expect(html).toContain("Japan trip");
    expect(html).toContain("RM 1,200.00 saved");
    expect(html).toContain("Unarchive");
    expect(html).toContain("archived");
  });
});
