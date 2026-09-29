/**
 * Plan 9 ruling 2 — the pure half of the amounts mask. Clock-free, DOM-free.
 *
 * Masked output is a FIXED-WIDTH `RM ••••` (four U+2022 bullets after the
 * currency code): never digit-count-preserving, because digit count leaks
 * magnitude. The sign glyph is kept (`−RM ••••`) — ruling 4 lets direction
 * remain visible; only magnitude is hidden.
 */

const BULLETS = "••••";

export const MASKED_MYR = `RM ${BULLETS}`;

/** The prefix-less mask (`maskBare`'s output for a non-negative figure) for a
 *  caller that has no figure at all, only a cell to blank. */
export const MASKED_BARE = BULLETS;

/** Per-device cookie (ruling 1): `duit_amounts=hidden`; absent means shown. */
export const AMOUNTS_COOKIE = "duit_amounts";

/**
 * Exactly `formatSen` / `formatCcy`'s grammar with boundaries: a currency code
 * (RM or three capitals not preceded by a capital — `PTPTN 300.00` is refused),
 * one space, 1–3 digits, optional `,ddd` groups, `.dd` not followed by a digit
 * (`RM 12.345` is refused). A `−` before the match is left in place.
 */
export const MONEY_RE = /(?<![A-Z])(?:RM|[A-Z]{3}) \d{1,3}(?:,\d{3})*\.\d{2}(?!\d)/g;

function signOf(minor: number): string {
  return minor < 0 ? "−" : "";
}

export function maskSen(sen: number): string {
  return `${signOf(sen)}${MASKED_MYR}`;
}

export function maskCcy(currency: string, minorUnits: number): string {
  const code = currency === "MYR" ? "RM" : currency;
  return `${signOf(minorUnits)}${code} ${BULLETS}`;
}

/** The Activity/Transactions rows' prefix-less figure, masked. */
export function maskBare(sen: number): string {
  return `${signOf(sen)}${BULLETS}`;
}

/** Every figure in the grammar becomes `<CUR> ••••`; nothing else changes. */
export function maskMoneyText(text: string): string {
  return text.replace(MONEY_RE, (m) => `${m.slice(0, m.indexOf(" "))} ${BULLETS}`);
}

/**
 * A statement cell's figure — digits with optional thousands commas and two
 * decimals, not glued to more digits or dots. Wider than the app's grammar
 * on purpose (a bank prints `15304.75` without commas, and every cell sits
 * after a `,`): a raw line is file text, not the app's output, and Plan 9
 * Q40's rule for file text on the Map screen is that it masks too.
 */
const CELL_FIGURE_RE = /(?<![\d.])\d+(?:,\d{3})*\.\d{2}(?![\d.])/g;

/** Plan 9 ruling 7's picker under the mask: every figure in a raw statement
 *  line becomes `••••` (fixed width — digit count leaks magnitude); dates,
 *  account numbers and words stay. Two decimals are the whole tell: an
 *  integer-only or one-decimal cell stays visible — do not widen
 *  `CELL_FIGURE_RE` for it, or dates, account numbers and reference codes
 *  would mask too. */
export function maskRawLine(line: string): string {
  return line.replace(CELL_FIGURE_RE, BULLETS);
}

/**
 * Ruling 1's cookie contract, pinned by test. Hidden writes the one-year
 * cookie; shown DELETES it (`max-age=0`, same attributes) — "absent means
 * shown" is literal. `Secure` only when served over https.
 */
export function amountsCookieString(hidden: boolean, secure: boolean): string {
  const base = hidden
    ? `${AMOUNTS_COOKIE}=hidden; path=/; max-age=31536000; SameSite=Lax`
    : `${AMOUNTS_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  return secure ? `${base}; Secure` : base;
}

/**
 * The client-side read of `document.cookie` — the same literal test the app
 * layout makes on the server (`value === "hidden"`), over the `; `-joined
 * `name=value` pairs the browser exposes. Whole-name match; any other value
 * (or none) is shown. Pure so the provider's resync (final review A, I2:
 * a cached document can carry a stale `initialHidden`) is pinned by test.
 */
export function readAmountsCookie(cookieString: string): boolean {
  return cookieString.split(";").some((pair) => pair.trim() === `${AMOUNTS_COOKIE}=hidden`);
}
