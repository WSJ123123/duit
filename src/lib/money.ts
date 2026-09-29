export function assertSen(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`invalid sen amount: ${n}`);
  }
}

export function formatSen(sen: number): string {
  const sign = sen < 0 ? "−" : "";
  const abs = Math.abs(sen);
  const ringgit = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}RM ${ringgit.toLocaleString("en-MY")}.${cents}`;
}

/** Currency-aware sibling of formatSen (Task 5): "RM x.xx" via formatSen for
 *  MYR, "CUR x.xx" for any other minor-unit amount (account balances and
 *  holding figures denominated in their own currency). Moved here from
 *  HoldingsTable.tsx so server components can format native amounts too. */
export function formatCcy(currency: string, minorUnits: number): string {
  if (currency === "MYR") return formatSen(minorUnits);
  const sign = minorUnits < 0 ? "−" : "";
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${currency} ${whole.toLocaleString("en-MY")}.${frac}`;
}

const AMOUNT_RE = /^(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/;

export function parseAmountToSen(input: string): number | null {
  const trimmed = input.trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  const parts = trimmed.replace(/,/g, "").split(".");
  const whole = parts[0];
  const frac = parts[1] ?? "";
  if (whole === undefined) return null;
  const sen = Number(whole) * 100 + (frac ? Number(frac.padEnd(2, "0")) : 0);
  return Number.isSafeInteger(sen) ? sen : null;
}

const E8_AMOUNT_RE = /^(\d{1,3}(,\d{3})*|\d+)(\.\d{1,8})?$/;

/** parseAmountToSen's strictness at e8 precision (quantities / unit prices,
 *  ruling 13): digits with optional thousands commas and up to 8 decimals —
 *  no signs, no exponents, no bare dots. Integer arithmetic only; null
 *  instead of an unsafe integer. */
export function parseAmountToE8(input: string): number | null {
  const trimmed = input.trim();
  if (!E8_AMOUNT_RE.test(trimmed)) return null;
  const parts = trimmed.replace(/,/g, "").split(".");
  const whole = parts[0];
  const frac = parts[1] ?? "";
  if (whole === undefined) return null;
  const e8 = Number(whole) * 100_000_000 + (frac ? Number(frac.padEnd(8, "0")) : 0);
  return Number.isSafeInteger(e8) ? e8 : null;
}
