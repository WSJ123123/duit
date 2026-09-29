import type { SupabaseClient } from "@supabase/supabase-js";
import { saveImportMapping } from "@/db/settings";
import { summarize, type ImportMapping, type ImportSummary, type PreviewRow } from "@/lib/import";
import {
  batchNumbers,
  classifyFile,
  hashContent,
  importedCount,
  loadImportAccount,
  parseImportFile,
  type DateRange,
  type ImportResult,
} from "./shared";

export interface PreviewInput {
  account_id: string;
  filename: string;
  text: string;
  mapping: ImportMapping;
  /** Ruling 12c: the in-flight batch when the owner steps back mid-import —
   *  never refused against, and its own rows are left out of the read. */
  batch_id?: string | null;
}

/** Ruling 12c's refuse-by-default disclosure. */
export interface SameFile {
  batch_id: string;
  batch_no: number;
  filename: string;
  row_count: number;
  imported_count: number;
  created_at: string;
}

export type PreviewResult = ImportResult<{
  account: { id: string; name: string };
  content_sha256: string;
  rows: PreviewRow[];
  /** The counts under the default choices (`default_include`). */
  summary: ImportSummary;
  same_file: SameFile | null;
  reconcile: { count: number; net_sen: number } | null;
  range: DateRange | null;
  /** Existing row id → owning batch id, for the already-imported rows and
   *  the probable duplicates an import wrote (ruling 8h's `· import`). */
  imported_batch: Record<string, string>;
  /** Plan 9 ruling 7: raw lines above the header — not rows; disclosed. */
  preamble_lines: number;
}>;

/**
 * Preview a statement (rulings 11–13, 16, 18): validates the account and the
 * caps, remembers the mapping for the account (the ONLY write — header line
 * included, `saved_at` stamped), hashes the WHOLE text (preamble included)
 * and names an earlier non-undone batch with the same hash that still owns
 * rows, then classifies every row off one paged range read.
 */
export async function previewImport(supabase: SupabaseClient, input: PreviewInput): Promise<PreviewResult> {
  if (input.filename.length < 1 || input.filename.length > 200) {
    return { ok: false, error: "Filename must be 1–200 characters" };
  }
  const acct = await loadImportAccount(supabase, input.account_id);
  if (!acct.ok) return acct;
  const parsed = parseImportFile(input.text, input.mapping);
  if (!parsed.ok) return parsed;

  const saved = await saveImportMapping(supabase, acct.account.id, input.mapping);
  if (!saved.ok) return { ok: false, error: saved.error };

  const content_sha256 = hashContent(input.text);
  const excludeBatchId = input.batch_id ?? null;
  const [same_file, classified] = await Promise.all([
    findSameFile(supabase, acct.account.id, content_sha256, excludeBatchId),
    classifyFile(supabase, acct.account.id, parsed.raw, excludeBatchId),
  ]);
  const summary = summarize(
    classified.rows,
    classified.rows.flatMap((r) => (r.id === null ? [] : [{ id: r.id, include: r.default_include }])),
  );
  return {
    ok: true,
    account: acct.account,
    content_sha256,
    rows: classified.rows,
    summary,
    same_file,
    reconcile: classified.reconcile,
    range: classified.range,
    imported_batch: classified.imported_batch,
    preamble_lines: parsed.preamble_lines,
  };
}

/** The earliest non-undone batch on the account with this hash that still
 *  owns rows (a batch owning none is no reason to refuse), excluding the
 *  in-flight one. */
async function findSameFile(
  supabase: SupabaseClient,
  accountId: string,
  contentSha256: string,
  excludeBatchId: string | null,
): Promise<SameFile | null> {
  const { data, error } = await supabase
    .from("import_batches")
    .select("id, filename, row_count, created_at")
    .eq("account_id", accountId)
    .eq("content_sha256", contentSha256)
    .is("undone_at", null)
    .order("created_at")
    .order("id");
  if (error) throw error;
  const candidates = (data as Array<{ id: string; filename: string; row_count: number; created_at: string }>).filter(
    (b) => b.id !== excludeBatchId,
  );
  for (const b of candidates) {
    const imported = await importedCount(supabase, b.id);
    if (imported === 0) continue;
    const numbers = await batchNumbers(supabase);
    return {
      batch_id: b.id,
      batch_no: numbers.get(b.id) ?? 0,
      filename: b.filename,
      row_count: b.row_count,
      imported_count: imported,
      created_at: b.created_at,
    };
  }
  return null;
}
