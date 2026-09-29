import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAmountToSen } from "@/lib/money";
import { fetchAllPages } from "@/db/paging";

/** Remaining owed on a reimbursable expense: expected_back minus payments, never negative. */
export function computeOwed(
  tx: { expected_back_sen: number },
  payments: Array<{ amount_sen: number }>,
): number {
  const paid = payments.reduce((sum, p) => sum + p.amount_sen, 0);
  return Math.max(0, tx.expected_back_sen - paid);
}

/** Transaction row with its reimbursement payments, as fetched by getOpenReimbursements. */
export interface ReimbursableTxRow {
  id: string;
  note: string;
  date: string;
  expected_back_sen: number;
  payments: Array<{ amount_sen: number }>;
}

export interface OpenReimbursement {
  transaction_id: string;
  note: string;
  date: string;
  expected_back_sen: number;
  paid_sen: number;
  owed_sen: number;
}

/** Only rows still owed (> 0), newest first (date desc, transaction_id asc tiebreak). */
export function shapeOpenReimbursements(rows: ReimbursableTxRow[]): OpenReimbursement[] {
  return rows
    .map((r) => {
      const paid = r.payments.reduce((sum, p) => sum + p.amount_sen, 0);
      return {
        transaction_id: r.id,
        note: r.note,
        date: r.date,
        expected_back_sen: r.expected_back_sen,
        paid_sen: paid,
        owed_sen: computeOwed(r, r.payments),
      };
    })
    .filter((r) => r.owed_sen > 0)
    .sort((x, y) =>
      x.date === y.date
        ? x.transaction_id.localeCompare(y.transaction_id)
        : y.date.localeCompare(x.date),
    );
}

/**
 * Two reads + TS join, each PAGED on a total order (Plan 9 ruling 10b,
 * finding #19): a lifetime's reimbursable expenses and payments both grow
 * past PostgREST's 1000-row cap, and an unpaged read drops the newest ones
 * with HTTP 200 and no flag. Pinned at 1,200 rows in
 * src/db/transactions-page.test.ts.
 */
export async function getOpenReimbursements(
  supabase: SupabaseClient,
): Promise<OpenReimbursement[]> {
  const [txRows, payRows] = await Promise.all([
    fetchAllPages<{ id: string; note: string; date: string; expected_back_sen: number }>((from, to) =>
      supabase
        .from("transactions")
        .select("id, note, date, expected_back_sen")
        .gt("expected_back_sen", 0)
        .order("date")
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<{ transaction_id: string; amount_sen: number }>((from, to) =>
      supabase
        .from("reimbursement_payments")
        .select("transaction_id, amount_sen")
        .order("id")
        .range(from, to),
    ),
  ]);

  const paymentsByTx = new Map<string, Array<{ amount_sen: number }>>();
  for (const p of payRows) {
    const list = paymentsByTx.get(p.transaction_id) ?? [];
    list.push({ amount_sen: p.amount_sen });
    paymentsByTx.set(p.transaction_id, list);
  }

  const rows: ReimbursableTxRow[] = txRows.map((t) => ({ ...t, payments: paymentsByTx.get(t.id) ?? [] }));

  return shapeOpenReimbursements(rows);
}

export type ReimbursementResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Record a payment against a reimbursable expense. Rejects unparseable or
 * non-positive amounts and any payment larger than what is currently owed.
 */
export async function performRecordReimbursement(
  supabase: SupabaseClient,
  txId: string,
  accountId: string,
  amount: string,
): Promise<ReimbursementResult> {
  const amountSen = parseAmountToSen(amount);
  if (amountSen === null || amountSen <= 0) {
    return { ok: false, error: "amount must be a positive ringgit amount like 12.34" };
  }

  const [txRes, payRes] = await Promise.all([
    supabase
      .from("transactions")
      .select("id, expected_back_sen")
      .eq("id", txId)
      .maybeSingle(),
    supabase
      .from("reimbursement_payments")
      .select("amount_sen")
      .eq("transaction_id", txId),
  ]);
  if (txRes.error) return { ok: false, error: txRes.error.message };
  if (payRes.error) return { ok: false, error: payRes.error.message };
  if (!txRes.data) return { ok: false, error: "transaction not found" };

  const owed = computeOwed(
    txRes.data as { expected_back_sen: number },
    payRes.data as Array<{ amount_sen: number }>,
  );
  if (amountSen > owed) {
    return { ok: false, error: "payment is more than owed" };
  }

  const { data, error } = await supabase
    .from("reimbursement_payments")
    .insert({ transaction_id: txId, account_id: accountId, amount_sen: amountSen })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data.id };
}
