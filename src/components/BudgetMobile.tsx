"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Tip } from "@/components/Tip";
import { AllocationGuideMobile } from "@/components/AllocationGuide";
import { Money, useMoney } from "@/components/Money";
import { fundSpendLine } from "@/lib/funds-display";
import { heroStats, meterState, fundEnvelopeSplit, type MeterState } from "@/lib/budget";
import type { BudgetMonthData, BudgetRow } from "@/db/budget";

/**
 * Mobile (<md) Budget tab, mockup v3 Phone C (lines 481-530: `.bt-hero`,
 * `.b-row-m`, `.banner`, `.mini-btn`, `.m-title`). Reads the SAME
 * `BudgetMonthData` the desktop `BudgetTable` (`AllocStrip` included) reads
 * from the single `getBudgetMonth` fetch in `page.tsx` — no second query,
 * no divergent math.
 *
 * The unplanned-month CTA and any actual editing happen in the desktop
 * `BudgetTable`'s edit mode, mounted mobile-visible via `page.tsx`'s
 * `?edit=1` — this component only ever renders the read-only hero/rows/
 * banner/month-switcher (Plan 4 Task 5 contract: "no separate mobile
 * planner logic").
 */

function meterColor(state: MeterState): string {
  if (state === "over") return "var(--critical)";
  if (state === "warn") return "var(--warning)";
  return "var(--accent)";
}

function Meter({ fraction, color, over }: { fraction: number; color: string; over?: boolean }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <span
      className="block h-2.5 overflow-hidden rounded-full"
      style={{ background: over ? "color-mix(in srgb, var(--critical) 25%, var(--surface))" : "var(--accent-track)" }}
    >
      <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

function IconDoc() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none">
      <rect x="4" y="2.8" width="12" height="14.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7h6M7 10h6M7 13h3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

interface MonthOption {
  value: string;
  label: string;
}

function MonthSwitcher({ month, options }: { month: string; options: MonthOption[] }) {
  const router = useRouter();
  return (
    <select
      value={month}
      onChange={(e) => router.push(`/budget?month=${e.target.value}`)}
      className="ml-auto bg-transparent text-right text-[12.5px] font-semibold outline-none"
      style={{ color: "var(--accent)" }}
      aria-label="Switch month"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Hero({
  data,
  todayStr,
  showDaysToGo,
}: {
  data: BudgetMonthData;
  todayStr: string;
  showDaysToGo: boolean;
}) {
  const plannedSen = data.totals.allocated_sen;
  const spentSen = data.totals.expense_sen;
  const { left_sen, over_sen, days_left } = heroStats(plannedSen, spentSen, todayStr);
  const isOver = over_sen > 0;
  const state = meterState(spentSen, plannedSen);
  const fraction = plannedSen > 0 ? spentSen / plannedSen : spentSen > 0 ? 1 : 0;
  const { fmt } = useMoney();

  return (
    <div className="pb-1 pt-2.5 text-center">
      <div className="text-[40px] font-bold tracking-tight" style={{ color: isOver ? "var(--critical)" : "var(--ink-1)" }}>
        {fmt(isOver ? over_sen : left_sen)}
      </div>
      <div className="mt-0.5 text-[13px]" style={{ color: "var(--ink-3)" }}>
        {isOver
          ? "over plan"
          : showDaysToGo
            ? `left to spend · ${days_left} day${days_left === 1 ? "" : "s"} to go`
            : "left to spend"}
      </div>
      <div className="my-2.5">
        <Meter fraction={fraction} color={meterColor(state)} over={isOver} />
      </div>
      <div className="flex justify-between text-xs" style={{ color: "var(--ink-3)" }}>
        <span>{fmt(spentSen)} spent</span>
        <span>{fmt(plannedSen)} planned</span>
      </div>
    </div>
  );
}

function StartPlanCta({ month, monthName }: { month: string; monthName: string }) {
  return (
    <div className="py-4 text-center">
      <Link
        href={`/budget?month=${month}&edit=1`}
        className="inline-block rounded-lg px-4 py-2.5 text-sm font-semibold"
        style={{ background: "var(--accent)", color: "#fff" }}
      >
        Start {monthName}&apos;s plan
      </Link>
    </div>
  );
}

function CategoryRow({ row }: { row: BudgetRow }) {
  const { fmt } = useMoney();
  const state = meterState(row.spent_sen, row.allocated_sen);
  const over = row.spent_sen - row.allocated_sen;
  const fraction = row.allocated_sen > 0 ? row.spent_sen / row.allocated_sen : row.spent_sen > 0 ? 1 : 0;

  return (
    <div className="border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--grid)" }}>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[13.5px]">
        <span
          className="flex items-center gap-2 truncate font-semibold"
          style={{ color: row.archived ? "var(--ink-3)" : "var(--ink-1)" }}
        >
          <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: "var(--accent)" }} />
          <span className="truncate">
            {row.name}
            {row.archived ? " (archived)" : ""}
          </span>
        </span>
        <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--ink-3)" }}>
          {state === "over" ? (
            <span className="inline-flex items-center gap-1 font-semibold" style={{ color: "var(--critical)" }}>
              ▲ over {fmt(Math.abs(over))}
            </span>
          ) : (
            <>
              <b style={{ color: "var(--ink-1)" }}>{fmt(row.spent_sen)}</b> / <Money sen={row.allocated_sen} bare />
            </>
          )}
        </span>
      </div>
      <Meter fraction={fraction} color={meterColor(state)} over={state === "over"} />
    </div>
  );
}

