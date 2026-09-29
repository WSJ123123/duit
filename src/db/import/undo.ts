import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages } from "@/db/paging";
import { formatDayMonth } from "@/lib/import-display";
import { batchNumbers, importedCount, paidImportedTransactionIds, touchedRows, type TouchCols } from "./shared";

export type UndoResult =
  /** `owner_batch_id`: present with the `saved by batch #n` message — the
   *  batch the history links that "batch #n" to (ruling 17). */
  | { ok: true; deleted: number; message: string | null; owner_batch_id?: string }
  /** `deleted` is set when the rows ARE gone but the batch could not be
   *  marked — the caller must still refresh what it shows. */
  | { ok: false; error: string; deleted?: number };

interface UndoRow extends TouchCols {
  date: string;
  note: string;
  needs_review: boolean;
}

interface UndoBatch {
  id: string;
  account_id: string;
  content_sha256: string;
  row_count: number;
  unparseable_count: number;
  undone_at: string | null;
}

/**
 * Ruling 17: delete the batch's transactions only while every one is
 * untouched since import; otherwise refuse and name the changed rows. The
 * delete is ONE bulk `delete … eq("import_batch_id")` under RLS — the third
 * enumerated delete path (ruling 1). `undone_at` is set either way; the
 * honesty is the returned count and message.
 */
export async function undoImport(supabase: SupabaseClient, batchId: string): Promise<UndoResult> {
  const batchRes = await supabase
    .from("import_batches")
    .select("id, account_id, content_sha256, row_count, unparseable_count, undone_at")
    .eq("id", batchId)
    .maybeSingle();
  if (batchRes.error) return { ok: false, error: batchRes.error.message };
  const batch = batchRes.data as UndoBatch | null;
  if (!batch) return { ok: false, error: "Batch not found" };
  if (batch.undone_at !== null) return { ok: false, error: "This batch was already undone" };

  const rows = await fetchAllPages<UndoRow>((from, to) =>
    supabase
      .from("transactions")
      .select("id, date, note, needs_review, created_at, updated_at, fund_id, recurring_rule_id")
      .eq("import_batch_id", batch.id)
      .order("date")
      .order("id")
      .range(from, to),
  );
  const paid = await paidImportedTransactionIds(supabase, [batch.id]);
  const touched = touchedRows(rows, paid);
  if (touched.length > 0) {
    const named = touched
      .slice(0, 3)
      .map(({ row, reason }) => `${formatDayMonth(row.date)} "${row.note}" (${reason})`)
      .join(", ");
    const more = touched.length > 3 ? ` and ${touched.length - 3} more` : "";
    const noun = touched.length === 1 ? "row" : "rows";
    return { ok: false, error: `Can't undo — ${touched.length} ${noun} changed since import: ${named}${more}` };
  }

  // The untouched check above and this delete are two statements, not one:
  // an edit landing between them is deleted unseen. That check-then-delete
  // race is ACCEPTED single-user exposure (the house precedent is Session-12
  // Minor 3 in src/db/accounts.ts) — the only writer is the owner, in one
  // session; no lock is built (rule 24).
  const del = await supabase.from("transactions").delete().eq("import_batch_id", batch.id).select("id");
  if (del.error) return { ok: false, error: del.error.message };
  const deleted = del.data.length;

  // The ledger keeps reading true once the rows are gone: history derives an
  // undone batch's imported figure as row_count − skipped − unparseable, so
  // the counters are settled HERE from what was just deleted. A batch whose
  // final chunk never ran (counters still 0) would otherwise read
  // imported = row_count. Every deleted row was untouched, so its
  // needs_review flag is the one the import wrote. Plan 9 R4: a pass that
  // deletes nothing (a second undo after the rows went but the mark failed,
  // or a row-less batch) leaves the counters as they stand — settling them
  // from a derived count of 0 would zero what the final chunk wrote.
  const settled =
    deleted > 0
      ? {
          skipped_count: Math.max(0, batch.row_count - batch.unparseable_count - deleted),
          needs_review_count: rows.filter((r) => r.needs_review).length,
        }
      : {};
  const mark = await supabase
    .from("import_batches")
    .update({ undone_at: new Date().toISOString(), ...settled })
    .eq("id", batch.id);
  if (mark.error) {
    const noun = deleted === 1 ? "row was" : "rows were";
    return {
      ok: false,
      deleted,
      error:
        deleted > 0
          ? `${deleted} ${noun} removed, but the batch could not be marked undone (${mark.error.message}) — press Discard to close it`
          : mark.error.message,
    };
  }

  if (deleted > 0) return { ok: true, deleted, message: null };
  const owner = await owningBatch(supabase, batch);
  // "owns no rows" is true of an abandoned wizard AND of a batch whose rows
  // an earlier pass removed before its mark failed (R4): the two are
  // indistinguishable once the rows are gone, so the sentence claims no more.
  if (owner === null) return { ok: true, deleted: 0, message: "Nothing to undo — this batch owns no rows" };
  return {
    ok: true,
    deleted: 0,
    message: `Nothing to undo — these rows were saved by batch #${owner.batch_no}`,
    owner_batch_id: owner.id,
  };
}

/** A re-import of an already-imported file owns none of its rows: the
 *  earlier non-undone batch with the same hash on the account does. */
async function owningBatch(
  supabase: SupabaseClient,
  batch: { id: string; account_id: string; content_sha256: string },
): Promise<{ id: string; batch_no: number } | null> {
  const { data, error } = await supabase
    .from("import_batches")
    .select("id")
    .eq("account_id", batch.account_id)
    .eq("content_sha256", batch.content_sha256)
    .is("undone_at", null)
    .neq("id", batch.id)
    .order("created_at")
    .order("id");
  if (error) throw error;
  for (const b of data as Array<{ id: string }>) {
    if ((await importedCount(supabase, b.id)) === 0) continue;
    const batch_no = (await batchNumbers(supabase)).get(b.id);
    return batch_no === undefined ? null : { id: b.id, batch_no };
  }
  return null;
}
