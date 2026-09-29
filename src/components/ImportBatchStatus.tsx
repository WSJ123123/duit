"use client";

import Link from "next/link";
import { useState } from "react";
import { TwoTapAction } from "@/components/DialogKit";
import { undoImportAction } from "@/app/(app)/transactions/import/actions";
import { splitBatchLabel } from "@/lib/import-display";

/**
 * The right-hand end of one import-history row: ruling 17's Undo as the house
 * two-tap (`Discard` for a row-less live batch — an abandoned wizard, or a
 * re-import that owned nothing), the `n rows edited · can't undo` state, or
 * the `undone` pill. One component for all three ON PURPOSE: the action's
 * `Nothing to undo — …` notice lives in this component's state, and the
 * refreshed row swaps Undo for the pill — were the pill a different
 * component, the notice would unmount with the button and never be read.
 * `batch #n` in the notice links to that batch's row in Settings › Import
 * history.
 */
export function ImportBatchStatus({
  batchId,
  undone,
  touchedCount,
  rowless,
}: {
  batchId: string;
  undone: boolean;
  touchedCount: number;
  rowless: boolean;
}) {
  const [notice, setNotice] = useState<{ message: string; ownerBatchId?: string } | null>(null);
  const parts = notice?.ownerBatchId ? splitBatchLabel(notice.message) : null;
  return (
    <>
      {undone ? (
        <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: "var(--chip)", color: "var(--ink-2)" }}>
          undone
        </span>
      ) : touchedCount > 0 ? (
        <span className="text-xs" style={{ color: "var(--ink-3)" }}>
          {touchedCount} row{touchedCount === 1 ? "" : "s"} edited · can&apos;t undo
        </span>
      ) : (
        <TwoTapAction
          label={rowless ? "Discard" : "Undo"}
          confirmLabel={rowless ? "Confirm discard" : "Confirm undo"}
          pendingLabel="Undoing…"
          run={async () => {
            try {
              const result = await undoImportAction(batchId);
              if (!result.ok) return result;
              setNotice(result.message === null ? null : { message: result.message, ownerBatchId: result.owner_batch_id });
              return { ok: true };
            } catch {
              return { ok: false, error: "The request did not complete — check the connection and try again" };
            }
          }}
        />
      )}
      {notice ? (
        <span className="basis-full text-xs" style={{ color: "var(--ink-2)" }}>
          {parts && notice.ownerBatchId ? (
            <>
              {parts.before}
              <Link href={`/settings#import-batch-${notice.ownerBatchId}`} style={{ color: "var(--accent)" }}>
                {parts.label}
              </Link>
              {parts.after}
            </>
          ) : (
            notice.message
          )}
        </span>
      ) : null}
    </>
  );
}
