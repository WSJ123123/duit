import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, IN_CHUNK } from "@/db/paging";
import { paidImportedTransactionIds, touchedRows, type TouchCols } from "./shared";

/** Settings › Import history (ruling 13's ledger), newest first. */
export interface ImportBatchRow {
  id: string;
  /** PF4: derived from (created_at, id) order across the user's batches. */
  batch_no: number;
  filename: string;
  account_name: string;
  row_count: number;
  /** Live batch: count(*) of its rows. Undone batch: the rows are gone, so
   *  row_count − skipped − unparseable — `undoImport` settles `skipped` from
   *  the rows it deleted, so this is what undo removed even when the final
   *  chunk never ran. */
  imported_count: number;
  skipped_count: number;
  needs_review_count: number;
  unparseable_count: number;
  /** Ruling 17: rows no longer what the import wrote — `n rows edited ·
   *  can't undo` when > 0. */
  touched_count: number;
  created_at: string;
  undone_at: string | null;
}

interface StoredBatch {
  id: string;
  account_id: string;
  filename: string;
  row_count: number;
  skipped_count: number;
  needs_review_count: number;
  unparseable_count: number;
  created_at: string;
  undone_at: string | null;
}

interface TaggedRow extends TouchCols {
  import_batch_id: string;
}

export async function listImportBatches(supabase: SupabaseClient): Promise<ImportBatchRow[]> {
  const [batches, accountsRes] = await Promise.all([
    fetchAllPages<StoredBatch>((from, to) =>
      supabase
        .from("import_batches")
        .select("id, account_id, filename, row_count, skipped_count, needs_review_count, unparseable_count, created_at, undone_at")
        .order("created_at")
        .order("id")
        .range(from, to),
    ),
    supabase.from("accounts").select("id, name"),
  ]);
  if (accountsRes.error) throw accountsRes.error;
  const accountName = new Map((accountsRes.data as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));

  // The live batches' rows: paged, in id chunks — the touched check needs
  // the row itself, and count(*) per batch falls out of the same read. The
  // paid set is one inner-join read over the same batch ids (ruling 10c),
  // not a per-100-row loop over the tagged ids.
  const liveIds = batches.filter((b) => b.undone_at === null).map((b) => b.id);
  const tagged: TaggedRow[] = [];
  for (let i = 0; i < liveIds.length; i += IN_CHUNK) {
    const chunk = liveIds.slice(i, i + IN_CHUNK);
    tagged.push(
      ...(await fetchAllPages<TaggedRow>((from, to) =>
        supabase
          .from("transactions")
          .select("id, import_batch_id, created_at, updated_at, fund_id, recurring_rule_id")
          .in("import_batch_id", chunk)
          .order("id")
          .range(from, to),
      )),
    );
  }
  const paid = await paidImportedTransactionIds(supabase, liveIds);
  const imported = new Map<string, number>();
  for (const r of tagged) imported.set(r.import_batch_id, (imported.get(r.import_batch_id) ?? 0) + 1);
  const touched = new Map<string, number>();
  for (const { row } of touchedRows(tagged, paid)) {
    touched.set(row.import_batch_id, (touched.get(row.import_batch_id) ?? 0) + 1);
  }

  return batches
    .map((b, i) => ({
      id: b.id,
      batch_no: i + 1,
      filename: b.filename,
      account_name: accountName.get(b.account_id) ?? "—",
      row_count: b.row_count,
      imported_count:
        b.undone_at === null
          ? (imported.get(b.id) ?? 0)
          : Math.max(0, b.row_count - b.skipped_count - b.unparseable_count),
      skipped_count: b.skipped_count,
      needs_review_count: b.needs_review_count,
      unparseable_count: b.unparseable_count,
      touched_count: touched.get(b.id) ?? 0,
      created_at: b.created_at,
      undone_at: b.undone_at,
    }))
    .reverse();
}
