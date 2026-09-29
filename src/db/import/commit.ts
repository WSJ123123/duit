import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { performUpsert } from "@/lib/transactions";
import { importMappingSchema, type ImportMapping, type PreviewRow } from "@/lib/import";
import { IMPORT_CHUNK_ROWS } from "@/lib/import-limits";
import {
  batchNumbers,
  classifyFile,
  hashContent,
  importedCount,
  loadImportAccount,
  parseImportFile,
  type ImportResult,
} from "./shared";

const beginSchema = z.object({
  /** Plan 9 Q25: the wizard's client-generated batch id, minted once per
   *  import attempt and carried by every retry of it. */
  id: z.uuid(),
  account_id: z.uuid(),
  filename: z.string().min(1).max(200),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  row_count: z.number().int().min(0),
});
export type BeginImportInput = z.infer<typeof beginSchema>;

/** Q25's generic refusal — RLS shows no row to name (another user's id). */
export const IMPORT_ID_USED = "Import id already used — start the import again";

/**
 * Ruling 11: ONE batch per import, opened once by the wizard; every chunk
 * and every retry carries its id. Plan 9 Q25 (ruling 8f): the id is the
 * wizard's, so a `begin` whose request died after the insert is retried
 * under the same id and lands here on `23505` — the house no-op pattern
 * returns the existing batch when it is the caller's own, on the same
 * account and not undone; the caller's own on another account or undone is
 * refused by name; a row RLS cannot show gets the generic sentence. No
 * orphan batch can exist afterwards.
 */
export async function beginImport(
  supabase: SupabaseClient,
  input: BeginImportInput,
): Promise<ImportResult<{ batch_id: string }>> {
  const parsed = beginSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  const acct = await loadImportAccount(supabase, parsed.data.account_id);
  if (!acct.ok) return acct;
  const { error } = await supabase.from("import_batches").insert({
    id: parsed.data.id,
    account_id: acct.account.id,
    filename: parsed.data.filename,
    content_sha256: parsed.data.content_sha256,
    row_count: parsed.data.row_count,
  });
  if (!error) return { ok: true, batch_id: parsed.data.id };
  if (error.code !== "23505") return { ok: false, error: error.message };
  const existing = await supabase
    .from("import_batches")
    .select("id, account_id, undone_at")
    .eq("id", parsed.data.id)
    .maybeSingle();
  if (existing.error) return { ok: false, error: existing.error.message };
  const batch = existing.data as { id: string; account_id: string; undone_at: string | null } | null;
  if (!batch) return { ok: false, error: IMPORT_ID_USED };
  if (batch.undone_at !== null) return { ok: false, error: "This import was undone — start the import again" };
  if (batch.account_id !== acct.account.id) {
    return { ok: false, error: "This import id was used for another account — start the import again" };
  }
  return { ok: true, batch_id: batch.id };
}

const choiceSchema = z.object({ id: z.uuid(), include: z.boolean() });
const chunkSchema = z.object({
  batch_id: z.uuid(),
  text: z.string(),
  mapping: importMappingSchema,
  choices: z.array(choiceSchema),
  chunk: z.object({ from: z.number().int().min(0), to: z.number().int().min(1) }),
});
export interface CommitChunkInput {
  batch_id: string;
  text: string;
  mapping: ImportMapping;
  /** PF3: the owner's include list over PARSEABLE rows — the sole authority
   *  over inclusion. An unknown id is an error. */
  choices: Array<{ id: string; include: boolean }>;
  /** Preview-row positions [from, to) — unparseable rows count. */
  chunk: { from: number; to: number };
}

/** Ruling 19's counters, written by the final chunk; `imported_count` derived.
 *  `created_at` is the batch row's, so the Done screen can list the batch
 *  it just finished without a refetch (Plan 9 ruling 8g). */
export interface CommitDone {
  batch_no: number;
  imported_count: number;
  needs_review_count: number;
  skipped_count: number;
  unparseable_count: number;
  created_at: string;
}

export type CommitChunkResult =
  | { ok: true; saved_in_chunk: number; skipped_in_chunk: number; done: false }
  | ({ ok: true; saved_in_chunk: number; skipped_in_chunk: number; done: true } & CommitDone)
  | { ok: false; partial: true; saved_in_chunk: number; error: string }
  | { ok: false; partial: false; error: string };

interface BatchRow {
  id: string;
  account_id: string;
  content_sha256: string;
  undone_at: string | null;
  created_at: string;
}

/** Plan 9 R2 (controller decision): R2's terminal rule applies to REFUSALS;
 *  a transient DB error on a pre-write read (the batch row, the account) is
 *  reported as a partial with nothing saved, so the runner keeps the batch
 *  and Retry replays the chunk — ending the attempt there would open a
 *  second batch over rows the first still owns. */
function retryable(error: string): CommitChunkResult {
  return { ok: false, partial: true, saved_in_chunk: 0, error };
}

/** Integer sen → the "12.34" string performUpsert parses (no float division). */
function senToAmountStr(sen: number): string {
  return `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, "0")}`;
}

/** The entry's visible text: the statement description, then the mapped
 *  note when the file has one. */
function noteFor(row: PreviewRow & { id: string }): string {
  return row.note === null ? row.description : `${row.description} · ${row.note}`;
}

