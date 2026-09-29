import { z } from "zod";
import { v5 as uuidv5 } from "uuid";
import { assertSen } from "@/lib/money";
import { parseEntry, type ParserContext } from "@/lib/parser/parse";
import { IMPORT_PICKER_LINES } from "@/lib/import-limits";
import { civilDays, DATE_FORMATS, parseDate, parseStatementAmountToSen } from "@/lib/statement-parse";

export { DATE_FORMATS, type DateFormat } from "@/lib/statement-parse";

/**
 * CSV statement import — the pure layer (Plan 8 Task 5, rulings 12, 13, 15,
 * 16). Everything here is clock-free and I/O-free: the server action (Task 6)
 * feeds it `parseCsv` rows, the owner's mapping, the account's existing
 * transactions from one paged range read, and the parser context the Quick
 * Add path builds. Money is integer sen throughout; amounts are converted by
 * string arithmetic, never `parseFloat`.
 */

/**
 * Fixed namespace for deterministic import ids (ruling 12a). The sibling of
 * `RECURRING_NAMESPACE` in recurring.ts — declared once, here; import it,
 * never re-declare it. Changing it re-keys every row ever imported.
 */
export const IMPORT_NAMESPACE = "38f7c1e6-c3f3-464c-a4e4-a65d7233c8c9";

// --- mapping -------------------------------------------------------------

const colSchema = z.number().int().min(0);

/** Column mapping (ruling 16). Columns are 0-based indexes into the CSV row
 *  (headers vary by bank); the date format is chosen, never sniffed. Stored
 *  per account in `user_settings.import_mappings` and validated on both
 *  sides with this schema. Plan 9 ruling 7 adds two OPTIONAL keys — a
 *  mapping stored under Plan 8's shape parses to exactly itself (pinned:
 *  `getImportMappings` drops a failing entry and the next save persists the
 *  drop): `header_line`, the 0-based raw line the header sits on (default
 *  0; the picker shows lines 0–11), and `saved_at`, the ISO time of the
 *  last save (v7's `last used … <date>`). */
export const importMappingSchema = z.object({
  date_col: colSchema,
  date_format: z.enum(DATE_FORMATS),
  description_col: colSchema,
  amount: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("signed"), col: colSchema }),
    z.object({ kind: z.literal("pair"), debit_col: colSchema, credit_col: colSchema }),
  ]),
  note_col: colSchema.nullable(),
  header_line: z.number().int().min(0).max(IMPORT_PICKER_LINES - 1).optional(),
  saved_at: z.string().optional(),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

// --- mapping application -------------------------------------------------

/** One file row after the mapping. A parseable row has a date and a signed
 *  amount and no `error`; an unparseable row names its reason and keeps
 *  whatever parsed (rule 15 — nothing is dropped). `raw` is the row's cells
 *  as read, for the preview's raw-text listing; `line` is the 1-based row
 *  number with the header as row 1. */
export type RawRow =
  | {
      line: number;
      raw: string[];
      date: string;
      description: string;
      signed_amount_sen: number;
      note: string | null;
      error?: undefined;
    }
  | {
      line: number;
      raw: string[];
      date: string | null;
      description: string;
      signed_amount_sen: number | null;
      note: string | null;
      error: string;
    };

type AmountResult = { sen: number; error?: undefined } | { sen: null; error: string };

function signedAmount(raw: string[], amount: ImportMapping["amount"]): AmountResult {
  if (amount.kind === "signed") {
    const sen = parseStatementAmountToSen(raw[amount.col] ?? "");
    if (sen === null) return { sen: null, error: "bad amount" };
    if (sen === 0) return { sen: null, error: "zero amount" };
    return { sen };
  }
  // Debit = money out = negative; credit = money in = positive; blank = 0.
  const debitText = (raw[amount.debit_col] ?? "").trim();
  const creditText = (raw[amount.credit_col] ?? "").trim();
  if (debitText === "" && creditText === "") return { sen: null, error: "debit and credit both blank" };
  const debit = debitText === "" ? 0 : parseStatementAmountToSen(debitText);
  const credit = creditText === "" ? 0 : parseStatementAmountToSen(creditText);
  if (debit === null || credit === null) return { sen: null, error: "bad amount" };
  if (debit !== 0 && credit !== 0) return { sen: null, error: "debit and credit both filled" };
  if (debit === 0 && credit === 0) return { sen: null, error: "zero amount" };
  return { sen: debit !== 0 ? -Math.abs(debit) : Math.abs(credit) };
}

