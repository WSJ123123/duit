import type { FundRow } from "@/db/funds";
import type { Waterfall, WaterfallStep, WaterfallStepKey } from "@/lib/funds";
import { Money, MoneyText } from "@/components/Money";
import { Tip } from "@/components/Tip";
import { fundDetailLine, fundCardLine, multiFundLine, progressBarColor } from "@/lib/funds-display";

/**
 * The savings waterfall card (Task 3, mockup v6 §7's `.wf` block, the
 * per-STEP desktop view) and its mobile sibling (§10 ph1's `Waterfall ·
 * <month>` section, a per-FUND view — re-read v6 §10 ph1: `1 · Emergency
 * fund`, `2 · Car insurance & road tax`, `3 · Travel · Japan`, `4 · Invest
 * the rest` are four cards for three funds plus the leftover step, NOT one
 * card per waterfall step. Desktop groups by step because several funds can
 * share one; mobile gives every fund its own card so a fund's own status —
 * including an overdue target date — always has a home, even when it shares
 * a step with another fund (Task 3 review F2: `multiFundLine`'s desktop
 * step-grouping carries no per-fund status, and that was mobile's ONLY
 * waterfall view, so a fund three months overdue rendered as a bare name and
 * amount there). Pure display over ruling 10's already-computed Waterfall
 * (desktop) and the page's own FundRow[] (mobile) — no money math happens
 * here. A plain (non-"use client") module: nothing on this card is
 * interactive.
 *
 * `WaterfallStepFund` (the lib's per-step entry) carries only id/name/
 * planned_sen/status/behind_by_sen — the richer single-fund progress line
 * mockup v6 draws for a one-fund step needs balance/target/dates too, so
 * `funds` (the page's full FundRow[]) is passed alongside the waterfall and
 * joined here by id (desktop only — mobile reads FundRow[] directly, one
 * card per fund, no step-joining needed).
 */

const STEP_LABEL: Record<WaterfallStepKey, string> = {
  emergency: "Emergency fund",
  // Mockup v6 calls this "Sinking funds with a date", but ruling 10 defines
  // the step by target_date, not by kind — the mock's own demo data puts a
  // `goal`-kind fund in it too. "Sinking" would misdescribe that fund, so
  // this label follows the ruling's own wording instead (a v6 gap: the
  // heading text isn't itself a rendered number/layout element, and the
  // mock's phrasing doesn't generalize).
  dated: "Funds with a date",
  open: "Open-ended funds",
  invest: "Invest the rest",
};

function stepMeta(
  step: WaterfallStep,
  fundsById: Map<string, FundRow>,
  avgMonthlyExpenseSen: number,
  todayIso: string,
): string {
  const only = step.funds.length === 1 ? step.funds[0] : undefined;
  if (only) {
    const fund = fundsById.get(only.id);
    if (fund) return fundDetailLine(fund, only.planned_sen, avgMonthlyExpenseSen, todayIso);
  }
  return multiFundLine(step);
}

/** Envelope-funding coverage for the step's own bar (NOT the fund's progress
 *  toward its target — the fund table already shows that per row). The one
 *  exception: a step with exactly one targeted fund reuses that fund's own
 *  progress_pct, matching what the mockup's single-fund emergency step
 *  actually shows (61% = the fund's own balance/target, not an envelope
 *  coverage ratio, which would read 100% here). */
