import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import type { RecurringRuleDefaults } from "./RecurringRuleForm";
import { RecurringRuleForm } from "./RecurringRuleForm";
import { RecurringRuleRow } from "./RecurringRuleRow";

interface RuleRow extends RecurringRuleDefaults {
  active: boolean;
  next_run: string;
}

interface NamedRow {
  id: string;
  name: string;
}

export default async function RecurringSettingsPage() {
  const supabase = await createServerSupabase();

  const [rulesRes, categoriesRes, accountsRes] = await Promise.all([
    supabase
      .from("recurring_rules")
      .select(
        "id, name, type, amount_sen, variable, account_id, transfer_account_id, category_id, freq, day_of_month, weekday, month_of_year, next_run, active",
      )
      .order("name"),
    supabase.from("categories").select("id, name, kind, archived").order("name"),
    supabase.from("accounts").select("id, name, currency, archived").order("name"),
  ]);
  if (rulesRes.error) throw rulesRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (accountsRes.error) throw accountsRes.error;

  const rules = rulesRes.data as RuleRow[];
  const categories = categoriesRes.data as Array<NamedRow & { kind: "expense" | "income"; archived: boolean }>;
  const accounts = accountsRes.data as Array<NamedRow & { currency: string; archived: boolean }>;

  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
  const activeCategories = categories.filter((c) => !c.archived);
  // Ruling 7: recurring rules materialize MYR income/expense rows — only
  // MYR accounts are offered.
  const activeAccounts = accounts.filter((a) => !a.archived && a.currency === "MYR");

  const activeRules = rules.filter((r) => r.active);
  const archivedRules = rules.filter((r) => !r.active);

  return (
    <div className="flex flex-col gap-6">
      <nav className="eye-clear flex gap-4 text-sm max-md:flex-wrap" style={{ color: "var(--ink-3)" }}>
        <Link href="/settings">Settings</Link>
        <Link href="/settings/accounts">Accounts</Link>
        <Link href="/settings/categories">Categories</Link>
        <Link href="/settings/aliases">Aliases</Link>
        <Link href="/settings/shortcut">Shortcut</Link>
        <span style={{ color: "var(--ink-1)", fontWeight: 600 }}>Recurring</span>
      </nav>

      <Card title="Recurring rules">
        <Tip className="mb-3">Bills and income that post automatically on a schedule.</Tip>
        <ul className="flex flex-col">
          {activeRules.length === 0 ? (
            <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
              No recurring rules yet.
            </li>
          ) : null}
          {activeRules.map((rule) => (
            <RecurringRuleRow
              key={rule.id}
              rule={rule}
              active
              accountName={accountNameById.get(rule.account_id) ?? "Unknown account"}
              nextRun={rule.next_run}
              accounts={activeAccounts}
              categories={activeCategories}
            />
          ))}
        </ul>
      </Card>

      <Card title="Add recurring rule">
        <RecurringRuleForm accounts={activeAccounts} categories={activeCategories} />
      </Card>

      {archivedRules.length > 0 ? (
        <Card title="Archived">
          <Tip className="mb-3">Muted — restore to resume posting entries.</Tip>
          <ul className="flex flex-col">
            {archivedRules.map((rule) => (
              <RecurringRuleRow
                key={rule.id}
                rule={rule}
                active={false}
                accountName={accountNameById.get(rule.account_id) ?? "Unknown account"}
                nextRun={rule.next_run}
                accounts={activeAccounts}
                categories={activeCategories}
              />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
