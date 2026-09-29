import type { SupabaseClient } from "@supabase/supabase-js";
import { nextRunAfter } from "@/lib/recurring";
import type { RecurringRuleValue } from "@/lib/recurring-form";

/**
 * Recurring-rule writes (Plan 9 ruling 10d). Moved verbatim out of
 * `src/app/(app)/settings/recurring/actions.ts`: every export of a
 * `"use server"` module is a callable endpoint (finding #20 in reverse),
 * and these helpers have no zod boundary of their own — the action wrappers
 * there validate the form and are the only callers.
 */

export type RecurringWriteResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Core insert. Initial `next_run` is the first occurrence strictly after
 * `todayIso` — the clock is read at the action boundary (see
 * `createRecurringRule`) and passed in here so this stays testable and
 * `nextRunAfter` itself stays pure date math (src/lib/recurring.ts).
 */
export async function performCreateRule(
  supabase: SupabaseClient,
  value: RecurringRuleValue,
  todayIso: string,
): Promise<RecurringWriteResult> {
  const nextRun = nextRunAfter(
    {
      freq: value.freq,
      day_of_month: value.day_of_month,
      weekday: value.weekday,
      month_of_year: value.month_of_year,
    },
    todayIso,
  );
  const { data, error } = await supabase
    .from("recurring_rules")
    .insert({ ...value, next_run: nextRun })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data.id };
}

/**
 * Core edit. Re-derives `next_run` from the (possibly changed) cadence, same
 * "strictly after today" rule as create — editing a rule restarts its
 * schedule from today rather than preserving a stale next_run computed under
 * the old cadence.
 */
export async function performUpdateRule(
  supabase: SupabaseClient,
  id: string,
  value: RecurringRuleValue,
  todayIso: string,
): Promise<RecurringWriteResult> {
  const nextRun = nextRunAfter(
    {
      freq: value.freq,
      day_of_month: value.day_of_month,
      weekday: value.weekday,
      month_of_year: value.month_of_year,
    },
    todayIso,
  );
  const { data, error } = await supabase
    .from("recurring_rules")
    .update({ ...value, next_run: nextRun })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "rule not found" };
  return { ok: true, id };
}

/**
 * Archive-only lifecycle: `active` flip, never DELETE (no delete grant on
 * this table). Plan 9 Q26: re-activating refuses while either leg's account
 * is archived, naming the rule and the account — the symmetric half of Plan 8
 * ruling 2 (an account with an active rule cannot be archived), so an active
 * rule never points at an archived account from either direction.
 */
export async function performSetActive(
  supabase: SupabaseClient,
  id: string,
  active: boolean,
): Promise<{ error?: string }> {
  if (active) {
    const ruleRes = await supabase
      .from("recurring_rules")
      .select("name, account_id, transfer_account_id")
      .eq("id", id)
      .maybeSingle();
    if (ruleRes.error) return { error: ruleRes.error.message };
    const rule = ruleRes.data as { name: string; account_id: string; transfer_account_id: string | null } | null;
    if (rule) {
      const legs = rule.transfer_account_id === null ? [rule.account_id] : [rule.account_id, rule.transfer_account_id];
      const acctRes = await supabase.from("accounts").select("name, archived").in("id", legs).order("name");
      if (acctRes.error) return { error: acctRes.error.message };
      const archived = (acctRes.data as Array<{ name: string; archived: boolean }>).filter((a) => a.archived).map((a) => a.name);
      if (archived.length > 0) {
        return {
          error: `Can't reactivate ${rule.name} — ${archived.join(" and ")} ${archived.length === 1 ? "is" : "are"} archived. Re-point the rule first.`,
        };
      }
    }
  }
  const { error } = await supabase.from("recurring_rules").update({ active }).eq("id", id);
  if (error) return { error: error.message };
  return {};
}
