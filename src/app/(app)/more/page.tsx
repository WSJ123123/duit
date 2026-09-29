import Link from "next/link";
import type { ReactNode } from "react";
import { createServerSupabase } from "@/db/server";
import { getSettingsSummaries } from "@/db/queries";
import { getNetWorthGlance } from "@/db/networth";
import { getInvestments } from "@/db/portfolio";
import { getFunds } from "@/db/funds";
import { getBills } from "@/db/bills";
import { klToday } from "@/lib/kl-date";
import { Money } from "@/components/Money";
import { Card } from "@/components/Card";

// No mockup covers /more. Minimal, token-consistent choice: mirror the
// Settings index row list (Card > ul of bordered rows, chevron affordance),
// plus a Logout row that posts to the existing /logout route handler.
// Tips-off density (Plan 3 Task 8): "Recurring" here is the same row as
// Settings index's Recurring section, so it carries the identical
// "<n> active rules" summary (same getSettingsSummaries call, same wording —
// the two pages cannot drift). "Settings" links to the index as a whole
// rather than to any one SECTIONS row, so it has no single corresponding
// count and stays label + chevron, same as it always has.
// "Net worth" / "Investments" (Task 9, ruling 18) carry their live totals the
// same way — data, visible tips-off — reusing getNetWorthGlance and the
// Investments page's own getInvestments().portfolio_total_sen (no lighter
// read exists; this page is low-traffic).
// "Goals" (Plan 7 Task 3) follows the same convention: getFunds()'s own
// total_saved_sen, the same figure the Goals hero shows — no separate
// lighter read either, same low-traffic reasoning.
// "Bills" (Plan 7 Task 5) likewise: getBills()'s own due_window_sen and
// count, the same pair the Bills hero shows.
const LINKS: Array<{ label: string; href: string; summary: string | null }> = [
  { label: "Net worth", href: "/net-worth", summary: "networth" },
  { label: "Investments", href: "/investments", summary: "investments" },
  { label: "Goals", href: "/goals", summary: "goals" },
  { label: "Bills", href: "/bills", summary: "bills" },
  { label: "Settings", href: "/settings", summary: null },
  { label: "Recurring", href: "/settings/recurring", summary: "recurring" },
];

export default async function MorePage() {
  const supabase = await createServerSupabase();
  const todayIso = klToday(new Date());
  const [summaries, netWorthGlance, investments, funds, bills] = await Promise.all([
    getSettingsSummaries(supabase),
    getNetWorthGlance(supabase, todayIso),
    getInvestments(supabase, todayIso),
    getFunds(supabase, todayIso),
    getBills(supabase, todayIso),
  ]);

  const summaryValueFor = (key: string | null): ReactNode => {
    if (key === "recurring") return `${summaries.recurringRules} active rules`;
    // Plan 8 ruling 10: the debts figure rides along — data, visible tips-off.
    if (key === "networth")
      return (
        <>
          <Money sen={netWorthGlance?.total_sen ?? 0} /> · debts <Money sen={netWorthGlance?.liabilities_sen ?? 0} />
        </>
      );
    if (key === "investments") return <Money sen={investments.portfolio_total_sen} />;
    if (key === "goals") return <Money sen={funds.total_saved_sen} />;
    if (key === "bills")
      return (
        <>
          <Money sen={bills.due_window_sen} /> · {bills.due_window_count} in {bills.window_days} days
        </>
      );
    return null;
  };

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold" style={{ color: "var(--ink-1)" }}>
        More
      </h1>

      <Card>
        <ul className="flex flex-col">
          {LINKS.map((link) => {
            const summaryValue = summaryValueFor(link.summary);
            return (
              <li key={link.href} style={{ borderBottom: "1px solid var(--grid)" }}>
                <Link href={link.href} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-sm font-medium" style={{ color: "var(--ink-1)" }}>
                    {link.label}
                  </span>
                  <span className="flex flex-shrink-0 items-center gap-3">
                    {summaryValue ? (
                      <span className="text-sm" style={{ color: "var(--ink-2)" }}>
                        {summaryValue}
                      </span>
                    ) : null}
                    <span aria-hidden style={{ color: "var(--ink-3)" }}>
                      →
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
          <li>
            <form action="/logout" method="post">
              <button
                type="submit"
                className="flex w-full items-center justify-between gap-3 py-2.5 text-left"
              >
                <span className="text-sm font-medium" style={{ color: "var(--critical)" }}>
                  Logout
                </span>
              </button>
            </form>
          </li>
        </ul>
      </Card>
    </div>
  );
}
