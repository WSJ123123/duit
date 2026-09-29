"use server";

import { revalidatePath } from "next/cache";
import { revalidateSettingsIndexPaths } from "@/app/(app)/settings/revalidate";

/** Aliases are read on their own settings page AND by the NL parser context
 *  `/quick` loads on every render (src/db/parser-context.ts) — Task-7 audit
 *  gap: without /quick a just-saved alias silently does not apply for the
 *  client Router Cache's stale window. Pre-existing since Plan 3. */
function revalidateAliasPaths(): void {
  revalidatePath("/settings/aliases");
  revalidatePath("/quick");
  // Q10: /settings shows the alias count.
  revalidateSettingsIndexPaths();
}
import { createServerSupabase } from "@/db/server";
import {
  performSaveAlias,
  performDeleteAlias,
  performGenerateDefaultAliases,
  type AliasTarget,
} from "@/db/aliases";

export async function saveAlias(
  _prevState: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const phrase = formData.get("phrase");
  const targetValue = formData.get("target");
  const target: AliasTarget = {};
  if (typeof targetValue === "string" && targetValue.includes(":")) {
    const [kind, id] = targetValue.split(":", 2);
    if (kind === "category") target.categoryId = id;
    if (kind === "account") target.accountId = id;
  }

  const supabase = await createServerSupabase();
  const result = await performSaveAlias(supabase, typeof phrase === "string" ? phrase : "", target);
  if (!result.error) revalidateAliasPaths();
  return result;
}

export async function deleteAlias(id: string): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performDeleteAlias(supabase, id);
  if (!result.error) revalidateAliasPaths();
  return result;
}

export async function generateDefaultAliases(): Promise<{ error?: string; inserted?: number }> {
  const supabase = await createServerSupabase();
  const result = await performGenerateDefaultAliases(supabase);
  if (!result.error) revalidateAliasPaths();
  return result;
}
