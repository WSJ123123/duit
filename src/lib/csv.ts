/**
 * RFC-4180 CSV rendering, pure. Header row from `columns`; each row is
 * rendered by reading exactly those keys in that order (extra keys on a row
 * are ignored, missing keys render empty — same as null/undefined).
 * Money columns are integer sen (bigint-as-number from Postgres) and are
 * written verbatim; this file never derives a decimal.
 */
function csvField(value: unknown): string {
  let str: string;
  if (value === null || value === undefined) {
    str = "";
  } else if (typeof value === "boolean") {
    str = value ? "true" : "false";
  } else {
    str = String(value);
  }
  if (/["\n\r,]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Thrown by parseCsv on an unterminated quoted field; `line` is the file
 *  line (1-based) where the open quote sits. */
export class CsvParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = "CsvParseError";
    this.line = line;
  }
}

/**
 * RFC-4180 reader, pure (Plan 8 Task 5). Returns every row including the
 * header (row 0): quoted fields may hold commas, doubled quotes and
 * newlines; CRLF, LF and lone CR all end a row; a leading BOM is stripped;
 * TRAILING all-blank rows are dropped (an empty line inside the data stays —
 * applyMapping names it); rows shorter than the header are padded with ""
 * to its width (longer rows keep their extra cells). No dependency.
 */
export function parseCsv(text: string): string[][] {
  const s = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        if (c === "\n") line += 1;
        field += c;
        i += 1;
      }
    } else if (c === '"' && field === "") {
      inQuotes = true;
      quoteLine = line;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
      line += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) throw new CsvParseError(`unterminated quote at line ${quoteLine}`, quoteLine);
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === "")) rows.pop();
  const width = rows[0]?.length ?? 0;
  return rows.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r));
}
