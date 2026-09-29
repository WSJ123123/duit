"use server";

import { createServerSupabase } from "@/db/server";
import { performHasShortcutEntry } from "@/db/onboarding";

export async function hasShortcutEntry(): Promise<boolean> {
  const supabase = await createServerSupabase();
  return performHasShortcutEntry(supabase);
}

export interface ShortcutEntryPreview {
  amount_sen: number;
  type: string;
  note: string;
  date: string;
  categoryName: string | null;
}

/**
 * Display-only fetch of the most recent shortcut-sourced transaction, for
 * the wizard's "entry rendered" confirmation panel once `hasShortcutEntry`
 * flips true. Kept separate from `hasShortcutEntry` so that one stays a
 * cheap boolean fit for 5s polling. Same "inline query" tier as the reads
 * settings pages already do in their page components — no dedicated test.
 */
export async function getLatestShortcutEntry(): Promise<ShortcutEntryPreview | null> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("transactions")
    .select("amount_sen, type, note, date, category_id")
    .eq("source", "shortcut")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  let categoryName: string | null = null;
  if (data.category_id) {
    const { data: category } = await supabase
      .from("categories")
      .select("name")
      .eq("id", data.category_id)
      .maybeSingle();
    categoryName = category?.name ?? null;
  }

  return {
    amount_sen: data.amount_sen,
    type: data.type,
    note: data.note,
    date: data.date,
    categoryName,
  };
}

export interface AliasPreview {
  phrase: string;
  targetName: string;
}

/**
 * Alias list resolved to display names, for the wizard's aliases-step
 * preview — same resolution the Aliases settings page does inline, reused
 * here since `generateDefaultAliases` itself only returns a count.
 */
export async function listAliasPreview(): Promise<AliasPreview[]> {
  const supabase = await createServerSupabase();
  const [aliasesRes, categoriesRes, accountsRes] = await Promise.all([
    supabase.from("parser_aliases").select("phrase, category_id, account_id").order("phrase"),
    supabase.from("categories").select("id, name"),
    supabase.from("accounts").select("id, name"),
  ]);
  if (aliasesRes.error) throw aliasesRes.error;
  if (categoriesRes.error) throw categoriesRes.error;
  if (accountsRes.error) throw accountsRes.error;

  const categoryNameById = new Map(
    (categoriesRes.data as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  const accountNameById = new Map(
    (accountsRes.data as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]),
  );

  return (
    aliasesRes.data as Array<{ phrase: string; category_id: string | null; account_id: string | null }>
  ).map((alias) => ({
    phrase: alias.phrase,
    targetName: alias.category_id
      ? (categoryNameById.get(alias.category_id) ?? "Unknown category")
      : (accountNameById.get(alias.account_id ?? "") ?? "Unknown account"),
  }));
}
