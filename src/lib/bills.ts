/**
 * Pure bills & cashflow math (Plan 7 Task 5, rulings 11 / 11a / 12 / 13).
 * No I/O and no clock: every date is a parameter. Integer sen throughout.
 *
 * A bill is DERIVED — there is no bill record. Every row here is an
 * occurrence of an existing recurring rule, matched against an existing
 * transaction by the materializer's exact `(recurring_rule_id, date)` pair.
 *
 * ⚠ `nextRunAfter` is NOT a general "next occurrence after any date"
 * function: for monthly/yearly it advances one month/year from the date it is
 * GIVEN and clamps the day. Seeding a walk from the window start therefore
 * silently drops the occurrence inside the current month (a day-15 rule
 * seeded at 2026-09-01 returns 2026-10-15 and loses 15 Sep). Every walk in
 * this module seeds from `rule.next_run` and steps forward.
 *
 * Occurrences strictly before `next_run` are ones the cron (or a `Record now`
 * the cron later caught up with) has already materialized — the walk cannot
 * reach them, but their TRANSACTIONS carry the exact `(rule, date)` pair, so
 * `recoverRecordedOccurrences` rebuilds them from those rows and they render
 * `recorded ✓` like any other recorded occurrence. Without that recovery a
 * bill the 06:00 cron wrote would VANISH from the page at the moment it was
 * paid (Session 12, architect question 12 — owner-ruled fixed 2026-08-31).
 */

import { v5 as uuidv5 } from "uuid";
import { nextRunAfter, RECURRING_NAMESPACE, type RecurringSchedule } from "@/lib/recurring";
import { assertSen } from "@/lib/money";

/**
 * Ruling 14: the id `Record now` writes for one occurrence — byte-identical
 * to the one `materializeDueRules` would have written, because both call
 * `uuidv5` over the same string with the SAME imported namespace constant.
 * That identity is the whole idempotence story: whichever path writes first,
 * the other one hits `performUpsert`'s existing 23505 no-op branch.
 */
export function recordNowTxId(ruleId: string, dateIso: string): string {
  return uuidv5(`${ruleId}:${dateIso}`, RECURRING_NAMESPACE);
}

export type BillType = "expense" | "income" | "transfer";

/** A `recurring_rules` row, exactly the columns the bill view reads. */
export interface BillRule extends RecurringSchedule {
  id: string;
  name: string;
  type: BillType;
  amount_sen: number;
  variable: boolean;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  next_run: string;
  active: boolean;
}

/** One dated instance of a rule. Carries the rule's payload so nothing below
 *  has to go back to the rule list. */
export interface Occurrence {
  rule_id: string;
  name: string;
  type: BillType;
  amount_sen: number;
  variable: boolean;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  date: string;
}

/**
 * Defensive cap on ONE rule's walk. Every `nextRunAfter` branch advances
 * strictly, so a well-formed rule terminates at `toIso` on its own; this
 * bound exists so a malformed rule (a monthly rule with a null day, say)
 * cannot spin. 1000 steps is ~19 years of the fastest cadence (weekly), which
 * is far past any window this product asks for while still being finite.
 */
export const MAX_OCCURRENCE_STEPS = 1000;

/**
 * Every occurrence of every ACTIVE rule with `fromIso <= date <= toIso`.
 *
 * Seeded from `rule.next_run` (see the module header). A rule whose
 * `next_run` is behind `fromIso` is walked forward to the window; a rule
 * whose `next_run` is past `toIso` contributes nothing. The result is one
 * ascending list across all rules (date, then rule name, then rule id — a
 * TOTAL order, so the list is stable regardless of input order).
 */