/**
 * Ruling 11: the import is a mapper over the ordinary write path. Each
 * included row of the chunk goes through `performUpsert` with
 * `source: "import"` and the batch tag, so every guard applies and the
 * 23505 branch (`created: false`) is what makes a re-import a skip. Ruling
 * 13: the file is re-parsed and re-classified here only to re-derive each
 * row's id, type, category, review flag and note — inclusion is the owner's
 * choice list. On the first hard failure the rows before it stay and the
 * caller replays the same chunk under the same batch id.
 */
export async function commitImportChunk(
  supabase: SupabaseClient,
  input: CommitChunkInput,
): Promise<CommitChunkResult> {
  const parsed = chunkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, partial: false, error: parsed.error.issues[0]?.message ?? "invalid input" };
  const { batch_id, text, mapping, choices, chunk } = parsed.data;
  if (chunk.to <= chunk.from) return { ok: false, partial: false, error: "Empty chunk" };
  if (chunk.to - chunk.from > IMPORT_CHUNK_ROWS) {
    return { ok: false, partial: false, error: `A chunk is at most ${IMPORT_CHUNK_ROWS} rows` };
  }

  const batchRes = await supabase
    .from("import_batches")
    .select("id, account_id, content_sha256, undone_at, created_at")
    .eq("id", batch_id)
    .maybeSingle();
  if (batchRes.error) return retryable(batchRes.error.message);
  const batch = batchRes.data as BatchRow | null;
  if (!batch) return { ok: false, partial: false, error: "Batch not found" };
  if (batch.undone_at !== null) return { ok: false, partial: false, error: "This batch was undone — start a new import" };
  if (hashContent(text) !== batch.content_sha256) {
    return { ok: false, partial: false, error: "This file is not the one this batch was opened for" };
  }

  // Rule 16 on the WRITE path: the batch's account is re-checked on every
  // chunk — a batch row made outside beginImport, or an account archived
  // since, never takes a row.
  const acct = await loadImportAccount(supabase, batch.account_id);
  if (!acct.ok) return acct.transient ? retryable(acct.error) : { ok: false, partial: false, error: acct.error };

  const file = parseImportFile(text, mapping);
  if (!file.ok) return { ok: false, partial: false, error: file.error };
  const { rows } = await classifyFile(supabase, batch.account_id, file.raw, batch.id);
  const ids = new Set(rows.flatMap((r) => (r.id === null ? [] : [r.id])));
  for (const c of choices) {
    if (!ids.has(c.id)) return { ok: false, partial: false, error: "Unknown row in choices" };
  }
  const included = new Set(choices.filter((c) => c.include).map((c) => c.id));

  let saved = 0;
  let skipped = 0;
  for (const row of rows.slice(chunk.from, chunk.to)) {
    if (row.id === null || !included.has(row.id)) continue;
    const result = await performUpsert(supabase, {
      id: row.id,
      source: "import",
      accountId: batch.account_id,
      type: row.type,
      amount: senToAmountStr(Math.abs(row.signed_amount_sen)),
      ...(row.category_id !== null ? { categoryId: row.category_id } : {}),
      date: row.date,
      note: noteFor(row),
      needsReview: row.needs_review,
      importBatchId: batch.id,
    });
    if (!result.ok) return { ok: false, partial: true, saved_in_chunk: saved, error: `Line ${row.line}: ${result.error}` };
    if (result.created) saved += 1;
    else skipped += 1;
  }

  if (chunk.to < rows.length) return { ok: true, saved_in_chunk: saved, skipped_in_chunk: skipped, done: false };
  // The rows are written: a failure from here on is PARTIAL, so the action
  // still revalidates and the wizard's Retry replays this chunk — every row
  // a 23505 skip, the counters recomputed.
  try {
    const done = await finalize(supabase, batch.id, rows);
    return { ok: true, saved_in_chunk: saved, skipped_in_chunk: skipped, done: true, ...done, created_at: batch.created_at };
  } catch (e) {
    const reason = e instanceof Error ? e.message : (e as { message?: string } | null)?.message ?? "unknown error";
    return { ok: false, partial: true, saved_in_chunk: saved, error: `The rows were saved but the batch could not be closed (${reason})` };
  }
}

/** Ruling 19: the three counters, from what is actually in the table — a
 *  dead request cannot leave them stale, because a replayed final chunk
 *  recomputes them. skipped = rows − unparseable − imported covers both the
 *  owner's preview skips and the write path's 23505 skips. */
async function finalize(supabase: SupabaseClient, batchId: string, rows: PreviewRow[]): Promise<Omit<CommitDone, "created_at">> {
  const unparseable_count = rows.filter((r) => r.state === "unparseable").length;
  const [imported_count, reviewRes, numbers] = await Promise.all([
    importedCount(supabase, batchId),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId)
      .eq("needs_review", true),
    batchNumbers(supabase),
  ]);
  if (reviewRes.error) throw reviewRes.error;
  const needs_review_count = reviewRes.count ?? 0;
  const skipped_count = rows.length - unparseable_count - imported_count;
  const { error } = await supabase
    .from("import_batches")
    .update({ row_count: rows.length, skipped_count, needs_review_count, unparseable_count })
    .eq("id", batchId);
  if (error) throw error;
  return { batch_no: numbers.get(batchId) ?? 0, imported_count, needs_review_count, skipped_count, unparseable_count };
}
