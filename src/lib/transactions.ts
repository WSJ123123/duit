import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatSen, parseAmountToSen } from "@/lib/money";

export type TxType = "expense" | "income" | "transfer";

/** Matches the `transactions.source` check constraint (20260815191057_transactions.sql). */
export const TX_SOURCES = ["manual", "nl", "shortcut", "recurring", "import", "reconcile"] as const;
export type TxSource = (typeof TX_SOURCES)[number];

export interface TxInput {
  id?: string;
  type: TxType;
  amount: string;
  accountId: string;
  transferAccountId?: string;
  /** Cross-currency transfers only (Task 5, ruling 7): the amount that
   *  actually arrived, in the DESTINATION account's minor units. Required
   *  when the two accounts' currencies differ; ignored (stored null) when
   *  they match — null = same-currency is the storage contract. */
  received?: string;
  categoryId?: string;
  date: string;
  note?: string;
  expectedBack?: string;
  splits?: Array<{ categoryId: string; amount: string }>;
  /** Defaults to "manual" (the DB default) when omitted — existing callers are unaffected. */
  source?: TxSource;
  /** Defaults to false when omitted — existing callers are unaffected. */
  needsReview?: boolean;
  /** Plan 7 ruling 7: an expense paid out of a sinking fund. Form-only —
   *  the parser, /api/quick-entry, the Shortcut and the recurring
   *  materializer never set it. Omitted (or absent) ⇒ stored null, so an
   *  edit that leaves it out CLEARS the tag: the form must therefore carry
   *  the existing fund back, and does. */
  fundId?: string;
  /** Plan 7 ruling 14: the recurring rule whose occurrence this entry
   *  records. Set ONLY by the Bills page's `Record now`, alongside the
   *  materializer's deterministic `id`.
   *
   *  ⚠ Deliberately NOT shaped like `fundId`. A fund tag is a user-editable
   *  field on every expense form, so it must round-trip explicitly or an
   *  edit surface would silently clear it. A recurring link is PROVENANCE —
   *  no form ever sets or clears it — so the honest contract is
   *  "absent ⇒ leave the column alone": `recurring_rule_id` is omitted from
   *  the row entirely when this is undefined, which means editing the amount
   *  of a materialized variable bill cannot un-record it. */
  recurringRuleId?: string;
  /** Plan 8 ruling 11: the import batch that wrote this entry. Set ONLY by
   *  the import's commit (source "import"); provenance, so it takes the
   *  recurring link's shape — absent ⇒ the column is not mentioned. */
  importBatchId?: string;
}

/** DB-row-shaped transaction (public.transactions insert/update payload). */
export interface TxRow {
  id?: string;
  type: TxType;
  amount_sen: number;
  account_id: string;
  transfer_account_id: string | null;
  received_sen: number | null;
  category_id: string | null;
  date: string;
  note: string;
  source: TxSource;
  needs_review: boolean;
  expected_back_sen: number;
  fund_id: string | null;
  /** Optional KEY, not a nullable value (see TxInput.recurringRuleId): when
   *  it is absent the update statement never mentions the column. */
  recurring_rule_id?: string;
  /** Optional KEY like recurring_rule_id (see TxInput.importBatchId). */
  import_batch_id?: string;
}

/** DB-row-shaped split (transaction_id is attached at insert time). */
export interface SplitRow {
  category_id: string;
  amount_sen: number;
}

export type TxValidationResult =
  | { ok: true; value: TxRow; splits: SplitRow[] }
  | { ok: false; error: string };

const txInputSchema = z.object({
  id: z.uuid().optional(),
  type: z.enum(["expense", "income", "transfer"]),
  amount: z.string(),
  accountId: z.string().min(1),
  transferAccountId: z.string().min(1).optional(),
  received: z.string().optional(),
  categoryId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  note: z.string().optional(),
  expectedBack: z.string().optional(),
  splits: z
    .array(z.object({ categoryId: z.string().min(1), amount: z.string() }))
    .optional(),
  source: z.enum(TX_SOURCES).optional(),
  needsReview: z.boolean().optional(),
  fundId: z.string().min(1).optional(),
  recurringRuleId: z.uuid().optional(),
  importBatchId: z.uuid().optional(),
});

/** Ruling 6's refusal, worded to name the rule and the fix (Plan 8 Smoke
 *  Minor B). One string, used at input time here and by performUpdate's
 *  written-row backstop (c) — the two must never describe the rule differently. */
