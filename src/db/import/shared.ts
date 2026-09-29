import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, IN_CHUNK } from "@/db/paging";
import { loadParserContext } from "@/db/parser-context";
import { addDaysIso } from "@/lib/bills";
import { CsvParseError, parseCsv } from "@/lib/csv";
import { IMPORT_MAX_ROWS, oversizeError } from "@/lib/import-limits";
import {
  applyMapping,
  classifyRows,
  type ExistingTx,
  type ImportMapping,
  type PreviewRow,
  type RawRow,
} from "@/lib/import";

/**
 * CSV statement import — what preview, commit, undo and history share
 * (Plan 8 Task 6). Everything runs under the caller's RLS session client;
 * the admin client is never imported anywhere under src/db/import/.
 * Ruling 18's limits live in src/lib/import-limits.ts (Plan 9 Task 4, R5).
 */

/** Ruling 12c: lowercase hex by construction (the column CHECK agrees). */
export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `transient`: a DB error on a read, not a refusal — the caller may retry
 *  as it stands (Plan 9 R2, controller decision). Honoured by
 *  `commitImportChunk` only (its `retryable()` result); `beginImport` and
 *  `previewImport` pass it through unread, so a transient refusal there is
 *  terminal to the runner today (final review B, p1 — backlog, Q50). */
export type ImportResult<T> = ({ ok: true } & T) | { ok: false; error: string; transient?: true };

/** Ruling 11: only a non-archived MYR account is an import target. */
export async function loadImportAccount(
  supabase: SupabaseClient,
  accountId: string,
): Promise<ImportResult<{ account: { id: string; name: string } }>> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, currency, archived")
    .eq("id", accountId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, transient: true };
  if (!data) return { ok: false, error: "Account not found" };
  const account = data as { id: string; name: string; currency: string; archived: boolean };
  if (account.archived) return { ok: false, error: `${account.name} is archived — pick an active account` };
  if (account.currency !== "MYR") {
    return { ok: false, error: `Imports are MYR-only — ${account.name} is in ${account.currency}` };
  }
  return { ok: true, account: { id: account.id, name: account.name } };
}

/** Plan 9 ruling 7: the file's raw lines — the text split on `\r?\n` (a
 *  leading BOM dropped; the empty segment after a final newline is not a
 *  line). The picker shows the first twelve; `header_line` indexes them. */
export function rawLines(text: string): string[] {
  const lines = (text.startsWith("\uFEFF") ? text.slice(1) : text).split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The text from raw line `n` on (its line endings kept), or null past the end. */
function textFromLine(text: string, n: number): string | null {
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) return null;
    pos = nl + 1;
  }
  return text.slice(pos);
}

/** Ruling 18: the size and row caps, then the RFC-4180 reader. Row 0 is the
 *  header. Plan 9 ruling 7: the text is sliced from raw line `headerLine`
 *  BEFORE the reader runs (a preamble line may hold an unbalanced quote
 *  that would kill it), refused when that line is past the end; the lines
 *  above are `preamble_lines` — not rows, disclosed as such. The text
 *  itself never appears in an error. */
export function readImportCsv(text: string, headerLine = 0): ImportResult<{ rows: string[][]; preamble_lines: number }> {
  const tooLarge = oversizeError(Buffer.byteLength(text, "utf8"));
  if (tooLarge !== null) return { ok: false, error: tooLarge };
  const lineCount = rawLines(text).length;
  const sliced = headerLine > 0 ? textFromLine(text, headerLine) : text;
  if (sliced === null || (headerLine > 0 && headerLine >= lineCount)) {
    return { ok: false, error: `Header line ${headerLine} is past the end of this file (${lineCount} lines)` };
  }
  let rows: string[][];
  try {
    rows = parseCsv(sliced);
  } catch (e) {
    // The reader's message already ends "at line n" — say the line once. Its
    // `line` counts the SLICED text; add the header offset back so the number
    // is the file line (csv.ts's 1-based meaning, as at header 0).
    if (e instanceof CsvParseError) {
      return { ok: false, error: `Line ${e.line + headerLine}: ${e.message.replace(/ at line \d+$/, "")}` };
    }
    throw e;
  }
  if (rows.length === 0) return { ok: false, error: "The file is empty" };
  const dataRows = rows.length - 1;
  if (dataRows > IMPORT_MAX_ROWS) {
    return { ok: false, error: `File has ${dataRows} data rows — the limit is ${IMPORT_MAX_ROWS}; split the export by month` };
  }
  return { ok: true, rows, preamble_lines: headerLine };
}

