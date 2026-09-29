import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccountsWithBalances } from "@/db/queries";
import { avgMonthlyExpenseSen } from "@/db/networth";
import { getIncomeVsExpense } from "@/db/stats";
import { fetchAllPages, PAGE_SIZE } from "@/db/paging";
import {
  buildWaterfall,
  fundBalanceSen,
  fundStatus,
  progressPct,
  requiredMonthlySen,
  resolveTargetSen,
  type FundKind,
  type FundLike,
  type FundStatus,
  type Waterfall,
} from "@/lib/funds";

/**
 * Fund query layer + write helpers (Plan 7 Task 2). Everything runs under the
 * caller's RLS session client — the admin client is never imported here.
 *
 * Ruling 1: funds are an earmark over money the accounts already hold. Nothing
 * in this module writes a transaction or touches net worth; `getFunds` is a
 * pure read composed with `src/lib/funds.ts`.
 *
 * Conventions:
 * - `todayIso` is already the KL date (`klToday` at the route boundary), so
 *   the KL month is its "YYYY-MM" prefix; months are "YYYY-MM" at this
 *   boundary and "YYYY-MM-01" in the DB `month` date columns (budget's).
 * - Ruling 9a: archiving never untags, so archived funds are disclosed WITH
 *   their balances, `total_saved_sen` counts ACTIVE funds only, and this
 *   month's draw LIST includes tags to archived funds (its sen total is
 *   active-only — Plan 8 ruling 4).
 * - Ruling 9b: `myr_accounts_total_sen` is every non-archived MYR account of
 *   EVERY type — deliberately wider than ruling 12's bill-paying base,
 *   because a fund's money legitimately sits in ASM or an MMF.
 */

export interface FundRow {
  id: string;
  name: string;
  kind: FundKind;
  target_sen: number | null;
  target_months: number | null;
  target_date: string | null;
  monthly_contribution_sen: number;
  priority: number;
  archived: boolean;
  /** Ruling 5: Σ contributions − Σ fund-tagged expenses. May be negative. */
  balance_sen: number;
  /** Ruling 3's one target shape, resolved; null when the fund has none. */
  resolved_target_sen: number | null;
  progress_pct: number | null;
  status: FundStatus;
  behind_by_sen: number;
  required_monthly_sen: number | null;
  /** This month's earmark: the stored row when one exists, else the fallback. */
  contribution_sen: number;
  /** True once a `fund_contributions` row exists for the month. */
  contribution_applied: boolean;
}

export interface FundDrawRow {
  id: string;
  date: string;
  amount_sen: number;
  note: string;
  fund_id: string;
  fund_name: string;
  category_id: string | null;
  category_name: string | null;
}

export interface FundsData {
  /** KL month, "YYYY-MM". */
  month: string;
  /** Active funds, in waterfall order (emergency, dated, open-ended). */
  funds: FundRow[];
  archived_funds: FundRow[];
  archived_count: number;
  /** Ruling 9a: ACTIVE fund balances only. */
  total_saved_sen: number;
  /** Ruling 9b: every non-archived MYR account, all types. */
  myr_accounts_total_sen: number;
  /** True when a budget_months row exists for the month. */
  month_planned: boolean;
  /** `savings_allocated_sen`, 0 when the month is unplanned. */
  envelope_sen: number;
  avg_monthly_expense_sen: number;
  /** Ruling 3's coupling disclosure (F3, Task 3 review): the fund-paid SHARE
   *  of avg_monthly_expense_sen, over the exact same trailing-6-full-
   *  calendar-month window and the exact same divisor — see
   *  avgMonthlyFundPaidExpenseSen below. 0 when nothing fund-tagged fell
   *  inside that window. */
  avg_monthly_fund_paid_expense_sen: number;
  /** Active funds with a stored contribution row this month, and their total. */
  applied_count: number;
  applied_total_sen: number;
  /** Σ active funds' contribution for the month (stored row or fallback). */
  planned_total_sen: number;
  /** Fund-tagged spending this month on ACTIVE funds only (Plan 8 ruling 4):
   *  the hero delta's drawn term, netted against the equally active-only
   *  `applied_total_sen`. The Budget page's `Paid from funds` is a different
   *  figure (src/db/stats.ts's fund_spend_sen) and keeps ruling 9a's
   *  all-funds reading. */
  drawn_this_month_sen: number;
  /** Every draw this month, archived funds included (ruling 9a's disclosure). */
  drawn_this_month: FundDrawRow[];
  waterfall: Waterfall;
}

