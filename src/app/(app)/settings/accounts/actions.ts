"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import { revalidateSettingsIndexPaths } from "@/app/(app)/settings/revalidate";
import { parseAccountForm } from "@/lib/account-form";
import { performSetAllocationBucket, type NetWorthWriteResult } from "@/db/networth";
import {
  performArchiveAccount,
  performSetAccountCurrency,
  type AccountWriteResult,
} from "@/db/accounts";
import type { Bucket } from "@/lib/allocation";

/** Account name/archived feed the transaction form's dropdown, the
 *  dashboard's balances card, and Quick Add's dropdown + NL parser context
 *  (src/db/parser-context.ts) — everywhere accounts are read besides their
 *  own settings page. */
function revalidateAccountPaths(): void {
  revalidatePath("/settings/accounts");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
  revalidatePath("/quick");
  revalidatePath("/net-worth");
  revalidatePath("/investments");
  // Plan 7 ruling 12: an account write moves the projection's spendable base.
  revalidatePath("/bills");
  // Plan 7 ruling 9b: it also moves the Goals hero's "RM x in MYR accounts"
  // denominator, which is what keeps ruling 1(c)'s "already counted elsewhere"
  // claim honest. Same `account_balances` enumeration as /bills above.
  revalidatePath("/goals");
  revalidatePath("/more");
  // Plan 8: the import wizard's target picker and the history's account names.
  revalidatePath("/transactions/import");
  // Q10: an account's NAME is rendered on /settings/recurring (every rule
  // row) and /settings/aliases (every alias target), and its existence moves
  // the /settings accounts count.
  revalidateSettingsIndexPaths();
}

export async function createAccount(
  _prevState: { error?: string },
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = parseAccountForm({
    name: formData.get("name"),
    type: formData.get("type"),
    startingBalance: formData.get("startingBalance"),
    currency: formData.get("currency") ?? undefined,
  });
  if (!parsed.ok) return { error: parsed.error };

  const supabase = await createServerSupabase();
  const { error } = await supabase.from("accounts").insert({
    name: parsed.value.name,
    type: parsed.value.type,
    currency: parsed.value.currency,
    starting_balance_sen: parsed.value.startingBalanceSen,
  });
  if (error) return { error: error.message };

  revalidateAccountPaths();
  return {};
}

export async function renameAccount(id: string, formData: FormData): Promise<{ error?: string }> {
  const name = formData.get("name");
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed.length < 1 || trimmed.length > 60) {
    return { error: "Name must be 1–60 characters." };
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.from("accounts").update({ name: trimmed }).eq("id", id);
  if (error) return { error: error.message };

  revalidateAccountPaths();
  return {};
}

/** Plan 8 ruling 2: refused while an active recurring rule uses the account
 *  on either leg (performArchiveAccount names them); the refusal is shown by
 *  ArchiveAccountButton. Same revalidation set as before — the guard changes
 *  nothing about what an archive moves. */
export async function archiveAccount(id: string): Promise<AccountWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performArchiveAccount(supabase, id);
  if (result.ok) revalidateAccountPaths();
  return result;
}

/** Task 5 (ruling 7): brokerage-account currency edit — server-validated
 *  inside the RLS session (zero transactions/trades/business entries, see
 *  performSetAccountCurrency). Currency feeds every converted surface, so
 *  the full account revalidation set applies. */
export async function setAccountCurrency(
  account_id: string,
  currency: string,
): Promise<AccountWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetAccountCurrency(supabase, account_id, currency);
  if (result.ok) revalidateAccountPaths();
  return result;
}

/** Allocation bucket seg-mini (ruling 12) — the bucket feeds only the
 *  allocation-plan sections on /investments, so the audit set is exactly
 *  this page + that one (Task-5 audit list). */
export async function setAllocationBucket(
  account_id: string,
  bucket: Bucket,
): Promise<NetWorthWriteResult> {
  const supabase = await createServerSupabase();
  const result = await performSetAllocationBucket(supabase, account_id, bucket);
  if (result.ok) {
    revalidatePath("/settings/accounts");
    revalidatePath("/investments");
  }
  return result;
}