function stepTrackFraction(step: WaterfallStep, fundsById: Map<string, FundRow>): number {
  const only = step.funds.length === 1 ? step.funds[0] : undefined;
  if (only) {
    const fund = fundsById.get(only.id);
    if (fund && fund.resolved_target_sen !== null) return (fund.progress_pct ?? 0) / 100;
  }
  return step.planned_sen > 0 ? step.funded_sen / step.planned_sen : 0;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function stepVisual(step: WaterfallStep): { circleBg: string; circleColor: string } {
  if (step.key === "invest") {
    return { circleBg: "color-mix(in srgb, var(--good) 16%, transparent)", circleColor: "var(--good-text)" };
  }
  if (step.funded_sen > 0) return { circleBg: "var(--accent)", circleColor: "#fff" };
  return { circleBg: "var(--chip)", circleColor: "var(--ink-2)" };
}

interface SavingsWaterfallProps {
  waterfall: Waterfall;
  funds: FundRow[];
  envelope_sen: number;
  month_planned: boolean;
  monthLabel: string;
  avgMonthlyExpenseSen: number;
  todayIso: string;
}

export function SavingsWaterfall({
  waterfall,
  funds,
  envelope_sen,
  month_planned,
  monthLabel,
  avgMonthlyExpenseSen,
  todayIso,
}: SavingsWaterfallProps) {
  const fundsById = new Map(funds.map((f) => [f.id, f]));

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Savings waterfall
      </h3>
      <Tip className="mb-1">
        where each ringgit of this month&apos;s savings goes, in order — fill the emergency fund first, then the
        funds with a deadline, then invest what&apos;s left
      </Tip>
      {month_planned ? (
        <p className="mb-3 text-xs" style={{ color: "var(--ink-2)" }}>
          {monthLabel} savings envelope <Money sen={envelope_sen} /> · <Money sen={waterfall.planned_total_sen} /> to funds
          · <Money sen={waterfall.leftover_sen} /> to investing
        </p>
      ) : (
        <p className="mb-3 text-xs font-semibold" style={{ color: "var(--warning)" }}>
          no plan for {monthLabel} yet
        </p>
      )}

      <div className="flex flex-col">
        {waterfall.steps.map((step) => {
          const visual = stepVisual(step);
          const isInvest = step.key === "invest";
          const fraction = clamp01(stepTrackFraction(step, fundsById));
          return (
            <div
              key={step.step}
              className="grid grid-cols-[26px_minmax(0,1fr)_auto] items-start gap-3 border-b py-2.5 last:border-b-0"
              style={{ borderColor: "var(--grid)" }}
            >
              <span
                className="mt-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-lg text-[11.5px] font-bold"
                style={{ background: visual.circleBg, color: visual.circleColor }}
              >
                {step.step}
              </span>
              <span>
                <span className="block text-[13.5px] font-semibold" style={{ color: "var(--ink-1)" }}>
                  {STEP_LABEL[step.key]}
                </span>
                {isInvest ? (
                  <>
                    <Tip as="span" className="mt-0.5 block">
                      what&apos;s left after every fund is fed — moves to the brokerage, tracked in Investments
                    </Tip>
                    <span className="mt-0.5 block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                      nothing scheduled · transfer manually
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="mt-0.5 block text-[11.5px]"
                      style={{
                        color: step.first_shortfall ? "var(--warning)" : "var(--ink-3)",
                        fontWeight: step.first_shortfall ? 600 : 400,
                      }}
                    >
                      <MoneyText>{stepMeta(step, fundsById, avgMonthlyExpenseSen, todayIso)}</MoneyText>
                    </span>
                    <span
                      className="mt-1.5 block h-[7px] overflow-hidden rounded-full"
                      style={{ background: "var(--accent-track)", opacity: 0.45 }}
                    >
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${fraction * 100}%`,
                          background: step.first_shortfall ? "var(--warning)" : "var(--accent)",
                        }}
                      />
                    </span>
                  </>
                )}
              </span>
              <span
                className="whitespace-nowrap text-right text-[13.5px] font-semibold tabular-nums"
                style={{ color: "var(--ink-1)" }}
              >
                <Money sen={isInvest ? waterfall.leftover_sen : step.planned_sen} />
                <span className="block text-[11px] font-medium" style={{ color: "var(--ink-3)" }}>
                  {isInvest ? "left over" : "this month"}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      <div
        className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-xs font-semibold"
        style={{ borderColor: "var(--grid)", color: "var(--ink-1)" }}
      >
        <span>{monthLabel} envelope</span>
        <span className="tabular-nums"><Money sen={envelope_sen} /></span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile — mockup v6 §10 ph1, per-FUND (Task 3 review F2 — see the module
// doc comment above for why this is not per-step). Each active fund gets
// its own m-card, in waterfall order (the order `data.funds` already
// arrives in): index, name, this month's contribution, its OWN progress bar
// and status line — the same figures the funds table's row carries, just in
// card form, via the same `fundCardLine`/`progressBarColor` helpers so the
// two surfaces cannot drift. One final card for "Invest the rest". No
// wrapping card, no envelope-breakdown sub-h (the mobile hero already
// carries the "planned this month" figure).
// ---------------------------------------------------------------------------

interface WaterfallStepsMobileProps {
  funds: FundRow[];
  leftoverSen: number;
  avgMonthlyExpenseSen: number;
  todayIso: string;
}

export function WaterfallStepsMobile({ funds, leftoverSen, avgMonthlyExpenseSen, todayIso }: WaterfallStepsMobileProps) {
  return (
    <>
      {funds.map((fund, i) => {
        const line = fundCardLine(fund, avgMonthlyExpenseSen, todayIso);
        return (
          <div key={fund.id} className="mb-2.5 rounded-2xl p-3.5" style={{ background: "var(--chip)" }}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[14.5px] font-semibold" style={{ color: "var(--ink-1)" }}>
                {i + 1} · {fund.name}
              </span>
              <span className="text-sm font-bold tabular-nums" style={{ color: "var(--ink-1)" }}>
                <Money sen={fund.contribution_sen} />
              </span>
            </div>
            {fund.resolved_target_sen !== null ? (
              <span
                className="mt-2 block h-[7px] overflow-hidden rounded-full"
                style={{ background: "var(--accent-track)" }}
              >
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max(0, Math.min(100, fund.progress_pct ?? 0))}%`,
                    background: progressBarColor(fund.status),
                  }}
                />
              </span>
            ) : null}
            <span className="mt-1.5 block text-[11.5px]" style={{ color: line.color ?? "var(--ink-3)" }}>
              <MoneyText>{line.text}</MoneyText>
            </span>
          </div>
        );
      })}
      <div className="mb-2.5 rounded-2xl p-3.5" style={{ background: "var(--chip)" }}>
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[14.5px] font-semibold" style={{ color: "var(--ink-1)" }}>
            {funds.length + 1} · Invest the rest
          </span>
          <span className="text-sm font-bold tabular-nums" style={{ color: "var(--ink-1)" }}>
            <Money sen={leftoverSen} />
          </span>
        </div>
        <span className="mt-1.5 block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          left over after every fund · transfer to the brokerage yourself
        </span>
      </div>
    </>
  );
}
