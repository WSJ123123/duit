import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { getAccountsWithBalances, getMonthTransactions, getMonthSplitsAndPayments } from "@/db/queries";
import { getOpenReimbursements } from "@/lib/reimbursements";
import { getFundOptions } from "@/db/funds";
import { spendByCategory, netExpenseSen } from "@/lib/stats";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { BarMeter } from "@/components/BarMeter";
import { TxFormSheet } from "@/components/TxFormSheet";
import { Money } from "@/components/Money";
import { TransactionRows, type TxDisplayRow, type EnrichedTxRow } from "@/components/TransactionRow";
import { AccountReconcile } from "@/components/AccountReconcile";
import { RecordPaymentForm } from "@/components/RecordPaymentForm";
import { TransactionSearchBox } from "@/components/TransactionSearchBox";
import { ActivityList } from "@/components/ActivityList";

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

function monthRange(month: string): { start: string; end: string } {
  const start = `${month}-01`;
  const end = `${shiftMonth(month, 1)}-01`;
  return { start, end };
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; q?: string }>;
}) {
  const { month: monthParam, q: qParam } = await searchParams;
  const todayStr = todayInKL();
  const yesterdayStr = addDaysUTC(todayStr, -1);
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : todayStr.slice(0, 7);
  const q = qParam?.trim() ?? "";
  const { start, end } = monthRange(month);

  const supabase = await createServerSupabase();

  const [monthRows, { splits, payments }, accounts, openReimbursements, categoriesRes, fxRes, funds] = await Promise.all([
    getMonthTransactions(supabase, { start, end, q }),
    // Ruling 10a: bounded by the month, never the whole table.
    getMonthSplitsAndPayments(supabase, { start, end }),
    getAccountsWithBalances(supabase),
    getOpenReimbursements(supabase),
    supabase.from("categories").select("id, name, kind, archived").order("created_at"),
    supabase.from("fx_rates").select("pair, rate_e8, as_of"),
    // Ruling 7's fund picker (v6 §10 phone 3) — every edit sheet on this page
    // gets it, and every one of them carries an existing tag back on save.
    getFundOptions(supabase),
  ]);
  if (categoriesRes.error) throw categoriesRes.error;
  if (fxRes.error) throw fxRes.error;
  const fxRates = fxRes.data as Array<{ pair: string; rate_e8: number; as_of: string }>;

  const categories = categoriesRes.data as CategoryRow[];
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const splitsByTx = new Map<string, Array<{ category_id: string; amount_sen: number }>>();
  for (const s of splits) {
    const list = splitsByTx.get(s.transaction_id) ?? [];
    list.push({ category_id: s.category_id, amount_sen: s.amount_sen });
    splitsByTx.set(s.transaction_id, list);
  }
  const paidByTx = new Map<string, number>();
  for (const p of payments) {
    paidByTx.set(p.transaction_id, (paidByTx.get(p.transaction_id) ?? 0) + p.amount_sen);
  }

  const transactions: TxDisplayRow[] = monthRows.map((t) => ({
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
    paid_sen: paidByTx.get(t.id) ?? 0,
    splits: splitsByTx.get(t.id) ?? [],
  }));

  const activeAccounts = accounts.filter((a) => !a.archived);
  const formAccounts = accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, archived: a.archived }));
  const formCategories = categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, archived: c.archived }));

  const enrichedRows: EnrichedTxRow[] = transactions.map((tx) => {
    const category = tx.category_id ? categoryById.get(tx.category_id) : undefined;
    const account = accountById.get(tx.account_id);
    const transferAccount = tx.transfer_account_id ? accountById.get(tx.transfer_account_id) : undefined;
    return {
      ...tx,
      accountName: account?.name ?? "—",
      accountCurrency: account?.currency ?? "MYR",
      transferAccountName: transferAccount?.name ?? null,
      categoryName: category?.name ?? null,
    };
  });
  const incomeCategories = categories
    .filter((c) => c.kind === "income" && !c.archived)
    .map((c) => ({ id: c.id, name: c.name }));

  // "This month" summary card (density ruling): reuse the pinned stats.ts
  // helpers for net-expense math — transfers excluded from every total below
  // (netExpenseSen returns 0 for them; the income sum and entry count skip
  // them explicitly). Ruling 7 trend guard: rows on non-MYR accounts carry
  // that currency's minor units, so they never enter these RM totals.
  const myrTransactions = transactions.filter(
    (t) => (accountById.get(t.account_id)?.currency ?? "MYR") === "MYR",
  );
  const monthNetExpenseSen = myrTransactions.reduce((sum, t) => sum + netExpenseSen(t), 0);
  const monthIncomeSen = myrTransactions.reduce(
    (sum, t) => (t.type === "income" ? sum + t.amount_sen : sum),
    0,
  );
  const monthEntryCount = myrTransactions.filter((t) => t.type !== "transfer").length;

  const monthSpendByCategory = spendByCategory(myrTransactions, splits);
  const topCategoryRows = Array.from(monthSpendByCategory.entries())
    .map(([categoryId, sen]) => ({
      categoryId,
      name: categoryId === null ? "Uncategorized" : (categoryById.get(categoryId)?.name ?? "Unknown"),
      sen,
    }))
    .sort((a, b) => b.sen - a.sen)
    .slice(0, 5);
  const topCategoryMax = Math.max(1, ...topCategoryRows.map((r) => Math.abs(r.sen)));

  const qs = (params: Record<string, string>) => {
    const usp = new URLSearchParams(params);
    return `/transactions?${usp.toString()}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="eye-clear flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
          Transactions
        </h2>
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--ink-2)" }}>
          <Link
            href={qs({ month: shiftMonth(month, -1), ...(q ? { q } : {}) })}
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
            href={qs({ month: shiftMonth(month, 1), ...(q ? { q } : {}) })}
            className="rounded-lg border px-2 py-1"
            style={{ borderColor: "var(--border)" }}
          >
            ›
          </Link>
        </div>
        <TransactionSearchBox initialQuery={q} />
        <div className="ml-auto flex items-center gap-2">
          {/* Plan 8 ruling 18: desktop-first — hidden below md, no More-page entry. */}
          <Link
            href="/transactions/import"
            className="hidden md:inline-flex rounded-lg border px-3.5 py-2 text-sm font-medium"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink-1)" }}
          >
            Import CSV
          </Link>
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="hidden flex-col gap-4 md:flex">
          <Card title="Recent transactions" subtitle={`${transactions.length} entries this month`}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {["Description", "Category", "Account", "Date", "Amount", ""].map((h, i) => (
                      <th
                        key={h || i}
                        className={`px-2 py-1.5 text-xs font-semibold ${i === 4 ? "text-right" : "text-left"}`}
                        style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <TransactionRows
                    rows={enrichedRows}
                    todayStr={todayStr}
                    yesterdayStr={yesterdayStr}
                    accounts={formAccounts}
                    categories={formCategories}
                    fxRates={fxRates}
                    funds={funds}
                    emptyLabel={`No transactions ${q ? "match your search" : "this month"}.`}
                  />
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="This month">
            <Tip className="-mt-1 mb-3">Totals update as you log — transfers excluded.</Tip>
            <p className="text-xs tabular-nums" style={{ color: "var(--ink-2)" }}>
              Spent <Money sen={monthNetExpenseSen} /> · Income <Money sen={monthIncomeSen} /> · {monthEntryCount}{" "}
              entries
            </p>
            {topCategoryRows.length > 0 ? (
              <div className="mt-3">
                {topCategoryRows.map((r) => (
                  <BarMeter
                    key={r.categoryId ?? "null"}
                    label={r.name}
                    trailing={<Money sen={r.sen} />}
                    fraction={r.sen / topCategoryMax}
                  />
                ))}
              </div>
            ) : null}
          </Card>
        </div>

        <ActivityList
          rows={enrichedRows}
          todayStr={todayStr}
          yesterdayStr={yesterdayStr}
          accounts={formAccounts}
          categories={formCategories}
          fxRates={fxRates}
          funds={funds}
          emptyLabel={`No transactions ${q ? "match your search" : "this month"}.`}
        />

        <div className="flex flex-col gap-4">
          <Card title="Accounts" subtitle="Balances · reconcile to a stated amount">
            <ul className="flex flex-col">
              {activeAccounts.length === 0 ? (
                <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
                  No active accounts.
                </li>
              ) : null}
              {activeAccounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-2" style={{ borderBottom: "1px solid var(--grid)" }}>
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