/**
 * Apply the mapping to the DATA rows (the header already sliced off).
 * `firstLine` is the row number of `rows[0]` — 2 when the header is row 1.
 * `RawRow.line` is that 1-based ROW number, not a file line: a quoted newline
 * inside a field does not advance it. Every input row yields exactly one
 * output row; a row whose cells are all blank or whitespace-only is
 * `empty line`.
 */
export function applyMapping(rows: string[][], mapping: ImportMapping, firstLine = 2): RawRow[] {
  return rows.map((raw, i) => {
    const line = firstLine + i;
    const description = (raw[mapping.description_col] ?? "").trim();
    const noteText = mapping.note_col === null ? "" : (raw[mapping.note_col] ?? "").trim();
    const note = noteText === "" ? null : noteText;
    if (raw.every((cell) => cell.trim() === "")) {
      return { line, raw, date: null, description, signed_amount_sen: null, note, error: "empty line" };
    }
    const date = parseDate(raw[mapping.date_col] ?? "", mapping.date_format);
    const amount = signedAmount(raw, mapping.amount);
    if (amount.sen !== null) assertSen(Math.abs(amount.sen));
    if (date === null) return { line, raw, date, description, signed_amount_sen: amount.sen, note, error: "bad date" };
    if (amount.sen === null) return { line, raw, date, description, signed_amount_sen: null, note, error: amount.error };
    return { line, raw, date, description, signed_amount_sen: amount.sen, note };
  });
}

// --- ids -----------------------------------------------------------------

/** lowercase → collapse whitespace runs to one space → strip every character
 *  outside [a-z0-9 ] → trim. Part of every import id (ruling 12a): the test
 *  pins three examples so a change here is loud. */
export function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/** Ruling 12a's deterministic id. `ordinal` is the row's index among rows
 *  with an identical (account, date, signed amount, normalized description)
 *  key within the same file — two RM 4.50 kopi on one day are both real. */
export function importId(
  account_id: string,
  row: { date: string; signed_amount_sen: number; description: string },
  ordinal: number,
): string {
  return uuidv5(`${importKey(account_id, row)}:${ordinal}`, IMPORT_NAMESPACE);
}

/** The id key without its ordinal — also what the ordinal counts over. */
function importKey(account_id: string, row: { date: string; signed_amount_sen: number; description: string }): string {
  return `${account_id}:${row.date}:${row.signed_amount_sen}:${normalizeDescription(row.description)}`;
}

// --- classification ------------------------------------------------------

/** An existing transaction touching the target account from the preview's
 *  paged range read (ruling 12). `signed_amount_sen` is its effect ON THE
 *  TARGET ACCOUNT, signed by the DB layer — which alone knows which leg of a
 *  transfer the target is. */
export interface ExistingTx {
  id: string;
  date: string;
  note: string;
  signed_amount_sen: number;
  type: "expense" | "income" | "transfer";
}

/** The Quick Add parser context minus `default_account_id` (forced null here
 *  so the parser's account guess is non-null only when the description named
 *  an account) plus the import target `account_id`. */
export type ImportContext = Omit<ParserContext, "default_account_id"> & { account_id: string };

export type PreviewState = "new" | "probable_duplicate" | "already_imported" | "unparseable";

export interface DuplicateOf {
  id: string;
  date: string;
  note: string;
  amount_sen: number;
  type: ExistingTx["type"];
}

export type PreviewRow =
  | {
      id: string;
      line: number;
      raw: string[];
      state: Exclude<PreviewState, "unparseable">;
      date: string;
      description: string;
      note: string | null;
      signed_amount_sen: number;
      type: "expense" | "income";
      category_id: string | null;
      needs_review: boolean;
      transfer_hint: boolean;
      /** The matched existing row: the exact-id hit for `already_imported`,
       *  the first ±1-day candidate (by date, then id) for
       *  `probable_duplicate`, null for `new`. */
      duplicate_of: DuplicateOf | null;
      /** Ruling 12b: only `new` rows are included by default. */
      default_include: boolean;
      error?: undefined;
    }
  | {
      id: null;
      line: number;
      raw: string[];
      state: "unparseable";
      date: string | null;
      description: string;
      note: string | null;
      signed_amount_sen: number | null;
      type: null;
      category_id: null;
      needs_review: false;
      transfer_hint: false;
      duplicate_of: null;
      default_include: false;
      error: string;
    };

function pick(tx: ExistingTx): DuplicateOf {
  return { id: tx.id, date: tx.date, note: tx.note, amount_sen: Math.abs(tx.signed_amount_sen), type: tx.type };
}

