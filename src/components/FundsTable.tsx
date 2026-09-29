"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMoney } from "@/components/Money";
import { KIND_LABEL, fundSubLine, statusPillText, statusPillColor, progressBarColor } from "@/lib/funds-display";
import { ActionLink } from "@/components/DialogKit";
import { unarchiveFund, archiveFund } from "@/app/(app)/goals/actions";
import { FundFormDialog } from "@/components/FundDialogs";
import type { FundRow, FundDrawRow } from "@/db/funds";

/**
 * Funds table + `Archived (n)` disclosure (Task 3) — the same house pattern
 * HoldingsTable.tsx ships (ArchivedDisclosure / two-tap confirm), applied to
 * archive instead of delete (funds have no delete path, archive-only).
 *
 * The pure per-fund display helpers (date formatting, the functional
 * sub-line, the status pill, the "next target" stat line) live in
 * src/lib/funds-display.ts, not here — a plain function exported from this
 * "use client" file cannot be called directly from the server-component
 * Goals page (see that file's header comment for why).
 */

function Pill({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className="ml-1.5 inline-block flex-shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ background: "var(--chip)", color: muted ? "var(--ink-3)" : "var(--ink-2)" }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Archive (two-tap, house pattern) — names the current-month tagged count
// from data the page already loaded (getFunds' drawn_this_month), so the
// confirm step never needs a second query (ruling 9a).
// ---------------------------------------------------------------------------

function ArchiveAction({ fund, month, taggedCount }: { fund: FundRow; month: string; taggedCount: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  function handleArchive() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const result = await archiveFund(fund.id, month);
      if (!result.ok) {
        setConfirming(false);
        return setError(result.error);
      }
      router.refresh();
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={handleArchive}
        disabled={pending}
        className="whitespace-nowrap text-xs font-medium"
        style={{ color: confirming || pending ? "var(--critical)" : "var(--accent)" }}
      >
        {pending ? "Archiving…" : confirming ? `Confirm${taggedCount > 0 ? ` (${taggedCount} tagged)` : ""}` : "Archive"}
      </button>
      {error ? (
        <span className="text-[11px] font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Archived (n) disclosure — ruling 9a: archived funds stay visible WITH
// their balance; Unarchive only (funds are archive-only, no delete path).
// ---------------------------------------------------------------------------

function ArchivedFundRow({ fund, columns }: { fund: FundRow; columns: number }) {
  const { fmt } = useMoney();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function unarchive() {
    startTransition(async () => {
      const result = await unarchiveFund(fund.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <tr style={{ borderTop: "1px solid var(--grid)" }}>
      <td colSpan={columns} className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2.5 text-sm">
          <span className="flex-1 font-semibold" style={{ color: "var(--ink-3)" }}>
            {fund.name}
            <Pill muted>{KIND_LABEL[fund.kind]}</Pill>
            <Pill muted>archived</Pill>
            <span className="mt-0.5 block text-[10.5px] font-normal">{fmt(fund.balance_sen)} saved</span>
          </span>
          <ActionLink onClick={unarchive}>Unarchive</ActionLink>
          {error ? (
            <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
              {error}
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function ArchivedFundsDisclosure({ funds, columns }: { funds: FundRow[]; columns: number }) {
  const [expanded, setExpanded] = useState(false);
  if (funds.length === 0) return null;
  return (
    <>
      <tr style={{ borderTop: "1px solid var(--grid)" }}>
        <td colSpan={columns} className="px-2 py-2">
          <ActionLink onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide archived" : `Archived (${funds.length})`}
          </ActionLink>
        </td>
      </tr>
      {expanded ? funds.map((f) => <ArchivedFundRow key={f.id} fund={f} columns={columns} />) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

interface FundsTableProps {
  funds: FundRow[];
  archivedFunds: FundRow[];
  month: string;
  avgMonthlyExpenseSen: number;
  /** Ruling 3's coupling disclosure (F3) — the fund-paid share of
   *  avgMonthlyExpenseSen, same window/divisor (src/db/funds.ts). */
  avgMonthlyFundPaidExpenseSen: number;
  todayIso: string;
  drawnThisMonth: FundDrawRow[];
  totalSavedSen: number;
}

export function FundsTable({
  funds,
  archivedFunds,
  month,
  avgMonthlyExpenseSen,
  avgMonthlyFundPaidExpenseSen,
  todayIso,
  drawnThisMonth,
  totalSavedSen,
}: FundsTableProps) {
  const { fmt, text } = useMoney();
  const [editing, setEditing] = useState<FundRow | null>(null);
  const columns = ["Fund", "Saved", "Target", "Progress", "Monthly", "Status", ""];

  const taggedCountByFund = new Map<string, number>();
  for (const d of drawnThisMonth) taggedCountByFund.set(d.fund_id, (taggedCountByFund.get(d.fund_id) ?? 0) + 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((h, i) => (
              <th
                key={h || `col-${i}`}
                className={`px-2 py-1.5 text-xs font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {funds.map((fund) => (
            <tr key={fund.id} style={{ borderBottom: "1px solid var(--grid)" }}>
              <td className="px-2 py-2 text-left align-top">
                <span className="flex items-center" style={{ color: "var(--ink-1)" }}>
                  <span className="font-semibold">{fund.name}</span>
                  <Pill>{KIND_LABEL[fund.kind]}</Pill>
                </span>
                <span className="mt-0.5 block text-[11.5px] font-normal" style={{ color: "var(--ink-3)" }}>
                  {text(fundSubLine(fund, avgMonthlyExpenseSen, avgMonthlyFundPaidExpenseSen, todayIso))}
                </span>
              </td>
              <td
                className="px-2 py-2 text-right align-top tabular-nums font-semibold"
                style={{ color: fund.balance_sen < 0 ? "var(--critical)" : "var(--ink-1)" }}
              >
                {fmt(fund.balance_sen)}
              </td>
              <td className="px-2 py-2 text-right align-top tabular-nums" style={{ color: "var(--ink-2)" }}>
                {fund.resolved_target_sen === null ? "—" : fmt(fund.resolved_target_sen)}
              </td>
              <td className="px-2 py-2 text-right align-top">
                {fund.resolved_target_sen === null ? (
                  <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                    no target
                  </span>
                ) : (
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className="block h-1.5 w-[120px] overflow-hidden rounded-full"
                      style={{ background: "var(--accent-track)" }}
                    >
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${Math.max(0, Math.min(100, fund.progress_pct ?? 0))}%`,
                          background: progressBarColor(fund.status),
                        }}
                      />
                    </span>
                    <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                      {fund.progress_pct ?? 0}%
                    </span>
                  </div>
                )}
              </td>
              <td className="px-2 py-2 text-right align-top tabular-nums" style={{ color: "var(--ink-2)" }}>
                {fmt(fund.contribution_sen)}
              </td>
              <td className="px-2 py-2 text-right align-top">
                <span
                  className="inline-block rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                  style={{ background: "var(--chip)", color: statusPillColor(fund) ?? "var(--ink-2)" }}
                >
                  {text(statusPillText(fund))}
                </span>
              </td>
              <td className="px-2 py-2 text-right align-top whitespace-nowrap">
                <ActionLink onClick={() => setEditing(fund)}>Edit</ActionLink>
                <span style={{ color: "var(--ink-3)" }}> · </span>
                <ArchiveAction fund={fund} month={month} taggedCount={taggedCountByFund.get(fund.id) ?? 0} />
              </td>
            </tr>
          ))}
          <ArchivedFundsDisclosure funds={archivedFunds} columns={columns.length} />
        </tbody>
      </table>

      <div
        className="mt-2.5 flex items-center justify-between border-t pt-2.5 text-xs font-semibold"
        style={{ borderColor: "var(--grid)", color: "var(--ink-1)" }}
      >
        <span>
          Total saved · {funds.length} active fund{funds.length === 1 ? "" : "s"}
        </span>
        <span className="tabular-nums">{fmt(totalSavedSen)}</span>
      </div>

      {editing ? <FundFormDialog fund={editing} month={month} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
