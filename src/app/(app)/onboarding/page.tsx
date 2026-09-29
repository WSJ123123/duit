import { headers } from "next/headers";
import { createServerSupabase } from "@/db/server";
import { getSettings } from "@/db/settings";
import { OnboardingWizard, type OnboardingRecurringRule } from "@/components/OnboardingWizard";
import { listAliasPreview } from "./actions";

interface AccountRow {
  id: string;
  name: string;
  type: string;
  archived: boolean;
}

interface CategoryRow {
  id: string;
  name: string;
  kind: "expense" | "income";
  parent_id: string | null;
  tag: "needs" | "wants" | "savings";
  archived: boolean;
}

/**
 * First-run setup wizard. Categories are already seeded by the parent
 * `(app)` layout's `ensureSeedCategories()` call, which runs ahead of every
 * route in this group including this one — no separate seed call needed
 * here.
 */
export default async function OnboardingPage() {
  const [supabase, headerList] = await Promise.all([createServerSupabase(), headers()]);

  const host = headerList.get("host") ?? "localhost:3000";
  const proto =
    headerList.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const appUrl = `${proto}://${host}`;

  const [settings, accountsRes, categoriesRes, rulesRes, aliasPreview] = await Promise.all([
    getSettings(supabase),
    supabase.from("accounts").select("id, name, type, archived").order("created_at"),
    supabase
      .from("categories")
      .select("id, name, kind, parent_id, tag, archived")
      .order("created_at"),
    supabase
      .from("recurring_rules")
      .select(
        "id, name, type, amount_sen, variable, account_id, transfer_account_id, category_id, freq, day_of_month, weekday, month_of_year, next_run, active",
      )
      .eq("active", true)
      .order("name"),
    listAliasPreview(),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (rulesRes.error) throw rulesRes.error;

  const accounts = (accountsRes.data as AccountRow[]).filter((a) => !a.archived);
  const categories = (categoriesRes.data as CategoryRow[]).filter((c) => !c.archived);
  const recurringRules = rulesRes.data as OnboardingRecurringRule[];

  return (
    <OnboardingWizard
      accounts={accounts.map((a) => ({ id: a.id, name: a.name, type: a.type }))}
      categories={categories.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        parent_id: c.parent_id,
        tag: c.tag,
      }))}
      recurringRules={recurringRules}
      initialAliases={aliasPreview}
      initialDefaultAccountId={settings.default_account_id}
      appUrl={appUrl}
    />
  );
}