interface FundTableRow {
  id: string;
  name: string;
  kind: FundKind;
  target_sen: number | null;
  target_months: number | null;
  target_date: string | null;
  monthly_contribution_sen: number;
  priority: number;
  archived: boolean;
}

interface ContributionRow {
  fund_id: string;
  month: string;
  amount_sen: number;
}

interface DrawnRow {
  id: string;
  date: string;
  amount_sen: number;
  note: string;
  fund_id: string;
  category_id: string | null;
  account_id: string;
}

const FUND_COLUMNS =
  "id, name, kind, target_sen, target_months, target_date, monthly_contribution_sen, priority, archived";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

/** First day of `month` ("YYYY-MM") — the DB representation. */
function monthDate(month: string): string {
  return `${month}-01`;
}

/** First day of the month after `month`, integer arithmetic only. */
function nextMonthDate(month: string): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-01`;
}

/** Half-up integer division, d > 0 — half AWAY from zero for negative n,
 *  byte-identical to src/db/networth.ts's private copy (the house convention
 *  is a private copy per module, per src/lib/funds.ts's own docblock). The
 *  first cut here lacked the sign handling while claiming identity
 *  (Session-12 Minor 4); exported only so the pin below can bite. */
export function divHalfUp(n: number, d: number): number {
  const neg = n < 0;
  const abs = Math.abs(n);
  const q = Math.floor(abs / d);
  const r = abs - q * d;
  const rounded = 2 * r >= d ? q + 1 : q;
  return neg ? -rounded : rounded;
}

/**
 * R2-1 fix (Task 3 review, round 2): byte-identical private copy of
 * src/db/stats.ts's `nonMyrAccountIds` (private there too — every stats read
 * in that module filters through it, per that file's own comment, because a
 * non-MYR account's `amount_sen` are another currency's minor units, not
 * MYR sen). The first cut of `avgMonthlyFundPaidExpenseSen` filtered its
 * numerator on `type` and `fund_id` only and missed this — the exact shape
 * of both of Plan 6's Criticals, a filter applied in four places out of
 * five. `getIncomeVsExpense` (the denominator's source) already applies it;
 * this function's numerator now does too.
 */
async function nonMyrAccountIds(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from("accounts").select("id").neq("currency", "MYR");
  if (error) throw error;
  return new Set((data as Array<{ id: string }>).map((r) => r.id));
}

/**
 * Ruling 3's coupling disclosure (F3, Task 3 review — explicitly authorized
 * to extend this file, and only this file): the fund-paid SHARE of
 * avgMonthlyExpenseSen (in src/db/networth.ts) — same trailing-6-full-
 * calendar-month window, same divisor. If either differed by even one month
 * the disclosed share would not relate to the average it is disclosed
 * against, which is worse than omitting the line entirely, so this mirrors
 * that function's window/divisor logic rather than inventing a new one:
 *
 * - The window comes from calling the SAME exported `getIncomeVsExpense`
 *   with the SAME `prevMonthFirstIso`-shifted anchor avgMonthlyExpenseSen
 *   uses (copied here — that anchor shift is a private helper there) — same
 *   function, same arguments, so the 6-month list cannot drift.
 * - The divisor (months at or after the earliest transaction ever, so a
 *   fresh account isn't diluted by pre-history zero months) is recomputed
 *   here against the same `transactions` table state avgMonthlyExpenseSen
 *   reads; that query's own logic is duplicated (avgMonthlyExpenseSen's copy
 *   is private to networth.ts) — if that logic ever changes, this must too.
 *
 * The numerator is this module's own: Σ (amount_sen − expected_back_sen) for
 * expense-type, fund-tagged, MYR-account transactions across the window
 * (ruling 6 guarantees expected_back_sen is always 0 on a fund-tagged
 * expense, so this is gross = net, same as ruling 7 states — the
 * subtraction is kept for defensive symmetry with getIncomeVsExpense's own
 * formula, not because a nonzero value is expected). The MYR-only filter
 * (nonMyrAccountIds, above) is load-bearing, not defensive: ruling 8 is the
 * only entry-path guard that keeps a non-MYR account from ever carrying a
 * fund_id at all, and this DB read has no visibility into that — the table
 * check is only `fund_id is null or type = 'expense'`, currency-blind (R2-1,
 * Task 3 review round 2). `divHalfUp` here is a private copy, not an import
 * from src/lib/funds.ts (untouched by this task, per the review's explicit
 * instruction). The read is paged (fetchAllPages, src/db/paging.ts) rather than a
 * single unbounded select — finding #19: six months of fund-tagged spend
 * "probably" stays under PostgREST's 1000-row truncation cap, but the paged
 * reads beside it exist precisely because "probably" isn't the bound rule
 * 19 requires (R2-2).
 */
interface FundPaidRow {
  amount_sen: number;
  expected_back_sen: number;
  account_id: string;
}

export async function avgMonthlyFundPaidExpenseSen(
  supabase: SupabaseClient,
  todayIso: string,
  pageSize: number = PAGE_SIZE,
): Promise<number> {
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const windowAnchor = `${py}-${String(pm).padStart(2, "0")}-01`;

  const months = await getIncomeVsExpense(supabase, 6, windowAnchor);
  const monthKeys = months.map((mo) => mo.month);
  const firstMonth = monthKeys[0];
  const lastMonth = monthKeys[monthKeys.length - 1];
  if (firstMonth === undefined || lastMonth === undefined) return 0;

  const firstTxRes = await supabase.from("transactions").select("date").order("date").limit(1).maybeSingle();
  if (firstTxRes.error) throw firstTxRes.error;
  if (!firstTxRes.data) return 0;
  const earliestMonth = (firstTxRes.data as { date: string }).date.slice(0, 7);
  const divisor = monthKeys.filter((mo) => mo >= earliestMonth).length;
  if (divisor === 0) return 0;

  const [fundPaidRows, foreign] = await Promise.all([
    fetchAllPages<FundPaidRow>(
      (from, to) =>
        supabase
          .from("transactions")
          .select("amount_sen, expected_back_sen, account_id")
          .eq("type", "expense")
          .not("fund_id", "is", null)
          .gte("date", monthDate(firstMonth))
          .lt("date", nextMonthDate(lastMonth))
          // LOAD-BEARING: `id` (the primary key) makes this order TOTAL, the
          // same requirement every other paged read in this file carries.
          .order("id")
          .range(from, to),
      pageSize,
    ),
    nonMyrAccountIds(supabase),
  ]);

  let sum = 0;
  for (const row of fundPaidRows) {
    if (foreign.has(row.account_id)) continue;
    sum += row.amount_sen - row.expected_back_sen;
  }
  if (sum <= 0) return 0;
  return divHalfUp(sum, divisor);
}

/** The transaction form's fund picker (mockup v6 §10 phone 3): every fund
 *  with its ruling-5 balance, archived ones included so an existing tag on an
 *  archived fund still renders and can still be cleared (ruling 9a). */
export interface FundOption {
  id: string;
  name: string;
  archived: boolean;
  balance_sen: number;
}

/**
 * `getFunds` minus everything the picker does not need — no targets, no
 * statuses, no waterfall, no six-month expense average. Three reads instead of
 * eight, because the transactions page renders on every entry and the picker
 * only ever shows a name and a balance.
 *
 * The two history reads are paged for the same reason `getFunds`'s are
 * (finding #19: an unbounded select truncates at 1000 rows with HTTP 200 and
 * no flag, and ruling 5's balance needs ALL history); the funds read itself is
 * deliberately unpaged, per `getFunds`'s own note.
 */
export async function getFundOptions(
  supabase: SupabaseClient,
  pageSize: number = PAGE_SIZE,
): Promise<FundOption[]> {
  const [fundsRes, contributions, drawnRows, foreign] = await Promise.all([
    supabase.from("funds").select("id, name, archived").order("priority").order("name"),
    fetchAllPages<{ fund_id: string; amount_sen: number }>(
      (from, to) =>
        supabase
          .from("fund_contributions")
          .select("fund_id, amount_sen")
          .order("id") // LOAD-BEARING: makes the paged order TOTAL
          .range(from, to),
      pageSize,
    ),
    fetchAllPages<{ fund_id: string; amount_sen: number; account_id: string }>(
      (from, to) =>
        supabase
          .from("transactions")
          .select("fund_id, amount_sen, account_id")
          .not("fund_id", "is", null)
          .order("id") // LOAD-BEARING: same
          .range(from, to),
      pageSize,
    ),
    nonMyrAccountIds(supabase),
  ]);
  if (fundsRes.error) throw fundsRes.error;
  // Session-12 Minor 5: same non-MYR filter as avgMonthlyFundPaidExpenseSen —
  // a foreign account's amount_sen are not MYR sen, and the table check
  // cannot see the account's currency.
  const drawn = drawnRows.filter((t) => !foreign.has(t.account_id));

  const contributionsByFund = new Map<string, number[]>();
  for (const c of contributions) {
    const list = contributionsByFund.get(c.fund_id);
    if (list) list.push(c.amount_sen);
    else contributionsByFund.set(c.fund_id, [c.amount_sen]);
  }
  const drawnByFund = new Map<string, number[]>();
  for (const t of drawn) {
    const list = drawnByFund.get(t.fund_id);
    if (list) list.push(t.amount_sen);
    else drawnByFund.set(t.fund_id, [t.amount_sen]);
  }

  return (fundsRes.data as Array<{ id: string; name: string; archived: boolean }>).map((f) => ({
    ...f,
    balance_sen: fundBalanceSen(contributionsByFund.get(f.id) ?? [], drawnByFund.get(f.id) ?? []),
  }));
}

/**
 * Everything mockup v6 §7 and §10 phone 1 render, in ONE composed read (the
 * `getNetWorth` shape): parallel queries joined in TypeScript, so the page
 * never issues a second query.
 *
 * `pageSize` is the page-request hint for the two paged reads; callers leave it
 * alone. It is a parameter so a test can request MORE than the server's cap and
 * prove the result does not move — the failure mode that is invisible locally.
 */
export async function getFunds(
  supabase: SupabaseClient,
  todayIso: string,
  pageSize: number = PAGE_SIZE,
): Promise<FundsData> {
  const month = todayIso.slice(0, 7);
  const [fundsRes, contributions, drawnRows, monthRes, accounts, categoriesRes, avg, fundPaidAvg, foreign] =
    await Promise.all([
      // Deliberately UNPAGED: fund rows are hand-created and do not grow the
      // way contributions and draws do. If this read or the archived list is
      // ever paged, it needs an `id` tiebreaker too — `priority, name` is NOT
      // a total order, because ruling 2 deliberately has no unique constraint
      // on fund name.
      supabase.from("funds").select(FUND_COLUMNS).order("priority").order("name"),
      // Both of these feed ruling 5's identity over ALL history — paged, never
      // truncated.
      fetchAllPages<ContributionRow>(
        (from, to) =>
          supabase
            .from("fund_contributions")
            .select("fund_id, month, amount_sen")
            // LOAD-BEARING: `id` (the primary key) is what makes this order
            // TOTAL. Without it rows can repeat or vanish between pages. Do
            // not remove it — the suite stays green either way at small sizes.
            .order("id")
            .range(from, to),
        pageSize,
      ),
      fetchAllPages<DrawnRow>(
        (from, to) =>
          supabase
            .from("transactions")
            .select("id, date, amount_sen, note, fund_id, category_id, account_id")
            .not("fund_id", "is", null)
            .order("date")
            // LOAD-BEARING: `date` alone is not unique — one day of draws is a
            // tie straddling a page boundary. `id` (the primary key) makes the
            // order total. Do not remove it.
            .order("id")
            .range(from, to),
        pageSize,
      ),
      supabase
        .from("budget_months")
        .select("savings_allocated_sen")
        .eq("month", monthDate(month))
        .maybeSingle(),
      getAccountsWithBalances(supabase),
      supabase.from("categories").select("id, name"),
      avgMonthlyExpenseSen(supabase, todayIso),
      avgMonthlyFundPaidExpenseSen(supabase, todayIso),
      nonMyrAccountIds(supabase),
    ]);
  for (const res of [fundsRes, monthRes, categoriesRes]) {
    if (res.error) throw res.error;
  }

  const funds = fundsRes.data as FundTableRow[];
  // Session-12 Minor 5: the same non-MYR filter avgMonthlyFundPaidExpenseSen
  // applies — load-bearing, not defensive (see that function's docblock).
  const drawn = drawnRows.filter((t) => !foreign.has(t.account_id));

  const dbMonth = monthDate(month);
  const contributionsByFund = new Map<string, number[]>();
  const storedThisMonth = new Map<string, number>();
  for (const c of contributions) {
    const list = contributionsByFund.get(c.fund_id);
    if (list) list.push(c.amount_sen);
    else contributionsByFund.set(c.fund_id, [c.amount_sen]);
    if (c.month === dbMonth) storedThisMonth.set(c.fund_id, c.amount_sen);
  }

  const drawnByFund = new Map<string, number[]>();
  for (const t of drawn) {
    const list = drawnByFund.get(t.fund_id);
    if (list) list.push(t.amount_sen);
    else drawnByFund.set(t.fund_id, [t.amount_sen]);
  }

  const balanceOf = (fund: FundTableRow) =>
    fundBalanceSen(contributionsByFund.get(fund.id) ?? [], drawnByFund.get(fund.id) ?? []);

  const toRow = (fund: FundTableRow): FundRow => {
    const balance_sen = balanceOf(fund);
    const resolved_target_sen = resolveTargetSen(fund, avg);
    const stored = storedThisMonth.get(fund.id);
    const contribution_sen = stored ?? fund.monthly_contribution_sen;
    const { status, behind_by_sen } = fundStatus(
      balance_sen,
      resolved_target_sen,
      contribution_sen,
      todayIso,
      fund.target_date,
    );
    return {
      ...fund,
      balance_sen,
      resolved_target_sen,
      progress_pct: progressPct(balance_sen, resolved_target_sen),
      status,
      behind_by_sen,
      required_monthly_sen: requiredMonthlySen(
        balance_sen,
        resolved_target_sen,
        todayIso,
        fund.target_date,
      ),
      contribution_sen,
      contribution_applied: stored !== undefined,
    };
  };

  const active = funds.filter((f) => !f.archived);
  const activeInput: FundLike[] = active.map((f) => ({ ...f, balance_sen: balanceOf(f) }));
  const envelope_sen = (monthRes.data?.savings_allocated_sen as number | undefined) ?? 0;
  const waterfall = buildWaterfall(activeInput, storedThisMonth, envelope_sen, avg, todayIso);

  // The page renders the fund table in waterfall order (v6 §7); taking it from
  // the waterfall itself keeps one ordering rule, not two.
  const rowById = new Map(active.map((f) => [f.id, toRow(f)]));
  const orderedIds = waterfall.steps.flatMap((s) => s.funds.map((f) => f.id));
  const activeRows = orderedIds.flatMap((id) => {
    const row = rowById.get(id);
    return row ? [row] : [];
  });

  const fundNameById = new Map(funds.map((f) => [f.id, f.name]));
  const categoryNameById = new Map(
    (categoriesRes.data as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  const nextMonth = nextMonthDate(month);
  const drawn_this_month: FundDrawRow[] = drawn
    .filter((t) => t.date >= dbMonth && t.date < nextMonth)
    .map((t) => ({
      id: t.id,
      date: t.date,
      amount_sen: t.amount_sen,
      note: t.note,
      fund_id: t.fund_id,
      fund_name: fundNameById.get(t.fund_id) ?? "",
      category_id: t.category_id,
      category_name: t.category_id === null ? null : categoryNameById.get(t.category_id) ?? null,
    }));

  let total_saved_sen = 0;
  let applied_count = 0;
  let applied_total_sen = 0;
  for (const row of activeRows) {
    total_saved_sen += row.balance_sen;
    if (row.contribution_applied) {
      applied_count += 1;
      applied_total_sen += row.contribution_sen;
    }
  }

  let myr_accounts_total_sen = 0;
  for (const account of accounts) {
    if (!account.archived && account.currency === "MYR") {
      myr_accounts_total_sen += account.balance_sen;
    }
  }

  const archived_funds = funds.filter((f) => f.archived).map(toRow);
  return {
    month,
    funds: activeRows,
    archived_funds,
    archived_count: archived_funds.length,
    total_saved_sen,
    myr_accounts_total_sen,
    month_planned: monthRes.data !== null,
    envelope_sen,
    avg_monthly_expense_sen: avg,
    avg_monthly_fund_paid_expense_sen: fundPaidAvg,
    applied_count,
    applied_total_sen,
    planned_total_sen: waterfall.planned_total_sen,
    // Plan 8 ruling 4: active funds only, like applied_total_sen it is netted
    // against; the list beneath still discloses every draw (ruling 9a).
    drawn_this_month_sen: drawn_this_month
      .filter((d) => rowById.has(d.fund_id))
      .reduce((sum, d) => sum + d.amount_sen, 0),
    drawn_this_month,
    waterfall,
  };
}

// ---------------------------------------------------------------------------
// Write helpers ("perform*" — plain functions so DB tests can exercise them;
// the "use server" actions in src/app/(app)/goals/actions.ts wrap these).
// ---------------------------------------------------------------------------

export type FundWriteResult = { ok: true } | { ok: false; error: string };
export type FundApplyResult = { ok: true; inserted: number } | { ok: false; error: string };
export type FundArchiveResult =
  | { ok: true; tagged_this_month: number }
  | { ok: false; error: string };

function zodError(error: z.ZodError): { ok: false; error: string } {
  const first = error.issues[0];
  return { ok: false, error: first ? first.message : "invalid input" };
}

/** Ruling 3's target rules, re-checked server-side even though the form makes
 *  the illegal combinations unreachable; the table checks are the last line. */
const fundInputSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(60, "name is too long"),
    kind: z.enum(["emergency", "sinking", "goal"]),
    target_sen: z.number().int().positive().nullable().default(null),
    target_months: z.number().int().min(1).max(60).nullable().default(null),
    target_date: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "target date must be YYYY-MM-DD")
      .nullable()
      .default(null),
    monthly_contribution_sen: z.number().int().min(0).default(0),
    priority: z.number().int().default(0),
  })
  .refine((v) => v.target_sen === null || v.target_months === null, {
    message: "a fund has at most one target shape",
  })
  .refine((v) => v.target_months === null || v.kind === "emergency", {
    message: "months of expenses is only available on the emergency fund",
  });

export type FundInput = z.input<typeof fundInputSchema>;

export async function performCreateFund(
  supabase: SupabaseClient,
  input: FundInput,
): Promise<FundWriteResult> {
  const parsed = fundInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase.from("funds").insert(parsed.data);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Takes the WHOLE fund shape, not a patch: an omitted target field falls to
 *  its default (null / 0), which is how the edit dialog clears a target. */
export async function performUpdateFund(
  supabase: SupabaseClient,
  fund_id: string,
  input: FundInput,
): Promise<FundWriteResult> {
  const idParsed = z.uuid().safeParse(fund_id);
  if (!idParsed.success) return zodError(idParsed.error);
  const parsed = fundInputSchema.safeParse(input);
  if (!parsed.success) return zodError(parsed.error);
  const { data, error } = await supabase
    .from("funds")
    .update(parsed.data)
    .eq("id", idParsed.data)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "fund not found" };
  return { ok: true };
}

/**
 * Ruling 9a: archiving leaves every `fund_id` in place, so the fund's spending
 * stays out of the category budget forever and stays visible in the Goals
 * disclosure. The current-month tagged count comes back with the result so the
 * UI confirm can name it without a second query.
 */
export async function performArchiveFund(
  supabase: SupabaseClient,
  fund_id: string,
  month: string,
): Promise<FundArchiveResult> {
  const idParsed = z.uuid().safeParse(fund_id);
  if (!idParsed.success) return zodError(idParsed.error);
  const monthParsed = monthSchema.safeParse(month);
  if (!monthParsed.success) return zodError(monthParsed.error);

  const taggedRes = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("fund_id", idParsed.data)
    .gte("date", monthDate(monthParsed.data))
    .lt("date", nextMonthDate(monthParsed.data));
  if (taggedRes.error) return { ok: false, error: taggedRes.error.message };

  const { data, error } = await supabase
    .from("funds")
    .update({ archived: true })
    .eq("id", idParsed.data)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "fund not found" };
  return { ok: true, tagged_this_month: taggedRes.count ?? 0 };
}

export async function performUnarchiveFund(
  supabase: SupabaseClient,
  fund_id: string,
): Promise<FundWriteResult> {
  const idParsed = z.uuid().safeParse(fund_id);
  if (!idParsed.success) return zodError(idParsed.error);
  const { data, error } = await supabase
    .from("funds")
    .update({ archived: false })
    .eq("id", idParsed.data)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "fund not found" };
  return { ok: true };
}

/** One earmark row per (fund, month); a re-set overwrites the amount. */
export async function performSetContribution(
  supabase: SupabaseClient,
  fund_id: string,
  month: string,
  amount_sen: number,
): Promise<FundWriteResult> {
  const idParsed = z.uuid().safeParse(fund_id);
  if (!idParsed.success) return zodError(idParsed.error);
  const monthParsed = monthSchema.safeParse(month);
  if (!monthParsed.success) return zodError(monthParsed.error);
  const senParsed = z.number().int().min(0).safeParse(amount_sen);
  if (!senParsed.success) return zodError(senParsed.error);

  const { error } = await supabase.from("fund_contributions").upsert(
    {
      fund_id: idParsed.data,
      month: monthDate(monthParsed.data),
      amount_sen: senParsed.data,
    },
    { onConflict: "user_id,fund_id,month" },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Ruling 4: one row per ACTIVE fund at that fund's `monthly_contribution_sen`,
 * `on conflict do nothing`. Re-pressing it, double-firing it, or pressing it
 * after a hand-edit changes nothing — `inserted` is what actually landed.
 */
export async function performApplyMonthlyContributions(
  supabase: SupabaseClient,
  month: string,
): Promise<FundApplyResult> {
  const monthParsed = monthSchema.safeParse(month);
  if (!monthParsed.success) return zodError(monthParsed.error);

  const fundsRes = await supabase
    .from("funds")
    .select("id, monthly_contribution_sen")
    .eq("archived", false);
  if (fundsRes.error) return { ok: false, error: fundsRes.error.message };
  const funds = fundsRes.data as Array<{ id: string; monthly_contribution_sen: number }>;
  if (funds.length === 0) return { ok: true, inserted: 0 };

  const { data, error } = await supabase
    .from("fund_contributions")
    .upsert(
      funds.map((f) => ({
        fund_id: f.id,
        month: monthDate(monthParsed.data),
        // Never omitted: the column has no default and would raise 23502.
        amount_sen: f.monthly_contribution_sen,
      })),
      { onConflict: "user_id,fund_id,month", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return { ok: false, error: error.message };
  return { ok: true, inserted: data?.length ?? 0 };
}