const FUND_OWED_BACK_MESSAGE =
  "A fund can't pay an expense that has money owed back — clear the expected-back amount first";

export function validateTransactionInput(input: TxInput): TxValidationResult {
  const parsed = txInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first ? first.message : "invalid transaction input" };
  }
  const v = parsed.data;

  const amountSen = parseAmountToSen(v.amount);
  if (amountSen === null || amountSen <= 0) {
    return { ok: false, error: "amount must be a positive ringgit amount like 12.34" };
  }

  if (v.type === "transfer") {
    if (!v.transferAccountId) {
      return { ok: false, error: "transfer requires a destination account" };
    }
    if (v.transferAccountId === v.accountId) {
      return { ok: false, error: "transfer destination must differ from source" };
    }
    // Transfers are never income/expense: no category, no reimbursement, no splits.
    if (v.categoryId !== undefined) {
      return { ok: false, error: "transfers cannot have a category" };
    }
    if (v.expectedBack !== undefined) {
      return { ok: false, error: "expectedBack is only allowed on expenses" };
    }
    if (v.splits !== undefined && v.splits.length > 0) {
      return { ok: false, error: "splits are only allowed on expenses" };
    }
  } else if (v.transferAccountId !== undefined) {
    return { ok: false, error: "only transfers can have a destination account" };
  }
  if (v.received !== undefined && v.type !== "transfer") {
    return { ok: false, error: "a received amount is only allowed on transfers" };
  }
  let receivedSen: number | null = null;
  if (v.received !== undefined) {
    receivedSen = parseAmountToSen(v.received);
    if (receivedSen === null || receivedSen <= 0) {
      return { ok: false, error: "received must be a positive amount like 12.34" };
    }
  }

  let expectedBackSen = 0;
  if (v.expectedBack !== undefined) {
    if (v.type !== "expense") {
      return { ok: false, error: "expectedBack is only allowed on expenses" };
    }
    const parsedBack = parseAmountToSen(v.expectedBack);
    if (parsedBack === null) {
      return { ok: false, error: "expectedBack must be a valid ringgit amount" };
    }
    if (parsedBack > amountSen) {
      return { ok: false, error: "expectedBack cannot exceed the amount" };
    }
    expectedBackSen = parsedBack;
  }

  // Fund tagging (Plan 7). The lib backstop under the table CHECK
  // `fund_id is null or type = 'expense'`, plus ruling 6's refusal of the
  // combination the product has no coherent meaning for.
  if (v.fundId !== undefined) {
    if (v.type !== "expense") {
      return { ok: false, error: "only an expense can be paid from a fund" };
    }
    if (expectedBackSen > 0) {
      return { ok: false, error: FUND_OWED_BACK_MESSAGE };
    }
  }

  const splitRows: SplitRow[] = [];
  if (v.splits !== undefined && v.splits.length > 0) {
    if (v.type !== "expense") {
      return { ok: false, error: "splits are only allowed on expenses" };
    }
    let sum = 0;
    for (const s of v.splits) {
      const sen = parseAmountToSen(s.amount);
      if (sen === null || sen <= 0) {
        return { ok: false, error: "each split must be a positive ringgit amount" };
      }
      sum += sen;
      splitRows.push({ category_id: s.categoryId, amount_sen: sen });
    }
    if (sum !== amountSen) {
      return { ok: false, error: "splits must sum to the total" };
    }
  }

  const row: TxRow = {
    ...(v.id !== undefined ? { id: v.id } : {}),
    type: v.type,
    amount_sen: amountSen,
    account_id: v.accountId,
    transfer_account_id: v.type === "transfer" ? v.transferAccountId! : null,
    received_sen: receivedSen,
    category_id: v.categoryId ?? null,
    date: v.date,
    note: v.note ?? "",
    source: v.source ?? "manual",
    needs_review: v.needsReview ?? false,
    expected_back_sen: expectedBackSen,
    fund_id: v.fundId ?? null,
    ...(v.recurringRuleId !== undefined ? { recurring_rule_id: v.recurringRuleId } : {}),
    ...(v.importBatchId !== undefined ? { import_batch_id: v.importBatchId } : {}),
  };
  return { ok: true, value: row, splits: splitRows };
}

export type TxWriteResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Plan 8 ruling 11: the INSERT path also reports whether it wrote. `created`
 * is false only on the 23505 branch — a retry that found the row already
 * there — so a caller can tell a no-op from a write off the write path
 * itself, never off a pre-flight read of its own (Q11b's `Record now` notice;
 * Task 6's import skip count). Additive: a `TxWriteResult` consumer ignores it.
 */
export type TxUpsertResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; error: string };