export function enumerateOccurrences(
  rules: BillRule[],
  fromIso: string,
  toIso: string,
): Occurrence[] {
  const out: Occurrence[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    let date = rule.next_run;
    for (let step = 0; step < MAX_OCCURRENCE_STEPS && date <= toIso; step += 1) {
      if (date >= fromIso) {
        out.push({
          rule_id: rule.id,
          name: rule.name,
          type: rule.type,
          amount_sen: rule.amount_sen,
          variable: rule.variable,
          account_id: rule.account_id,
          transfer_account_id: rule.transfer_account_id,
          category_id: rule.category_id,
          date,
        });
      }
      const next = nextRunAfter(rule, date);
      if (next <= date) break; // a non-advancing rule would otherwise spin
      date = next;
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.name.localeCompare(b.name) ||
      a.rule_id.localeCompare(b.rule_id),
  );
}

/**
 * The recorded occurrences enumeration can no longer reach: transactions in
 * `[fromIso, toIso]` whose `(rule, date)` pair sits strictly BEFORE the rule's
 * `next_run` — i.e. the cron has materialized them and advanced past them.
 * Rebuilt from the rule's payload with the transaction's date, exactly the
 * shape `enumerateOccurrences` would have produced.
 *
 * Disjoint from enumeration BY CONSTRUCTION: enumeration only emits dates at
 * or after `next_run`, recovery only accepts dates before it — so merging the
 * two can never render an occurrence twice. `date >= next_run` transactions
 * (the `Record now` shape, where `next_run` has not advanced yet) are left to
 * enumeration + `classifyOccurrences`, which already marks them `recorded`.
 *
 * These rows are display-only history: they are already inside every account
 * balance, so they must never be handed to `projectBalance`/`dueSoon` (see
 * those contracts) and they enter no strip figure.
 */
export function recoverRecordedOccurrences(
  rules: BillRule[],
  transactions: RecordedTxLike[],
  fromIso: string,
  toIso: string,
): RecordedOccurrence[] {
  const ruleById = new Map(rules.filter((r) => r.active).map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: RecordedOccurrence[] = [];
  for (const tx of transactions) {
    const rule = ruleById.get(tx.recurring_rule_id);
    if (rule === undefined) continue;
    if (tx.date < fromIso || tx.date > toIso || tx.date >= rule.next_run) continue;
    const key = `${rule.id}:${tx.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rule_id: rule.id,
      name: rule.name,
      type: rule.type,
      amount_sen: rule.amount_sen,
      variable: rule.variable,
      account_id: rule.account_id,
      transfer_account_id: rule.transfer_account_id,
      category_id: rule.category_id,
      date: tx.date,
      // Q11a: the money that actually moved, beside the rule's template.
      recorded_amount_sen: tx.amount_sen,
      recorded_tx_id: tx.id,
    });
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.name.localeCompare(b.name) ||
      a.rule_id.localeCompare(b.rule_id),
  );
}

/** The account columns a classification decision reads. */
export interface AccountLike {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
}

/** The transaction columns ruling 11's exact match reads. */
export interface RecordedTxLike {
  /** Q11a: the row points at the transaction it was recorded by. */
  id: string;
  recurring_rule_id: string;
  date: string;
  /** Q11a: what ACTUALLY left the account, which for a variable bill is
   *  exactly the figure the rule's template does not hold. */
  amount_sen: number;
}

/**
 * Q11a: a recorded occurrence, carrying its transaction's real figure.
 *
 * `amount_sen` stays the RULE's template — the two are different facts and the
 * row shows both when they differ (`RM 175.50 · template RM 180`). Both
 * recorded lists produce this shape (`classifyOccurrences`'s `recorded` and
 * `recoverRecordedOccurrences`'s output), so no surface has to know which walk
 * a Paid row came from.
 */
export interface RecordedOccurrence extends Occurrence {
  recorded_amount_sen: number;
  recorded_tx_id: string;
}

/** Ruling 11a: a blocked occurrence carries the reason the owner has to act on,
 *  and whether the cron is still going to materialize it anyway. */
export interface BlockedOccurrence extends Occurrence {
  reason: string;
  /**
   * True when `materializeDueRules` will STILL write this occurrence — an
   * archived MYR account is a configuration problem, not a cron blocker
   * (ruling 16's guard skips on currency, never on `archived`). The money
   * really leaves, so a `cron_materializes` occurrence must reach the money
   * figures; see `projectBalance`'s and `dueSoon`'s contracts.
   */
  cron_materializes: boolean;
}

export interface ClassifiedOccurrences {
  recorded: RecordedOccurrence[];
  blocked: BlockedOccurrence[];
  overdue: Occurrence[];
  upcoming: Occurrence[];
}

/**
 * Why this occurrence needs the owner's attention, or null when nothing does.
 * The enumeration is exhaustive over both legs and over all three axes:
 * unresolvable account, non-MYR account, archived account — source leg before
 * destination leg, so the message names the leg to fix first.
 *
 * ⚠ TWO PASSES, and the split is load-bearing. `materializeDueRules` skips a
 * rule when a leg is non-MYR or unresolvable (fail closed) and **only** then;
 * `archived` is not in its guard, so an archived MYR account's rule really is
 * materialized and the money really leaves. So:
 *   pass 1 = the CRON-BLOCKING axes, mirroring that guard exactly. Whatever it
 *            finds, the cron will not write the occurrence.
 *   pass 2 = the ARCHIVED axis, reached only when pass 1 found nothing — the
 *            cron writes it, so it still counts everywhere money is counted.
 * A single pass would report "archived" for a rule whose OTHER leg is non-MYR
 * and then wrongly count it: the pass order is what keeps `cron_materializes`
 * true only when every leg is clean of the cron's guard.
 */
function blockAssessment(
  occurrence: Occurrence,
  accounts: Map<string, AccountLike>,
): { reason: string; cron_materializes: boolean } | null {
  const legs: Array<{ id: string; label: string }> = [
    { id: occurrence.account_id, label: "account" },
    ...(occurrence.transfer_account_id !== null
      ? [{ id: occurrence.transfer_account_id, label: "destination account" }]
      : []),
  ];

  // Pass 1 — the cron's own guard. Wording matches its errors[] skip lines.
  for (const leg of legs) {
    const account = accounts.get(leg.id);
    if (account === undefined) {
      return { reason: `its ${leg.label} no longer exists`, cron_materializes: false };
    }
    if (account.currency !== "MYR") {
      return {
        reason: `${account.name} is a ${account.currency} account — a MYR rule cannot be materialized into it`,
        cron_materializes: false,
      };
    }
  }

  // Pass 2 — every leg is MYR and resolvable, so the cron WILL materialize.
  for (const leg of legs) {
    const account = accounts.get(leg.id)!;
    if (account.archived) {
      return { reason: `${account.name} is archived`, cron_materializes: true };
    }
  }
  return null;
}

/**
 * Ruling 11's four states, assigned in this precedence:
 *
 * 1. **recorded** — a transaction exists with this rule id AND this exact
 *    date. Ruling 11's exact match; no fuzzy amount/date matching is ever
 *    introduced, in this plan or any later one. Reality wins over every other
 *    state: if the money moved, the occurrence happened.
 * 2. **blocked** — either leg's account is missing, archived or non-MYR
 *    (ruling 11a). Listed under Needs attention, NEVER as an ordinary bill.
 *    Whether it ALSO counts in the money figures is `cron_materializes`, not
 *    the state itself — an archived MYR leg still gets materialized, so its
 *    cash really moves (see `blockAssessment`).
 * 3. **overdue** — date < today, unrecorded, not blocked.
 * 4. **upcoming** — everything else (today's occurrence included).
 *
 * Returns the four groups, not a flag soup: every input occurrence lands in
 * exactly one of them.
 */
export function classifyOccurrences(
  occurrences: Occurrence[],
  transactions: RecordedTxLike[],
  accounts: AccountLike[],
  todayIso: string,
): ClassifiedOccurrences {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  // Q11a: the matched transaction, not just the fact that one exists — the
  // recorded row renders ITS amount. First writer wins on a repeated pair,
  // which is the same row `recoverRecordedOccurrences` keeps.
  const recordedByKey = new Map<string, RecordedTxLike>();
  for (const t of transactions) {
    const key = `${t.recurring_rule_id}:${t.date}`;
    if (!recordedByKey.has(key)) recordedByKey.set(key, t);
  }

  const result: ClassifiedOccurrences = { recorded: [], blocked: [], overdue: [], upcoming: [] };
  for (const occurrence of occurrences) {
    const recordedBy = recordedByKey.get(`${occurrence.rule_id}:${occurrence.date}`);
    if (recordedBy !== undefined) {
      result.recorded.push({
        ...occurrence,
        recorded_amount_sen: recordedBy.amount_sen,
        recorded_tx_id: recordedBy.id,
      });
      continue;
    }
    const blocked = blockAssessment(occurrence, accountById);
    if (blocked !== null) {
      result.blocked.push({ ...occurrence, ...blocked });
      continue;
    }
    if (occurrence.date < todayIso) {
      result.overdue.push(occurrence);
      continue;
    }
    result.upcoming.push(occurrence);
  }
  return result;
}

export interface ProjectionPoint {
  date: string;
  balance_sen: number;
}

export interface Projection {
  /** Step series over [fromIso, toIso]; always starts at fromIso and ends at toIso. */
  series: ProjectionPoint[];
  min_sen: number;
  min_date: string;
  end_sen: number;
  /** Ruling 12's uncertainty disclosure: the variable occurrences that
   *  actually MOVED the series, and their total. The count is the array
   *  length. */
  variable_occurrences: Occurrence[];
  variable_total_sen: number;
}

/**
 * Ruling 12's spendable-cash effect of one occurrence, in sen (signed).
 *
 * - expense: leaves the spendable set only if it is drawn on a spendable account.
 * - income: arrives only if it lands on a spendable account.
 * - transfer: moves the projection ONLY when it CROSSES the boundary. A
 *   transfer inside the spendable set nets to zero and must not be
 *   double-counted; one entirely outside it never touched spendable cash.
 *   Both legs are still MYR here by construction, but NOT because blocked
 *   occurrences cannot reach this function — since the archived-axis fix they
 *   can. It holds because `cron_materializes` is only ever true when every leg
 *   resolved AND was MYR (`blockAssessment` pass 1), so the occurrences the
 *   caller passes are exactly the MYR ones either way.
 */
function effectSen(occurrence: Occurrence, spendable: Set<string>): number {
  const fromSpendable = spendable.has(occurrence.account_id);
  switch (occurrence.type) {
    case "expense":
      return fromSpendable ? -occurrence.amount_sen : 0;
    case "income":
      return fromSpendable ? occurrence.amount_sen : 0;
    case "transfer": {
      const toSpendable =
        occurrence.transfer_account_id !== null && spendable.has(occurrence.transfer_account_id);
      if (fromSpendable === toSpendable) return 0;
      return fromSpendable ? -occurrence.amount_sen : occurrence.amount_sen;
    }
  }
}

/** Guarded exit for a figure that may legitimately be negative (an overdrawn
 *  projection). Same convention as src/lib/funds.ts's `toSigned`. */
function toSigned(n: number): number {
  assertSen(Math.abs(n));
  return n;
}

/**
 * The projected-spendable-cash step series and its low point.
 *
 * ⚠ **Pass exactly the occurrences the cron is going to materialize and that
 * are not already recorded** — `upcoming`, `overdue`, and the `blocked` ones
 * whose `cron_materializes` is true. A `recorded` occurrence is already inside
 * `startingSpendableSen` — counting it again understates the low point by its
 * amount every single day a bill lands. A `blocked` one is excluded ONLY when
 * the cron genuinely will not write it (the non-MYR and unresolvable-account
 * axes, ruling 16's guard); ruling 11a's "not going to happen" reasoning does
 * not reach the ARCHIVED axis, where the cron materializes normally and the
 * cash really leaves — dropping those overstated the low point by their amount
 * every month. This function deliberately does not re-derive the states: it
 * has no transaction list and no account list, and hiding the filter inside it
 * would let a caller believe the filtering happened when it did not.
 *
 * An occurrence dated before `fromIso` (an overdue one) steps the series at
 * `fromIso`: the money has not left yet, so it is still ahead of the owner.
 * An occurrence past `toIso` is dropped.
 */
export function projectBalance(
  startingSpendableSen: number,
  occurrences: Occurrence[],
  spendableAccountIds: string[],
  fromIso: string,
  toIso: string,
): Projection {
  const spendable = new Set(spendableAccountIds);

  const deltaByDate = new Map<string, number>();
  const variable_occurrences: Occurrence[] = [];
  let variable_total_sen = 0;

  for (const occurrence of occurrences) {
    if (occurrence.date > toIso) continue;
    const effect = effectSen(occurrence, spendable);
    if (effect === 0) continue;
    const date = occurrence.date < fromIso ? fromIso : occurrence.date;
    deltaByDate.set(date, (deltaByDate.get(date) ?? 0) + effect);
    if (occurrence.variable) {
      variable_occurrences.push(occurrence);
      variable_total_sen += occurrence.amount_sen;
    }
  }

  const series: ProjectionPoint[] = [{ date: fromIso, balance_sen: startingSpendableSen }];
  let balance = startingSpendableSen;
  let min_sen = startingSpendableSen;
  let min_date = fromIso;

  for (const date of [...deltaByDate.keys()].sort()) {
    const delta = deltaByDate.get(date)!;
    if (delta === 0) continue; // a same-day pair that nets out never steps
    balance += delta;
    series.push({ date, balance_sen: toSigned(balance) });
    if (balance < min_sen) {
      min_sen = balance;
      min_date = date;
    }
  }

  if (series[series.length - 1]!.date !== toIso) {
    series.push({ date: toIso, balance_sen: toSigned(balance) });
  }

  assertSen(variable_total_sen);
  return {
    series,
    min_sen: toSigned(min_sen),
    min_date,
    end_sen: toSigned(balance),
    variable_occurrences,
    variable_total_sen,
  };
}

export interface DueSoonPayload {
  /** Expense occurrences due within the window, overdue ones included. */
  bills: Occurrence[];
  total_sen: number;
  count: number;
  /** The earliest income occurrence in the given set — deliberately NOT
   *  limited to `days`, because "the next paycheque" is the useful figure
   *  even when it is three weeks out (mockup v6 §9 left fragment). */
  next_income: Occurrence | null;
}

/**
 * Ruling 13's dashboard payload. Same state filtering as the projection —
 * **pass exactly what `projectBalance` gets** (see its contract), so the card
 * and the low point can never describe different money. Transfers are not
 * bills (ruling 11), so they never enter the count or the total.
 */
export function dueSoon(occurrences: Occurrence[], todayIso: string, days: number): DueSoonPayload {
  const cutoff = addDaysIso(todayIso, days);
  const bills = occurrences
    .filter((o) => o.type === "expense" && o.date <= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const total_sen = bills.reduce((sum, b) => sum + b.amount_sen, 0);
  assertSen(total_sen);

  const incomes = occurrences
    .filter((o) => o.type === "income")
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  return { bills, total_sen, count: bills.length, next_income: incomes[0] ?? null };
}

/** ISO date + n days, UTC-anchored (the repo's date strings are calendar
 *  dates, never instants). */
export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The lexicographically smallest ISO date — dates are yyyy-mm-dd, so string
 *  order IS chronological order. */
export function minIso(...dates: string[]): string {
  return dates.reduce((min, d) => (d < min ? d : min));
}
