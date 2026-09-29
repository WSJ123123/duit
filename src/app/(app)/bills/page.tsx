import Link from "next/link";
import type { ReactNode } from "react";
import { createServerSupabase } from "@/db/server";
import { getBills, type BillsData } from "@/db/bills";
import { getFundOptions } from "@/db/funds";
import { klToday } from "@/lib/kl-date";
import { Money } from "@/components/Money";
import { formatDM } from "@/lib/bills-display";
import { Tip } from "@/components/Tip";
import { BillsTable, BillsList, type BillFormOptions } from "@/components/BillsTable";
import { RecordNow } from "@/components/RecordNow";
import { CashflowChart, RANGE_DAYS } from "@/components/CashflowChart";

/**
 * Bills & projected cashflow (Plan 7 Task 5, mockup v6 §8 desktop / §10
 * phone 2 mobile). Server component: one composed `getBills` read plus the
 * three option lists the `Record now` form needs (the dashboard's precedent).
 *
 * Three places this deliberately goes beyond what v6 draws, because the
 * rulings require them and v6 has no picture of them (all three are in the
 * task report):
 * 1. **Needs attention** — ruling 11a's blocked rules, grouped one row per
 *    rule with the reason and a link to Settings › Recurring.
 * 2. **Scheduled transfers** — ruling 11 lists transfer occurrences
 *    separately and says they are not bills; the card also says which of them
 *    move the projection and which net out inside the spendable set.
 * 3. **Record now** — ruling 14's affordance (inside `BillsTable`).
 *
 * v6's Watch card row `Paid from a fund` reads RETROSPECTIVELY (F3): the
 * forward-looking reading really is unbuildable — no recurring rule holds a
 * `fund_id` — but `Record now` opens the ordinary form WITH ruling 7's fund
 * picker, so a scheduled bill can be paid from a fund and the recorded ones
 * are countable. Its sub-line says plainly that it counts bills already
 * recorded, so the figure cannot be misread as a forecast.
 */

const DEFAULT_WINDOW_DAYS = 30;

function StatTile({
  label,
  swatch,
  value,
  valueColor,
  sub,
}: {
  label: string;
  swatch: string;
  value: ReactNode;
  valueColor?: string;
  sub: ReactNode;
}) {
  return (
    <div className="rounded-2xl p-3.5" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: swatch }} />
        {label}
      </div>
      <div className="mt-1 text-lg font-bold tracking-tight tabular-nums" style={{ color: valueColor ?? "var(--ink-1)" }}>
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
        {sub}
      </div>
    </div>
  );
}

function ItRow({ label, tip, sub, value, valueColor }: { label: string; tip?: string; sub: ReactNode; value: ReactNode; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-2.5 text-[13px] last:border-b-0" style={{ borderColor: "var(--grid)" }}>
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

/** Ruling 11a: one row per blocked RULE, not per occurrence — a rule the cron
 *  cannot materialise reappears in every window forever, and listing 14 copies
 *  of the same problem would bury the fix instead of naming it. */
function NeedsAttention({ blocked }: { blocked: BillsData["blocked"] }) {
  const byRule = new Map<
    string,
    { name: string; reason: string; cron_materializes: boolean; dates: string[] }
  >();
  for (const row of blocked) {
    const entry = byRule.get(row.rule_id);
    if (entry) entry.dates.push(row.date);
    else
      byRule.set(row.rule_id, {
        name: row.name,
        reason: row.reason,
        cron_materializes: row.cron_materializes,
        dates: [row.date],
      });
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--critical)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--critical)" }}>
        Needs attention
      </h3>
      <Tip className="mb-2">
        these rules are misconfigured and will keep reappearing until you fix them in Settings › Recurring —
        each row says whether the daily job still records it
      </Tip>
      {[...byRule.entries()].map(([ruleId, entry]) => (
        <ItRow
          key={ruleId}
          label={entry.name}
          // Data, not a Tip: "needs attention" and "counted in the projection"
          // must never be silently contradictory, so the row names which kind
          // this is. The archived axis is still materialised by the daily job
          // (its guard tests currency, not `archived`), so its money counts.
          sub={`${entry.reason} · ${entry.dates.length} occurrence${entry.dates.length === 1 ? "" : "s"} from ${formatDM(entry.dates[0]!)} · ${
            entry.cron_materializes
              ? "the daily job still records these, so they stay in the totals and the projection"
              : "the daily job cannot record these, so they are left out of the totals and the projection"
          }`}
          value={
            <Link href="/settings/recurring" style={{ color: "var(--accent)" }}>
              Fix rule →
            </Link>
          }
        />
      ))}
    </div>
  );
}