/** The mapping's `header_line` (default 0) picks the header; row `line`
 *  numbers stay 1-based ROW numbers from the header (ordinals and ids are
 *  per row content and do not move). */
export function parseImportFile(text: string, mapping: ImportMapping): ImportResult<{ raw: RawRow[]; preamble_lines: number }> {
  const read = readImportCsv(text, mapping.header_line ?? 0);
  if (!read.ok) return read;
  return { ok: true, raw: applyMapping(read.rows.slice(1), mapping), preamble_lines: read.preamble_lines };
}

export interface DateRange {
  min: string;
  max: string;
}

/** The file's parseable date span, or null when nothing parsed. */
export function dateRange(raw: RawRow[]): DateRange | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const row of raw) {
    if (row.error !== undefined) continue;
    if (min === null || row.date < min) min = row.date;
    if (max === null || row.date > max) max = row.date;
  }
  return min === null || max === null ? null : { min, max };
}

interface ExistingRow {
  id: string;
  date: string;
  note: string;
  amount_sen: number;
  received_sen: number | null;
  type: ExistingTx["type"];
  account_id: string;
  source: string;
  import_batch_id: string | null;
}

export interface ClassifiedFile {
  rows: PreviewRow[];
  range: DateRange | null;
  /** Ruling 16's disclosure: reconcile adjustments dated inside the file's
   *  range on the account — count and net (income +, expense −). */
  reconcile: { count: number; net_sen: number } | null;
  /** Existing row id → the batch that wrote it, for every matched existing
   *  row a batch tagged — the `already_imported` hits (so the preview can
   *  say `imported 24 Aug (batch #6)`) and, since Plan 9 Task 4 (ruling
   *  8h), the `probable_duplicate` matches (the `· import` suffix) — off
   *  the same read. */
  imported_batch: Record<string, string>;
}

/** The row's effect on the target account: an expense or a transfer OUT of
 *  it debits `amount_sen`; an income credits it; a transfer INTO it credits
 *  what arrived (`received_sen` for a cross-currency leg — the target is
 *  always MYR). */
function signOnAccount(t: ExistingRow, accountId: string): ExistingTx {
  const signed_amount_sen =
    t.type === "income" ? t.amount_sen : t.account_id === accountId ? -t.amount_sen : (t.received_sen ?? t.amount_sen);
  return { id: t.id, date: t.date, note: t.note, type: t.type, signed_amount_sen };
}

/**
 * Ruling 12's ONE read: the existing transactions touching the account —
 * its own rows and the transfers INTO it (ruling 12b: a logged transfer is
 * an existing transaction on the account) — inside
 * [min − 1, max + 1], PAGED on (date, id), serve the ±1-day candidates, the
 * exact-id hits and the reconcile disclosure alike — there is no `id in (…)`
 * lookup. Ruling 13: rows carrying `excludeBatchId` (the in-flight batch)
 * are left out, so chunk 1's own rows never turn chunk 2's neighbours into
 * duplicates and a mid-import preview reads as the first one did.
 */
