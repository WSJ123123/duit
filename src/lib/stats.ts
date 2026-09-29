/**
 * Pure reporting/aggregation helpers — the single home for "net spend" money
 * math. No clock, no I/O; integer sen arithmetic only.
 *
 * Money contract:
 * - Net spending for an expense = amount_sen − expected_back_sen.
 * - Transfers are never income or expense; income never counts as spend.
 */

export type TxLike = {
  id: string;
  type: "expense" | "income" | "transfer";
  amount_sen: number;
  expected_back_sen: number;
  category_id: string | null;
  date: string;
};

export type SplitLike = {
  transaction_id: string;
  category_id: string;
  amount_sen: number;
};

/** Net expense contribution of a row: amount − expected_back for expenses, 0 otherwise. */
export function netExpenseSen(tx: {
  type: "expense" | "income" | "transfer";
  amount_sen: number;
  expected_back_sen: number;
}): number {
  return tx.type === "expense" ? tx.amount_sen - tx.expected_back_sen : 0;
}

/**
 * Net expense sen per category. Expenses only; split rows REPLACE the parent
 * transaction's category attribution. Reimbursement netting applies
 * proportionally to splits, remainder-safe in integer sen: each split's share
 * is floor(split * net / amount) except the LAST split, which absorbs the
 * rounding remainder so the per-transaction sum is exactly amount − expected_back.
 */
export function spendByCategory(
  tx: TxLike[],
  splits: SplitLike[],
): Map<string | null, number> {
  const splitsByTx = new Map<string, SplitLike[]>();
  for (const s of splits) {
    const list = splitsByTx.get(s.transaction_id);
    if (list) {
      list.push(s);
    } else {
      splitsByTx.set(s.transaction_id, [s]);
    }
  }

  const totals = new Map<string | null, number>();
  const add = (key: string | null, sen: number): void => {
    totals.set(key, (totals.get(key) ?? 0) + sen);
  };

  for (const t of tx) {
    if (t.type !== "expense") continue;
    const net = t.amount_sen - t.expected_back_sen;
    const txSplits = splitsByTx.get(t.id);
    if (txSplits === undefined || txSplits.length === 0) {
      add(t.category_id, net);
      continue;
    }
    // Proportional netting, integer-exact: floor each share, last absorbs remainder.
    let allocated = 0;
    for (let i = 0; i < txSplits.length; i++) {
      const s = txSplits[i]!;
      const share =
        i === txSplits.length - 1
          ? net - allocated
          : Math.floor((s.amount_sen * net) / t.amount_sen);
      allocated += share;
      add(s.category_id, share);
    }
  }
  return totals;
}

/**
 * Per-month income vs net expense. Months are "YYYY-MM" KL-date prefixes
 * (tx.date is already a KL date string); output preserves the given order.
 */
export function incomeVsExpense(
  tx: TxLike[],
  months: string[],
): Array<{ month: string; income_sen: number; expense_sen: number }> {
  const byMonth = new Map<string, { income_sen: number; expense_sen: number }>();
  for (const month of months) {
    byMonth.set(month, { income_sen: 0, expense_sen: 0 });
  }
  for (const t of tx) {
    const bucket = byMonth.get(t.date.slice(0, 7));
    if (bucket === undefined) continue;
    if (t.type === "income") {
      bucket.income_sen += t.amount_sen;
    } else if (t.type === "expense") {
      bucket.expense_sen += t.amount_sen - t.expected_back_sen;
    }
    // transfers excluded
  }
  return months.map((month) => ({ month, ...byMonth.get(month)! }));
}

/** Net expense sen for a single KL day. */
export function todayTotal(tx: TxLike[], todayIso: string): number {
  let total = 0;
  for (const t of tx) {
    if (t.date !== todayIso) continue;
    total += netExpenseSen(t);
  }
  return total;
}
