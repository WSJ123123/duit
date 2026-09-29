import type { ReactNode } from "react";
import { createServerSupabase } from "@/db/server";
import { getFunds, type FundsData, type FundDrawRow } from "@/db/funds";
import { klToday } from "@/lib/kl-date";
import { Money, MoneyText } from "@/components/Money";
import { Tip } from "@/components/Tip";
import { SavingsWaterfall, WaterfallStepsMobile } from "@/components/SavingsWaterfall";
import { FundsTable } from "@/components/FundsTable";
import { ArchivedFundsMobile } from "@/components/ArchivedFundsMobile";
import { formatDMY, pickEmergencyFund, monthsCoverageText, pickNearestDatedFund, nextTargetLine } from "@/lib/funds-display";
import { NewFundButton, ApplyMonthButton } from "@/components/FundDialogs";

/**
 * Goals page (Plan 7 Task 3, mockup v6 §7 desktop / §10 phone 1 mobile).
 * Server component: one composed getFunds() read (the getInvestments/
 * getNetWorth shape) feeds the hero, banner, stat strip, waterfall,
 * "This month" card and funds table — no second query anywhere below.
 *
 * Three carry-ins that deliberately override what v6 draws (see the report):
 * 1. monthsToFillAtRate, not a re-derived "18 months" — the lib is right.
 * 2. Hero delta = applied_total_sen − drawn_this_month_sen (the "This month"
 *    card's own arithmetic), not v6's inconsistent "▲ RM 900".
 * 3. A fund whose target_date has passed says so in its sub-line regardless
 *    of status pill (ruling 3's paused-before-behind precedence can otherwise
 *    hide it).
 */

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

function StatTile({
  label,
  value,
  valueColor,
  sub,
  subColor,
}: {
  label: string;
  value: ReactNode;
  valueColor?: string;
  sub: ReactNode;
  subColor?: string;
}) {
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

/** Ruling 9b: warn at ≥90%, critical above 100% — integer cross-multiplied,
 *  no float division (rule 13 is about money amounts; this is still kept
 *  integer-only as the house convention for any sen-derived comparison). */
function earmarkSeverity(totalSavedSen: number, myrAccountsTotalSen: number): "normal" | "warn" | "critical" {
  if (totalSavedSen > myrAccountsTotalSen) return "critical";
  if (myrAccountsTotalSen > 0 && totalSavedSen * 100 >= myrAccountsTotalSen * 90) return "warn";
  return "normal";
}

function drawLabel(draw: FundDrawRow): string {
  return `${draw.note || draw.category_name || draw.fund_name} · ${new Date(`${draw.date}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" })}`;
}

function ItRow({
  label,
  tip,
  sub,
  value,
  valueColor,
}: {
  label: string;
  tip?: string;
  sub: ReactNode;
  value: ReactNode;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between border-b py-2.5 text-[13px] last:border-b-0" style={{ borderColor: "var(--grid)" }}>
      <span>
        <span style={{ color: "var(--ink-1)", fontWeight: 550 }}>{label}</span>
        {tip ? (
          <Tip as="span" className="mt-0.5 block">
            {tip}
          </Tip>
        ) : null}
        <span className="mt-0.5 block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          {sub}
        </span>
      </span>
      <span className="whitespace-nowrap font-semibold tabular-nums" style={{ color: valueColor ?? "var(--ink-1)" }}>
        {value}
      </span>
    </div>
  );
}

function ThisMonthCard({ data, heroDeltaSen }: { data: FundsData; heroDeltaSen: number }) {
  const draws = data.drawn_this_month;
  // Two figures on purpose (Plan 8 ruling 4 / ruling 9a): `drawn_this_month_sen`
  // is ACTIVE-only — the hero delta's term and the "Drawn from funds" row —
  // but archiving never untags, so what is actually kept off the category
  // limits is every draw in the disclosure list, the Budget page's
  // `fund_spend_sen` (fixture: RM 130 all-funds vs RM 90 active).
  const keptOffLimitsSen = draws.reduce((sum, d) => sum + d.amount_sen, 0);
  const only = draws.length === 1 ? draws[0] : undefined;
  const drawnSub = draws.length === 0 ? "no draws yet this month" : only ? drawLabel(only) : `${draws.length} draws this month`;

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        This month
      </h3>
      <Tip className="mb-2">contributions are an earmark, not a transfer — no money moves between accounts</Tip>
      <ItRow label="Applied so far" sub={`${data.applied_count} of ${data.funds.length} funds`} value={<Money sen={data.applied_total_sen} />} />
      <ItRow label="Planned" sub={`${data.funds.length} funds · edit any fund to change`} value={<Money sen={data.planned_total_sen} />} />
      <ItRow
        label="Drawn from funds"
        sub={drawnSub}
        value={data.drawn_this_month_sen > 0 ? <>− <Money sen={data.drawn_this_month_sen} /></> : <Money sen={0} />}
        valueColor={data.drawn_this_month_sen > 0 ? "var(--critical)" : undefined}
      />
      <ItRow
        label="Budget effect"
        tip="fund-paid spending never counts against a category limit"
        sub={<><Money sen={keptOffLimitsSen} /> kept off category limits</>}
        value={<Money sen={0} />}
      />
      <div
        className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-xs font-semibold"
        style={{ borderColor: "var(--grid)", color: heroDeltaSen < 0 ? "var(--critical)" : "var(--ink-1)" }}
      >
        <span>Net change</span>
        <span className="tabular-nums">
          {heroDeltaSen >= 0 ? "+ " : "− "}
          <Money sen={Math.abs(heroDeltaSen)} />
        </span>
      </div>
    </div>
  );
}

