import { createServerSupabase } from "@/db/server";
import { getAccountsWithBalances } from "@/db/queries";
import { getImportMappings, getSettings } from "@/db/settings";
import { listImportBatches } from "@/db/import/history";
import { ImportWizard } from "@/components/ImportWizard";
import { categoryPathLabels } from "@/lib/import-display";

// Server actions inherit this: a 100-row chunk is ~215 sequential round-trips.
export const maxDuration = 60;

/**
 * /transactions/import (Plan 8 ruling 18): desktop-first, entered from the
 * Transactions header and Settings. Ruling 11: only non-archived MYR
 * accounts are offered as targets.
 */
export default async function ImportPage() {
  const supabase = await createServerSupabase();
  const [accounts, settings, mappings, categoriesRes, history] = await Promise.all([
    getAccountsWithBalances(supabase),
    getSettings(supabase),
    getImportMappings(supabase),
    supabase.from("categories").select("id, name, parent_id"),
    listImportBatches(supabase),
  ]);
  if (categoriesRes.error) throw categoriesRes.error;

  const targets = accounts
    .filter((a) => !a.archived && a.currency === "MYR")
    .map((a) => ({ id: a.id, name: a.name, type: a.type }));
  const categories = categoryPathLabels(categoriesRes.data as Array<{ id: string; name: string; parent_id: string | null }>);

  return (
    <ImportWizard
      accounts={targets}
      mappings={mappings}
      categories={categories}
      defaultAccountId={settings.default_account_id}
      history={history}
    />
  );
}
