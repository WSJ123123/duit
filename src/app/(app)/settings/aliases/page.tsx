import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Tip } from "@/components/Tip";
import { AddAliasForm } from "./AddAliasForm";
import { GenerateAliasesButton } from "./GenerateAliasesButton";
import { deleteAlias } from "./actions";

interface AliasRow {
  id: string;
  phrase: string;
  category_id: string | null;
  account_id: string | null;
}

interface NamedRow {
  id: string;
  name: string;
}

async function deleteAliasAction(id: string): Promise<void> {
  "use server";
  await deleteAlias(id);
}

export default async function AliasesSettingsPage() {
  const supabase = await createServerSupabase();

  const [aliasesRes, categoriesRes, accountsRes] = await Promise.all([
    supabase.from("parser_aliases").select("id, phrase, category_id, account_id").order("phrase"),
    supabase.from("categories").select("id, name, kind, archived").order("name"),
    supabase.from("accounts").select("id, name, archived").order("name"),
  ]);
  if (aliasesRes.error) throw aliasesRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (accountsRes.error) throw accountsRes.error;

  const aliases = aliasesRes.data as AliasRow[];
  const categories = categoriesRes.data as Array<NamedRow & { kind: string; archived: boolean }>;
  const accounts = accountsRes.data as Array<NamedRow & { archived: boolean }>;

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  const activeCategories = categories.filter((c) => !c.archived);
  const activeAccounts = accounts.filter((a) => !a.archived);

  return (
    <div className="flex flex-col gap-6">
      <nav className="eye-clear flex gap-4 text-sm max-md:flex-wrap" style={{ color: "var(--ink-3)" }}>
        <Link href="/settings">Settings</Link>
        <Link href="/settings/accounts">Accounts</Link>
        <Link href="/settings/categories">Categories</Link>
        <span style={{ color: "var(--ink-1)", fontWeight: 600 }}>Aliases</span>
        <Link href="/settings/shortcut">Shortcut</Link>
        <Link href="/settings/recurring">Recurring</Link>
      </nav>

      <Card title="Aliases">
        <Tip className="mb-3">
          Aliases beat the built-in dictionary. Teach it your kopitiam.
        </Tip>
        <ul className="flex flex-col">
          {aliases.length === 0 ? (
            <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
              No aliases yet.
            </li>
          ) : null}
          {aliases.map((alias) => {
            const targetName = alias.category_id
              ? (categoryNameById.get(alias.category_id) ?? "Unknown category")
              : alias.account_id
                ? (accountNameById.get(alias.account_id) ?? "Unknown account")
                : "—";
            const targetKind = alias.category_id ? "Category" : alias.account_id ? "Account" : null;
            return (
              <li
                key={alias.id}
                className="flex items-center gap-3 py-2.5"
                style={{ borderBottom: "1px solid var(--grid)" }}
              >
                <span className="flex-1 text-sm font-medium">{alias.phrase}</span>
                <span aria-hidden style={{ color: "var(--ink-3)" }}>
                  →
                </span>
                <span className="flex-1 text-sm" style={{ color: "var(--ink-2)" }}>
                  {targetName}
                </span>
                {targetKind ? (
                  <span
                    className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs"
                    style={{ background: "var(--chip)", color: "var(--ink-2)" }}
                  >
                    {targetKind}
                  </span>
                ) : null}
                <form action={deleteAliasAction.bind(null, alias.id)}>
                  <Button type="submit" variant="ghost" className="px-2 py-1">
                    Delete
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Add alias">
        <AddAliasForm categories={activeCategories} accounts={activeAccounts} />
      </Card>

      <Card title="Generate from my names">
        <Tip className="mb-3">
          Creates an alias for each account and category name, plus any word that&apos;s unambiguous across all of them.
        </Tip>
        <GenerateAliasesButton />
      </Card>
    </div>
  );
}
