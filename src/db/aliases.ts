import type { SupabaseClient } from "@supabase/supabase-js";
import { generateAliasesFromNames } from "@/lib/alias-gen";

/**
 * Parser-alias writes (Plan 9 ruling 10d). Moved verbatim out of
 * `src/app/(app)/settings/aliases/actions.ts`: every export of a
 * `"use server"` module is a callable endpoint (finding #20 in reverse),
 * and these helpers have no zod boundary of their own — the action wrappers
 * there are the only callers.
 */

export interface AliasTarget {
  categoryId?: string;
  accountId?: string;
}

/**
 * Upsert on (user_id, phrase) — that pair is unique per the parser_aliases
 * schema (supabase/migrations/20260815191612_recurring_aliases_tokens.sql),
 * so a single upsert with onConflict handles both "new phrase" and
 * "re-target an existing phrase" without a separate select-then-branch.
 */
export async function performSaveAlias(
  supabase: SupabaseClient,
  phrase: string,
  target: AliasTarget,
): Promise<{ error?: string }> {
  const trimmed = typeof phrase === "string" ? phrase.trim().toLowerCase() : "";
  if (trimmed.length < 1 || trimmed.length > 60) {
    return { error: "Phrase must be 1–60 characters." };
  }
  const categoryId = target.categoryId ?? null;
  const accountId = target.accountId ?? null;
  if (!categoryId && !accountId) {
    return { error: "Choose a category or an account." };
  }

  const { error } = await supabase
    .from("parser_aliases")
    .upsert(
      { phrase: trimmed, category_id: categoryId, account_id: accountId },
      { onConflict: "user_id,phrase" },
    );
  if (error) return { error: error.message };
  return {};
}

export async function performDeleteAlias(
  supabase: SupabaseClient,
  id: string,
): Promise<{ error?: string }> {
  const { error } = await supabase.from("parser_aliases").delete().eq("id", id);
  if (error) return { error: error.message };
  return {};
}

/**
 * Loads the caller's unarchived account/category names plus existing alias
 * phrases, runs the pure generator, and bulk-inserts whatever's new.
 */
export async function performGenerateDefaultAliases(
  supabase: SupabaseClient,
): Promise<{ error?: string; inserted?: number }> {
  const [accountsRes, categoriesRes, aliasesRes] = await Promise.all([
    supabase.from("accounts").select("id, name").eq("archived", false),
    supabase.from("categories").select("id, name").eq("archived", false),
    supabase.from("parser_aliases").select("phrase"),
  ]);
  if (accountsRes.error) return { error: accountsRes.error.message };
  if (categoriesRes.error) return { error: categoriesRes.error.message };
  if (aliasesRes.error) return { error: aliasesRes.error.message };

  const existingPhrases = (aliasesRes.data as Array<{ phrase: string }>).map((a) => a.phrase);
  const generated = generateAliasesFromNames(
    accountsRes.data as Array<{ id: string; name: string }>,
    categoriesRes.data as Array<{ id: string; name: string }>,
    existingPhrases,
  );
  if (generated.length === 0) return { inserted: 0 };

  const { error } = await supabase.from("parser_aliases").insert(generated);
  if (error) return { error: error.message };
  return { inserted: generated.length };
}
