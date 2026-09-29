import type { ReactNode } from "react";
import { createServerSupabase } from "@/db/server";
import { getInvestments } from "@/db/portfolio";
import { getAllocation } from "@/db/networth";
import { getFunds } from "@/db/funds";
import { klToday } from "@/lib/kl-date";
import { sinkingReserveRow } from "@/lib/funds-display";
import { plColor, unrealizedPct, formatPct } from "@/lib/pl-display";
import { Tip } from "@/components/Tip";
import { Money } from "@/components/Money";
import { AddHoldingButton, HoldingsTable, HoldingsDisplaySeg } from "@/components/HoldingsTable";
import { AddTradeButton, RecentTradesCard } from "@/components/TradeSheet";
import { AllocationPlan } from "@/components/AllocationPlan";

/**
 * Desktop Investments page (Plan 5 Task 7, v5 §7 binding). Server component:
 * fetches getInvestments once and renders the stat strip + holdings table +
 * recent trades from that single snapshot; the trade/holding dialogs are
 * client components layered on top of the Task-5 actions. The Allocation
 * plan sections (Task 8, mockup v4 §5) render below, from a second
 * getAllocation() snapshot — presets/buckets are independent of the
 * holdings/trades data above, so they don't share a fetch.
 */

function StatTile({ label, value, valueColor, sub, subColor }: { label: string; value: ReactNode; valueColor?: string; sub: ReactNode; subColor?: string }) {
  return (
    <div className="rounded-2xl p-3.5" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="text-xs" style={{ color: "var(--ink-3)" }}>
        {label}
      </div>
      <div className="mt-1 text-lg font-bold tracking-tight tabular-nums" style={{ color: valueColor ?? "var(--ink-1)" }}>
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: subColor ?? "var(--ink-3)" }}>
        {sub}
      </div>
    </div>
  );
}

export default async function InvestmentsPage() {
  const todayIso = klToday(new Date());
  const supabase = await createServerSupabase();
  const [data, allocationData, fundsData] = await Promise.all([
    getInvestments(supabase, todayIso),
    getAllocation(supabase, todayIso),
    // Ruling 20's reserve row reads REAL fund balances. `getFunds` is the one
    // source for those (ruling 5's derived identity, paged per finding #19) —
    // re-summing them here would be a second source that could drift.
    getFunds(supabase, todayIso),
  ]);
  const reserve = sinkingReserveRow(
    fundsData.funds,
    fundsData.total_saved_sen,
    fundsData.avg_monthly_expense_sen,
  );
  const { holdings, archivedHoldings, groups, cash, portfolio_total_sen, trades, totals, accounts } = data;

  // Client payload for the trade form's rate resolution (ruling 6) — the fx
  // Map itself is server-side only (Maps don't serialize to client props).
  const fxRates = Array.from(data.fx, ([pair, r]) => ({ pair, rate_e8: r.rate_e8, as_of: r.as_of }));
  // Ruling 8: an all-MYR portfolio renders no seg — nothing to toggle.
  const hasNonMyrHolding = holdings.some((h) => h.currency !== "MYR");

  // Archived-only holdings (e.g. a lone recovered symbol) must still reach
  // the Archived (n) disclosure — the empty state is only for truly nothing.
  const isEmpty = holdings.length === 0 && archivedHoldings.length === 0;
  const unrealizedPctTotal = unrealizedPct(totals.unrealized_sen, totals.cost_sen);
  const unrealizedColor = plColor(totals.unrealized_sen);

  return (
    <div className="flex flex-col gap-4">
      <div className="eye-clear flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
          Investments
        </h2>
        <div className="ml-auto flex gap-2">
          <AddHoldingButton />
          <AddTradeButton holdings={holdings} accounts={accounts} fxRates={fxRates} todayStr={todayIso} variant="primary" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Portfolio value"
          value={<Money sen={portfolio_total_sen} />}
          sub={
            <>
              <Money sen={totals.value_sen} /> holdings · <Money sen={cash.value_sen} /> cash
            </>
          }
        />
        <StatTile
          label="Cost basis"
          value={<Money sen={totals.cost_sen} />}
          sub={<>holdings · <Tip as="span">incl. fees</Tip></>}
        />
        <StatTile
          label="Unrealized P/L"
          value={<Money sen={totals.unrealized_sen} signed />}
          valueColor={unrealizedColor}
          sub={formatPct(unrealizedPctTotal)}
          subColor={unrealizedColor}
        />
        <StatTile label="Realized P/L" value={<Money sen={totals.realized_ytd_sen} />} sub="this year" />
      </div>

      {isEmpty ? (
        <div
          className="flex flex-col items-center gap-3 rounded-2xl p-8 text-center"
          style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <p className="text-sm" style={{ color: "var(--ink-3)" }}>
            No holdings yet.
          </p>
          <AddHoldingButton variant="primary" />
          <Tip>Add a holding, then log a trade — quantity, average cost and value all derive from your trade history.</Tip>
        </div>
      ) : (
        <>
          <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
                Holdings
              </h3>
              {hasNonMyrHolding ? <HoldingsDisplaySeg display={data.holdings_display} /> : null}
            </div>
            <Tip className="mb-2">
              quantity and cost come from your trades (average cost, fees included) · prices refresh daily at 06:00 ·
              % = share of the whole portfolio, cash included
            </Tip>
            <HoldingsTable
              holdings={holdings}
              archivedHoldings={archivedHoldings}
              groups={groups}
              cash={cash}
              display={hasNonMyrHolding ? data.holdings_display : "myr"}
            />
          </div>

          <RecentTradesCard trades={trades} holdings={holdings} accounts={accounts} fxRates={fxRates} todayStr={todayIso} />
        </>
      )}

      <AllocationPlan data={allocationData} reserve={reserve} />
    </div>
  );
}