/** Ruling 11: transfer occurrences are listed separately and are not bills.
 *  Q13: each unrecorded one carries `Record now` — the same sheet, on the
 *  transfer tab, at the materializer's id — and a recorded one links to its
 *  entry. */
function ScheduledTransfers({ transfers, form }: { transfers: BillsData["transfers"]; form: BillFormOptions }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Scheduled transfers
      </h3>
      <Tip className="mb-2">
        moving your own money is not a bill — it only changes the projection when it leaves or enters the
        accounts that pay your bills
      </Tip>
      {transfers.map((t) => (
        <ItRow
          key={`${t.rule_id}:${t.date}`}
          label={t.name}
          sub={`${formatDM(t.date)} · ${t.account_name} → ${t.transfer_account_name ?? "—"} · ${
            t.state === "recorded"
              ? "recorded ✓"
              : t.crosses_spendable
                ? "moves the projection"
                : "inside your spendable accounts — nets to zero"
          }`}
          value={
            <span className="flex items-center justify-end gap-2">
              <Money sen={t.amount_sen} />
              <RecordNow row={t} form={form} recordedTxId={t.recorded_tx_id} />
            </span>
          }
          valueColor={t.state === "recorded" ? "var(--ink-3)" : undefined}
        />
      ))}
    </div>
  );
}