/**
 * Task 5 currency guards (ruling 7), checked inside the caller's RLS session
 * BEFORE any write:
 * - income/expense on a non-MYR account is rejected unless the row is a
 *   reconciliation adjustment (source "reconcile") — non-MYR accounts carry
 *   transfers + reconcile deltas only; their sen never enter budget math.
 * - transfers: when the two accounts' currencies differ, `received` (the
 *   destination's minor-unit amount) is REQUIRED; when they match it is
 *   forced to null — null = same-currency is the storage shape (Task 1).
 * - Plan 7 ruling 8: a `fund_id` on a non-MYR account is rejected outright,
 *   ahead of (not inside) the reconcile exemption — a fund balance is MYR
 *   sen, and this account's amount_sen are another currency's minor units.
 *   The table CHECK cannot see the account's currency, so this layer must.
 * Returns an error string, or null after normalizing row.received_sen. An
 * account id this session cannot see is left to the FK/RLS failure on write.
 *
 * ⚠ SCOPE: this is the choke point for the two FORM/ACTION write paths only
 * (performUpsert, performUpdate). It is not universal. The repo's other four
 * transaction writers — performQuickEntry and materializeDueRules (admin
 * client, own guards), performReconcile and performRecordLiabilityPayment —
 * keep fund_id off their rows BY CONSTRUCTION: each builds a fixed row
 * literal with no fund key and accepts no fund from its caller. Add a fifth
 * writer ⇒ re-run that enumeration before assuming this function covers it.
 */
async function applyCurrencyRules(supabase: SupabaseClient, row: TxRow): Promise<string | null> {
  const ids = [row.account_id, ...(row.transfer_account_id ? [row.transfer_account_id] : [])];
  const { data, error } = await supabase.from("accounts").select("id, currency").in("id", ids);
  if (error) return error.message;
  const byId = new Map(
    (data as Array<{ id: string; currency: string }>).map((a) => [a.id, a.currency]),
  );
  const srcCur = byId.get(row.account_id);
  if (srcCur === undefined) return null;

  if (row.type !== "transfer") {
    if (srcCur !== "MYR") {
      if (row.fund_id !== null) {
        return `Paying from a fund is MYR-only — this account is in ${srcCur}, and a fund balance is ringgit.`;
      }
      if (row.source !== "reconcile") {
        return `This account is in ${srcCur} — only transfers and reconciliation entries are allowed on it.`;
      }
    }
    return null;
  }

  const dstCur = row.transfer_account_id ? byId.get(row.transfer_account_id) : undefined;
  if (dstCur === undefined) return null;
  if (srcCur === dstCur) {
    row.received_sen = null; // same-currency: destination receives amount_sen
    return null;
  }
  if (row.received_sen === null) {
    return `Enter the amount received in ${dstCur} — the two accounts use different currencies.`;
  }
  return null;
}

/**
 * Plan 8 ruling 5 — EDIT-PATH INTEGRITY GUARDS LIVE HERE. Ruling 6 (a fund
 * can't pay an expense that has money owed back) must hold at every write,
 * not just the first, and two of its three edit-time forms need Σ recorded
 * `reimbursement_payments` for the row — a query — so none of them can live
 * in the pure validateTransactionInput. Updates are FULL-REPLACE: a TxInput
 * is the whole row, and an omitted fundId writes fund_id null (the form's
 * "None" omits the key; see validateTransactionInput's `fund_id: v.fundId ??
 * null`). So every guard judges the row that will be WRITTEN — nothing is
 * merged from the stored row, which is why "fund → None + add owed-back" is
 * one coherent save. Σ payments is read inside the caller's RLS session and
 * the write is refused when:
 *   (b) the written row carries a fund_id while any payment is recorded —
 *       checked FIRST, because a row with a recorded payback can never
 *       become fund-paid whatever else the patch says;
 *   (a) expected_back_sen would go below Σ payments — a settled
 *       reimbursement stays settled: the money really came back to an
 *       account, so the floor is exactly Σ payments, never 0. A cleared
 *       field writes 0, which is exactly the lowering this guard exists for;
 *   (c) the written row carries both a fund_id and expected_back_sen > 0 —
 *       ruling 6 itself. validateTransactionInput already refuses this
 *       combination at input time, and performUpdate always runs it first,
 *       so (c) is NOT a reachable branch through performUpdate: it is kept
 *       here by design as the durable backstop beside (a) and (b), so a
 *       future caller that hands this function a row without passing
 *       validateTransactionInput still cannot write the pair.
 * The only exit from (b) is removing the payment rows, which is the
 * reimbursement feature's affair, not this guard's. The next edit-path guard
 * goes here. Returns an error string, or null.
 */