/** Mockup v6 §9's middle fragment on mobile (ruling 21 permits exactly this
 *  edit): the savings row keeps its meter and gains each active fund's
 *  earmark for the month, the unassigned remainder, and one link to Goals. */
function SavingsRow({ savings }: { savings: BudgetMonthData["savings"] }) {
  const { fmt } = useMoney();
  const fraction =
    savings.allocated_sen > 0 ? savings.set_aside_sen / savings.allocated_sen : savings.set_aside_sen > 0 ? 1 : 0;
  const { unassigned_sen } = fundEnvelopeSplit(
    savings.funds.map((f) => f.contribution_sen),
    savings.allocated_sen,
  );

  return (
    <div className="border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--grid)" }}>
      <div className="mb-1.5 flex items-center justify-between text-[13.5px]">
        <span className="flex items-center gap-2 font-semibold" style={{ color: "var(--ink-1)" }}>
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--good)" }} />
          Savings &amp; funds
        </span>
        <span className="tabular-nums" style={{ color: "var(--ink-3)" }}>
          <b style={{ color: "var(--ink-1)" }}>{fmt(savings.set_aside_sen)}</b> / <Money sen={savings.allocated_sen} bare />
        </span>
      </div>
      <Meter fraction={fraction} color="var(--good)" />
      {savings.funds.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {savings.funds.map((f) => (
            <div key={f.id} className="flex items-center justify-between text-xs" style={{ color: "var(--ink-2)" }}>
              <span className="truncate">{f.name}</span>
              <span className="flex-shrink-0 tabular-nums">{fmt(f.contribution_sen)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-xs" style={{ color: "var(--ink-3)" }}>
            <span>Unassigned</span>
            <span className="tabular-nums">{fmt(unassigned_sen)}</span>
          </div>
          <Link href="/goals" className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
            Open Goals ›
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function UnbudgetedRow({ unbudgeted }: { unbudgeted: BudgetMonthData["unbudgeted"] }) {
  const total = unbudgeted.reduce((sum, u) => sum + u.spent_sen, 0);
  const { fmt } = useMoney();
  return (
    <div className="mt-1">
      <Tip className="mb-1.5">spending outside any category limit · still counts toward this month&apos;s totals</Tip>
      <div className="flex items-center justify-between border-b py-2.5 text-[13.5px]" style={{ borderColor: "var(--grid)" }}>
        <span className="font-semibold" style={{ color: "var(--ink-1)" }}>
          Unbudgeted spending
        </span>
        <span className="font-semibold tabular-nums" style={{ color: "var(--ink-1)" }}>
          {fmt(total)}
        </span>
      </div>
    </div>
  );
}

function NextPlanBanner({
  href,
  nextMonthName,
  currentMonthName,
  openDateLabel,
}: {
  href: string;
  nextMonthName: string;
  currentMonthName: string;
  openDateLabel: string;
}) {
  return (
    <Link
      href={href}
      className="mt-3.5 flex items-center gap-2.5 rounded-2xl px-4 py-3.5 text-[13.5px]"
      style={{ background: "var(--accent-soft)" }}
    >
      <span className="flex-shrink-0" style={{ color: "var(--accent)" }}>
        <IconDoc />
      </span>
      <span>
        <b style={{ fontWeight: 650 }}>{nextMonthName} plan</b> opens {openDateLabel} — copy {currentMonthName} or start
        fresh
      </span>
      <span className="ml-auto flex-shrink-0 font-bold" style={{ color: "var(--accent)" }}>
        ›
      </span>
    </Link>
  );
}

interface BudgetMobileProps {
  month: string;
  monthName: string;
  monthOptions: MonthOption[];
  data: BudgetMonthData;
  isPast: boolean;
  todayStr: string;
  bannerVisible: boolean;
  bannerHref: string;
  bannerNextMonthName: string;
  bannerCurrentMonthName: string;
  bannerOpenDateLabel: string;
}

export function BudgetMobile({
  month,
  monthName,
  monthOptions,
  data,
  isPast,
  todayStr,
  bannerVisible,
  bannerHref,
  bannerNextMonthName,
  bannerCurrentMonthName,
  bannerOpenDateLabel,
}: BudgetMobileProps) {
  // Mirrors BudgetTable's mode order exactly: unplanned wins over past/future.
  const mode: "empty" | "review" | "track" = !data.planned ? "empty" : isPast ? "review" : "track";
  const { text } = useMoney();
  // Q19: the Dashboard's helper — same figure, same annotation.
  const fundSpend = fundSpendLine(data.totals.fund_spend_sen);

  return (
    <div className="flex flex-col">
      <div className="eye-clear flex items-center pb-3 pt-1.5">
        <h2 className="text-2xl font-bold" style={{ color: "var(--ink-1)" }}>
          Budget
        </h2>
        <MonthSwitcher month={month} options={monthOptions} />
      </div>

      {mode === "empty" ? (
        <>
          <StartPlanCta month={month} monthName={monthName} />
          <Tip className="-mt-2 mb-2 text-center">
            Zero-based planning: give every ringgit a job — categories plus savings should add up to what you expect
            to earn.
          </Tip>
        </>
      ) : (
        <Hero data={data} todayStr={todayStr} showDaysToGo={mode === "track"} />
      )}

      {mode !== "empty" ? (
        <div className="mt-1">
          {data.rows.map((row) => (
            <CategoryRow key={row.category_id} row={row} />
          ))}
          <SavingsRow savings={data.savings} />
        </div>
      ) : null}

      {/* Ruling 7's disclosure of the one term the category rows above drop. */}
      {mode !== "empty" && fundSpend ? (
        <div className="mt-2 flex items-center justify-end text-[13px]" style={{ color: "var(--ink-2)" }}>
          <span className="tabular-nums">{text(fundSpend)}</span>
        </div>
      ) : null}

      {mode !== "empty" && data.unbudgeted.length > 0 ? <UnbudgetedRow unbudgeted={data.unbudgeted} /> : null}

      {bannerVisible ? (
        <NextPlanBanner
          href={bannerHref}
          nextMonthName={bannerNextMonthName}
          currentMonthName={bannerCurrentMonthName}
          openDateLabel={bannerOpenDateLabel}
        />
      ) : null}

      {mode !== "empty" ? (
        <AllocationGuideMobile
          rows={data.rows}
          savingsAllocatedSen={data.savings.allocated_sen}
          benchmark={data.benchmark}
        />
      ) : null}
    </div>
  );
}
