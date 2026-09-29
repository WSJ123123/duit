import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAccountCurrency } from "@/lib/account-form";

/**
 * Account write helpers beyond the inline settings actions (Task 5, ruling
 * 7). Plain "perform*" function so DB tests can exercise it; the "use
 * server" action in settings/accounts/actions.ts wraps it. Runs under the
 * caller's RLS session client.
 */

export type AccountWriteResult = { ok: true } | { ok: false; error: string };

async function countRows(
  supabase: SupabaseClient,
  table: string,
  column: string,
  accountId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, accountId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Change a brokerage account's currency — allowed ONLY while the account has
 * zero balance-moving activity AND a zero starting balance, re-checked
 * server-side inside this RLS session immediately before the write (like a
 * holding's symbol, the currency is fixed once money moved in it: historical
 * sen are minor units of the currency they were entered in).
 */
export async function performSetAccountCurrency(
  supabase: SupabaseClient,
  accountId: string,
  currency: string,
): Promise<AccountWriteResult> {
  if (!isAccountCurrency(currency)) {
    return { ok: false, error: "Choose a currency from the list." };
  }

  const acctRes = await supabase
    .from("accounts")
    .select("id, type, starting_balance_sen")
    .eq("id", accountId)
    .maybeSingle();
  if (acctRes.error) return { ok: false, error: acctRes.error.message };
  if (!acctRes.data) return { ok: false, error: "account not found" };
  if (currency !== "MYR" && acctRes.data.type !== "brokerage") {
    return { ok: false, error: "Only brokerage accounts can hold a foreign currency." };
  }

  try {
    // RULE (final form) — what locks an account's currency, and why.
    // Every sen figure attached to an account is stored bare: it is a minor
    // unit of whatever currency the ACCOUNT row happens to say. Re-currency
    // the account after one of them exists and all of them are silently
    // re-read in the new currency — permanently, including into net-worth
    // snapshots, which are never recomputed. So this guard must enumerate
    // ALL THREE groups:
    //   (a) every reference the `account_balances` view sums — transactions
    //       on BOTH legs, reimbursement_payments, trades,
    //       business_investment_entries;
    //   (b) recurring rules on BOTH legs — they hold no sen yet, but the
    //       cron's ADMIN materializer turns them into (a) later, bypassing
    //       applyCurrencyRules entirely (it carries its own currency guard
    //       for that same reason);
    //   (c) the account's own `starting_balance_sen` — the one recorded
    //       amount no reference count can structurally reach, because it
    //       lives on the account row itself. Checked right below the counts,
    //       with its own message so the owner knows which condition bit.
    // Add a term to the view, or a new writer ⇒ add it here. This
    // enumeration has already shipped incomplete once (reimbursement_payments,
    // caught in review as a Critical); an uncounted reference is exactly how
    // recorded sen get re-denominated.
    // The counts and the write are two statements, not one: a reference
    // inserted between them is not seen. That check-then-write race is
    // ACCEPTED single-user exposure (Plan 8, Session-12 Minor 3) — the only
    // writer is the owner, in one session; no lock is built (rule 24).
    const counts = await Promise.all([
      countRows(supabase, "transactions", "account_id", accountId),
      countRows(supabase, "transactions", "transfer_account_id", accountId),
      countRows(supabase, "reimbursement_payments", "account_id", accountId),
      countRows(supabase, "trades", "account_id", accountId),
      countRows(supabase, "business_investment_entries", "account_id", accountId),
      countRows(supabase, "recurring_rules", "account_id", accountId),
      countRows(supabase, "recurring_rules", "transfer_account_id", accountId),
    ]);
    if (counts.reduce((sum, n) => sum + n, 0) > 0) {
      return {
        ok: false,
        error:
          "Currency is locked: this account already has activity (its amounts are minor units of the current currency).",
      };
    }
    // (c) — costs nothing in practice: currency and starting balance are set
    // together in one INSERT at creation, so this only bites when
    // re-currencying an already-funded account. The message states the
    // CONDITION, never an instruction: `starting_balance_sen` is write-once at
    // createAccount and no edit control for it exists anywhere in the app, so
    // "set it to zero" would name an affordance the owner does not have.
    if (Number(acctRes.data.starting_balance_sen ?? 0) !== 0) {
      return {
        ok: false,
        error:
          "Currency is locked: this account has a starting balance (it is a recorded amount in minor units of the current currency). Only an account whose starting balance is zero can change currency.",
      };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "currency check failed" };
  }

  const { data, error } = await supabase
    .from("accounts")
    .update({ currency })
    .eq("id", accountId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "account not found" };
  return { ok: true };
}

/**
 * Plan 8 ruling 2: an account with an ACTIVE recurring rule on either leg
 * cannot be archived — the cron would keep materializing into it, and the
 * account's archived state would be a lie about money still moving. The
 * refusal names the rules (data, not a Tip) in the Recurring settings page's
 * order so the owner can deactivate or re-point them; inactive rules do not
 * block. Same check-then-write exposure as performSetAccountCurrency above,
 * accepted for the same reason.
 */
export async function performArchiveAccount(
  supabase: SupabaseClient,
  accountId: string,
): Promise<AccountWriteResult> {
  const idParsed = z.uuid().safeParse(accountId);
  if (!idParsed.success) return { ok: false, error: "invalid account id" };
  const id = idParsed.data;

  const rulesRes = await supabase
    .from("recurring_rules")
    .select("name")
    .eq("active", true)
    .or(`account_id.eq.${id},transfer_account_id.eq.${id}`)
    .order("name");
  if (rulesRes.error) return { ok: false, error: rulesRes.error.message };
  const names = (rulesRes.data as Array<{ name: string }>).map((r) => r.name);
  if (names.length > 0) {
    const n = names.length;
    return {
      ok: false,
      error: `Archive blocked: ${n} active rule${n === 1 ? " uses" : "s use"} this account — ${names.join(", ")}. Deactivate or re-point ${n === 1 ? "it" : "them"} first.`,
    };
  }

  const { data, error } = await supabase
    .from("accounts")
    .update({ archived: true })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "account not found" };
  return { ok: true };
}