async function applyEditGuards(
  supabase: SupabaseClient,
  id: string,
  row: TxRow,
): Promise<string | null> {
  const paymentsRes = await supabase
    .from("reimbursement_payments")
    .select("amount_sen")
    .eq("transaction_id", id);
  if (paymentsRes.error) return paymentsRes.error.message;
  let paid = 0;
  for (const p of paymentsRes.data as Array<{ amount_sen: number }>) paid += p.amount_sen;

  if (row.fund_id !== null && paid > 0) {
    return `A fund can't pay an expense that has already been paid back — ${formatSen(paid)} came back to an account, not to a fund. Save it without the fund.`;
  }
  if (row.expected_back_sen < paid) {
    return `Owed-back can't go below ${formatSen(paid)} — ${formatSen(paid)} has already been paid back`;
  }
  if (row.fund_id !== null && row.expected_back_sen > 0) {
    return FUND_OWED_BACK_MESSAGE;
  }
  return null;
}

/**
 * Insert a transaction (+ splits). Idempotent: a duplicate-pk (23505) on the
 * transaction insert means a retry of an already-committed entry — treated as
 * success and nothing else is written (splits were handled by the first call).
 * If a split insert fails, the just-inserted transaction is deleted
 * (compensating cleanup) so no partial entry remains.
 */
export async function performUpsert(
  supabase: SupabaseClient,
  input: TxInput,
): Promise<TxUpsertResult> {
  const validated = validateTransactionInput(input);
  if (!validated.ok) return validated;
  const currencyError = await applyCurrencyRules(supabase, validated.value);
  if (currencyError) return { ok: false, error: currencyError };

  const { data, error } = await supabase
    .from("transactions")
    .insert(validated.value)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505" && input.id !== undefined) {
      return { ok: true, id: input.id, created: false }; // idempotent retry: row already exists
    }
    return { ok: false, error: error.message };
  }

  const id: string = data.id;
  if (validated.splits.length > 0) {
    const { error: splitError } = await supabase
      .from("transaction_splits")
      .insert(validated.splits.map((s) => ({ ...s, transaction_id: id })));
    if (splitError) {
      // Compensating cleanup: never leave a half-written entry behind.
      await supabase.from("transactions").delete().eq("id", id);
      return { ok: false, error: splitError.message };
    }
  }
  return { ok: true, id, created: true };
}

/**
 * Explicit edit: validate, apply the currency and edit-path guards, update
 * the transaction row in place, then replace its splits (delete + reinsert).
 */
export async function performUpdate(
  supabase: SupabaseClient,
  id: string,
  input: TxInput,
): Promise<TxWriteResult> {
  const validated = validateTransactionInput(input);
  if (!validated.ok) return validated;
  const currencyError = await applyCurrencyRules(supabase, validated.value);
  if (currencyError) return { ok: false, error: currencyError };
  const guardError = await applyEditGuards(supabase, id, validated.value);
  if (guardError) return { ok: false, error: guardError };

  // Plan 9 Q27: `source` is provenance and survives every edit — the update
  // never writes it (the create path still sets it), so an ordinary form
  // edit cannot rewrite `import` (or `nl`, `shortcut`, `recurring`) to
  // `manual`. Undo's "edited" check is `updated_at = created_at`, unaffected.
  const { id: _ignored, source: _source, ...fields } = validated.value;
  void _ignored;
  void _source;
  const { data, error } = await supabase
    .from("transactions")
    .update(fields)
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "transaction not found" };

  const { error: deleteError } = await supabase
    .from("transaction_splits")
    .delete()
    .eq("transaction_id", id);
  if (deleteError) return { ok: false, error: deleteError.message };

  if (validated.splits.length > 0) {
    const { error: splitError } = await supabase
      .from("transaction_splits")
      .insert(validated.splits.map((s) => ({ ...s, transaction_id: id })));
    if (splitError) return { ok: false, error: splitError.message };
  }
  return { ok: true, id };
}

/** Hard delete (allowed for transactions); splits cascade via FK. */
export async function performDelete(
  supabase: SupabaseClient,
  id: string,
): Promise<TxWriteResult> {
  const { error } = await supabase.from("transactions").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, id };
}
