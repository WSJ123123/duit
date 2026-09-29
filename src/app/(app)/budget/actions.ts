"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import { revalidateSettingsIndexPaths } from "@/app/(app)/settings/revalidate";
import {
  performSaveBudgetPlan,
  performAdjustAllocation,
  performMoveAllocation,
  performUpdateBenchmark,
  performUpdateCategoryTag,
  type BudgetPlanInput,
  type BudgetWriteResult,
} from "@/db/budget";
import type { Tag } from "@/lib/budget";

/** Budget numbers surface on the budget page, dashboard, and Quick Add hero —
 *  and, since Plan 7 ruling 10, on /goals: `budget_months.savings_allocated_sen`
 *  IS the savings waterfall's envelope, so editing the savings row (via
 *  `saveBudgetPlan` or `adjustAllocation` with a null category) changes the
 *  waterfall's leftover and its shortfall flag. The set is shared across all
 *  five actions rather than split: a benchmark or tag edit revalidating
 *  /goals costs one refetch, while a missed one leaves a wrong envelope on
 *  screen. */
function revalidateBudgetPaths(): void {
  revalidatePath("/budget");
  revalidatePath("/dashboard");
  revalidatePath("/quick");
  revalidatePath("/goals");
}

export async function saveBudgetPlan(
  month: string,
  plan: BudgetPlanInput,
): Promise<BudgetWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSaveBudgetPlan(supabase, month, plan);
  if (result.ok) revalidateBudgetPaths();
  return result;
}

export async function adjustAllocation(
  month: string,
  category_id: string | null,
  new_sen: number,
): Promise<BudgetWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performAdjustAllocation(supabase, month, category_id, new_sen);
  if (result.ok) revalidateBudgetPaths();
  return result;
}

export async function moveAllocation(
  month: string,
  from_category_id: string | null,
  to_category_id: string | null,
  amount_sen: number,
): Promise<BudgetWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performMoveAllocation(
    supabase,
    month,
    from_category_id,
    to_category_id,
    amount_sen,
  );
  if (result.ok) revalidateBudgetPaths();
  return result;
}

export async function updateBenchmark(
  needs_pct: number,
  wants_pct: number,
): Promise<BudgetWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateBenchmark(supabase, needs_pct, wants_pct);
  if (result.ok) revalidateBudgetPaths();
  return result;
}

export async function updateCategoryTag(
  category_id: string,
  tag: Tag,
): Promise<BudgetWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performUpdateCategoryTag(supabase, category_id, tag);
  if (result.ok) {
    revalidateBudgetPaths();
    // Q10: the control that calls this lives on /settings/categories
    // (CategoryTagControl), which the budget set does not cover — so the page
    // the owner just used was the one page that kept showing the old tag.
    revalidateSettingsIndexPaths();
  }
  return result;
}
