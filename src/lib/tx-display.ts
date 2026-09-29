import type { TxType } from "@/lib/transactions";
import type { ExistingTx } from "@/components/TxFormSheet";

/**
 * Pure display helpers for transaction rows. Plain module (no "use client")
 * so BOTH server components (dashboard) and client components (TransactionRow,
 * ActivityList) can call them — client-module exports can only be rendered
 * from the server, never invoked.
 */

export interface TxDisplayRow {
  id: string;
  type: TxType;
  amount_sen: number;
  account_id: string;
  transfer_account_id: string | null;
  /** Cross-currency transfers: destination-currency amount; null = same-currency. */
  received_sen: number | null;
  category_id: string | null;
  date: string;
  note: string;
  source: string;
  needs_review: boolean;
  expected_back_sen: number;
  /** Plan 7 ruling 7: the fund this expense was paid from, or null. Required
   *  (not optional) on purpose — every edit surface must carry it back into
   *  the form, or saving would clear the tag and move a fund balance with no
   *  trace of why. */
  fund_id: string | null;
  paid_sen: number;
  splits: Array<{ category_id: string; amount_sen: number }>;
}

/** A TxDisplayRow with account/category names already resolved server-side. */
export interface EnrichedTxRow extends TxDisplayRow {
  accountName: string;
  /** amount_sen is minor units of THIS currency (the source account's) —
   *  amount cells render it with its code (ruling 7 honest display). */
  accountCurrency: string;
  transferAccountName: string | null;
  categoryName: string | null;
}

export function dateLabel(date: string, today: string, yesterday: string): string {
  if (date === today) return "Today";
  if (date === yesterday) return "Yesterday";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Category chip text: "Transfer", the resolved category name, or a split count. */
export function categoryLabelFor(row: EnrichedTxRow): string {
  return row.type === "transfer"
    ? "Transfer"
    : row.categoryName ?? (row.splits.length > 0 ? `Split (${row.splits.length})` : "—");
}

/**
 * The fund a tagged expense was paid from — `from Emergency fund`, or null on
 * an untagged row (owner's Task-3 audit call: "Yes, show the label").
 *
 * Keyed on the TAG, never on the resolved option: a surface that has no fund
 * list still says the row was paid from a fund, because the alternative is a
 * row that looks like ordinary spending while drawing a fund down. Archived
 * funds resolve normally — `getFundOptions` returns them (ruling 9a) — so
 * `from a fund` is the fallback for a list rendered without the prop, not the
 * archived case.
 */
export function fundLabelFor(
  fundId: string | null,
  funds: Array<{ id: string; name: string }>,
): string | null {
  if (fundId === null) return null;
  const fund = funds.find((f) => f.id === fundId);
  return fund ? `from ${fund.name}` : "from a fund";
}

/** Account text: "From → To" for transfers, else the account name. */
export function accountLabelFor(row: EnrichedTxRow): string {
  return row.type === "transfer" && row.transferAccountName
    ? `${row.accountName} → ${row.transferAccountName}`
    : row.accountName;
}

export function existingTxFrom(row: EnrichedTxRow): ExistingTx {
  return {
    id: row.id,
    type: row.type,
    amount_sen: row.amount_sen,
    account_id: row.account_id,
    transfer_account_id: row.transfer_account_id,
    received_sen: row.received_sen,
    category_id: row.category_id,
    date: row.date,
    note: row.note,
    needs_review: row.needs_review,
    expected_back_sen: row.expected_back_sen,
    fund_id: row.fund_id,
    splits: row.splits,
  };
}
