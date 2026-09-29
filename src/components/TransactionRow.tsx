"use client";

import { startTransition, useOptimistic, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Money, useMoney } from "@/components/Money";
import { deleteTransaction } from "@/app/(app)/transactions/actions";
import { TxFormSheet, type ExistingTx } from "@/components/TxFormSheet";
import type { FundOption } from "@/db/funds";
import { applyPatch, removeRow, type RowPatch, type OptimisticRowHandlers } from "@/lib/optimistic-entry";
import {
  dateLabel,
  categoryLabelFor,
  accountLabelFor,
  existingTxFrom,
  fundLabelFor,
  type EnrichedTxRow,
} from "@/lib/tx-display";

export type { TxDisplayRow, EnrichedTxRow } from "@/lib/tx-display";

interface AccountOption {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
}

interface CategoryOption {
  id: string;
  name: string;
  kind: "expense" | "income";
  archived: boolean;
}

const pillStyle = {
  background: "var(--chip)",
  color: "var(--ink-2)",
} as const;

type RowListAction = { kind: "patch"; patch: RowPatch } | { kind: "remove"; id: string };

function reduceRows(state: EnrichedTxRow[], action: RowListAction): EnrichedTxRow[] {
  return action.kind === "patch" ? applyPatch(state, action.patch) : removeRow(state, action.id);
}

interface TransactionRowsProps {
  rows: EnrichedTxRow[];
  todayStr: string;
  yesterdayStr: string;
  accounts: AccountOption[];
  categories: CategoryOption[];
  /** fx_rates rows for the edit sheet's cross-currency transfer prefill. */
  fxRates?: Array<{ pair: string; rate_e8: number; as_of: string }>;
  /** Ruling 7's fund picker on the edit sheet. */
  funds?: FundOption[];
  emptyLabel: string;
}

/**
 * Owns the desktop table body's optimistic state (Plan 3 Task 6). Each row's
 * edit sheet / delete dispatches through the `optimistic` handlers below,
 * which fold into this `useOptimistic` array via the pure
 * src/lib/optimistic-entry.ts helpers — same reducer shape ActivityList uses
 * for the mobile list. Renders `<tr>`s only; the caller keeps the `<tbody>`.
 */
export function TransactionRows({ rows, todayStr, yesterdayStr, accounts, categories, fxRates, funds, emptyLabel }: TransactionRowsProps) {
  const [optimisticRows, dispatch] = useOptimistic<EnrichedTxRow[], RowListAction>(rows, reduceRows);
  const [error, setError] = useState<string | null>(null);

  const optimistic: OptimisticRowHandlers = {
    patch: (patch) => dispatch({ kind: "patch", patch }),
    remove: (id) => dispatch({ kind: "remove", id }),
    settled: (ok) => setError(ok ? null : "Couldn't save — nothing was changed"),
  };

  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={6} className="py-4 text-center text-sm" style={{ color: "var(--ink-3)" }}>
          {emptyLabel}
        </td>
      </tr>
    );
  }

  const originalById = new Map(rows.map((r) => [r.id, r]));

  return (
    <>
      {error ? (
        // Rule 15: a failed edit/delete never fails silently. Tip-styled
        // (ink-3/critical, same visual register as the rest of the app's
        // inline errors) but NOT inside <Tip> — always visible regardless
        // of the tips-off setting.
        <tr>
          <td colSpan={6} className="px-2 py-2 text-sm font-medium" style={{ color: "var(--critical)" }}>
            {error}
          </td>
        </tr>
      ) : null}
      {optimisticRows.map((row) => (
        <TransactionRow
          key={row.id}
          row={row}
          pending={originalById.get(row.id) !== row}
          todayStr={todayStr}
          yesterdayStr={yesterdayStr}
          accounts={accounts}
          categories={categories}
          fxRates={fxRates}
          funds={funds}
          optimistic={optimistic}
        />
      ))}
    </>
  );
}

interface TransactionRowProps {
  row: EnrichedTxRow;
  pending?: boolean;
  todayStr: string;
  yesterdayStr: string;
  accounts: AccountOption[];
  categories: CategoryOption[];
  fxRates?: Array<{ pair: string; rate_e8: number; as_of: string }>;
  funds?: FundOption[];
  optimistic?: OptimisticRowHandlers;
}

