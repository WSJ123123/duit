"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabase } from "@/db/server";
import { revalidateTxPaths } from "@/app/(app)/transactions/revalidate";
import { previewImport, type PreviewResult } from "@/db/import/preview";
import { beginImport, commitImportChunk, type BeginImportInput, type CommitChunkResult } from "@/db/import/commit";
import { undoImport, type UndoResult } from "@/db/import/undo";
import { rawLines, readImportCsv, type ImportResult } from "@/db/import/shared";
import { importMappingSchema } from "@/lib/import";
import { IMPORT_PICKER_LINES, oversizeError } from "@/lib/import-limits";

/**
 * Plan 8 Task 6: the import's server actions. Every field of the multipart
 * body is zod-parsed here; the file text is read once per request, handed to
 * the DB layer, and never reaches a log or an error message. Session client
 * only (RLS) — the admin client is never imported.
 */

const uuidField = z.uuid();
const optionalUuidField = z.union([z.literal(""), z.null(), z.uuid()]);
const filenameSchema = z.string().min(1).max(200);

/** The uploaded file: a File field named `file`, its name 1–200 characters,
 *  its size under ruling 18's cap BEFORE the text is read. */
async function readUpload(fd: FormData): Promise<ImportResult<{ filename: string; text: string; size: number }>> {
  const file = fd.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a CSV file" };
  const name = filenameSchema.safeParse(file.name);
  if (!name.success) return { ok: false, error: "Filename must be 1–200 characters" };
  const tooLarge = oversizeError(file.size);
  if (tooLarge !== null) return { ok: false, error: tooLarge };
  return { ok: true, filename: name.data, text: await file.text(), size: file.size };
}

function readJson(fd: FormData, field: string): unknown {
  const raw = fd.get(field);
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export interface InspectResult {
  filename: string;
  size: number;
  /** Plan 9 ruling 7: the file's first twelve raw lines (0-based), for the
   *  header-line picker, and how many lines the file has. */
  lines: string[];
  line_count: number;
  /** The header line this read applied. */
  header_line: number;
  header: string[];
  /** The first data row, for the map screen's "first row read as" line. */
  sample: string[] | null;
  row_count: number;
  /** Why the header line does not read (past the end, an open quote, over
   *  the row cap) — the picker stays up so another line can be chosen;
   *  null when it reads. */
  error: string | null;
}

const headerLineField = z.coerce.number().int().min(0).max(IMPORT_PICKER_LINES - 1);

/** Map screen: the raw lines for the picker, then the header and row count
 *  under `header_line` (default 0) so the column pickers can be built — the
 *  caps apply here already, so an oversized file is refused at once. */
export async function inspectImportFile(fd: FormData): Promise<ImportResult<InspectResult>> {
  const headerLine = headerLineField.safeParse(fd.get("header_line") ?? 0);
  if (!headerLine.success) return { ok: false, error: "Bad header line" };
  const upload = await readUpload(fd);
  if (!upload.ok) return upload;
  const lines = rawLines(upload.text);
  const read = readImportCsv(upload.text, headerLine.data);
  const base = { ok: true as const, filename: upload.filename, size: upload.size, lines: lines.slice(0, IMPORT_PICKER_LINES), line_count: lines.length, header_line: headerLine.data };
  if (!read.ok) return { ...base, header: [], sample: null, row_count: 0, error: read.error };
  const [header = [], sample] = read.rows;
  return { ...base, header, sample: sample ?? null, row_count: read.rows.length - 1, error: null };
}

export async function previewImportAction(fd: FormData): Promise<PreviewResult> {
  const account = uuidField.safeParse(fd.get("account_id"));
  if (!account.success) return { ok: false, error: "Pick an account" };
  const mapping = importMappingSchema.safeParse(readJson(fd, "mapping"));
  if (!mapping.success) return { ok: false, error: "Every column must be chosen" };
  const batch = optionalUuidField.safeParse(fd.get("batch_id"));
  if (!batch.success) return { ok: false, error: "Bad batch id" };
  const upload = await readUpload(fd);
  if (!upload.ok) return upload;

  const supabase = await createServerSupabase();
  return previewImport(supabase, {
    account_id: account.data,
    filename: upload.filename,
    text: upload.text,
    mapping: mapping.data,
    batch_id: batch.data || null,
  });
}

/** Ruling 11: one batch per import, under the wizard's id (Plan 9 Q25). The
 *  new (still rowless) batch is LISTED by `listImportBatches`, so its two
 *  readers refresh; no transaction moved. */
export async function beginImportAction(input: BeginImportInput): Promise<ImportResult<{ batch_id: string }>> {
  const supabase = await createServerSupabase();
  const result = await beginImport(supabase, input);
  if (result.ok) {
    revalidatePath("/settings");
    revalidatePath("/transactions/import");
  }
  return result;
}

const choicesSchema = z.array(z.object({ id: z.uuid(), include: z.boolean() }));
const boundSchema = z.coerce.number().int().min(0);

export async function commitImportChunkAction(fd: FormData): Promise<CommitChunkResult> {
  const batch = uuidField.safeParse(fd.get("batch_id"));
  if (!batch.success) return { ok: false, partial: false, error: "Bad batch id" };
  const mapping = importMappingSchema.safeParse(readJson(fd, "mapping"));
  if (!mapping.success) return { ok: false, partial: false, error: "Every column must be chosen" };
  const choices = choicesSchema.safeParse(readJson(fd, "choices"));
  if (!choices.success) return { ok: false, partial: false, error: "Bad choices" };
  const from = boundSchema.safeParse(fd.get("from"));
  const to = boundSchema.safeParse(fd.get("to"));
  if (!from.success || !to.success) return { ok: false, partial: false, error: "Bad chunk bounds" };
  const upload = await readUpload(fd);
  if (!upload.ok) return { ok: false, partial: false, error: upload.error };

  const supabase = await createServerSupabase();
  const result = await commitImportChunk(supabase, {
    batch_id: batch.data,
    text: upload.text,
    mapping: mapping.data,
    choices: choices.data,
    chunk: { from: from.data, to: to.data },
  });
  // Every chunk that reached the write path (a partial one included) may
  // have moved balances and month totals — refresh, even when it saved
  // nothing (the 23505 no-op case, as upsertTransaction does).
  if (result.ok || result.partial) revalidateTxPaths();
  return result;
}

export async function undoImportAction(batchId: string): Promise<UndoResult> {
  const parsed = uuidField.safeParse(batchId);
  if (!parsed.success) return { ok: false, error: "Bad batch id" };
  const supabase = await createServerSupabase();
  const result = await undoImport(supabase, parsed.data);
  // Also when the rows are gone but the batch could not be marked (m5).
  if (result.ok || (result.deleted ?? 0) > 0) revalidateTxPaths();
  return result;
}
