import type { SupabaseClient } from "@supabase/supabase-js";
import { v5 as uuidv5 } from "uuid";

/**
 * Fixed namespace for deterministic recurring-transaction ids (rule 14).
 *
 * Exported for Plan 7 ruling 14's `Record now`, which must write the SAME
 * `uuidv5(`${rule.id}:${date}`)` this materializer would have written — if the
 * two ever diverged the occurrence would never flip to `recorded` and the cron
 * would insert a second copy. There is exactly one declaration of this
 * constant: import it, never re-declare it.
 */
export const RECURRING_NAMESPACE = "9f2c1a34-7b6d-4e2f-8a1c-5d3e9b0f4a67";

export interface RecurringSchedule {
  freq: "monthly" | "weekly" | "yearly";
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
}

function daysInMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the next month is this month's last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Pure date math on ISO yyyy-mm-dd strings — "after" is always a parameter,
 * never the wall clock. Returns the strictly next occurrence after `after`.
 * Monthly/yearly target days clamp to the target month's last day (a day-31
 * rule runs Sep 30 then Oct 31; a Feb 29 rule runs Feb 28 in non-leap years).
 */
export function nextRunAfter(rule: RecurringSchedule, after: string): string {
  const y = Number(after.slice(0, 4));
  const m = Number(after.slice(5, 7));
  const d = Number(after.slice(8, 10));

  switch (rule.freq) {
    case "monthly": {
      const year = m === 12 ? y + 1 : y;
      const month = m === 12 ? 1 : m + 1;
      const day = Math.min(rule.day_of_month!, daysInMonth(year, month));
      return toIso(year, month, day);
    }
    case "weekly": {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      const delta = ((rule.weekday! - dow) % 7 + 7) % 7 || 7;
      const next = new Date(Date.UTC(y, m - 1, d + delta));
      return toIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    }
    case "yearly": {
      const year = y + 1;
      const month = rule.month_of_year!;
      const day = Math.min(rule.day_of_month!, daysInMonth(year, month));
      return toIso(year, month, day);
    }
  }
}

interface RecurringRuleRow extends RecurringSchedule {
  id: string;
  user_id: string;
  name: string;
  type: "expense" | "income" | "transfer";
  amount_sen: number;
  variable: boolean;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  next_run: string;
}

export interface MaterializeResult {
  /** Transactions actually inserted (double-fires re-insert nothing). */
  inserted: number;
  /** One line per rule the currency guard refused to materialize. */
  skipped: string[];
}

/**
 * Materialize every active rule (all users — service-role client) whose
 * next_run is due, catching up one occurrence at a time until next_run passes
 * `today`. Transaction ids are deterministic (uuidv5 of `${rule.id}:${date}`),
 * so re-runs and double-fires are no-ops (23505 = already materialized).
 *
 * CURRENCY GUARD (ruling 16). This runs with the ADMIN client, outside the
 * action layer, so `applyCurrencyRules` never sees these writes — the same
 * class of hole the quick-entry path had to be hardened against. A rule's
 * `amount_sen` was entered as MYR, so materializing it into a foreign-currency
 * account would mint corrupt minor units. Any rule whose `account_id` or
 * `transfer_account_id` is not a MYR account is therefore SKIPPED whole, with
 * `next_run` left exactly where it was, and reported in `skipped`. Skipping,
 * never converting.
 *
 * Leaving `next_run` stale is deliberate: the occurrence keeps reappearing and
 * shows up in the product as a `blocked` bill under the Bills page's *Needs
 * attention* (ruling 11a) — that is what satisfies rule 15, not the cron's
 * `errors[]` line, which is the operator's copy. Between that guard and the
 * account-currency lock in `performSetAccountCurrency`, this state should be
 * unreachable: if a skip is ever reported, that is a finding.
 */
export async function materializeDueRules(
  admin: SupabaseClient,
  today: string,
): Promise<MaterializeResult> {
  const { data, error } = await admin
    .from("recurring_rules")
    .select(
      "id, user_id, name, type, amount_sen, variable, account_id, transfer_account_id, category_id, freq, day_of_month, weekday, month_of_year, next_run",
    )
    .eq("active", true)
    .lte("next_run", today);
  if (error) throw error;

  const rules = (data ?? []) as RecurringRuleRow[];

  // One query for the whole due set, not one per rule.
  const accountIds = new Set<string>();
  for (const rule of rules) {
    accountIds.add(rule.account_id);
    if (rule.transfer_account_id !== null) accountIds.add(rule.transfer_account_id);
  }
  const currencyById = new Map<string, string>();
  if (accountIds.size > 0) {
    const { data: accounts, error: acctErr } = await admin
      .from("accounts")
      .select("id, currency")
      .in("id", [...accountIds]);
    if (acctErr) throw acctErr;
    for (const account of accounts ?? []) {
      currencyById.set(account.id as string, account.currency as string);
    }
  }

  let inserted = 0;
  const skipped: string[] = [];
  for (const rule of rules) {
    // Fail closed: an id the select did not resolve is not MYR either. Source
    // leg before destination leg, and both skip reasons are worded to match
    // `blockAssessment`'s pass 1 in src/lib/bills.ts byte for byte — the
    // operator's errors[] copy and the owner's Needs-attention row must never
    // describe the same rule differently. ⚠ This guard is also what that
    // function's `cron_materializes` mirrors: `archived` is deliberately NOT
    // tested here (an archived MYR account's rule IS materialized), so adding
    // a condition to this loop means adding it to pass 1 there too.
    const legs =
      rule.transfer_account_id === null
        ? [{ id: rule.account_id, label: "account" }]
        : [
            { id: rule.account_id, label: "account" },
            { id: rule.transfer_account_id, label: "destination account" },
          ];
    const foreignLeg = legs.find((leg) => currencyById.get(leg.id) !== "MYR");
    if (foreignLeg !== undefined) {
      const currency = currencyById.get(foreignLeg.id);
      skipped.push(
        currency === undefined
          ? `${rule.id}: its ${foreignLeg.label} no longer exists`
          : `${rule.id}: ${currency} account — a MYR rule cannot be materialized into it`,
      );
      continue;
    }

    let nextRun = rule.next_run;
    while (nextRun <= today) {
      const { error: insErr } = await admin.from("transactions").insert({
        id: uuidv5(`${rule.id}:${nextRun}`, RECURRING_NAMESPACE),
        user_id: rule.user_id, // service role bypasses RLS: set owner explicitly
        type: rule.type,
        amount_sen: rule.amount_sen,
        account_id: rule.account_id,
        transfer_account_id: rule.transfer_account_id,
        category_id: rule.category_id,
        date: nextRun,
        // Plan 8 (Session-13 smoke Info): the rule's name, matching `Record
        // now` — a materialised row is never a blank line in the list.
        note: rule.name,
        source: "recurring",
        needs_review: rule.variable,
        recurring_rule_id: rule.id,
      });
      if (insErr && insErr.code !== "23505") throw insErr;
      if (!insErr) inserted += 1;

      nextRun = nextRunAfter(rule, nextRun);
      const { error: updErr } = await admin
        .from("recurring_rules")
        .update({ next_run: nextRun })
        .eq("id", rule.id);
      if (updErr) throw updErr;
    }
  }
  return { inserted, skipped };
}
