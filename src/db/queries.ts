import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bucket } from "@/lib/allocation";
import type { TxType } from "@/lib/transactions";
import { fetchAllPages } from "@/db/paging";

interface AccountRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  archived: boolean;
  allocation_bucket: Bucket | null;
}

interface BalanceRow {
  account_id: string;
  // sum() returns Postgres numeric; PostgREST may serialize it as a string.
  balance_sen: number | string;
}

export interface AccountWithBalance {
  id: string;
  name: string;
  type: string;
  /** Task 5 (ruling 7): balance_sen is integer minor units of THIS currency
   *  — MYR for every non-brokerage account. */
  currency: string;
  archived: boolean;
  balance_sen: number;
  /** Ruling 12: explicit override, or null to fall back to defaultBucket(type)
   *  (Task-8 Settings → Accounts seg-mini control). */
  allocation_bucket: Bucket | null;
}

export async function getAccountsWithBalances(
  supabase: SupabaseClient,
): Promise<AccountWithBalance[]> {
  const [accountsRes, balancesRes] = await Promise.all([
    supabase
      .from("accounts")
      .select("id, name, type, currency, archived, allocation_bucket")
      .order("created_at"),
    supabase.from("account_balances").select("account_id, balance_sen"),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (balancesRes.error) throw balancesRes.error;

  const balanceByAccountId = new Map<string, number>(
    (balancesRes.data as BalanceRow[]).map((b) => [
      b.account_id,
      // Boundary conversion: balance_sen is an integer (sen); Number() on an
      // integer-valued string is exact within Number.MAX_SAFE_INTEGER.
      Number(b.balance_sen),
    ]),
  );

  return (accountsRes.data as AccountRow[]).map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    archived: a.archived,
    balance_sen: balanceByAccountId.get(a.id) ?? 0,
    allocation_bucket: a.allocation_bucket,
  }));
}

export interface SettingsSummaries {
  accounts: number;
  categories: number;
  aliases: number;
  activeTokens: number;
  recurringRules: number;
}

/**
 * Tips-off functional density (Plan 3 Task 8): counts backing the Settings
 * index / `/more` row summaries. One `Promise.all` of `head: true` count-only
 * queries — no rows transfer. Shared by both pages so their numbers cannot
 * drift apart. Filters mirror what each settings subpage itself treats as
 * "active":
 *   - accounts / categories: `archived = false` (accounts/categories/page.tsx)
 *   - aliases: unfiltered — parser_aliases has no archived/active concept,
 *     every row is a live alias (settings/aliases/page.tsx lists them all)
 *   - activeTokens: `revoked = false` (settings/shortcut/page.tsx)
 *   - recurringRules: `active = true` (settings/recurring/page.tsx splits
 *     rules into an "active" list and an "Archived" list on this column)
 */
export async function getSettingsSummaries(supabase: SupabaseClient): Promise<SettingsSummaries> {
  const [accountsRes, categoriesRes, aliasesRes, tokensRes, recurringRes] = await Promise.all([
    supabase.from("accounts").select("id", { count: "exact", head: true }).eq("archived", false),
    supabase.from("categories").select("id", { count: "exact", head: true }).eq("archived", false),
    supabase.from("parser_aliases").select("id", { count: "exact", head: true }),
    supabase.from("api_tokens").select("id", { count: "exact", head: true }).eq("revoked", false),
    supabase.from("recurring_rules").select("id", { count: "exact", head: true }).eq("active", true),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (aliasesRes.error) throw aliasesRes.error;
  if (tokensRes.error) throw tokensRes.error;
  if (recurringRes.error) throw recurringRes.error;

  return {
    accounts: accountsRes.count ?? 0,
    categories: categoriesRes.count ?? 0,
    aliases: aliasesRes.count ?? 0,
    activeTokens: tokensRes.count ?? 0,
    recurringRules: recurringRes.count ?? 0,
  };
}

/** Exact wording per the Task 8 Settings-index contract. */
export function activeTokensLabel(count: number): string {
  if (count === 0) return "No token";
  if (count === 1) return "1 active token";
  return `${count} active tokens`;
}

export interface MonthTxRow {
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

/** The Transactions page's list for [start, end), newest first, optionally
 *  narrowed to notes containing `q`. Finding #19: the page sums its "This
 *  month" card from this list, so it is PAGED, on a total order (`id` last). */
export async function getMonthTransactions(
  supabase: SupabaseClient,
  range: { start: string; end: string; q?: string },
): Promise<MonthTxRow[]> {
  return fetchAllPages<MonthTxRow>((from, to) => {
    let query = supabase
      .from("transactions")
      .select(
        "id, type, amount_sen, account_id, transfer_account_id, received_sen, category_id, date, note, source, needs_review, expected_back_sen, fund_id, created_at",
      )
      .gte("date", range.start)
      .lt("date", range.end);
    if (range.q) query = query.ilike("note", `%${range.q}%`);
    return query
      .order("date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to);
  });
}

export interface MonthSplitRow {
  transaction_id: string;
  category_id: string;
  amount_sen: number;
}

export interface MonthPaymentRow {
  transaction_id: string;
  amount_sen: number;
}

/**
 * The Transactions page's split and reimbursement-payment rows for the month
 * [start, end). Plan 9 ruling 10a: these were whole-table reads — lifetime
 * volume, unpaged, finding #19's silently-truncated shape — and are now an
 * INNER JOIN on the parent transaction's date (`transactions!inner(date)`),
 * so nothing enumerates ids in the URL (finding #22), paged on `id` (a total
 * order). Measured at 1,200 rows in one month: 3 requests per table (two
 * pages + the terminating empty one) against 24 for IN_CHUNK-chunked id
 * lists (12 chunks × 2) — recorded in PROGRESS.md, Session 16, Task 5.
 */
export async function getMonthSplitsAndPayments(
  supabase: SupabaseClient,
  range: { start: string; end: string },
): Promise<{ splits: MonthSplitRow[]; payments: MonthPaymentRow[] }> {
  const [splits, payments] = await Promise.all([
    fetchAllPages<MonthSplitRow>((from, to) =>
      supabase
        .from("transaction_splits")
        .select("transaction_id, category_id, amount_sen, transactions!inner(date)")
        .gte("transactions.date", range.start)
        .lt("transactions.date", range.end)
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<MonthPaymentRow>((from, to) =>
      supabase
        .from("reimbursement_payments")
        .select("transaction_id, amount_sen, transactions!inner(date)")
        .gte("transactions.date", range.start)
        .lt("transactions.date", range.end)
        .order("id")
        .range(from, to),
    ),
  ]);
  return { splits, payments };
}
