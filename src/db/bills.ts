import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccountsWithBalances } from "@/db/queries";
import { fetchAllPages, PAGE_SIZE } from "@/db/paging";
import {
  addDaysIso,
  classifyOccurrences,
  dueSoon,
  enumerateOccurrences,
  minIso,
  projectBalance,
  recordNowTxId,
  recoverRecordedOccurrences,
  type AccountLike,
  type BillRule,
  type Occurrence,
  type Projection,
} from "@/lib/bills";

/**
 * Bills & projected cashflow query layer (Plan 7 Task 5). Runs under the
 * caller's RLS session client — the admin client is never imported here.
 *
 * Ruling 11: there is no bill record. Every row below is an occurrence of an
 * existing recurring rule composed with `src/lib/bills.ts`; the only thing
 * this module reads from `transactions` is the exact `(recurring_rule_id,
 * date)` pairs that mark an occurrence recorded.
 *
 * ⚠ The two halves of the filtering differ, deliberately:
 * - the SPENDABLE BASE (ruling 12) sums only non-archived MYR accounts of
 *   type bank / ewallet / cash — the money that actually pays a bill.
 * - OCCURRENCES on ANY account are enumerated and then classified. An
 *   occurrence is `blocked` (never silently dropped) when its account is
 *   non-MYR or archived, and an occurrence on a HEALTHY non-spendable MYR
 *   account — a brokerage top-up transfer, a broker fee — is exactly ruling
 *   12's boundary-crossing case and must reach the projection.
 *   Never filter occurrences by account before classification.
 */

/** Ruling 12: the account types whose cash actually pays a bill. */
const SPENDABLE_TYPES = new Set(["bank", "ewallet", "cash"]);

const RULE_COLUMNS =
  "id, name, type, amount_sen, variable, account_id, transfer_account_id, category_id, freq, day_of_month, weekday, month_of_year, next_run, active";

/**
 * The one read here whose row count is not bounded by a hand-created entity —
 * the recurring-rule transactions inside the window — is paged (finding #19;
 * the loop lives in src/db/paging.ts).
 */
/** An occurrence with its display names and its `Record now` id resolved. */
export interface BillRow extends Occurrence {
  account_name: string;
  transfer_account_name: string | null;
  category_name: string | null;
  /** Ruling 14: the deterministic id `Record now` will write for this occurrence. */
  record_id: string;
}

/**
 * Q11a: a Paid row, carrying the figure that actually left the account.
 * `amount_sen` stays the RULE's template — the row shows both when they
 * differ, which for a variable bill is the normal case.
 */
export interface RecordedBillRow extends BillRow {
  recorded_amount_sen: number;
  recorded_tx_id: string;
}

/** Ruling 11a: listed under Needs attention, never as an ordinary bill. */
export interface BlockedBillRow extends BillRow {
  reason: string;
  /** True when the cron still materializes it (the archived axis) — the row
   *  says so, because "needs attention" and "counted in the projection" must
   *  never be silently contradictory. */
  cron_materializes: boolean;
}

/**
 * One `Due soon` row. Ruling 11a's clause reaches the dashboard too: an
 * occurrence the cron will materialize but whose rule is misconfigured must
 * NEVER read as an ordinary bill, on either surface. It is not excluded — that
 * would leave the rows failing to reconcile with the total beside them — it is
 * MARKED, with the same reason and the same "Fix rule" destination the Bills
 * page's Needs-attention row carries.
 */
export interface DueSoonRow extends BillRow {
  /** Non-null exactly when this occurrence is a `blocked` one (ruling 11a). */
  blocked_reason: string | null;
}

/** Ruling 13's dashboard payload, with display names resolved. */
export interface DueSoonRows {
  bills: DueSoonRow[];
  total_sen: number;
  count: number;
  next_income: DueSoonRow | null;
}

/** Ruling 11: transfer occurrences are listed separately and are not bills. */
export interface TransferBillRow extends BillRow {
  state: "upcoming" | "overdue" | "recorded";
  /** True when this transfer moves the projection (ruling 12's boundary). */
  crosses_spendable: boolean;
  /** Q13: the transaction a `recorded` row was recorded by; null otherwise. */
  recorded_tx_id: string | null;
}

export interface BillsData {
  today: string;
  /** Enumeration window start — see `getBills` for why it is not always today. */
  from: string;
  to: string;
  window_days: number;
  has_active_rules: boolean;

