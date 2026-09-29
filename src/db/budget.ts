import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMonthStats } from "@/db/stats";
import {
  rollupToParents,
  expectedIncomeFromRules,
  setAsideSen,
  type Tag,
} from "@/lib/budget";

/**
 * Budget query layer + write helpers (Plan 4 Task 3). Everything runs under
 * the caller's RLS session client; months are "YYYY-MM" at this boundary and
 * "YYYY-MM-01" in the DB `month` date columns.
 */

export interface BudgetRow {
  category_id: string;
  name: string;
  tag: Tag;
  /** Archived categories with money in the month still render. */
  archived: boolean;
  /** Previous month actual, rolled up to this top-level category. */
  prev_spent_sen: number;
  /** Previous month's current allocation (0 when none) — copy prefill. */
  prev_allocated_sen: number;
  planned_sen: number;
  allocated_sen: number;
  spent_sen: number;
}

/** One active fund's earmark for the month — mockup v6 §9's Savings & funds row. */
export interface BudgetFundRow {
  id: string;
  name: string;
  /** Ruling 10: the stored `fund_contributions` row for the month when one
   *  exists, `monthly_contribution_sen` only as the fallback for a month not
   *  yet applied. Any other rule would let this card and the Goals waterfall
   *  describe the same month with different numbers. */
  contribution_sen: number;
}

export interface BudgetMonthData {
  /** "YYYY-MM" */
  month: string;
  /** True when the budget_months row exists. */
  planned: boolean;
  /** Stored value, or the recurring-rules default when unplanned. */
  expected_income_sen: number;
  savings: {
    planned_sen: number;
    allocated_sen: number;
    set_aside_sen: number;
    /** ACTIVE funds only (ruling 9a: the archived ones keep their balances on
     *  the Goals page, but they are not part of this month's plan), ordered
     *  priority then name — the waterfall's own ordering. */
    funds: BudgetFundRow[];
  };
  rows: BudgetRow[];
  /** Spend that can't sit against any allocation row (never dropped). */
  unbudgeted: Array<{ category_id: string | null; name: string; spent_sen: number }>;
  /** Copy-prefill source; null when the previous month is unplanned. */
  prev: { expected_income_sen: number; savings_allocated_sen: number } | null;
  totals: {
    allocated_sen: number;
    spent_sen: number;
    income_sen: number;
    expense_sen: number;
    /** Ruling 7: the month's fund-paid spend — inside `expense_sen`, inside
     *  no row and inside no `unbudgeted` entry. The page discloses it as
     *  `Paid from funds RM x` beneath the totals. */
    fund_spend_sen: number;
  };
  change_count: number;
  benchmark: { needs_pct: number; wants_pct: number; savings_pct: number };
}

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

/** First day of `month` ("YYYY-MM") — the DB representation. */
function monthDate(month: string): string {
  return `${month}-01`;
}

/** The month before `month` ("YYYY-MM"), integer arithmetic only. */
function prevMonthOf(month: string): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

interface CategoryRow {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
  tag: Tag;
  archived: boolean;
}

interface AllocationRow {
  category_id: string;
  planned_sen: number;
  allocated_sen: number;
}

const DEFAULT_BENCHMARK = { needs_pct: 50, wants_pct: 30, savings_pct: 20 };

