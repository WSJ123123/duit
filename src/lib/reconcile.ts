import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSen, formatCcy, parseAmountToSen } from "@/lib/money";

export type ReconciliationPlan =
  | { kind: "none" }
  | { kind: "income" | "expense"; amount_sen: number };

/**
 * Rule 19: reconciliation adjustments are ordinary transactions, never
 * balance overwrites. Plan the adjustment that moves current to stated.
 */
export function planReconciliation(
  current_sen: number,
  stated_sen: number,
): ReconciliationPlan {
  const diff = stated_sen - current_sen;
  if (diff === 0) return { kind: "none" };
  const amount_sen = Math.abs(diff);
  assertSen(amount_sen);
  return { kind: diff > 0 ? "income" : "expense", amount_sen };
}

export type ReconcileResult = { ok: true } | { ok: false; error: string };

/**
 * Reconcile an account to a stated balance by inserting an adjustment
 * transaction for the difference (nothing when already equal).
 */
export async function performReconcile(
  supabase: SupabaseClient,
  accountId: string,
  statedBalance: string,
  categoryId: string,
): Promise<ReconcileResult> {
  const statedSen = parseAmountToSen(statedBalance);
  if (statedSen === null) {
    return { ok: false, error: "balance must be a ringgit amount like 248.64" };
  }

  const [{ data, error }, acctRes] = await Promise.all([
    supabase.from("account_balances").select("balance_sen").eq("account_id", accountId).maybeSingle(),
    supabase.from("accounts").select("currency").eq("id", accountId).maybeSingle(),
  ]);
  if (error) return { ok: false, error: error.message };
  if (acctRes.error) return { ok: false, error: acctRes.error.message };
  if (!data || !acctRes.data) return { ok: false, error: "account not found" };
  // Ruling 7: reconciliation stays allowed on non-MYR accounts (its
  // adjustment carries source "reconcile"); amounts and the note speak the
  // ACCOUNT's own currency.
  const currency = acctRes.data.currency as string;

  // Boundary conversion: sum() is Postgres numeric; PostgREST may serialize
  // it as a string (see src/db/queries.ts).
  const plan = planReconciliation(Number(data.balance_sen), statedSen);
  if (plan.kind === "none") return { ok: true };

  const { error: insErr } = await supabase.from("transactions").insert({
    type: plan.kind,
    amount_sen: plan.amount_sen,
    account_id: accountId,
    category_id: categoryId,
    source: "reconcile",
    note: `Reconciled to ${formatCcy(currency, statedSen)}`,
  });
  if (insErr) return { ok: false, error: insErr.message };
  return { ok: true };
}
