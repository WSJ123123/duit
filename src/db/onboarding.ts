import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True when the caller has at least one transaction created via the iOS
 * Shortcut quick-entry endpoint (`transactions.source = 'shortcut'`). RLS
 * scopes `transactions` to `auth.uid()`, so — matching the repo's
 * `performX(supabase)` pattern (e.g. `performGenerateDefaultAliases`) — no
 * explicit user filter is needed here; the caller's own client does the
 * scoping.
 */
export async function performHasShortcutEntry(supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase
    .from("transactions")
    .select("id")
    .eq("source", "shortcut")
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
