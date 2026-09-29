"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import { performReconcile, type ReconcileResult } from "@/lib/reconcile";

export async function reconcileAccount(
  accountId: string,
  statedBalance: string,
  categoryId: string,
): Promise<ReconcileResult> {
  const supabase = await createServerSupabase();
  const result = await performReconcile(supabase, accountId, statedBalance, categoryId);
  // A reconciliation adjustment is an ordinary categorized transaction (rule
  // 19) — same downstream readers as any other transaction write.
  if (result.ok) {
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    revalidatePath("/quick");
    revalidatePath("/budget");
    revalidatePath("/net-worth");
    revalidatePath("/investments");
    // Plan 7 ruling 12: a reconcile adjustment moves an account balance, and
    // the projection starts from the spendable balance.
    revalidatePath("/bills");
    // Plan 7 ruling 9b: an account_balances term also moves the Goals hero's
    // "RM x in MYR accounts" denominator.
    revalidatePath("/goals");
    // F3: /settings/accounts renders a per-account balance off the same
    // account_balances view, so it belongs to this enumeration too.
    revalidatePath("/settings/accounts");
    revalidatePath("/more");
  }
  return result;
}
