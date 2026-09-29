import Link from "next/link";
import { createServerSupabase } from "@/db/server";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { AddCategoryForm } from "./AddCategoryForm";
import { CategoryTagControl } from "./CategoryTagControl";
import { archiveCategory } from "./actions";

interface CategoryRow {
  id: string;
  name: string;
  kind: "expense" | "income";
  parent_id: string | null;
  tag: "needs" | "wants" | "savings";
  archived: boolean;
}

function CategoryColumn({ kind, title, categories }: { kind: "expense" | "income"; title: string; categories: CategoryRow[] }) {
  const inKind = categories.filter((c) => c.kind === kind);
  const parents = inKind.filter((c) => c.parent_id === null);
  const childrenOf = (parentId: string) => inKind.filter((c) => c.parent_id === parentId);

  return (
    <Card title={title}>
      <ul className="flex flex-col">
        {parents.length === 0 ? (
          <li className="py-2 text-sm" style={{ color: "var(--ink-3)" }}>
            No {title.toLowerCase()} categories yet.
          </li>
        ) : null}
        {parents.map((parent) => (
          <li key={parent.id} className="flex flex-col">
            <CategoryRowView category={parent} indent={false} showTagControl={kind === "expense"} />
            {childrenOf(parent.id).map((child) => (
              <CategoryRowView key={child.id} category={child} indent showTagControl={false} />
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

async function archiveCategoryAction(id: string): Promise<void> {
  "use server";
  await archiveCategory(id);
}

function CategoryRowView({
  category,
  indent,
  showTagControl,
}: {
  category: CategoryRow;
  indent: boolean;
  showTagControl: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 py-2"
      style={{ borderBottom: "1px solid var(--grid)", paddingLeft: indent ? 20 : 0 }}
    >
      <span className="flex-1 text-sm" style={{ fontWeight: indent ? 400 : 600 }}>
        {category.name}
      </span>
      {showTagControl ? (
        <CategoryTagControl categoryId={category.id} tag={category.tag} />
      ) : (
        <span
          className="flex-shrink-0 rounded-full px-2 py-0.5 text-xs"
          style={{ background: "var(--chip)", color: "var(--ink-2)" }}
        >
          {category.tag}
        </span>
      )}
      <form action={archiveCategoryAction.bind(null, category.id)}>
        <Button type="submit" variant="ghost" className="px-2 py-1">
          Archive
        </Button>
      </form>
    </div>
  );
}

export default async function CategoriesSettingsPage() {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind, parent_id, tag, archived")
    .eq("archived", false)
    .order("created_at");
  if (error) throw error;
  const categories = data as CategoryRow[];

  const parentOptions = categories
    .filter((c) => c.parent_id === null)
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind }));

  return (
    <div className="flex flex-col gap-6">
      <nav className="eye-clear flex gap-4 text-sm max-md:flex-wrap" style={{ color: "var(--ink-3)" }}>
        <Link href="/settings">Settings</Link>
        <Link href="/settings/accounts">Accounts</Link>
        <span style={{ color: "var(--ink-1)", fontWeight: 600 }}>Categories</span>
        <Link href="/settings/aliases">Aliases</Link>
        <Link href="/settings/shortcut">Shortcut</Link>
        <Link href="/settings/recurring">Recurring</Link>
      </nav>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <CategoryColumn kind="expense" title="Expense" categories={categories} />
        <CategoryColumn kind="income" title="Income" categories={categories} />
      </div>

      <Card title="Add category">
        <AddCategoryForm parents={parentOptions} />
      </Card>
    </div>
  );
}
