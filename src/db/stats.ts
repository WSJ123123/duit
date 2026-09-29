import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, IN_CHUNK } from "@/db/paging";
import {
  spendByCategory,
  incomeVsExpense,
  todayTotal,
  netExpenseSen,
  type TxLike,
  type SplitLike,
} from "@/lib/stats";

/** Columns the pure stats helpers need — kept explicit (query-layer convention). */
const TX_STATS_COLUMNS =
  "id, type, amount_sen, expected_back_sen, category_id, date, account_id, fund_id";

/** A stats row as read: TxLike plus the two columns the filters key on. */
type StatsTxRow = TxLike & { account_id: string; fund_id: string | null };

export interface MonthStats {
  /** "YYYY-MM" (KL month). */
  month: string;
  /** Sum of income amount_sen for the month. */
  income_sen: number;
  /** Sum of net expense (amount − expected_back) for the month. */
  expense_sen: number;
  /** Net expense sen per category; key null = uncategorized. Plan 7 ruling 7:
   *  fund-paid expenses are NOT here — they were pre-saved, so they never
   *  count against a category limit. */
  spend_by_category: Map<string | null, number>;
  /** Plan 7 ruling 7: the month's fund-paid net expense — the term
   *  `spend_by_category` drops. Keyed on `fund_id is not null` and BLIND to
   *  the fund's `archived` flag (ruling 9a: archiving never untags, and the
   *  money really was pre-saved). Computed with the same `netExpenseSen`
   *  helper the other totals use, so the identity
   *    Σ spend_by_category (null key included) + fund_spend_sen = expense_sen
   *  holds by construction rather than by trusting ruling 6's enforcement. */
  fund_spend_sen: number;
}

/** First day of `month` ("YYYY-MM") as a date string. */
function monthStart(month: string): string {
  return `${month}-01`;
}

/** First day of the month after `month` ("YYYY-MM"), integer arithmetic only. */
function nextMonthStart(month: string): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-01`;
}

/** The `n` months ending at (and including) todayIso's month, oldest first. */
function lastMonths(n: number, todayIso: string): string[] {
  const [yStr, mStr] = todayIso.slice(0, 7).split("-");
  let y = Number(yStr);
  let m = Number(mStr); // 1-based
  const months: string[] = [];
  for (let i = 0; i < n; i++) {
    months.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}

/**
 * Ruling 7 trend guard (rule 16 extended, pinned by src/db/trend-guard.test.ts):
 * transactions belonging to non-MYR accounts never enter income/expense
 * trends, spend-by-category, budget math or the set-aside derivation — their
 * amount_sen are minor units of the ACCOUNT's currency, not MYR sen. Every
 * stats read in this module filters through this set.
 */
async function nonMyrAccountIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from("accounts").select("id").neq("currency", "MYR");
  if (error) throw error;
  return new Set((data as Array<{ id: string }>).map((r) => r.id));
}

/**
 * Plan 8 ruling 14 (finding #19): the window is date-bounded but not
 * row-bounded — a statement import is exactly how a month passes 1000 rows —
 * so the read is paged on the TOTAL order (date, id) and terminates on an
 * empty page. Feeds every stats read here and, through getIncomeVsExpense,
 * avgMonthlyExpenseSen.
 */
async function fetchTxRange(
  supabase: SupabaseClient,
  fromInclusive: string,
  toExclusive: string,
): Promise<StatsTxRow[]> {
  const [tx, foreign] = await Promise.all([
    fetchAllPages<StatsTxRow>((from, to) =>
      supabase
        .from("transactions")
        .select(TX_STATS_COLUMNS)
        .gte("date", fromInclusive)
        .lt("date", toExclusive)
        .order("date")
        .order("id")
        .range(from, to),
    ),
    nonMyrAccountIds(supabase),
  ]);
  return tx.filter((t) => !foreign.has(t.account_id));
}

/** Read the splits in IN_CHUNK-sized id chunks (src/db/paging.ts), each chunk
 *  paged on `id` so no single request is unbounded either way. The chunks are
 *  independent, so they run in parallel (Plan 9 ruling 10c; the equality with
 *  the sequential shape is pinned at 250 rows in src/db/stats.test.ts). */
async function fetchSplitsFor(supabase: SupabaseClient, txIds: string[]): Promise<SplitLike[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < txIds.length; i += IN_CHUNK) chunks.push(txIds.slice(i, i + IN_CHUNK));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      fetchAllPages<SplitLike>((from, to) =>
        supabase
          .from("transaction_splits")
          .select("transaction_id, category_id, amount_sen")
          .in("transaction_id", chunk)
          .order("id")
          .range(from, to),
      ),
    ),
  );
  return pages.flat();
}

/**
 * One month of reporting stats: per-category net spend plus month income and
 * net-expense totals. `month` is "YYYY-MM" (KL). Runs under the caller's RLS
 * session client.
 */
export async function getMonthStats(
  supabase: SupabaseClient,
  month: string,
): Promise<MonthStats> {
  const tx = await fetchTxRange(supabase, monthStart(month), nextMonthStart(month));

  // Ruling 7's ONE split: fund-paid expenses leave the category budget and
  // nothing else. Both halves are derived from the same filtered list, so the
  // identity below cannot drift.
  const budgeted = tx.filter((t) => t.fund_id === null);
  let fund_spend_sen = 0;
  for (const t of tx) {
    if (t.fund_id !== null) fund_spend_sen += netExpenseSen(t);
  }

  const expenseIds = budgeted.filter((t) => t.type === "expense").map((t) => t.id);
  const splits = await fetchSplitsFor(supabase, expenseIds);

  // `tx`, not `budgeted`: the cash really left, so the month totals keep it.
  const [totals] = incomeVsExpense(tx, [month]);
  return {
    month,
    income_sen: totals!.income_sen,
    expense_sen: totals!.expense_sen,
    spend_by_category: spendByCategory(budgeted, splits),
    fund_spend_sen,
  };
}

/** Net expense sen for one KL day (`todayIso` = "YYYY-MM-DD"). Ruling 7:
 *  fund-paid expenses are KEPT here — the cash left the account today. */
export async function getTodayTotal(
  supabase: SupabaseClient,
  todayIso: string,
): Promise<number> {
  const [txRes, foreign] = await Promise.all([
    supabase.from("transactions").select(TX_STATS_COLUMNS).eq("date", todayIso),
    nonMyrAccountIds(supabase),
  ]);
  if (txRes.error) throw txRes.error;
  const tx = (txRes.data as StatsTxRow[]).filter((t) => !foreign.has(t.account_id));
  return todayTotal(tx, todayIso);
}

/**
 * Income vs net expense for the last `lastNMonths` months (including the
 * current one), oldest first.
 */
export async function getIncomeVsExpense(
  supabase: SupabaseClient,
  lastNMonths: number,
  todayIso: string,
): Promise<Array<{ month: string; income_sen: number; expense_sen: number }>> {
  const months = lastMonths(lastNMonths, todayIso);
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return [];
  const tx = await fetchTxRange(supabase, monthStart(first), nextMonthStart(last));
  return incomeVsExpense(tx, months);
}
