"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import { revalidateSettingsIndexPaths } from "@/app/(app)/settings/revalidate";
import { klToday } from "@/lib/kl-date";
import { performCreateRule, performUpdateRule, performSetActive } from "@/db/recurring";
import { validateRecurringInput, type RecurringFormInput } from "@/lib/recurring-form";

/** Recurring rules feed getBudgetMonth's unplanned-month expected-income
 *  default (src/db/budget.ts, expectedIncomeFromRules), and — since Plan 7 —
 *  every row and every figure on `/bills` (a bill IS an occurrence of a rule,
 *  ruling 11) plus the dashboard's `Due soon` card (ruling 13). `/more`
 *  carries both a rule count and a bills summary. */
function revalidateRecurringPaths(): void {
  revalidatePath("/settings/recurring");
  revalidatePath("/budget");
  revalidatePath("/bills");
  revalidatePath("/dashboard");
  revalidatePath("/more");
  // Q10: /settings shows the active-rule count.
  revalidateSettingsIndexPaths();
}

function formInputFromFormData(formData: FormData): RecurringFormInput {
  const str = (key: string): string | undefined => {
    const v = formData.get(key);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  return {
    name: str("name"),
    type: str("type"),
    amount: str("amount"),
    variable: formData.get("variable") === "on",
    accountId: str("accountId"),
    transferAccountId: str("transferAccountId"),
    categoryId: str("categoryId"),
    freq: str("freq"),
    dayOfMonth: str("dayOfMonth"),
    weekday: str("weekday"),
    monthOfYear: str("monthOfYear"),
  };
}

export async function createRecurringRule(
  _prevState: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = validateRecurringInput(formInputFromFormData(formData));
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createServerSupabase();
  const result = await performCreateRule(supabase, parsed.value, klToday(new Date()));
  if (!result.ok) return { error: result.error };

  revalidateRecurringPaths();
  return {};
}

export async function updateRecurringRule(
  id: string,
  _prevState: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = validateRecurringInput(formInputFromFormData(formData));
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createServerSupabase();
  const result = await performUpdateRule(supabase, id, parsed.value, klToday(new Date()));
  if (!result.ok) return { error: result.error };

  revalidateRecurringPaths();
  return {};
}

export async function archiveRecurringRule(id: string): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performSetActive(supabase, id, false);
  if (!result.error) revalidateRecurringPaths();
  return result;
}

export async function unarchiveRecurringRule(id: string): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performSetActive(supabase, id, true);
  if (!result.error) revalidateRecurringPaths();
  return result;
}
