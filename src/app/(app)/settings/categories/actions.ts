"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import { revalidateSettingsIndexPaths } from "@/app/(app)/settings/revalidate";
import { parseCategoryForm } from "@/lib/account-form";

/** Category name/kind/archived feed the transaction form's dropdown, the
 *  dashboard's spend-by-category card, Quick Add's dropdown + NL parser
 *  context (src/db/parser-context.ts), and the budget page's rows —
 *  everywhere categories are read besides their own settings page. */
function revalidateCategoryPaths(): void {
  revalidatePath("/settings/categories");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  revalidatePath("/quick");
  revalidatePath("/budget");
  // Plan 7: bill rows render the rule's category name.
  revalidatePath("/bills");
  // Task-7 audit gap (pre-existing since Plan 5): the Net Worth page's
  // "Record payment" dialog offers the expense-category list.
  revalidatePath("/net-worth");
  // Plan 8: the import preview's category path labels.
  revalidatePath("/transactions/import");
  // Q10: same shape as accounts — category names appear on
  // /settings/recurring and /settings/aliases, and the count on /settings.
  revalidateSettingsIndexPaths();
}

export async function ensureSeedCategories(): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const { error } = await supabase.rpc("seed_default_categories");
  if (error) return { error: error.message };
  return {};
}

export async function createCategory(
  _prevState: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = parseCategoryForm({
    name: formData.get("name"),
    kind: formData.get("kind"),
    parentId: formData.get("parentId"),
    tag: formData.get("tag"),
  });
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").insert({
    name: parsed.value.name,
    kind: parsed.value.kind,
    parent_id: parsed.value.parentId,
    tag: parsed.value.tag,
  });
  if (error) return { error: error.message };

  revalidateCategoryPaths();
  return {};
}

export async function archiveCategory(id: string): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("categories").update({ archived: true }).eq("id", id);
  if (error) return { error: error.message };

  revalidateCategoryPaths();
  return {};
}
