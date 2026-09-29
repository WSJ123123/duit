import type { ImportMapping } from "@/lib/import";
import { parseDate, parseStatementAmountToSen, type DateFormat } from "@/lib/statement-parse";
import { formatSen } from "@/lib/money";

/**
 * The import wizard's map-screen form (Plan 8 Task 6) — pure: the stored
 * mapping ⇄ the `<select>` values, and the one-line "first row read as"
 * check. The server re-derives everything; this is the only mapping logic
 * the browser runs. No "use client" here (finding #20).
 */

/** Every column is the `<select>`'s string value; "" is `none` (note only).
 *  `header_line` (Plan 9 ruling 7) is the picker's 0-based raw line. */
export interface MapForm {
  date_col: string;
  date_format: DateFormat;
  description_col: string;
  kind: "signed" | "pair";
  signed_col: string;
  debit_col: string;
  credit_col: string;
  note_col: string;
  header_line: number;
}

export function formFrom(mapping: ImportMapping | undefined, width: number): MapForm {
  // A stored column past this file's width would leave a <select> whose
  // value matches no option: the whole mapping falls back to unset. The
  // header line is what DEFINED the width, so it is kept either way.
  const cols = mapping
    ? [
        mapping.date_col,
        mapping.description_col,
        ...(mapping.amount.kind === "signed" ? [mapping.amount.col] : [mapping.amount.debit_col, mapping.amount.credit_col]),
        ...(mapping.note_col === null ? [] : [mapping.note_col]),
      ]
    : [];
  const m = mapping && cols.every((i) => i < width) ? mapping : undefined;
  return {
    date_col: String(m?.date_col ?? 0),
    date_format: m?.date_format ?? "DD/MM/YYYY",
    description_col: String(m?.description_col ?? Math.min(1, width - 1)),
    kind: m?.amount.kind ?? "signed",
    signed_col: String(m?.amount.kind === "signed" ? m.amount.col : Math.min(2, width - 1)),
    debit_col: String(m?.amount.kind === "pair" ? m.amount.debit_col : Math.min(2, width - 1)),
    credit_col: String(m?.amount.kind === "pair" ? m.amount.credit_col : Math.min(3, width - 1)),
    note_col: m?.note_col === null || m?.note_col === undefined ? "" : String(m.note_col),
    header_line: mapping?.header_line ?? 0,
  };
}

/** The mapping the server receives — `header_line` always stated, so the
 *  stored shape says which line was used; `saved_at` is the server's stamp. */
export function mappingFrom(f: MapForm): ImportMapping {
  return {
    date_col: Number(f.date_col),
    date_format: f.date_format,
    description_col: Number(f.description_col),
    amount:
      f.kind === "signed"
        ? { kind: "signed", col: Number(f.signed_col) }
        : { kind: "pair", debit_col: Number(f.debit_col), credit_col: Number(f.credit_col) },
    note_col: f.note_col === "" ? null : Number(f.note_col),
    header_line: f.header_line,
  };
}

/** The map screen's one-line check of the chosen format against the first
 *  data row — the same pure readers the server applies to every row.
 *  `rawCell` renders the file's own amount cell (Plan 9 Q40: the Map screen
 *  masks it with the amounts hidden — the grammar mask cannot see a raw
 *  statement cell); identity by default. */
export function firstRowLine(sample: string[] | null, f: MapForm, rawCell: (raw: string) => string = (raw) => raw): string {
  if (!sample) return "No data rows in this file";
  const date = parseDate(sample[Number(f.date_col)] ?? "", f.date_format);
  const desc = (sample[Number(f.description_col)] ?? "").trim();
  let amountPart: string;
  let sen: number | null;
  if (f.kind === "signed") {
    const raw = (sample[Number(f.signed_col)] ?? "").trim();
    sen = parseStatementAmountToSen(raw);
    amountPart = `amount ${raw ? rawCell(raw) : "(blank)"}`;
  } else {
    const debit = (sample[Number(f.debit_col)] ?? "").trim();
    const credit = (sample[Number(f.credit_col)] ?? "").trim();
    if (debit !== "") {
      const d = parseStatementAmountToSen(debit);
      sen = d === null ? null : -Math.abs(d);
      amountPart = `debit ${rawCell(debit)}`;
    } else {
      const c = parseStatementAmountToSen(credit);
      sen = c === null ? null : Math.abs(c);
      amountPart = `credit ${credit ? rawCell(credit) : "(blank)"}`;
    }
  }
  const outcome =
    date === null
      ? "date not read — try another format"
      : sen === null || sen === 0
        ? "amount not read"
        : `${sen < 0 ? "expense" : "income"} ${formatSen(Math.abs(sen))}`;
  return `First row read as: ${date ?? "?"} · “${desc}” · ${amountPart} → ${outcome}`;
}