export function TransactionRow({ row, pending, todayStr, yesterdayStr, accounts, categories, fxRates, funds, optimistic }: TransactionRowProps) {
  const router = useRouter();
  const { fmtCcy } = useMoney();
  const tx = row;
  const categoryLabel = categoryLabelFor(row);
  const accountLabel = accountLabelFor(row);
  // Owner's Task-3 audit call: a fund-paid expense must say so on the row —
  // it draws a fund down and is kept off the category limits, and until now
  // that was visible only inside the edit sheet.
  const fundLabel = fundLabelFor(row.fund_id, funds ?? []);
  const existingTx: ExistingTx = existingTxFrom(row);

  /** Same immediate-remove, dispatch-in-background shape as the sheet's
   *  handleDelete — the row-list owner's useOptimistic reverts on failure. */
  function handleDelete() {
    startTransition(async () => {
      optimistic?.remove(tx.id);
      const result = await deleteTransaction(tx.id);
      optimistic?.settled(result.ok);
      if (result.ok) router.refresh();
    });
  }

  return (
    <tr id={tx.id} style={{ borderBottom: "1px solid var(--grid)", opacity: pending ? 0.5 : 1 }}>
      <td className="py-2 px-2 text-sm font-medium" style={{ color: "var(--ink-1)" }}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{tx.note || "(no note)"}</span>
          {pending ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: "var(--chip)", color: "var(--ink-3)" }}
            >
              saving…
            </span>
          ) : null}
          {tx.needs_review ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: "color-mix(in srgb, var(--warning) 30%, var(--surface))", color: "var(--ink-1)" }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--warning)" }} />
              review
            </span>
          ) : null}
          {tx.source === "reconcile" ? (
            <span className="rounded-full px-2 py-0.5 text-[11px]" style={pillStyle}>
              reconciled
            </span>
          ) : null}
          {tx.expected_back_sen > 0 ? (
            <span className="rounded-full px-2 py-0.5 text-[11px]" style={pillStyle}>
              {/* `RM {paid}/{expected} paid back`, one shared prefix — built
                  from `<Money bare>` parts so both figures mask (ruling 3). */}
              RM <Money sen={tx.paid_sen} bare />/<Money sen={tx.expected_back_sen} bare /> paid back
            </span>
          ) : null}
          {fundLabel ? (
            <span className="rounded-full px-2 py-0.5 text-[11px]" style={pillStyle}>
              {fundLabel}
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-2 px-2 text-sm" style={{ color: "var(--ink-2)" }}>
        <span className="rounded-full px-2 py-0.5 text-[11px]" style={pillStyle}>
          {categoryLabel}
        </span>
      </td>
      <td className="py-2 px-2 text-sm" style={{ color: "var(--ink-2)" }}>
        {accountLabel}
      </td>
      <td className="py-2 px-2 text-sm" style={{ color: "var(--ink-2)" }}>
        {dateLabel(tx.date, todayStr, yesterdayStr)}
      </td>
      <td
        className="py-2 px-2 text-right text-sm font-semibold tabular-nums"
        style={{ color: tx.type === "income" ? "var(--good-text)" : "var(--ink-1)" }}
      >
        {tx.type === "income"
          ? `+${fmtCcy(row.accountCurrency, tx.amount_sen)}`
          : fmtCcy(row.accountCurrency, -tx.amount_sen)}
      </td>
      <td className="py-2 px-2 text-right">
        <div className="flex justify-end gap-2">
          <TxFormSheet
            mode="edit"
            accounts={accounts}
            categories={categories}
            fxRates={fxRates}
            funds={funds}
            tx={existingTx}
            todayStr={todayStr}
            triggerLabel="Edit"
            triggerVariant="secondary"
            triggerClassName="px-2 py-1 text-xs"
            optimistic={optimistic}
          />
          <Button type="button" variant="ghost" className="px-2 py-1 text-xs" onClick={handleDelete}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}
