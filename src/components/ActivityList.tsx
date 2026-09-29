"use client";

import { useOptimistic, useState } from "react";
import { useMoney } from "@/components/Money";
import { groupByDay } from "@/lib/activity";
import type { TxType } from "@/lib/transactions";
import { TxFormSheet } from "@/components/TxFormSheet";
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

interface ActivityListProps {
  rows: EnrichedTxRow[];
  todayStr: string;
  yesterdayStr: string;
  accounts: AccountOption[];
  categories: CategoryOption[];
  /** fx_rates rows for the edit sheet's cross-currency transfer prefill. */
  fxRates?: Array<{ pair: string; rate_e8: number; as_of: string }>;
  /** Ruling 7's fund picker on the edit sheet (mockup v6 §10 phone 3). */
  funds?: FundOption[];
  emptyLabel: string;
}

type RowListAction = { kind: "patch"; patch: RowPatch } | { kind: "remove"; id: string };

function reduceRows(state: EnrichedTxRow[], action: RowListAction): EnrichedTxRow[] {
  return action.kind === "patch" ? applyPatch(state, action.patch) : removeRow(state, action.id);
}

/**
 * Mobile (<md) day-grouped Activity list from mockup v3. The desktop table
 * in the same page covers md+; this is CSS-hidden there (md:hidden).
 *
 * Owns Task 6's optimistic edit/delete state for this list: day buckets and
 * day totals are always derived from the server-truth `rows` prop (never the
 * optimistic overlay) per the Task 6 contract — a pending edit's row shows
 * its patched value via the "saving…" affordance, but the day total it
 * belongs to only moves once the server refresh lands. Deleted rows are
 * hidden immediately by filtering them out of the optimistic overlay while
 * still counting toward the (stale, honest) day total until then.
 */
export function ActivityList({ rows, todayStr, yesterdayStr, accounts, categories, fxRates, funds, emptyLabel }: ActivityListProps) {
  const days = groupByDay(rows);
  const [optimisticRows, dispatch] = useOptimistic<EnrichedTxRow[], RowListAction>(rows, reduceRows);
  const [error, setError] = useState<string | null>(null);
  const { fmt } = useMoney();

  const optimistic: OptimisticRowHandlers = {
    patch: (patch) => dispatch({ kind: "patch", patch }),
    remove: (id) => dispatch({ kind: "remove", id }),
    settled: (ok) => setError(ok ? null : "Couldn't save — nothing was changed"),
  };

  if (days.length === 0) {
    return (
      <p className="py-6 text-center text-sm md:hidden" style={{ color: "var(--ink-3)" }}>
        {emptyLabel}
      </p>
    );
  }

  const originalById = new Map(rows.map((r) => [r.id, r]));
  const optimisticById = new Map(optimisticRows.map((r) => [r.id, r]));

  return (
    <div className="flex flex-col md:hidden">
      {error ? (
        // Rule 15: a failed edit/delete never fails silently. Tip-styled
        // but NOT inside <Tip> — always visible regardless of tips-off.
        <p className="pt-3 text-sm font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      ) : null}
      {days.map((day) => (
        <div key={day.date}>
          <div
            className="pb-1 pt-3.5 text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--ink-3)" }}
          >
            {dateLabel(day.date, todayStr, yesterdayStr)} · {fmt(day.total_sen)}
          </div>
          {day.rows.map((row) => {
            const display = optimisticById.get(row.id);
            if (!display) return null; // optimistically deleted — vanished until (or unless) the delete settles
            const pending = originalById.get(row.id) !== display;
            return (
              <ActivityRow
                key={row.id}
                row={display}
                pending={pending}
                accounts={accounts}
                categories={categories}
                fxRates={fxRates}
                funds={funds}
                todayStr={todayStr}
                optimistic={optimistic}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function RowTypeIcon({ type }: { type: TxType }) {
  if (type === "income") {
    return (
      <svg viewBox="0 0 20 20" fill="none" width="18" height="18">
        <path
          d="M10 15V5M5.5 9.5L10 5l4.5 4.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (type === "transfer") {
    return (
      <svg viewBox="0 0 20 20" fill="none" width="18" height="18">
        <path
          d="M4 7h10.5M11 3.5L14.5 7 11 10.5M16 13H5.5M9 9.5L5.5 13 9 16.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" width="18" height="18">
      <path
        d="M10 5v10M5.5 10.5L10 15l4.5-4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ActivityRow({
  row,
  pending,
  accounts,
  categories,
  fxRates,
  funds,
  todayStr,
  optimistic,
}: {
  row: EnrichedTxRow;
  pending?: boolean;
  accounts: AccountOption[];
  categories: CategoryOption[];
  fxRates?: Array<{ pair: string; rate_e8: number; as_of: string }>;
  funds?: FundOption[];
  todayStr: string;
  optimistic?: OptimisticRowHandlers;
}) {
  const categoryLabel = categoryLabelFor(row);
  const accountLabel = accountLabelFor(row);
  // Same disclosure as the desktop row (owner's Task-3 audit call).
  const fundLabel = fundLabelFor(row.fund_id, funds ?? []);
  const description = row.note || categoryLabel;
  const existingTx = existingTxFrom(row);
  const { fmtCcy } = useMoney();

  return (
    <TxFormSheet
      mode="edit"
      accounts={accounts}
      categories={categories}
      fxRates={fxRates}
      funds={funds}
      tx={existingTx}
      todayStr={todayStr}
      triggerLabel="Edit"
      optimistic={optimistic}
      renderTrigger={(onClick) => (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-3 border-b py-2.5 text-left last:border-b-0"
          style={{ borderColor: "var(--grid)", opacity: pending ? 0.5 : 1 }}
        >
          <span
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: "var(--chip)", color: "var(--ink-2)" }}
          >
            <RowTypeIcon type={row.type} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[14.5px] font-medium" style={{ color: "var(--ink-1)" }}>
                {description}
              </span>
              {pending ? (
                <span
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: "var(--chip)", color: "var(--ink-3)" }}
                >
                  saving…
                </span>
              ) : null}
              {row.needs_review ? (
                <span
                  className="inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: "color-mix(in srgb, var(--warning) 30%, var(--surface))", color: "var(--ink-1)" }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--warning)" }} />
                  review
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
              <span className="rounded-full px-2 py-0.5" style={{ background: "var(--chip)" }}>
                {categoryLabel}
              </span>
              {fundLabel ? (
                <span className="rounded-full px-2 py-0.5" style={{ background: "var(--chip)" }}>
                  {fundLabel}
                </span>
              ) : null}
              {accountLabel}
            </span>
          </span>
          <span
            className="flex-shrink-0 text-[14.5px] font-semibold tabular-nums"
            style={{ color: row.type === "income" ? "var(--good-text)" : "var(--ink-1)" }}
          >
            {row.type === "income"
              ? `+${fmtCcy(row.accountCurrency, row.amount_sen)}`
              : fmtCcy(row.accountCurrency, -row.amount_sen)}
          </span>
        </button>
      )}
    />
  );
}