  /**
   * The five lists PARTITION every enumerated occurrence PLUS every recovered
   * recorded one (question 12: an occurrence the cron materialized and
   * advanced `next_run` past is rebuilt from its transaction, or it would
   * vanish from the page the moment the bill was paid) — each appears in
   * exactly one of them:
   * - `upcoming` / `overdue` / `recorded`: expense and income occurrences.
   * - `blocked`: every type (a blocked transfer rule needs attention too).
   * - `transfers`: the non-blocked transfer occurrences, with their state.
   */
  upcoming: BillRow[];
  overdue: BillRow[];
  recorded: RecordedBillRow[];
  blocked: BlockedBillRow[];
  transfers: TransferBillRow[];

  /** Ruling 12's base, and the account names it summed (the functional sub-line). */
  spendable_base_sen: number;
  spendable_accounts: string[];
  /** Non-archived accounts left OUT of the base — 0 means the sub-line's
   *  "excluded" clause would be noise and the page drops it. */
  excluded_account_count: number;

  projection: Projection;
  due_soon: DueSoonRows;

  /** Strip figures (mockup v6 §8), all built from the same `live` set the
   *  projection consumes — so the strip, the chart and the dashboard card can
   *  never describe different money. A bill drawn on a healthy non-spendable
   *  MYR account IS counted here (it is still money leaving, it just does not
   *  move spendable cash); a blocked occurrence is counted only when the cron
   *  is still going to materialize it (see `live`). */
  due_7_sen: number;
  due_7_count: number;
  due_window_sen: number;
  due_window_count: number;
  due_window_variable_count: number;
  income_window_sen: number;
  income_window_count: number;
  overdue_sen: number;
  /** Rows behind `overdue_sen` — same array, so the pair cannot drift. */
  overdue_count: number;
  /** Income minus bills across the window — the Upcoming card's foot line. */
  net_window_sen: number;
  /**
   * Ruling 7's `Paid from a fund` disclosure (mockup v6 §8's Watch row), read
   * RETROSPECTIVELY: bills already recorded inside this window that carry a
   * fund tag. It cannot be forward-looking — no recurring rule holds a
   * `fund_id`, and ruling 7 keeps the materializer from ever writing one — but
   * `Record now` opens the ordinary form WITH the fund picker, so a scheduled
   * bill really can be paid from a fund, and this is the figure that says so.
   * Money already spent, never a forecast; the card's sub-line says which.
   */
  fund_paid_sen: number;
  fund_paid_count: number;
}

interface RecordedTxRow {
  /** Q11a: the Paid row points at the transaction it was recorded by. */
  id: string;
  recurring_rule_id: string;
  date: string;
  amount_sen: number;
  fund_id: string | null;
}

interface RuleRow {
  id: string;
  name: string;
  type: "expense" | "income" | "transfer";
  amount_sen: number;
  variable: boolean;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  freq: "monthly" | "weekly" | "yearly";
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
  next_run: string;
  active: boolean;
}

/**
 * Everything mockup v6 §8 / §10 phone 2 render plus ruling 13's dashboard
 * card, in ONE composed read (the `getNetWorth` / `getFunds` shape): parallel
 * queries joined in TypeScript, so no page issues a second query.
 *
 * `windowDays` is the projection horizon (30 / 60 / 90 on the page).
 * `pageSize` is the page-request hint for the one paged read; callers leave
 * it alone — it is a parameter so a test can request more than the server's
 * cap and prove the result does not move.
 */
