import { assertSen } from "@/lib/money";

/**
 * Statement cell readers — the amount and date grammars a bank export uses,
 * split out of src/lib/import.ts at the seam the Plan 8 final review named
 * (Plan 9 Task 4, ruling 8i). Pure, clock-free: string arithmetic for money,
 * civil-calendar arithmetic for dates, no Date object anywhere.
 */

export const DATE_FORMATS = ["DD/MM/YYYY", "YYYY-MM-DD", "D MMM YYYY", "MM/DD/YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

// --- amount --------------------------------------------------------------

const BODY_RE = /^(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/;

/**
 * Statement amount → signed sen, or null. Grammar, applied in this order:
 * optional `RM`/`MYR` prefix (any case, optional space) → optional ` DR`/` CR`
 * suffix (any case; DR negative, CR positive) → optional parentheses
 * (negative) → optional leading `-`/`+` → digits with optional 1,234,567.89
 * commas and at most two decimals. Exactly one sign carrier is allowed —
 * `(-12.00)` and `-12.00 CR` are null. String arithmetic only: the decimal
 * part is padded to two digits and read as an integer, never as a float.
 * The existing `parseAmountToSen` (money.ts) deliberately rejects signs,
 * prefixes and parentheses for the forms and is untouched.
 */
export function parseStatementAmountToSen(input: string): number | null {
  let s = input.trim().replace(/^(RM|MYR)\s?/i, "");
  let sign = 1;
  let signed = false;
  const suffix = /^(.*)\s(DR|CR)$/i.exec(s);
  if (suffix) {
    s = suffix[1]!;
    sign = suffix[2]!.toUpperCase() === "DR" ? -1 : 1;
    signed = true;
  }
  if (s.startsWith("(") && s.endsWith(")")) {
    if (signed) return null;
    s = s.slice(1, -1);
    sign = -1;
    signed = true;
  }
  if (s.startsWith("-") || s.startsWith("+")) {
    if (signed) return null;
    sign = s.startsWith("-") ? -1 : 1;
    s = s.slice(1);
  }
  if (!BODY_RE.test(s)) return null;
  const [whole, frac = ""] = s.replace(/,/g, "").split(".");
  const sen = Number(whole) * 100 + (frac ? Number(frac.padEnd(2, "0")) : 0);
  if (!Number.isSafeInteger(sen)) return null;
  assertSen(sen);
  return sen === 0 ? 0 : sign * sen;
}

// --- date ----------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Strict date reader for the four mapper formats → ISO `YYYY-MM-DD`, or
 *  null for any other shape or an impossible calendar date. Slash formats
 *  take one or two digits for day and month; `D MMM YYYY` takes an English
 *  three-letter month in any case. Nothing here touches a Date object. */
export function parseDate(input: string, format: DateFormat): string | null {
  const s = input.trim();
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  switch (format) {
    case "DD/MM/YYYY":
      if (!(match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return null;
      [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
      break;
    case "MM/DD/YYYY":
      if (!(match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return null;
      [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
      break;
    case "YYYY-MM-DD":
      if (!(match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return null;
      [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
      break;
    case "D MMM YYYY": {
      if (!(match = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(s))) return null;
      const month = MONTHS.indexOf(match[2]!.toLowerCase());
      if (month < 0) return null;
      [d, m, y] = [Number(match[1]), month + 1, Number(match[3])];
      break;
    }
  }
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Days since 1970-01-01 for an ISO date — civil-calendar integer
 *  arithmetic (the days-from-civil algorithm), no Date object. */
export function civilDays(iso: string): number {
  const y0 = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}
