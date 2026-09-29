"use client";

import Link from "next/link";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { ImportHistory, type HistoryRow } from "@/components/ImportHistory";
import type { CommitDone } from "@/db/import/commit";
import { preambleLine, skippedLine, withFinishedBatch, type SkipBreakdown } from "@/lib/import-display";

/** Screen C of mockup v7 §12 — the imported count, its breakdown, the ledger
 *  — with v8 §16's preamble disclosure and the batch just finished on the
 *  history card at once (Plan 9 rulings 7, 8g). */

interface Props {
  done: CommitDone & { breakdown: SkipBreakdown };
  filename: string;
  accountName: string;
  /** The file's last month (YYYY-MM) — where `Open Transactions` lands. */
  month: string | null;
  history: HistoryRow[];
  /** The batch this wizard just finished, as a history row (ruling 8g). */
  finished: HistoryRow;
  onAnother: () => void;
}

export function DoneStep({ done, filename, accountName, month, history, finished, onAnother }: Props) {
  const disclosure = preambleLine(finished.preamble_lines ?? 0);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Imported">
        <div className="text-3xl font-bold tabular-nums" style={{ color: "var(--ink-1)" }}>
          {done.imported_count} rows
        </div>
        <p className="mt-1 text-xs" style={{ color: "var(--ink-2)" }}>
          {filename} → {accountName} · batch #{done.batch_no} · {done.needs_review_count} need review · {skippedLine(done.breakdown)}
        </p>
        {disclosure ? (
          <p className="mt-1 text-xs" style={{ color: "var(--ink-2)" }}>
            {disclosure}
          </p>
        ) : null}
        <Tip className="mt-2">
          the flagged rows are in the review list on Activity — give each a category and the flag clears · a bad import can be undone from Settings while its rows are untouched
        </Tip>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="button" variant="ghost" onClick={onAnother}>
            Import another
          </Button>
          <Link
            href={month ? `/transactions?month=${month}` : "/transactions"}
            className="rounded-lg border px-3.5 py-2 text-sm font-medium"
            style={{ background: "var(--accent)", borderColor: "transparent", color: "#fff" }}
          >
            Open Transactions
          </Link>
        </div>
      </Card>
      <ImportHistory rows={withFinishedBatch(history, finished)} title="Settings › Import history" />
    </div>
  );
}
