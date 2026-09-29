import Link from "next/link";
import { Card } from "@/components/Card";
import { ImportBatchStatus } from "@/components/ImportBatchStatus";
import type { ImportBatchRow } from "@/db/import/history";
import { formatDayMonth, historyCountsLine } from "@/lib/import-display";

/** A history row, plus the preamble count the wizard knows for the batch it
 *  just finished (Plan 9 ruling 7 — not a stored column, so the fetched
 *  history never carries it). */
export type HistoryRow = ImportBatchRow & { preamble_lines?: number };

/**
 * Settings › Import history (mockup v7 §12, ruling 13's ledger): one row per
 * batch, newest first, with its counts and its state (ImportBatchStatus:
 * `Undo`, `n rows edited · can't undo` or the `undone` pill). Presentational —
 * rendered by the Settings page (server) and the wizard's Done screen
 * (client) alike; the rows come in as props.
 */
export function ImportHistory({ rows, title = "Import history" }: { rows: HistoryRow[]; title?: string }) {
  const undone = rows.filter((r) => r.undone_at !== null).length;
  return (
    <Card
      title={title}
      subtitle={rows.length === 0 ? "No imports yet" : `${rows.length} import${rows.length === 1 ? "" : "s"} · ${undone} undone`}
    >
      <ul className="flex flex-col">
        {rows.map((r) => {
          const isUndone = r.undone_at !== null;
          const preamble = r.preamble_lines ?? 0;
          return (
            <li
              key={r.id}
              id={`import-batch-${r.id}`}
              className="flex flex-wrap items-center gap-2 py-2"
              style={{ borderBottom: "1px solid var(--grid)", color: isUndone ? "var(--ink-3)" : "var(--ink-1)" }}
            >
              <span className="flex min-w-[160px] flex-1 flex-col">
                <span className={`text-sm ${isUndone ? "font-medium" : "font-semibold"}`}>{r.filename}</span>
                <span className="text-xs" style={{ color: "var(--ink-3)" }}>
                  {r.account_name} · {historyCountsLine(r)}
                  {preamble > 0 ? ` · ${preamble} preamble line${preamble === 1 ? "" : "s"}` : ""}
                  {isUndone ? ` · undone ${formatDayMonth(r.undone_at!, true)}` : ""}
                </span>
              </span>
              <span className="text-xs tabular-nums" style={{ color: "var(--ink-3)" }}>
                {formatDayMonth(r.created_at, true)}
              </span>
              <ImportBatchStatus batchId={r.id} undone={isUndone} touchedCount={r.touched_count} rowless={r.imported_count === 0} />
            </li>
          );
        })}
      </ul>
      <Link href="/transactions/import" className="mt-3 inline-block text-sm" style={{ color: "var(--accent)" }}>
        Import a statement →
      </Link>
    </Card>
  );
}
