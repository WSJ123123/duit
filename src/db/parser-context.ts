import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParserContext } from "@/lib/parser/parse";

/**
 * Loads everything the quick-entry parser needs for one user: unarchived
 * accounts/categories, all aliases, and the default account.
 *
 * CRITICAL: every query below filters explicitly with `.eq("user_id", userId)`
 * even though RLS on the session client would already scope the rows. This
 * function is also called with the service-role (admin) client — which
 * bypasses RLS entirely — so the explicit filter is the ONLY guard in that
 * path. Never rely on RLS alone here.
 */
export async function loadParserContext(
  client: SupabaseClient,
  userId: string,
): Promise<ParserContext> {
  const [accountsRes, categoriesRes, aliasesRes, settingsRes] = await Promise.all([
    // Ruling 7 (Task 5): only MYR accounts enter the parser vocabulary —
    // quick entries are income/expense, which non-MYR accounts never take.
    client
      .from("accounts")
      .select("id, name")
      .eq("user_id", userId)
      .eq("archived", false)
      .eq("currency", "MYR"),
    client
      .from("categories")
      .select("id, name, kind")
      .eq("user_id", userId)
      .eq("archived", false),
    client.from("parser_aliases").select("phrase, category_id, account_id").eq("user_id", userId),
    client
      .from("user_settings")
      .select("default_account_id")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (accountsRes.error) throw accountsRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (aliasesRes.error) throw aliasesRes.error;
  if (settingsRes.error) throw settingsRes.error;

  return {
    accounts: accountsRes.data as ParserContext["accounts"],
    categories: categoriesRes.data as ParserContext["categories"],
    aliases: aliasesRes.data as ParserContext["aliases"],
    default_account_id: settingsRes.data?.default_account_id ?? null,
  };
}
