"use client";

import Link from "next/link";
import { Button } from "@/components/Button";
import { TxFormSheet } from "@/components/TxFormSheet";
import type { BillFormOptions } from "@/components/BillsTable";
import type { BillRow } from "@/db/bills";
import { recordedTxHref } from "@/lib/bills-display";

/**
 * Ruling 14's only write: prefilled from the occurrence, amount editable.
 * Q13: a transfer occurrence comes through unchanged — `type` opens the sheet
 * on the transfer tab with both legs prefilled, same id, same write path.
 *
 * ⚠ Rendered for RECORDED rows too, with the entry link as its trigger (Q11a's
 * renderer). The Q11b notice lives inside the sheet, and the action's
 * revalidation re-renders the Bills page while the sheet is still open — that
 * is the moment a stale row flips to recorded. Swapping the cell's element
 * type there unmounts the sheet, notice and all, and the edited amount is
 * dropped silently again; one component per row, keyed by the row, keeps the
 * sheet mounted across the flip. A client module because the trigger is a
 * render function, which a Server Component cannot hand to `TxFormSheet`.
 */
export function RecordNow({
  row,
  form,
  recordedTxId,
}: {
  row: BillRow;
  form: BillFormOptions;
  recordedTxId: string | null;
}) {
  return (
    <TxFormSheet
      mode="create"
      accounts={form.accounts}
      categories={form.categories}
      funds={form.funds}
      todayStr={form.todayStr}
      prefill={{
        id: row.record_id,
        recurring_rule_id: row.rule_id,
        rule_name: row.name,
        type: row.type,
        amount_sen: row.amount_sen,
        account_id: row.account_id,
        transfer_account_id: row.transfer_account_id,
        category_id: row.category_id,
        date: row.date,
      }}
      triggerLabel="Record now"
      renderTrigger={(onClick) =>
        recordedTxId !== null ? (
          <RecordedEntryLink txId={recordedTxId} date={row.date} />
        ) : (
          <Button type="button" variant="secondary" className="px-2 py-1 text-xs" onClick={onClick}>
            Record now
          </Button>
        )
      }
    />
  );
}

/** Q11a's `recorded_tx_id` renderer: a recorded row points at the transaction
 *  it was recorded by — the same target the Q11b notice links to. */
export function RecordedEntryLink({ txId, date }: { txId: string; date: string }) {
  return (
    <Link
      href={recordedTxHref(txId, date)}
      className="whitespace-nowrap text-xs font-medium"
      style={{ color: "var(--accent)" }}
    >
      View entry →
    </Link>
  );
}