export default async function GoalsPage() {
  const todayIso = klToday(new Date());
  const supabase = await createServerSupabase();
  const data = await getFunds(supabase, todayIso);

  const isEmpty = data.funds.length === 0 && data.archived_count === 0;
  const monthLabel = monthName(data.month);
  const heroDeltaSen = data.applied_total_sen - data.drawn_this_month_sen;
  const severity = earmarkSeverity(data.total_saved_sen, data.myr_accounts_total_sen);
  const earmarkColor = severity === "critical" ? "var(--critical)" : severity === "warn" ? "var(--warning)" : "var(--ink-3)";
  const earmarkBold = severity !== "normal";

  const emergencyFund = pickEmergencyFund(data.funds);
  const coverage = emergencyFund ? monthsCoverageText(emergencyFund, data.avg_monthly_expense_sen) : null;
  const nearestDated = pickNearestDatedFund(data.funds);
  const nearestLine = nearestDated ? nextTargetLine(nearestDated, todayIso) : null;

  const deltaColor = heroDeltaSen > 0 ? "var(--good-text)" : heroDeltaSen < 0 ? "var(--critical)" : "var(--ink-3)";
  const deltaBg =
    heroDeltaSen > 0
      ? "color-mix(in srgb, var(--good) 12%, transparent)"
      : heroDeltaSen < 0
        ? "color-mix(in srgb, var(--critical) 12%, transparent)"
        : "var(--chip)";
  const deltaArrow = heroDeltaSen > 0 ? "▲ " : heroDeltaSen < 0 ? "▼ " : "";

  const emptyExplainer =
    "A fund is a labelled slice of money you already have — set a target and a monthly contribution, then this page tracks progress and lets you pay a bill straight from it without touching your category budget.";

  return (
    <>
      {/* Desktop — mockup v6 §7 */}
      <div className="hidden md:flex md:flex-col md:gap-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
            Goals &amp; funds
          </h2>
          <div className="ml-auto">
            <NewFundButton month={data.month} variant="primary" />
          </div>
        </div>

        {isEmpty ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl p-8 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>
              No funds yet.
            </p>
            <p className="text-xs" style={{ color: "var(--ink-3)" }}>
              <Money sen={data.myr_accounts_total_sen} /> sits in your MYR accounts, unearmarked.
            </p>
            <NewFundButton month={data.month} variant="primary" />
            <Tip>{emptyExplainer}</Tip>
          </div>
        ) : (
          <>
            <div>
              <div className="flex items-baseline gap-3.5">
                <span className="text-[34px] font-bold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
                  <Money sen={data.total_saved_sen} />
                </span>
                <span
                  className="rounded-full px-2.5 py-0.5 text-[13px] font-semibold"
                  style={{ color: deltaColor, background: deltaBg }}
                >
                  {deltaArrow}
                  <Money sen={Math.abs(heroDeltaSen)} /> this month · active funds
                </span>
              </div>
              <p className="mt-1 text-xs" style={{ color: "var(--ink-3)" }}>
                across {data.funds.length} fund{data.funds.length === 1 ? "" : "s"} ·{" "}
                <span style={{ color: earmarkColor, fontWeight: earmarkBold ? 600 : 400 }}>
                  <Money sen={data.total_saved_sen} /> earmarked of <Money sen={data.myr_accounts_total_sen} /> in your MYR
                  accounts
                </span>{" "}
                <Tip as="span">· a fund is money you already have with a label on it, not extra money</Tip>
              </p>
            </div>

            {data.applied_count === 0 && data.funds.length > 0 ? (
              <div
                className="flex flex-wrap items-center gap-3 rounded-2xl px-4 py-2.5 text-[13px]"
                style={{ background: "var(--accent-soft)", border: "1px solid var(--border)" }}
              >
                <span>
                  <b style={{ fontWeight: 650 }}>{monthLabel} contributions not applied yet.</b>{" "}
                  <Money sen={data.waterfall.planned_total_sen} /> planned across {data.funds.length} funds · your
                  savings envelope this month is <Money sen={data.envelope_sen} />.
                </span>
                <span className="ml-auto flex-shrink-0">
                  <ApplyMonthButton month={data.month} monthLabel={monthLabel} />
                </span>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Total saved"
                value={<Money sen={data.total_saved_sen} />}
                valueColor={data.total_saved_sen < 0 ? "var(--critical)" : undefined}
                sub={`${data.funds.length} fund${data.funds.length === 1 ? "" : "s"}${data.archived_count > 0 ? ` · ${data.archived_count} archived` : ""}`}
              />
              <StatTile
                label="Emergency cover"
                value={emergencyFund && coverage ? `${coverage.current} months` : "—"}
                sub={
                  emergencyFund && coverage
                    ? <>target {coverage.target} · <Money sen={data.avg_monthly_expense_sen} /> avg monthly spend</>
                    : "no emergency fund yet"
                }
              />
              <StatTile
                label="Planned monthly"
                value={<Money sen={data.planned_total_sen} />}
                sub={<>of <Money sen={data.envelope_sen} /> savings envelope</>}
              />
              <StatTile
                label="Next target"
                value={nearestDated ? formatDMY(nearestDated.target_date) : "—"}
                sub={nearestLine ? <MoneyText>{nearestLine.text}</MoneyText> : "no dated funds"}
                subColor={nearestLine?.color}
              />
            </div>

            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.35fr_1fr]">
              <SavingsWaterfall
                waterfall={data.waterfall}
                funds={data.funds}
                envelope_sen={data.envelope_sen}
                month_planned={data.month_planned}
                monthLabel={monthLabel}
                avgMonthlyExpenseSen={data.avg_monthly_expense_sen}
                todayIso={todayIso}
              />
              <ThisMonthCard data={data} heroDeltaSen={heroDeltaSen} />
            </div>

            <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
              <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
                Funds
              </h3>
              <Tip className="mb-2">
                a fund is a labelled slice of money you already have · paying a bill from a fund draws it down
                instead of your monthly budget
              </Tip>
              <FundsTable
                funds={data.funds}
                archivedFunds={data.archived_funds}
                month={data.month}
                avgMonthlyExpenseSen={data.avg_monthly_expense_sen}
                avgMonthlyFundPaidExpenseSen={data.avg_monthly_fund_paid_expense_sen}
                todayIso={todayIso}
                drawnThisMonth={data.drawn_this_month}
                totalSavedSen={data.total_saved_sen}
              />
            </div>
          </>
        )}
      </div>

      {/* Mobile — mockup v6 §10 phone 1 */}
      <div className="md:hidden">
        <div className="eye-clear flex items-center pb-3 pt-1.5">
          <h2 className="text-2xl font-bold" style={{ color: "var(--ink-1)" }}>
            Goals
          </h2>
          <span className="ml-auto">
            <NewFundButton month={data.month} variant="mini" />
          </span>
        </div>

        {isEmpty ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl p-6 text-center"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          >
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>
              No funds yet.
            </p>
            <p className="text-xs" style={{ color: "var(--ink-3)" }}>
              <Money sen={data.myr_accounts_total_sen} /> sits in your MYR accounts, unearmarked.
            </p>
            <NewFundButton month={data.month} variant="primary" />
            <Tip>{emptyExplainer}</Tip>
          </div>
        ) : (
          <>
            <div className="text-[30px] font-bold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
              <Money sen={data.total_saved_sen} />
            </div>
            <div className="mb-3.5 mt-0.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              {data.funds.length} fund{data.funds.length === 1 ? "" : "s"} ·{" "}
              <span style={{ color: earmarkColor, fontWeight: earmarkBold ? 600 : 400 }}>
                <Money sen={data.total_saved_sen} /> of <Money sen={data.myr_accounts_total_sen} /> in MYR accounts
              </span>{" "}
              · <Money sen={data.planned_total_sen} /> planned this month
              <Tip as="span"> — earmarked, not extra</Tip>
            </div>

            {data.applied_count === 0 && data.funds.length > 0 ? (
              <div className="mb-2.5">
                <ApplyMonthButton
                  month={data.month}
                  monthLabel={monthLabel}
                  variant="card"
                  plannedSen={data.waterfall.planned_total_sen}
                  fundsCount={data.funds.length}
                  envelopeSen={data.envelope_sen}
                />
              </div>
            ) : null}

            <div className="mb-1.5 mt-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>
              Waterfall · {monthLabel}
            </div>
            <WaterfallStepsMobile
              funds={data.funds}
              leftoverSen={data.waterfall.leftover_sen}
              avgMonthlyExpenseSen={data.avg_monthly_expense_sen}
              todayIso={todayIso}
            />

            {/* Q9: the same `Archived (n)` disclosure the desktop funds table
                carries — without it an archived fund is unreachable, and so
                un-unarchivable, on the phone (ruling 14's trap shape). Same
                action, same revalidation set. */}
            <ArchivedFundsMobile funds={data.archived_funds} />
          </>
        )}
      </div>
    </>
  );
}