export async function getBills(
  supabase: SupabaseClient,
  todayIso: string,
  windowDays: number = 30,
  pageSize: number = PAGE_SIZE,
): Promise<BillsData> {
  const toIso = addDaysIso(todayIso, windowDays);

  // Deliberately UNPAGED, the `getFunds` reasoning: recurring rules are
  // hand-created and do not grow the way transactions do. `next_run` is not
  // unique, so `id` makes the order total in case this is ever paged.
  const rulesRes = await supabase
    .from("recurring_rules")
    .select(RULE_COLUMNS)
    .eq("active", true)
    .order("next_run")
    .order("id");
  if (rulesRes.error) throw rulesRes.error;
  const rules = (rulesRes.data ?? []) as RuleRow[];

  // ⚠ The enumeration window starts at the EARLIEST unmaterialized
  // occurrence, not at today. `enumerateOccurrences` seeds every walk from
  // `rule.next_run`, and an occurrence at or after `next_run` is by
  // construction one the cron has NOT materialized — so anything between the
  // stalest `next_run` and today is exactly the overdue set. Starting at
  // today instead would make `overdue` structurally unreachable and hide a
  // rule that ruling 16's currency skip left stale on purpose.
  const fromIso = minIso(todayIso, ...rules.map((r) => r.next_run));

  const [accounts, categoriesRes, recordedTx] = await Promise.all([
    getAccountsWithBalances(supabase),
    supabase.from("categories").select("id, name"),
    // `amount_sen, fund_id` ride along for ruling 7's `Paid from a fund`
    // disclosure (F3) — two extra columns on a select this function already
    // runs, never a second query. `id` joins them for Q11a: the Paid row
    // renders THIS transaction's amount, so it has to be able to name it.
    fetchAllPages<RecordedTxRow>(
      (from, to) =>
        supabase
          .from("transactions")
          .select("id, recurring_rule_id, date, amount_sen, fund_id")
          .not("recurring_rule_id", "is", null)
          .gte("date", fromIso)
          .lte("date", toIso)
          // LOAD-BEARING: `date` alone is not unique. `id` (the primary key)
          // makes the paged order TOTAL — without it rows can repeat or
          // vanish between pages (finding #19).
          .order("date")
          .order("id")
          .range(from, to),
      pageSize,
    ),
  ]);
  if (categoriesRes.error) throw categoriesRes.error;

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const categoryNameById = new Map(
    (categoriesRes.data as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );

  const spendable = accounts.filter(
    (a) => !a.archived && a.currency === "MYR" && SPENDABLE_TYPES.has(a.type),
  );
  const spendableIds = spendable.map((a) => a.id);
  const spendableIdSet = new Set(spendableIds);
  const spendable_base_sen = spendable.reduce((sum, a) => sum + a.balance_sen, 0);

  const accountLikes: AccountLike[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    archived: a.archived,
  }));

  const billRules: BillRule[] = rules.map((r) => ({ ...r }));
  const occurrences = enumerateOccurrences(billRules, fromIso, toIso);
  const classified = classifyOccurrences(occurrences, recordedTx, accountLikes, todayIso);

  /**
   * Question 12 (Session 12): occurrences the cron has materialized AND
   * advanced `next_run` past are unreachable by enumeration — without this
   * they vanished from the page at the moment the bill was paid. Rebuilt from
   * their transactions; disjoint from `classified.recorded` by construction
   * (recovery accepts only dates BEFORE `next_run`, enumeration only emits at
   * or after it), merged into the one recorded list every surface below
   * renders. Display-only history: never handed to the projection, `dueSoon`
   * or any strip figure — the money is already inside the balances.
   */
  const recovered = recoverRecordedOccurrences(billRules, recordedTx, fromIso, toIso);
  const allRecorded = [...classified.recorded, ...recovered].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.name.localeCompare(b.name) ||
      a.rule_id.localeCompare(b.rule_id),
  );

  const toRow = (o: Occurrence): BillRow => ({
    ...o,
    account_name: accountById.get(o.account_id)?.name ?? "—",
    transfer_account_name: o.transfer_account_id
      ? (accountById.get(o.transfer_account_id)?.name ?? "—")
      : null,
    category_name: o.category_id ? (categoryNameById.get(o.category_id) ?? null) : null,
    record_id: recordNowTxId(o.rule_id, o.date),
  });

  const isBill = (o: Occurrence) => o.type !== "transfer";
  const upcoming = classified.upcoming.filter(isBill).map(toRow);
  const overdue = classified.overdue.filter(isBill).map(toRow);
  const recorded: RecordedBillRow[] = allRecorded.filter(isBill).map((o) => ({
    ...toRow(o),
    recorded_amount_sen: o.recorded_amount_sen,
    recorded_tx_id: o.recorded_tx_id,
  }));
  const blocked: BlockedBillRow[] = classified.blocked.map((o) => ({
    ...toRow(o),
    reason: o.reason,
    cron_materializes: o.cron_materializes,
  }));

  // Q13: a transfer row carries its recorded transaction's id (the section
  // links to it, as a Paid bill row does) but not the recorded amount — the
  // transfer section renders no amount comparison.
  const isTransfer = (o: Occurrence) => o.type === "transfer";
  const toTransfer = (
    o: Occurrence,
    state: TransferBillRow["state"],
    recorded_tx_id: string | null,
  ): TransferBillRow => ({
    ...toRow(o),
    state,
    crosses_spendable:
      spendableIdSet.has(o.account_id) !==
      (o.transfer_account_id !== null && spendableIdSet.has(o.transfer_account_id)),
    recorded_tx_id,
  });
  const transfers: TransferBillRow[] = [
    ...classified.overdue.filter(isTransfer).map((o) => toTransfer(o, "overdue", null)),
    ...classified.upcoming.filter(isTransfer).map((o) => toTransfer(o, "upcoming", null)),
    ...allRecorded.filter(isTransfer).map((o) => toTransfer(o, "recorded", o.recorded_tx_id)),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));

  /**
   * The money set: every occurrence the cron is going to materialize that is
   * not already recorded. `recorded` is already inside `spendable_base_sen`,
   * so counting it again would understate the low point.
   *
   * ⚠ `blocked` is filtered on `cron_materializes`, NOT dropped wholesale.
   * Ruling 11a excludes blocked occurrences because "blocked is not going to
   * happen" — true on the currency and unresolvable-account axes, where
   * ruling 16's guard leaves `next_run` stale on purpose, and FALSE on the
   * archived axis, which that guard does not test at all. An active rule
   * transferring MYR into a now-archived MYR account is materialized by the
   * cron every month and the cash really moves; dropping it overstated the low
   * point by that amount every single month. It stays in `blocked` (so it is
   * never rendered as an ordinary upcoming bill — ruling 11a's other clause)
   * and its Needs-attention row says which kind it is.
   */
  const live = [
    ...classified.overdue,
    ...classified.upcoming,
    ...classified.blocked.filter((o) => o.cron_materializes),
  ];
  const projection = projectBalance(spendable_base_sen, live, spendableIds, todayIso, toIso);
  const dueSoonPayload = dueSoon(live, todayIso, 7);
  // Ruling 11a on the dashboard: `live` deliberately carries the blocked
  // occurrences the cron will still materialize, so every row the card renders
  // has to be able to say so. Keyed on the same (rule, date) pair everything
  // else in this module matches on.
  const blockedReasonByKey = new Map(
    classified.blocked.map((o) => [`${o.rule_id}:${o.date}`, o.reason] as const),
  );
  const toDueSoonRow = (o: Occurrence): DueSoonRow => ({
    ...toRow(o),
    blocked_reason: blockedReasonByKey.get(`${o.rule_id}:${o.date}`) ?? null,
  });
  const due_soon: DueSoonRows = {
    bills: dueSoonPayload.bills.map(toDueSoonRow),
    total_sen: dueSoonPayload.total_sen,
    count: dueSoonPayload.count,
    next_income: dueSoonPayload.next_income ? toDueSoonRow(dueSoonPayload.next_income) : null,
  };

  const liveBills = live.filter((o) => o.type === "expense");
  const liveIncome = live.filter((o) => o.type === "income");
  const sevenDayCutoff = addDaysIso(todayIso, 7);
  const dueSeven = liveBills.filter((o) => o.date <= sevenDayCutoff);
  const sum = (list: Occurrence[]) => list.reduce((total, o) => total + o.amount_sen, 0);

  const overdueBills = liveBills.filter((o) => o.date < todayIso);
  const due_window_sen = sum(liveBills);
  const income_window_sen = sum(liveIncome);
  // Rule-linked AND fund-tagged: the read above is already filtered to
  // `recurring_rule_id is not null` and the table CHECK makes any fund-tagged
  // row an expense, so this pair is the whole condition.
  const fundPaid = recordedTx.filter((t) => t.fund_id !== null);

  return {
    today: todayIso,
    from: fromIso,
    to: toIso,
    window_days: windowDays,
    has_active_rules: rules.length > 0,
    upcoming,
    overdue,
    recorded,
    blocked,
    transfers,
    spendable_base_sen,
    spendable_accounts: spendable.map((a) => a.name),
    excluded_account_count: accounts.filter((a) => !a.archived && !spendableIdSet.has(a.id)).length,
    projection,
    due_soon,
    due_7_sen: sum(dueSeven),
    due_7_count: dueSeven.length,
    due_window_sen,
    due_window_count: liveBills.length,
    due_window_variable_count: liveBills.filter((o) => o.variable).length,
    income_window_sen,
    income_window_count: liveIncome.length,
    // From `live`, not `classified.overdue`: a past-dated occurrence the cron
    // will still materialize is overdue money too (see `live`'s note). The
    // COUNT ships beside the amount and is derived from the SAME array — a
    // renderer counting `overdue` while showing this total printed "1 past its
    // date" next to two items' worth of money.
    overdue_sen: sum(overdueBills),
    overdue_count: overdueBills.length,
    net_window_sen: income_window_sen - due_window_sen,
    fund_paid_sen: fundPaid.reduce((total, t) => total + t.amount_sen, 0),
    fund_paid_count: fundPaid.length,
  };
}