export async function getBudgetMonth(
  supabase: SupabaseClient,
  month: string,
): Promise<BudgetMonthData> {
  const prevMonth = prevMonthOf(month);
  const [
    catsRes,
    monthRes,
    prevMonthRes,
    allocRes,
    prevAllocRes,
    stats,
    prevStats,
    changesRes,
    settingsRes,
    fundsRes,
    fundContribRes,
  ] = await Promise.all([
    supabase.from("categories").select("id, name, kind, parent_id, tag, archived"),
    supabase
      .from("budget_months")
      .select("expected_income_sen, savings_planned_sen, savings_allocated_sen")
      .eq("month", monthDate(month))
      .maybeSingle(),
    supabase
      .from("budget_months")
      .select("expected_income_sen, savings_allocated_sen")
      .eq("month", monthDate(prevMonth))
      .maybeSingle(),
    supabase
      .from("budget_allocations")
      .select("category_id, planned_sen, allocated_sen")
      .eq("month", monthDate(month)),
    supabase
      .from("budget_allocations")
      .select("category_id, allocated_sen")
      .eq("month", monthDate(prevMonth)),
    getMonthStats(supabase, month),
    getMonthStats(supabase, prevMonth),
    supabase
      .from("budget_changes")
      .select("id", { count: "exact", head: true })
      .eq("month", monthDate(month)),
    supabase
      .from("user_settings")
      .select("benchmark_needs_pct, benchmark_wants_pct, benchmark_savings_pct")
      .maybeSingle(),
    // v6 §9's Savings & funds row. Deliberately UNPAGED, matching
    // src/db/funds.ts's own note: fund rows are hand-created and do not grow
    // the way contributions and draws do. The contributions read IS bounded —
    // one row per (fund, month) and this asks for one month.
    supabase
      .from("funds")
      .select("id, name, monthly_contribution_sen")
      .eq("archived", false)
      .order("priority")
      .order("name"),
    supabase
      .from("fund_contributions")
      .select("fund_id, amount_sen")
      .eq("month", monthDate(month)),
  ]);
  for (const res of [
    catsRes, monthRes, prevMonthRes, allocRes, prevAllocRes, changesRes, settingsRes,
    fundsRes, fundContribRes,
  ]) {
    if (res.error) throw res.error;
  }

  const cats = catsRes.data as CategoryRow[];
  const catById = new Map(cats.map((c) => [c.id, c]));
  const monthRow = monthRes.data as {
    expected_income_sen: number;
    savings_planned_sen: number;
    savings_allocated_sen: number;
  } | null;

  // Expected income: stored when planned, recurring-rules default otherwise.
  let expected_income_sen = monthRow ? monthRow.expected_income_sen : 0;
  if (!monthRow) {
    const rulesRes = await supabase
      .from("recurring_rules")
      .select("type, active, amount_sen, freq, day_of_month, weekday, month_of_year, next_run")
      .eq("active", true);
    if (rulesRes.error) throw rulesRes.error;
    expected_income_sen = expectedIncomeFromRules(rulesRes.data, month);
  }

  const rolled = rollupToParents(stats.spend_by_category, cats);
  const prevRolled = rollupToParents(prevStats.spend_by_category, cats);
  const allocMap = new Map(
    (allocRes.data as AllocationRow[]).map((a) => [a.category_id, a]),
  );
  const prevAllocMap = new Map(
    (prevAllocRes.data as Array<{ category_id: string; allocated_sen: number }>).map((a) => [
      a.category_id,
      a.allocated_sen,
    ]),
  );

  // rows = active top-level expense categories ∪ any category with an
  // allocation or (rolled-up, expense-kind) spend this month. Archived
  // categories with money stay visible — sen never disappears from view.
  const rowIds = new Set<string>();
  for (const c of cats) {
    if (c.kind === "expense" && c.parent_id === null && !c.archived) rowIds.add(c.id);
  }
  for (const id of allocMap.keys()) rowIds.add(id);
  for (const id of rolled.keys()) {
    if (id !== null && catById.get(id)?.kind === "expense") rowIds.add(id);
  }

  const rows: BudgetRow[] = [...rowIds]
    .flatMap((id) => {
      const cat = catById.get(id);
      if (!cat) return [];
      return [
        {
          category_id: id,
          name: cat.name,
          tag: cat.tag,
          archived: cat.archived,
          prev_spent_sen: prevRolled.get(id) ?? 0,
          prev_allocated_sen: prevAllocMap.get(id) ?? 0,
          planned_sen: allocMap.get(id)?.planned_sen ?? 0,
          allocated_sen: allocMap.get(id)?.allocated_sen ?? 0,
          spent_sen: rolled.get(id) ?? 0,
        },
      ];
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  // Spend that rolls into no budget row: uncategorized (always), plus any
  // non-expense-kind category spend. Never dropped.
  const unbudgeted: BudgetMonthData["unbudgeted"] = [];
  const uncategorized = rolled.get(null);
  if (uncategorized !== undefined) {
    unbudgeted.push({ category_id: null, name: "Uncategorized", spent_sen: uncategorized });
  }
  for (const [id, sen] of rolled) {
    if (id !== null && !rowIds.has(id)) {
      unbudgeted.push({ category_id: id, name: catById.get(id)?.name ?? "Unknown", spent_sen: sen });
    }
  }

  let allocated_total = 0;
  let spent_total = 0;
  for (const r of rows) {
    allocated_total += r.allocated_sen;
    spent_total += r.spent_sen;
  }

  const storedContribution = new Map(
    (fundContribRes.data as Array<{ fund_id: string; amount_sen: number }>).map((c) => [
      c.fund_id,
      c.amount_sen,
    ]),
  );
  const savingsFunds: BudgetFundRow[] = (
    fundsRes.data as Array<{ id: string; name: string; monthly_contribution_sen: number }>
  ).map((f) => ({
    id: f.id,
    name: f.name,
    contribution_sen: storedContribution.get(f.id) ?? f.monthly_contribution_sen,
  }));

  const prevRow = prevMonthRes.data as {
    expected_income_sen: number;
    savings_allocated_sen: number;
  } | null;
  const benchmark = settingsRes.data
    ? {
        needs_pct: settingsRes.data.benchmark_needs_pct as number,
        wants_pct: settingsRes.data.benchmark_wants_pct as number,
        savings_pct: settingsRes.data.benchmark_savings_pct as number,
      }
    : DEFAULT_BENCHMARK;

  return {
    month,
    planned: monthRow !== null,
    expected_income_sen,
    savings: {
      planned_sen: monthRow?.savings_planned_sen ?? 0,
      allocated_sen: monthRow?.savings_allocated_sen ?? 0,
      // Unchanged by ruling 7: `expense_sen` still carries fund-paid spend,
      // so what stayed with you this month is still income − everything spent.
      set_aside_sen: setAsideSen(stats.income_sen, stats.expense_sen),
      funds: savingsFunds,
    },
    rows,
    unbudgeted,
    prev: prevRow
      ? {
          expected_income_sen: prevRow.expected_income_sen,
          savings_allocated_sen: prevRow.savings_allocated_sen,
        }
      : null,
    totals: {
      allocated_sen: allocated_total,
      spent_sen: spent_total,
      income_sen: stats.income_sen,
      expense_sen: stats.expense_sen,
      fund_spend_sen: stats.fund_spend_sen,
    },
    change_count: changesRes.count ?? 0,
    benchmark,
  };
}

/** Light glance for Quick Add / dashboard: null when the month is unplanned.
 *  `spent_total_sen` is the month's total net expense (the hero's source). */
export async function getBudgetGlance(
  supabase: SupabaseClient,
  month: string,
): Promise<{ allocated_total_sen: number; spent_total_sen: number } | null> {
  const [monthRes, allocRes, stats] = await Promise.all([
    supabase
      .from("budget_months")
      .select("id")
      .eq("month", monthDate(month))
      .maybeSingle(),
    supabase
      .from("budget_allocations")
      .select("allocated_sen")
      .eq("month", monthDate(month)),
    getMonthStats(supabase, month),
  ]);
  if (monthRes.error) throw monthRes.error;
  if (allocRes.error) throw allocRes.error;
  if (!monthRes.data) return null;

  let allocated_total_sen = 0;
  for (const a of allocRes.data as Array<{ allocated_sen: number }>) {
    allocated_total_sen += a.allocated_sen;
  }
  return { allocated_total_sen, spent_total_sen: stats.expense_sen };
}

// ---------------------------------------------------------------------------
// Write helpers ("perform*" — plain functions so DB tests can exercise them;
// the "use server" actions in src/app/(app)/budget/actions.ts wrap these).
// ---------------------------------------------------------------------------

export type BudgetWriteResult = { ok: true } | { ok: false; error: string };

const senSchema = z.number().int().min(0);

const planSchema = z.object({
  expected_income_sen: senSchema,
  savings_sen: senSchema,
  allocations: z.array(z.object({ category_id: z.uuid(), allocated_sen: senSchema })),
});

export type BudgetPlanInput = z.infer<typeof planSchema>;

function zodError(error: z.ZodError): BudgetWriteResult {
  const first = error.issues[0];
  return { ok: false, error: first ? first.message : "invalid input" };
}

type ChangeInsert = {
  month: string;
  category_id: string | null;
  from_sen: number;
  to_sen: number;
};

/**
 * Upsert the month row + allocation rows. FIRST save of a month pins the
 * planned values; a re-save updates allocated values (and expected income /
 * savings_allocated_sen) only and logs one budget_changes row per envelope
 * whose allocated value actually changed. Upserts on the unique keys keep
 * retries idempotent (rule 14 spirit).
 */
export async function performSaveBudgetPlan(
  supabase: SupabaseClient,
  month: string,
  plan: BudgetPlanInput,
): Promise<BudgetWriteResult> {
  const monthParsed = monthSchema.safeParse(month);
  if (!monthParsed.success) return zodError(monthParsed.error);
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) return zodError(parsed.error);
  const { expected_income_sen, savings_sen, allocations } = parsed.data;
  const dbMonth = monthDate(month);

  const existingRes = await supabase
    .from("budget_months")
    .select("savings_allocated_sen")
    .eq("month", dbMonth)
    .maybeSingle();
  if (existingRes.error) return { ok: false, error: existingRes.error.message };

  if (!existingRes.data) {
    // First save: pin planned = allocated = the saved values. No change log.
    const monthUp = await supabase.from("budget_months").upsert(
      {
        month: dbMonth,
        expected_income_sen,
        savings_planned_sen: savings_sen,
        savings_allocated_sen: savings_sen,
      },
      { onConflict: "user_id,month" },
    );
    if (monthUp.error) return { ok: false, error: monthUp.error.message };
    if (allocations.length > 0) {
      const allocUp = await supabase.from("budget_allocations").upsert(
        allocations.map((a) => ({
          month: dbMonth,
          category_id: a.category_id,
          planned_sen: a.allocated_sen,
          allocated_sen: a.allocated_sen,
        })),
        { onConflict: "user_id,month,category_id" },
      );
      if (allocUp.error) return { ok: false, error: allocUp.error.message };
    }
    return { ok: true };
  }

  // Re-save: planned values are pinned; only allocated values move.
  const oldSavings = existingRes.data.savings_allocated_sen as number;
  const changes: ChangeInsert[] = [];

  const monthUpd = await supabase
    .from("budget_months")
    .update({ expected_income_sen, savings_allocated_sen: savings_sen })
    .eq("month", dbMonth);
  if (monthUpd.error) return { ok: false, error: monthUpd.error.message };
  if (oldSavings !== savings_sen) {
    changes.push({ month: dbMonth, category_id: null, from_sen: oldSavings, to_sen: savings_sen });
  }

  const allocRes = await supabase
    .from("budget_allocations")
    .select("category_id, allocated_sen")
    .eq("month", dbMonth);
  if (allocRes.error) return { ok: false, error: allocRes.error.message };
  const existingAlloc = new Map(
    (allocRes.data as Array<{ category_id: string; allocated_sen: number }>).map((a) => [
      a.category_id,
      a.allocated_sen,
    ]),
  );

  for (const a of allocations) {
    const old = existingAlloc.get(a.category_id);
    if (old === a.allocated_sen) continue;
    if (old === undefined) {
      // Envelope added after the plan was pinned: planned stays 0.
      const up = await supabase.from("budget_allocations").upsert(
        { month: dbMonth, category_id: a.category_id, planned_sen: 0, allocated_sen: a.allocated_sen },
        { onConflict: "user_id,month,category_id" },
      );
      if (up.error) return { ok: false, error: up.error.message };
      if (a.allocated_sen !== 0) {
        changes.push({ month: dbMonth, category_id: a.category_id, from_sen: 0, to_sen: a.allocated_sen });
      }
    } else {
      const upd = await supabase
        .from("budget_allocations")
        .update({ allocated_sen: a.allocated_sen })
        .eq("month", dbMonth)
        .eq("category_id", a.category_id);
      if (upd.error) return { ok: false, error: upd.error.message };
      changes.push({ month: dbMonth, category_id: a.category_id, from_sen: old, to_sen: a.allocated_sen });
    }
  }

  if (changes.length > 0) {
    const log = await supabase.from("budget_changes").insert(changes);
    if (log.error) return { ok: false, error: log.error.message };
  }
  return { ok: true };
}

/** Set one envelope's allocated value; null category = the savings envelope.
 *  Logs one change row when the value actually moved. */
export async function performAdjustAllocation(
  supabase: SupabaseClient,
  month: string,
  category_id: string | null,
  new_sen: number,
): Promise<BudgetWriteResult> {
  const monthParsed = monthSchema.safeParse(month);
  if (!monthParsed.success) return zodError(monthParsed.error);
  const senParsed = senSchema.safeParse(new_sen);
  if (!senParsed.success) return zodError(senParsed.error);
  const dbMonth = monthDate(month);

  const monthRes = await supabase
    .from("budget_months")
    .select("savings_allocated_sen")
    .eq("month", dbMonth)
    .maybeSingle();
  if (monthRes.error) return { ok: false, error: monthRes.error.message };
  if (!monthRes.data) return { ok: false, error: `month ${month} is not planned` };

  let old: number;
  if (category_id === null) {
    old = monthRes.data.savings_allocated_sen as number;
    const upd = await supabase
      .from("budget_months")
      .update({ savings_allocated_sen: new_sen })
      .eq("month", dbMonth);
    if (upd.error) return { ok: false, error: upd.error.message };
  } else {
    const allocRes = await supabase
      .from("budget_allocations")
      .select("allocated_sen")
      .eq("month", dbMonth)
      .eq("category_id", category_id)
      .maybeSingle();
    if (allocRes.error) return { ok: false, error: allocRes.error.message };
    old = (allocRes.data?.allocated_sen as number | undefined) ?? 0;
    // A visible row can have no allocation row yet (allocated 0) — create it.
    const up = await supabase.from("budget_allocations").upsert(
      allocRes.data
        ? { month: dbMonth, category_id, allocated_sen: new_sen }
        : { month: dbMonth, category_id, planned_sen: 0, allocated_sen: new_sen },
      { onConflict: "user_id,month,category_id" },
    );
    if (up.error) return { ok: false, error: up.error.message };
  }

  if (old !== new_sen) {
    const log = await supabase
      .from("budget_changes")
      .insert({ month: dbMonth, category_id, from_sen: old, to_sen: new_sen });
    if (log.error) return { ok: false, error: log.error.message };
  }
  return { ok: true };
}

/** Atomic envelope-to-envelope move via the SQL function (atomicity and the
 *  two log rows live in `move_budget_allocation`). Errors surface visibly. */
export async function performMoveAllocation(
  supabase: SupabaseClient,
  month: string,
  from_category_id: string | null,
  to_category_id: string | null,
  amount_sen: number,
): Promise<BudgetWriteResult> {
  const monthParsed = monthSchema.safeParse(month);
  if (!monthParsed.success) return zodError(monthParsed.error);
  const { error } = await supabase.rpc("move_budget_allocation", {
    p_month: monthDate(month),
    p_from_category: from_category_id,
    p_to_category: to_category_id,
    p_amount_sen: amount_sen,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const benchmarkSchema = z
  .object({
    needs_pct: z.number().int().min(0).max(100),
    wants_pct: z.number().int().min(0).max(100),
  })
  .refine((v) => v.needs_pct + v.wants_pct <= 100, {
    message: "needs + wants must not exceed 100",
  });

/** Write the benchmark split; savings is the generated column — never written. */
export async function performUpdateBenchmark(
  supabase: SupabaseClient,
  needs_pct: number,
  wants_pct: number,
): Promise<BudgetWriteResult> {
  const parsed = benchmarkSchema.safeParse({ needs_pct, wants_pct });
  if (!parsed.success) return zodError(parsed.error);
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { benchmark_needs_pct: parsed.data.needs_pct, benchmark_wants_pct: parsed.data.wants_pct },
      { onConflict: "user_id" },
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

const tagSchema = z.enum(["needs", "wants", "savings"]);

/** Re-tag an expense category (income categories have no budget tag to edit). */
export async function performUpdateCategoryTag(
  supabase: SupabaseClient,
  category_id: string,
  tag: Tag,
): Promise<BudgetWriteResult> {
  const idParsed = z.uuid().safeParse(category_id);
  if (!idParsed.success) return zodError(idParsed.error);
  const tagParsed = tagSchema.safeParse(tag);
  if (!tagParsed.success) return zodError(tagParsed.error);

  const { data, error } = await supabase
    .from("categories")
    .update({ tag: tagParsed.data })
    .eq("id", idParsed.data)
    .eq("kind", "expense")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "category not found or not an expense category" };
  }
  return { ok: true };
}
