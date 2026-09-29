import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { getAccountsWithBalances } from "@/db/queries";
import { getNetWorthGlance } from "@/db/networth";
import { getOpenReimbursements } from "@/lib/reimbursements";
import { getMonthStats, getIncomeVsExpense } from "@/db/stats";
import { getBudgetMonth } from "@/db/budget";
import { getFundOptions } from "@/db/funds";
import { fundSpendLine } from "@/lib/funds-display";
import { getBills } from "@/db/bills";
import { meterState, type MeterState } from "@/lib/budget";
import type { TxType } from "@/lib/transactions";
import { Card } from "@/components/Card";
import { Money, MoneyText } from "@/components/Money";
import { Tip } from "@/components/Tip";
import { BarMeter } from "@/components/BarMeter";
import { TxFormSheet } from "@/components/TxFormSheet";
import { AccountReconcile } from "@/components/AccountReconcile";
import { RecordPaymentForm } from "@/components/RecordPaymentForm";
import { DueSoonCard } from "@/components/DueSoonCard";
import {
  dateLabel,
  categoryLabelFor,
  accountLabelFor,
  type EnrichedTxRow,
} from "@/lib/tx-display";

interface TxRow {
  id: string;
  type: TxType;
  amount_sen: number;
  account_id: string;
  transfer_account_id: string | null;
  received_sen: number | null;
  category_id: string | null;
  date: string;
  note: string;
  source: string;
  needs_review: boolean;
  expected_back_sen: number;
  fund_id: string | null;
  created_at: string;
}

interface SplitRow {
  transaction_id: string;
  category_id: string;
  amount_sen: number;
}

interface CategoryRow {
  id: string;
  name: string;
  kind: "expense" | "income";
  archived: boolean;
}

function todayInKL(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
}