/**
 * Classify mapped rows against the account's existing transactions
 * (ruling 13). Per row: the id from `importId` with the in-file ordinal;
 * `already_imported` when an existing row carries that id (by id alone,
 * whatever its type); else `probable_duplicate` when an existing row —
 * a logged transfer leg included (ruling 12b) — has the same signed amount
 * within ±1 day (exact-id wins — a row is never both); else `new`. Unparseable rows pass through with `id: null`.
 *
 * Ruling 15: the description runs through `parseEntry` as the Quick Add text
 * `<magnitude> <description>` (`+` for a credit, so income categories match)
 * with `default_account_id: null`; only `category_id` and `confident` are
 * used — its type, amount and account-as-target are ignored. The account
 * guess is the transfer tell: `transfer_hint` when it names one of the
 * owner's accounts other than the import target (a bank's own name on its
 * own statement is not a transfer). A hinted row is still imported as
 * expense/income per the sign, with `needs_review` set.
 */
export function classifyRows(rawRows: RawRow[], existingTx: ExistingTx[], ctx: ImportContext): PreviewRow[] {
  const parserCtx: ParserContext = {
    aliases: ctx.aliases,
    accounts: ctx.accounts,
    categories: ctx.categories,
    default_account_id: null,
  };
  const byId = new Map(existingTx.map((tx) => [tx.id, tx]));
  const candidates = [...existingTx].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const ordinals = new Map<string, number>();

  return rawRows.map((row): PreviewRow => {
    if (row.error !== undefined) {
      return {
        id: null,
        line: row.line,
        raw: row.raw,
        state: "unparseable",
        date: row.date,
        description: row.description,
        note: row.note,
        signed_amount_sen: row.signed_amount_sen,
        type: null,
        category_id: null,
        needs_review: false,
        transfer_hint: false,
        duplicate_of: null,
        default_include: false,
        error: row.error,
      };
    }
    const key = importKey(ctx.account_id, row);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    const id = importId(ctx.account_id, row, ordinal);

    const magnitude = Math.abs(row.signed_amount_sen);
    assertSen(magnitude);
    const type = row.signed_amount_sen < 0 ? "expense" : "income";
    const amountText = `${type === "income" ? "+" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
    const parsed = parseEntry(`${amountText} ${row.description}`, parserCtx);
    const transfer_hint = parsed.account_id !== null && parsed.account_id !== ctx.account_id;
    const needs_review = !parsed.confident || parsed.category_id === null || transfer_hint;

    const exact = byId.get(id);
    const days = civilDays(row.date);
    const near = exact
      ? undefined
      : candidates.find(
          (tx) => tx.id !== id && tx.signed_amount_sen === row.signed_amount_sen && Math.abs(civilDays(tx.date) - days) <= 1,
        );
    const state: PreviewRow["state"] = exact ? "already_imported" : near ? "probable_duplicate" : "new";
    return {
      id,
      line: row.line,
      raw: row.raw,
      state,
      date: row.date,
      description: row.description,
      note: row.note,
      signed_amount_sen: row.signed_amount_sen,
      type,
      category_id: parsed.category_id,
      needs_review,
      transfer_hint,
      duplicate_of: exact ? pick(exact) : near ? pick(near) : null,
      default_include: state === "new",
    };
  });
}

// --- summary -------------------------------------------------------------

export interface ImportSummary {
  row_count: number;
  included_count: number;
  skipped_count: number;
  needs_review_count: number;
  unparseable_count: number;
}

/**
 * The batch counts the wizard shows (ruling 13). `choices` reference
 * parseable rows by id; a parseable row absent from `choices` counts as
 * skipped, an unknown id is ignored (the commit action, not this pure layer,
 * rejects it). Unparseable rows are counted from the rows themselves — they
 * can never be chosen. `skipped_count` here is the owner's preview skips;
 * the write path adds its own `23505` skips (ruling 11).
 */
export function summarize(previewRows: PreviewRow[], choices: Array<{ id: string; include: boolean }>): ImportSummary {
  const included = new Set(choices.filter((c) => c.include).map((c) => c.id));
  const summary: ImportSummary = {
    row_count: previewRows.length,
    included_count: 0,
    skipped_count: 0,
    needs_review_count: 0,
    unparseable_count: 0,
  };
  for (const row of previewRows) {
    if (row.state === "unparseable") summary.unparseable_count += 1;
    else if (included.has(row.id)) {
      summary.included_count += 1;
      if (row.needs_review) summary.needs_review_count += 1;
    } else summary.skipped_count += 1;
  }
  return summary;
}
