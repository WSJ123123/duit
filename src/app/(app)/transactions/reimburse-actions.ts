"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/db/server";
import {
  performRecordReimbursement,
  type ReimbursementResult,
} from "@/lib/reimbursements";

export async function recordReimbursementPayment(
  txId: string,
  accountId: string,
  amount: string,
): Promise<ReimbursementResult> {
  const supabase = await createServerSupabase();
  const result = await performRecordReimbursement(supabase, txId, accountId, amount);
  // Payments land in account_balances (supabase/migrations/20260815192453_balances_view.sql)
  // and shrink the dashboard's "Owed to me" card — not category spend, so
  // /quick and /budget are untouched.
  if (result.ok) {
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    revalidatePath("/net-worth");
    revalidatePath("/investments");
    // Plan 7 ruling 12: a payback credits an account, moving the spendable base.
    revalidatePath("/bills");
    // Plan 7 ruling 9b: an account_balances term also moves the Goals hero's
    // "RM x in MYR accounts" denominator.
    revalidatePath("/goals");
    // F3: /settings/accounts renders a per-account balance off the same
    // account_balances view, so it belongs to this enumeration too.
    revalidatePath("/settings/accounts");
    revalidatePath("/more");
    // Plan 8 Task 7 audit: a payment on an imported row makes its batch
    // "touched" — the import history's two readers.
    revalidatePath("/settings");
    revalidatePath("/transactions/import");
  }
  return result;
}