function WatchCard({ data }: { data: BillsData }) {
  const belowZero = data.projection.min_sen <= 0;
  const variable = data.projection.variable_occurrences;
  const lowestSub =
    data.projection.min_date === data.today
      ? "today · your balance never dips below this"
      : `${formatDM(data.projection.min_date)} · ${belowZero ? "goes negative" : "stays above zero"}`;

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Watch
      </h3>
      <Tip className="mb-2">
        the two things a {data.window_days}-day projection can actually tell you: when you dip lowest, and
        what is not yet certain
      </Tip>
      <ItRow
        label="Lowest point"
        sub={lowestSub}
        value={<Money sen={data.projection.min_sen} />}
        valueColor={belowZero ? "var(--critical)" : "var(--good-text)"}
      />
      <ItRow
        label="Variable bills"
        tip="the amount is a template — confirm the real figure when it lands"
        sub={
          variable.length === 0
            ? "every amount in the projection is fixed"
            : variable.map((o) => `${o.name} · ${formatDM(o.date)}`).join(" · ")
        }
        value={<Money sen={data.projection.variable_total_sen} />}
      />
      <ItRow
        label="Paid from a fund"
        tip="a fund is money you set aside earlier — paying a bill from one leaves the month's category budget alone"
        sub={
          data.fund_paid_count === 0
            ? "no bill recorded in this window was paid from a fund · tag one on the Record now form"
            : `${data.fund_paid_count} bill${data.fund_paid_count === 1 ? "" : "s"} already recorded in this window drew on a fund`
        }
        value={<Money sen={data.fund_paid_sen} />}
      />
      <ItRow
        label="Overdue"
        sub={
          // One set for both halves: `overdue_count` ships from getBills beside
          // `overdue_sen`, off the same array. Counting `data.overdue` here
          // while showing that total printed "1 past its date" next to two
          // items' worth of money.
          data.overdue_count === 0
            ? "nothing past its date and unrecorded"
            : `${data.overdue_count} past its date and unrecorded`
        }
        value={<Money sen={data.overdue_sen} />}
        valueColor={data.overdue_sen > 0 ? "var(--critical)" : undefined}
      />
      <ItRow
        label="Needs attention"
        sub={
          data.blocked.length === 0
            ? "every rule is pointed at a live MYR account"
            : `${data.blocked.length} occurrence${data.blocked.length === 1 ? "" : "s"} on a rule that needs fixing`
        }
        value={String(data.blocked.length)}
        valueColor={data.blocked.length > 0 ? "var(--critical)" : undefined}
      />
      <div
        className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-xs font-semibold"
        style={{ borderColor: "var(--grid)", color: "var(--ink-1)" }}
      >
        <span>Projection ends {formatDM(data.to)}</span>
        <span className="tabular-nums"><Money sen={data.projection.end_sen} /></span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-2xl p-8 text-center"
      style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
    >
      <p className="text-sm" style={{ color: "var(--ink-3)" }}>
        No recurring rules yet.
      </p>
      <Link
        href="/settings/recurring"
        className="rounded-lg border px-3.5 py-2 text-sm font-medium"
        style={{ background: "var(--accent)", borderColor: "transparent", color: "#ffffff" }}
      >
        Set up recurring rules
      </Link>
      <Tip>
        Bills are derived: every row on this page is an occurrence of a recurring rule, so the rent and the
        salary you already told the app about become a 30-day view of what leaves and when.
      </Tip>
    </div>
  );
}

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { days } = await searchParams;
  const parsedDays = Number(days);
  const windowDays = (RANGE_DAYS as readonly number[]).includes(parsedDays)
    ? parsedDays
    : DEFAULT_WINDOW_DAYS;

  const todayIso = klToday(new Date());
  const supabase = await createServerSupabase();
  const [data, accountsRes, categoriesRes, funds] = await Promise.all([
    getBills(supabase, todayIso, windowDays),
    supabase.from("accounts").select("id, name, currency, archived").order("created_at"),
    supabase.from("categories").select("id, name, kind, archived").order("created_at"),
    // Ruling 7's fund picker on the `Record now` sheet — a road-tax bill is
    // exactly the thing a sinking fund exists to pay.
    getFundOptions(supabase),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (categoriesRes.error) throw categoriesRes.error;

  // fxRates are deliberately not loaded: `Record now` never opens on a
  // non-MYR account (those occurrences are `blocked`), so the cross-currency
  // received-amount prefill has nothing to prefill from here.
  const form: BillFormOptions = {
    accounts: accountsRes.data as BillFormOptions["accounts"],
    categories: categoriesRes.data as BillFormOptions["categories"],
    funds,
    todayStr: todayIso,
  };

  // The label beside "Due in 7 days" must name a bill from the SAME set the
  // count and the total come from. `data.overdue[0]` was not filtered to
  // expenses (an overdue INCOME occurrence could name the tile) and could
  // never name a blocked-but-materialised row that the count includes.
  // `due_soon.bills` is exactly that set, sorted by date — so the earliest
  // entry is the right one, and the three figures cannot disagree.
  const nextBill = data.due_soon.bills[0];
  const nextIncome = data.due_soon.next_income;
  const belowZero = data.projection.min_sen <= 0;
  const lists = { upcoming: data.upcoming, overdue: data.overdue, recorded: data.recorded, todayIso, form };

  return (
    <>
      {/* Desktop — mockup v6 §8 */}
      <div className="hidden md:flex md:flex-col md:gap-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
            Bills &amp; cashflow
          </h2>
          <Link
            href="/settings/recurring"
            className="ml-auto rounded-lg border px-3.5 py-2 text-sm font-medium"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink-1)" }}
          >
            Manage recurring
          </Link>
        </div>

        {!data.has_active_rules ? (
          <EmptyState />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Due in 7 days"
                swatch="var(--warning)"
                value={<Money sen={data.due_7_sen} />}
                sub={
                  data.due_7_count === 0
                    ? "nothing due this week"
                    : `${data.due_7_count} bill${data.due_7_count === 1 ? "" : "s"}${nextBill ? ` · ${nextBill.name}, ${formatDM(nextBill.date)}` : ""}`
                }
              />
              <StatTile
                label={`Due in ${data.window_days} days`}
                swatch="var(--accent)"
                value={<Money sen={data.due_window_sen} />}
                sub={`${data.due_window_count} bill${data.due_window_count === 1 ? "" : "s"}${
                  data.due_window_variable_count > 0
                    ? ` · ${data.due_window_variable_count} needs confirming`
                    : ""
                }`}
              />
              <StatTile
                label="Expected income"
                swatch="var(--good)"
                value={<Money sen={data.income_window_sen} />}
                sub={
                  nextIncome
                    ? `${data.income_window_count} · ${nextIncome.name}, ${formatDM(nextIncome.date)}`
                    : "no income rules in this window"
                }
              />
              <StatTile
                label="Lowest balance"
                swatch="var(--series-2)"
                value={<Money sen={data.projection.min_sen} />}
                valueColor={belowZero ? "var(--critical)" : "var(--good-text)"}
                sub={`${formatDM(data.projection.min_date)} · ${belowZero ? "goes negative" : "stays above zero"}`}
              />
            </div>

            <CashflowChart
              projection={data.projection}
              fromIso={data.today}
              toIso={data.to}
              windowDays={data.window_days}
              spendableBaseSen={data.spendable_base_sen}
              spendableAccounts={data.spendable_accounts}
              excludedAccountCount={data.excluded_account_count}
            />

            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[1.6fr_1fr]">
              <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
                  Upcoming
                </h3>
                <Tip className="mb-2">
                  generated from your recurring rules — a bill flips to recorded the moment its transaction
                  exists
                </Tip>
                <BillsTable {...lists} />
                <div
                  className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-xs font-semibold"
                  style={{ borderColor: "var(--grid)", color: "var(--ink-1)" }}
                >
                  <span>
                    {data.due_window_count} bill{data.due_window_count === 1 ? "" : "s"} out ·{" "}
                    {data.income_window_count} in · next {data.window_days} days
                  </span>
                  <span
                    className="tabular-nums"
                    style={{ color: data.net_window_sen < 0 ? "var(--critical)" : "var(--good-text)" }}
                  >
                    {data.net_window_sen >= 0 ? "+ " : "− "}
                    <Money sen={Math.abs(data.net_window_sen)} />
                  </span>
                </div>
              </div>
              <WatchCard data={data} />
            </div>

            {data.blocked.length > 0 ? <NeedsAttention blocked={data.blocked} /> : null}
            {data.transfers.length > 0 ? <ScheduledTransfers transfers={data.transfers} form={form} /> : null}
          </>
        )}
      </div>

      {/* Mobile — mockup v6 §10 phone 2 */}
      <div className="md:hidden">
        <div className="eye-clear flex items-center pb-3 pt-1.5">
          <h2 className="text-2xl font-bold" style={{ color: "var(--ink-1)" }}>
            Bills
          </h2>
          <Link
            href="/settings/recurring"
            className="ml-auto rounded-lg border px-2.5 py-1 text-xs font-medium"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink-1)" }}
          >
            Recurring
          </Link>
        </div>

        {!data.has_active_rules ? (
          <EmptyState />
        ) : (
          <>
            <div className="text-[30px] font-bold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
              <Money sen={data.due_window_sen} />
            </div>
            <div className="mb-3.5 mt-0.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              due in the next {data.window_days} days · {data.due_window_count} bill
              {data.due_window_count === 1 ? "" : "s"} ·{" "}
              <span style={{ color: belowZero ? "var(--critical)" : undefined, fontWeight: belowZero ? 600 : 400 }}>
                lowest balance <Money sen={data.projection.min_sen} /> on {formatDM(data.projection.min_date)}
              </span>
            </div>

            <div className="mb-1.5 mt-1 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>
              Next {data.window_days} days
            </div>
            <BillsList {...lists} />

            {data.blocked.length > 0 ? (
              <div className="mt-3">
                <NeedsAttention blocked={data.blocked} />
              </div>
            ) : null}
            {data.transfers.length > 0 ? (
              <div className="mt-3">
                <ScheduledTransfers transfers={data.transfers} form={form} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
