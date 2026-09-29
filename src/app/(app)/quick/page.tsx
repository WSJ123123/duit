import { requireUser, createServerSupabase } from "@/db/server";
import { loadParserContext } from "@/db/parser-context";
import { getTodayTotal, getMonthStats } from "@/db/stats";
import { getBudgetGlance } from "@/db/budget";
import { getFundOptions } from "@/db/funds";
import { klToday } from "@/lib/kl-date";
import type { TxType } from "@/lib/transactions";
import type { EnrichedTxRow } from "@/components/TransactionRow";
import { QuickAdd } from "@/components/QuickAdd";

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

interface PaymentRow {
  transaction_id: string;
  amount_sen: number;
}

interface AccountRow {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
}

interface CategoryRow {
  id: string;
  name: string;
  kind: "expense" | "income";
  archived: boolean;
}

const RECENT_LIMIT = 10;
const USAGE_WINDOW_DAYS = 30;

function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function QuickAddPage({
  searchParams,
}: {
  searchParams: Promise<{ text?: string }>;
}) {
  const { text } = await searchParams;
  const user = await requireUser();
  const supabase = await createServerSupabase();
  const todayStr = klToday(new Date());
  const yesterdayStr = addDaysUTC(todayStr, -1);
  const usageStart = addDaysUTC(todayStr, -USAGE_WINDOW_DAYS);

  const [
    parserContext,
    todaySpendSen,
    monthStats,
    usageTxRes,
    recentTxRes,
    accountsRes,
    categoriesRes,
    budgetGlance,
    fxRes,
    funds,
  ] = await Promise.all([
    loadParserContext(supabase, user.id),
    getTodayTotal(supabase, todayStr),
    getMonthStats(supabase, todayStr.slice(0, 7)),
    supabase.from("transactions").select("category_id").gte("date", usageStart).lte("date", todayStr),
    supabase
      .from("transactions")
      .select(
        "id, type, amount_sen, account_id, transfer_account_id, received_sen, category_id, date, note, source, needs_review, expected_back_sen, fund_id, created_at",
      )
      .order("date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
    supabase.from("accounts").select("id, name, currency, archived").order("created_at"),
    supabase.from("categories").select("id, name, kind, archived").order("created_at"),
    getBudgetGlance(supabase, todayStr.slice(0, 7)),
    supabase.from("fx_rates").select("pair, rate_e8, as_of"),
    // Ruling 7's fund picker on the recent-row edit sheets.
    getFundOptions(supabase),
  ]);

  if (usageTxRes.error) throw usageTxRes.error;
  if (recentTxRes.error) throw recentTxRes.error;
  if (accountsRes.error) throw accountsRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (fxRes.error) throw fxRes.error;
  const fxRates = fxRes.data as Array<{ pair: string; rate_e8: number; as_of: string }>;

  const monthSpendSen = monthStats.expense_sen;
  const usageTx = usageTxRes.data as Array<{ category_id: string | null }>;

  const recentRows = recentTxRes.data as TxRow[];
  const recentIds = recentRows.map((t) => t.id);
  const [splitsRes, paymentsRes] =
    recentIds.length > 0
      ? await Promise.all([
          supabase.from("transaction_splits").select("transaction_id, category_id, amount_sen").in(
            "transaction_id",
            recentIds,
          ),
          supabase.from("reimbursement_payments").select("transaction_id, amount_sen").in(
            "transaction_id",
            recentIds,
          ),
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
  if (splitsRes.error) throw splitsRes.error;
  if (paymentsRes.error) throw paymentsRes.error;

  const accounts = accountsRes.data as AccountRow[];
  const categories = categoriesRes.data as CategoryRow[];
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const splitsByTx = new Map<string, Array<{ category_id: string; amount_sen: number }>>();
  for (const s of splitsRes.data as SplitRow[]) {
    const list = splitsByTx.get(s.transaction_id) ?? [];
    list.push({ category_id: s.category_id, amount_sen: s.amount_sen });
    splitsByTx.set(s.transaction_id, list);
  }
  const paidByTx = new Map<string, number>();
  for (const p of paymentsRes.data as PaymentRow[]) {
    paidByTx.set(p.transaction_id, (paidByTx.get(p.transaction_id) ?? 0) + p.amount_sen);
  }

  const recentEnriched: EnrichedTxRow[] = recentRows.map((t) => {
    const account = accountById.get(t.account_id);
    const transferAccount = t.transfer_account_id ? accountById.get(t.transfer_account_id) : undefined;
    const category = t.category_id ? categoryById.get(t.category_id) : undefined;
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
      paid_sen: paidByTx.get(t.id) ?? 0,
      splits: splitsByTx.get(t.id) ?? [],
      accountName: account?.name ?? "—",
      accountCurrency: account?.currency ?? "MYR",
      transferAccountName: transferAccount?.name ?? null,
      categoryName: category?.name ?? null,
    };
  });

  const formAccounts = accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, archived: a.archived }));
  const formCategories = categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, archived: c.archived }));

  return (
    <QuickAdd
      ctx={parserContext}
      initialText={text ?? ""}
      todayStr={todayStr}
      yesterdayStr={yesterdayStr}
      todaySpendSen={todaySpendSen}
      monthSpendSen={monthSpendSen}
      budgetGlance={budgetGlance}
      usageTx={usageTx}
      recentRows={recentEnriched}
      accounts={formAccounts}
      categories={formCategories}
      fxRates={fxRates}
      funds={funds}
    />
  );
}
