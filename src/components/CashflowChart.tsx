import Link from "next/link";
import { Tip } from "@/components/Tip";
import { Money } from "@/components/Money";
import { cashflowGeometry, formatDM, stepPath } from "@/lib/bills-display";
import type { Projection } from "@/lib/bills";

/**
 * Mockup v6 §8's `Projected cash` card. Server component: the 30D/60D/90D
 * range is a `?days=` link rather than client state, so the whole projection
 * is recomputed server-side from real balances — there is no second, weaker
 * copy of the money math in the browser.
 *
 * Ruling 23 (tips-off is the baseline): the spendable-accounts line and the
 * low point are DATA and stay on screen with tips off; only the "what this
 * chart is" line is a Tip.
 */

const VIEW_W = 1000;
const VIEW_H = 180;

export const RANGE_DAYS = [30, 60, 90] as const;

interface CashflowChartProps {
  projection: Projection;
  fromIso: string;
  toIso: string;
  windowDays: number;
  spendableBaseSen: number;
  spendableAccounts: string[];
  excludedAccountCount: number;
}

export function CashflowChart({
  projection,
  fromIso,
  toIso,
  windowDays,
  spendableBaseSen,
  spendableAccounts,
  excludedAccountCount,
}: CashflowChartProps) {
  const { points, zeroY } = cashflowGeometry(projection.series, fromIso, toIso, VIEW_W, VIEW_H);
  const minPoint = points.find((p) => p.date === projection.min_date && p.balance_sen === projection.min_sen);
  const belowZero = projection.min_sen <= 0;

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="mb-1 flex items-center gap-3">
        <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
          Projected cash
        </h3>
        <div
          className="ml-auto flex overflow-hidden rounded-lg text-xs"
          style={{ border: "1px solid var(--border)" }}
        >
          {RANGE_DAYS.map((days) => (
            <Link
              key={days}
              href={`/bills?days=${days}`}
              className="px-2.5 py-1"
              style={{
                background: windowDays === days ? "var(--chip)" : "transparent",
                color: windowDays === days ? "var(--ink-1)" : "var(--ink-3)",
                fontWeight: windowDays === days ? 650 : 400,
              }}
            >
              {days}D
            </Link>
          ))}
        </div>
      </div>

      <Tip className="mb-1">
        today&apos;s spendable balance, then every expected bill out and paycheque in — a projection from
        your recurring rules, not a forecast of your actual spending
      </Tip>
      <p className="mb-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
        spendable today <Money sen={spendableBaseSen} />
        {spendableAccounts.length > 0 ? ` · ${spendableAccounts.join(" · ")}` : " · no spendable accounts yet"}
        {excludedAccountCount > 0
          ? ` · ${excludedAccountCount} other account${excludedAccountCount === 1 ? "" : "s"} excluded (brokerage, EPF, other, non-MYR)`
          : ""}
      </p>

      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className="block h-[180px] w-full">
        <line x1="0" y1={VIEW_H * 0.25} x2={VIEW_W} y2={VIEW_H * 0.25} stroke="var(--grid)" strokeWidth="1" />
        <line x1="0" y1={VIEW_H * 0.6} x2={VIEW_W} y2={VIEW_H * 0.6} stroke="var(--grid)" strokeWidth="1" />
        {zeroY !== null ? (
          <line x1="0" y1={zeroY} x2={VIEW_W} y2={zeroY} stroke="var(--critical)" strokeWidth="1.5" />
        ) : (
          <line x1="0" y1={VIEW_H - 2} x2={VIEW_W} y2={VIEW_H - 2} stroke="var(--baseline)" strokeWidth="1.5" />
        )}
        <path
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinejoin="miter"
          d={stepPath(points)}
        />
        {points[0] ? <circle cx={points[0].x} cy={points[0].y} r="4" fill="var(--accent)" /> : null}
        {minPoint ? (
          <circle
            cx={minPoint.x}
            cy={minPoint.y}
            r="5"
            fill="var(--surface)"
            stroke={belowZero ? "var(--critical)" : "var(--series-2)"}
            strokeWidth="2.5"
          />
        ) : null}
      </svg>

      <div className="mt-1 flex justify-between text-[11px]" style={{ color: "var(--ink-3)" }}>
        <span>
          {formatDM(fromIso)} · <Money sen={spendableBaseSen} />
        </span>
        <span>
          lowest {formatDM(projection.min_date)} ·{" "}
          <span style={{ color: belowZero ? "var(--critical)" : "var(--good-text)", fontWeight: 600 }}>
            <Money sen={projection.min_sen} />
          </span>
        </span>
        <span>
          {formatDM(toIso)} · <Money sen={projection.end_sen} />
        </span>
      </div>
    </div>
  );
}