export async function classifyFile(
  supabase: SupabaseClient,
  accountId: string,
  raw: RawRow[],
  excludeBatchId: string | null,
): Promise<ClassifiedFile> {
  const range = dateRange(raw);
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!userData.user) throw new Error("no session");
  const [existing, ctx] = await Promise.all([
    range === null
      ? Promise.resolve([] as ExistingRow[])
      : fetchAllPages<ExistingRow>((from, to) =>
          supabase
            .from("transactions")
            .select("id, date, note, amount_sen, received_sen, type, account_id, source, import_batch_id")
            .or(`account_id.eq.${accountId},transfer_account_id.eq.${accountId}`)
            .gte("date", addDaysIso(range.min, -1))
            .lte("date", addDaysIso(range.max, 1))
            .order("date")
            .order("id")
            .range(from, to),
        ),
    loadParserContext(supabase, userData.user.id),
  ]);
  const visible = existing.filter((t) => excludeBatchId === null || t.import_batch_id !== excludeBatchId);
  const rows = classifyRows(raw, visible.map((t) => signOnAccount(t, accountId)), {
    account_id: accountId,
    aliases: ctx.aliases,
    accounts: ctx.accounts,
    categories: ctx.categories,
  });

  let reconcile: ClassifiedFile["reconcile"] = null;
  if (range !== null) {
    let count = 0;
    let net_sen = 0;
    for (const t of visible) {
      if (t.source !== "reconcile" || t.date < range.min || t.date > range.max) continue;
      count += 1;
      net_sen += t.type === "expense" ? -t.amount_sen : t.amount_sen;
    }
    reconcile = count > 0 ? { count, net_sen } : null;
  }
  const batchOf = new Map(visible.map((t) => [t.id, t.import_batch_id]));
  const imported_batch: Record<string, string> = {};
  for (const r of rows) {
    if (r.duplicate_of === null) continue;
    const batchId = batchOf.get(r.duplicate_of.id);
    if (batchId) imported_batch[r.duplicate_of.id] = batchId;
  }
  return { rows, range, reconcile, imported_batch };
}

/** PF4: "batch #n" is DERIVED on read — the batch's 1-based position in the
 *  user's (created_at, id) order. Paged: nothing bounds a user's batch count. */
export async function batchNumbers(supabase: SupabaseClient): Promise<Map<string, number>> {
  const ids = await fetchAllPages<{ id: string }>((from, to) =>
    supabase.from("import_batches").select("id").order("created_at").order("id").range(from, to),
  );
  return new Map(ids.map((b, i) => [b.id, i + 1]));
}

/** Ruling 11: `imported_count` is count(*) of the batch's rows, never a stored counter. */
export async function importedCount(supabase: SupabaseClient, batchId: string): Promise<number> {
  const { count, error } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("import_batch_id", batchId);
  if (error) throw error;
  return count ?? 0;
}

/** Ruling 17's precondition: which of a batch's rows are no longer what the
 *  import wrote. `updated_at = created_at` is provable (both default to
 *  now() in one statement; `touch_updated_at` fires on update only). */
export interface TouchCols {
  id: string;
  created_at: string;
  updated_at: string;
  fund_id: string | null;
  recurring_rule_id: string | null;
}

export function touchedRows<T extends TouchCols>(rows: T[], paid: Set<string>): Array<{ row: T; reason: string }> {
  const out: Array<{ row: T; reason: string }> = [];
  for (const row of rows) {
    if (paid.has(row.id)) out.push({ row, reason: "has a payment recorded" });
    else if (row.fund_id !== null) out.push({ row, reason: "paid from a fund" });
    else if (row.recurring_rule_id !== null) out.push({ row, reason: "linked to a bill" });
    else if (row.updated_at !== row.created_at) out.push({ row, reason: "edited" });
  }
  return out;
}

/**
 * Ids of the rows tagged with any of `batchIds` that carry a reimbursement
 * payment. Plan 9 ruling 10c: ONE paged inner-join read per IN_CHUNK of
 * batch ids (`reimbursement_payments` ⋈ `transactions!inner(import_batch_id)`
 * filtered to those batches) — a batch count, not a row count, bounds the
 * URL, where the previous shape looped `in (…)` over every tagged row a
 * hundred at a time. History passes its live batches, undo its one; the
 * equality with the old shape is pinned at 250 rows in src/db/import.test.ts.
 */
export async function paidImportedTransactionIds(supabase: SupabaseClient, batchIds: string[]): Promise<Set<string>> {
  const chunks: string[][] = [];
  for (let i = 0; i < batchIds.length; i += IN_CHUNK) chunks.push(batchIds.slice(i, i + IN_CHUNK));
  const pages = await Promise.all(
    chunks.map((chunk) =>
      fetchAllPages<{ transaction_id: string }>((from, to) =>
        supabase
          .from("reimbursement_payments")
          .select("transaction_id, transactions!inner(import_batch_id)")
          .in("transactions.import_batch_id", chunk)
          .order("id")
          .range(from, to),
      ),
    ),
  );
  return new Set(pages.flat().map((r) => r.transaction_id));
}
