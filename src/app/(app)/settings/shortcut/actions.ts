"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import {
  performCreateToken,
  performRevokeToken,
  performRegenerateToken,
} from "@/db/tokens";

/**
 * The raw token returned here is the ONLY time it exists outside the user's
 * clipboard — it is never logged, never persisted, never re-fetchable.
 */
export async function createApiToken(
  name?: string,
): Promise<{ token?: string; error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performCreateToken(supabase, name);
  if (!result.error) {
    revalidatePath("/settings/shortcut");
    revalidatePath("/settings"); // the index's "n active tokens"
  }
  return result;
}

export async function revokeApiToken(id: string): Promise<{ error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performRevokeToken(supabase, id);
  if (!result.error) {
    revalidatePath("/settings/shortcut");
    revalidatePath("/settings"); // the index's "n active tokens"
  }
  return result;
}

export async function regenerateApiToken(
  id: string,
): Promise<{ token?: string; error?: string }> {
  const supabase = await createServerSupabase();
  const result = await performRegenerateToken(supabase, id);
  if (!result.error) revalidatePath("/settings/shortcut");
  return result;
}