function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftMonth(month: string, delta: number): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const total = y * 12 + (m - 1) + delta;
  const newY = Math.floor(total / 12);
  const newM = (total % 12) + 1;
  return `${newY}-${String(newM).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function monthShort(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

/** Same meter-state → color mapping as BudgetTable / BudgetMobile. */
function meterColor(state: MeterState): string {
  if (state === "over") return "var(--critical)";
  if (state === "warn") return "var(--warning)";
  return "var(--accent)";
}

/** Same delta-chip pattern as the net-worth hero (net-worth/page.tsx's
 *  DeltaChip) — duplicated locally since that one is page-scoped there, not
 *  a shared component. */
function NetWorthDeltaChip({ deltaSen, prevMonthLabel }: { deltaSen: number; prevMonthLabel: string }) {
  const isUp = deltaSen > 0;
  const isDown = deltaSen < 0;
  const color = isUp ? "var(--good-text)" : isDown ? "var(--critical)" : "var(--ink-2)";
  const bg = isUp
    ? "color-mix(in srgb, var(--good) 12%, transparent)"
    : isDown
      ? "color-mix(in srgb, var(--critical) 12%, transparent)"
      : "var(--chip)";
  const arrow = isUp ? "▲" : isDown ? "▼" : "→";
  return (
    <span className="rounded-full px-2.5 py-1 text-[13px] font-semibold" style={{ color, background: bg }}>
      {arrow} <Money sen={Math.abs(deltaSen)} /> vs {prevMonthLabel}
    </span>
  );
}

/** Minimal inline sparkline for the dashboard glance card — same
 *  index-spaced-x / min-max-scaled-y convention as NetWorthChart.tsx's
 *  toPoints, without axis labels or a range picker. Fewer than 2 points
 *  (pre-history, or a fresh user) renders a flat baseline instead of
 *  crashing on an empty or single-value series. */
function MiniSparkline({ values }: { values: number[] }) {
  const w = 160;
  const h = 36;
  if (values.length < 2) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-9 w-full">
        <line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="var(--baseline)" strokeWidth="1.5" />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-9 w-full">
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={points} />
    </svg>
  );
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month: monthParam } = await searchParams;
  const todayStr = todayInKL();
  const yesterdayStr = addDaysUTC(todayStr, -1);
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : todayStr.slice(0, 7);

  const supabase = await createServerSupabase();

  const [
    monthStats,
    incomeVsExpense6,
    accounts,
    openReimbursements,
    categoriesRes,
    recentTxRes,
    budgetMonth,
    netWorthGlance,
    fxRes,
    funds,
    bills,
  ] = await Promise.all([
    getMonthStats(supabase, month),
    getIncomeVsExpense(supabase, 6, todayStr),
    getAccountsWithBalances(supabase),
    getOpenReimbursements(supabase),
    supabase.from("categories").select("id, name, kind, archived").order("created_at"),
    supabase
      .from("transactions")
      .select(
        "id, type, amount_sen, account_id, transfer_account_id, received_sen, category_id, date, note, source, needs_review, expected_back_sen, fund_id, created_at",
      )
      .order("date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(10),
    getBudgetMonth(supabase, month),
    getNetWorthGlance(supabase, todayStr),
    supabase.from("fx_rates").select("pair, rate_e8, as_of"),
    // Ruling 7's fund picker on this card's Add-entry sheet.
    getFundOptions(supabase),
    // Ruling 13: the `Due soon` card IS the reminder surface (no push, no
    // sidebar badge). Always "today" and always the 30-day window — the
    // month picker above scopes the budget cards, not what is about to leave.
    getBills(supabase, todayStr),
  ]);
  if (categoriesRes.error) throw categoriesRes.error;
  if (recentTxRes.error) throw recentTxRes.error;
  if (fxRes.error) throw fxRes.error;
  const fxRates = fxRes.data as Array<{ pair: string; rate_e8: number; as_of: string }>;

  const categories = categoriesRes.data as CategoryRow[];
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const activeAccounts = accounts.filter((a) => !a.archived);
  const incomeCategories = categories
    .filter((c) => c.kind === "income" && !c.archived)
    .map((c) => ({ id: c.id, name: c.name }));
  const formAccounts = accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, archived: a.archived }));
  const formCategories = categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, archived: c.archived }));

  // Recent transactions: same tx + splits join pattern as the transactions
  // page, scoped to the latest 10 rows overall (not month-filtered).
  const recentTx = recentTxRes.data as TxRow[];
  const recentTxIds = recentTx.map((t) => t.id);
  const splitsRes =
    recentTxIds.length > 0
      ? await supabase
          .from("transaction_splits")
          .select("transaction_id, category_id, amount_sen")
          .in("transaction_id", recentTxIds)
      : { data: [] as SplitRow[], error: null };
  if (splitsRes.error) throw splitsRes.error;

  const splitsByTx = new Map<string, Array<{ category_id: string; amount_sen: number }>>();
  for (const s of splitsRes.data as SplitRow[]) {
    const list = splitsByTx.get(s.transaction_id) ?? [];
    list.push({ category_id: s.category_id, amount_sen: s.amount_sen });
    splitsByTx.set(s.transaction_id, list);
  }

  const recentRows: EnrichedTxRow[] = recentTx.map((t) => {
    const category = t.category_id ? categoryById.get(t.category_id) : undefined;
    const account = accountById.get(t.account_id);
    const transferAccount = t.transfer_account_id ? accountById.get(t.transfer_account_id) : undefined;
    return {
      id: t.id,
      type: t.type,
      amount_sen: t.amount_sen,
      account_id: t.account_id,
      transfer_account_id: t.transfer_account_id,
      received_sen: t.received_sen,
      category_id: t.category_id,
      date: t.date,
      note: t.note,
      source: t.source,
      needs_review: t.needs_review,
      expected_back_sen: t.expected_back_sen,
      fund_id: t.fund_id,
      // Reimbursement paid-so-far isn't shown on this card (badges live on
      // the Transactions page); defaulting keeps EnrichedTxRow's shape without
      // an unused extra query.
      paid_sen: 0,
      splits: splitsByTx.get(t.id) ?? [],
      accountName: account?.name ?? "—",
      accountCurrency: account?.currency ?? "MYR",
      transferAccountName: transferAccount?.name ?? null,
      categoryName: category?.name ?? null,
    };
  });

  const savedSen = monthStats.income_sen - monthStats.expense_sen;

  // Null only for a user with literally no accounts/history yet (see
  // getNetWorthGlance); the card still renders always, so that falls back to
  // a live-zero baseline rather than being hidden.
  const netWorth = netWorthGlance ?? {
    total_sen: 0,
    delta_sen: null,
    spark: [] as number[],
    fx_missing: [] as string[],
  };
  const prevNetWorthMonthLabel = monthShort(shiftMonth(todayStr.slice(0, 7), -1));

  // Top 6 categories by net spend + an "Other" bucket for the remainder.
  // Uncategorized (null key) keeps its own label unless it falls past the
  // top 6, in which case it's absorbed into Other like everything else.
  //
  // Planned month: source from BudgetMonthData instead of the raw (possibly
  // per-subcategory) spend map — rows[] is already rolled up to top-level
  // parents (the same granularity as allocations), and unbudgeted[] carries
  // the rest (uncategorized + non-expense-kind spend) at that same
  // granularity. Single source of truth per Task 7's contract.
  const spendSourceRows: Array<{ categoryId: string | null; name: string; sen: number; allocatedSen: number | null }> =
    budgetMonth.planned
      ? [
          ...budgetMonth.rows
            .filter((r) => r.spent_sen !== 0)
            .map((r) => ({ categoryId: r.category_id, name: r.name, sen: r.spent_sen, allocatedSen: r.allocated_sen })),
          ...budgetMonth.unbudgeted.map((u) => ({
            categoryId: u.category_id,
            name: u.name,
            sen: u.spent_sen,
            allocatedSen: null,
          })),
        ]
      : Array.from(monthStats.spend_by_category.entries()).map(([categoryId, sen]) => ({
          categoryId,
          name: categoryId === null ? "Uncategorized" : (categoryById.get(categoryId)?.name ?? "Unknown"),
          sen,
          allocatedSen: null,
        }));
  const spendRows = spendSourceRows.sort((a, b) => b.sen - a.sen);
  const topSpendRows = spendRows.slice(0, 6);
  const otherSen = spendRows.slice(6).reduce((sum, r) => sum + r.sen, 0);
  const spendDisplayRows =
    otherSen > 0
      ? [...topSpendRows, { categoryId: "__other__", name: "Other", sen: otherSen, allocatedSen: null }]
      : topSpendRows;
  const spendMax = Math.max(1, ...spendDisplayRows.map((r) => Math.abs(r.sen)));
  // Q7: null on a month with no fund-paid spend, so the card stays quiet.
  const fundSpend = fundSpendLine(monthStats.fund_spend_sen);

  const ivxMax = Math.max(1, ...incomeVsExpense6.flatMap((m) => [m.income_sen, m.expense_sen]));

  const qs = (params: Record<string, string>) => `/dashboard?${new URLSearchParams(params).toString()}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="eye-clear flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
          Dashboard
        </h2>
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--ink-2)" }}>
          <Link
            href={qs({ month: shiftMonth(month, -1) })}
            className="rounded-lg border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          >
            ‹
          </Link>
          <span
            className="rounded-lg border px-3 py-1.5"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            {monthLabel(month)}
          </span>
          <Link
            href={qs({ month: shiftMonth(month, 1) })}
            className="rounded-lg border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          >
            ›
          </Link>
        </div>
        <div className="ml-auto">
          <TxFormSheet
            mode="create"
            accounts={formAccounts}
            categories={formCategories}
            fxRates={fxRates}
            funds={funds}
            todayStr={todayStr}
            triggerLabel="+ Add entry"
            triggerVariant="primary"
          />
        </div>
      </div>

      <Card title="Net worth">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[160px] flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span
                className="text-2xl font-semibold tracking-tight tabular-nums"
                style={{ color: "var(--ink-1)" }}
              >
                <Money sen={netWorth.total_sen} />
              </span>
              {netWorth.delta_sen !== null ? (
                <NetWorthDeltaChip deltaSen={netWorth.delta_sen} prevMonthLabel={prevNetWorthMonthLabel} />
              ) : null}
            </div>
            {netWorth.fx_missing.length > 0 ? (
              // Ruling 19: the same honest-gap line /net-worth already shows.
              // A total that silently omits a holding is a disclosure defect
              // wherever it appears — data, not a Tip, so tips-off keeps it.
              <p className="mt-1 text-xs font-medium" style={{ color: "var(--warning)" }}>
                No {netWorth.fx_missing.join(", ")} rate fetched yet — those balances are excluded from
                this total until the next daily update.
              </p>
            ) : null}
            <Link
              href="/net-worth"
              className="mt-2 inline-block text-xs font-semibold"
              style={{ color: "var(--accent)" }}
            >
              View net worth →
            </Link>
          </div>
          <div className="w-full sm:w-40">
            <MiniSparkline values={netWorth.spark} />
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-xs" style={{ color: "var(--ink-3)" }}>
            Income · {monthShort(month)}
          </div>
          <div
            className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums"
            style={{ color: "var(--ink-1)" }}
          >
            <Money sen={monthStats.income_sen} />
          </div>
        </Card>
        <Card>
          <div className="text-xs" style={{ color: "var(--ink-3)" }}>
            Spending · {monthShort(month)}
          </div>
          <div
            className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums"
            style={{ color: "var(--ink-1)" }}
          >
            <Money sen={monthStats.expense_sen} />
          </div>
        </Card>
        <Card>
          <div className="text-xs" style={{ color: "var(--ink-3)" }}>
            Saved · {monthShort(month)}
          </div>
          <div
            className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums"
            style={{ color: savedSen < 0 ? "var(--critical)" : "var(--good-text)" }}
          >
            <Money sen={savedSen} />
          </div>
        </Card>
      </div>

      <DueSoonCard dueSoon={bills.due_soon} projection={bills.projection} todayIso={todayStr} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card title={`Spending · ${monthLabel(month)}`}>
          <Tip className="-mt-1 mb-3">
            {budgetMonth.planned ? "spent / allocated by category" : "net spend by category"} · top 6 + Other
          </Tip>
          {!budgetMonth.planned ? (
            <Tip className="mb-3">
              <Link href="/budget" style={{ color: "var(--accent)" }}>
                Plan this month&apos;s budget
              </Link>{" "}
              to see spending limits here.
            </Tip>
          ) : null}
          {spendDisplayRows.length === 0 ? (
            <p className="py-4 text-sm" style={{ color: "var(--ink-3)" }}>
              No spending this month.
            </p>
          ) : (
            spendDisplayRows.map((r) => {
              const hasAllocation = r.allocatedSen !== null && r.allocatedSen > 0;
              return (
                <BarMeter
                  key={r.categoryId ?? "null"}
                  label={r.name}
                  trailing={
                    hasAllocation ? (
                      <>
                        <Money sen={r.sen} /> / <Money sen={r.allocatedSen!} bare />
                      </>
                    ) : (
                      <Money sen={r.sen} />
                    )
                  }
                  fraction={hasAllocation ? r.sen / r.allocatedSen! : r.sen / spendMax}
                  color={hasAllocation ? meterColor(meterState(r.sen, r.allocatedSen!)) : undefined}
                />
              );
            })
          )}
          {/* Q7: the one term these category totals drop (ruling 7). The
              Budget page has carried this disclosure since Plan 7; without it
              here the split is invisible inside a single screen. Data, not a
              Tip — it stays with tips off. */}
          {fundSpend ? (
            <p className="mt-2 text-xs tabular-nums" style={{ color: "var(--ink-2)" }}>
              <MoneyText>{fundSpend}</MoneyText>
            </p>
          ) : null}
        </Card>

        <Card title="Income vs expenses">
          <Tip className="-mt-1 mb-3">last 6 months</Tip>
          <div className="mb-2 flex gap-4 text-xs" style={{ color: "var(--ink-2)" }}>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--accent)" }} />
              Income
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "var(--series-2)" }} />
              Expenses
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {incomeVsExpense6.map((m) => (
              <div key={m.month}>
                <div className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
                  {monthShort(m.month)}
                </div>
                <BarMeter
                  label="Income"
                  trailing={<Money sen={m.income_sen} />}
                  fraction={m.income_sen / ivxMax}
                  color="var(--accent)"
                />
                <BarMeter
                  label="Expenses"
                  trailing={<Money sen={m.expense_sen} />}
                  fraction={m.expense_sen / ivxMax}
                  color="var(--series-2)"
                />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="Recent transactions">
          <Tip className="mb-2">latest 10 · full list in Transactions</Tip>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["Description", "Category", "Account", "Date", "Amount"].map((h, i) => (
                    <th
                      key={h}
                      className={`px-2 py-1.5 text-xs font-semibold ${i === 4 ? "text-right" : "text-left"}`}
                      style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-sm" style={{ color: "var(--ink-3)" }}>
                      No transactions yet.
                    </td>
                  </tr>
                ) : null}
                {recentRows.map((row) => (
                  <tr key={row.id} style={{ borderBottom: "1px solid var(--grid)" }}>
                    <td className="px-2 py-2 text-sm font-medium" style={{ color: "var(--ink-1)" }}>
                      {row.note || "(no note)"}
                    </td>
                    <td className="px-2 py-2 text-sm" style={{ color: "var(--ink-2)" }}>
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px]"
                        style={{ background: "var(--chip)", color: "var(--ink-2)" }}
                      >
                        {categoryLabelFor(row)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-sm" style={{ color: "var(--ink-2)" }}>
                      {accountLabelFor(row)}
                    </td>
                    <td className="px-2 py-2 text-sm" style={{ color: "var(--ink-2)" }}>
                      {dateLabel(row.date, todayStr, yesterdayStr)}
                    </td>
                    <td
                      className="px-2 py-2 text-right text-sm font-semibold tabular-nums"
                      style={{ color: row.type === "income" ? "var(--good-text)" : "var(--ink-1)" }}
                    >
                      {row.type === "income" ? (
                        <>
                          +<Money sen={row.amount_sen} currency={row.accountCurrency} />
                        </>
                      ) : (
                        <Money sen={-row.amount_sen} currency={row.accountCurrency} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link href="/transactions" className="mt-3 inline-block text-xs font-semibold" style={{ color: "var(--accent)" }}>
            View all transactions →
          </Link>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Accounts" subtitle="Balances · reconcile to a stated amount">
            <ul className="flex flex-col">
              {activeAccounts.length === 0 ? (
                <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
                  No active accounts.
                </li>
              ) : null}
              {activeAccounts.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center gap-2 py-2"
                  style={{ borderBottom: "1px solid var(--grid)" }}
                >
                  <span className="flex-1 text-sm font-medium" style={{ color: "var(--ink-1)" }}>
                    {a.name}
                  </span>
                  <span className="text-sm tabular-nums" style={{ color: "var(--ink-2)" }}>
                    <Money sen={a.balance_sen} currency={a.currency} />
                  </span>
                  <AccountReconcile accountId={a.id} incomeCategories={incomeCategories} />
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Owed to me" subtitle="open reimbursements">
            <ul className="flex flex-col">
              {openReimbursements.length === 0 ? (
                <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
                  Nothing outstanding.
                </li>
              ) : null}
              {openReimbursements.map((r) => (
                <li
                  key={r.transaction_id}
                  className="flex flex-wrap items-center gap-2 py-2"
                  style={{ borderBottom: "1px solid var(--grid)" }}
                >
                  <span className="flex-1 min-w-[140px] text-sm">
                    <span className="font-medium" style={{ color: "var(--ink-1)" }}>
                      {r.note || "(no note)"}
                    </span>
                    <div className="text-xs" style={{ color: "var(--ink-3)" }}>
                      {r.date} · <Money sen={r.paid_sen} /> of <Money sen={r.expected_back_sen} /> paid
                    </div>
                  </span>
                  <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--good-text)" }}>
                    <Money sen={r.owed_sen} />
                  </span>
                  <RecordPaymentForm
                    transactionId={r.transaction_id}
                    accounts={activeAccounts.filter((a) => a.currency === "MYR")}
                  />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
