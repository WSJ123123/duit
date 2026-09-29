import { describe, it, expect } from "vitest";
import { formatSen, formatCcy } from "@/lib/money";
import {
  AMOUNTS_COOKIE,
  MASKED_BARE,
  MASKED_MYR,
  MONEY_RE,
  amountsCookieString,
  maskBare,
  maskCcy,
  maskMoneyText,
  maskSen,
  readAmountsCookie,
} from "@/lib/money-mask";

/**
 * Plan 9 ruling 2: the grammar is DERIVED from `formatSen` / `formatCcy`'s
 * output — every expectation below is built by calling the real formatters,
 * never by typing a money string by hand — and the mask is a fixed-width
 * `RM ••••` that keeps the sign and never preserves digit count.
 */
const SEN_VALUES = [0, 1, 99, 100, 123_456, 1_000_000_000, 12_345_678_901];
const CURRENCIES = ["USD", "SGD", "JPY"];

describe("maskSen / maskCcy / maskBare — the fixed-width mask", () => {
  it("MASKED_MYR is the currency code and four U+2022 bullets", () => {
    expect(MASKED_MYR).toBe("RM ••••");
    expect(MASKED_MYR).toBe("RM ••••");
  });

  it("every magnitude masks to the same constant (digit count never leaks)", () => {
    const outputs = new Set(SEN_VALUES.map((v) => maskSen(v)));
    expect([...outputs]).toEqual([MASKED_MYR]);
  });

  it("keeps the sign glyph on negatives, exactly as formatSen prints it", () => {
    const sign = formatSen(-1).slice(0, 1);
    expect(sign).toBe("−");
    for (const v of SEN_VALUES.filter((n) => n > 0)) {
      expect(maskSen(-v)).toBe(`${sign}${MASKED_MYR}`);
    }
  });

  it("maskCcy masks to `<CUR> ••••`, MYR to the RM constant, sign kept", () => {
    for (const cur of CURRENCIES) {
      for (const v of SEN_VALUES) {
        expect(maskCcy(cur, v)).toBe(`${cur} ••••`);
        if (v > 0) expect(maskCcy(cur, -v)).toBe(`−${cur} ••••`);
      }
    }
    expect(maskCcy("MYR", 123_456)).toBe(MASKED_MYR);
    expect(maskCcy("MYR", -123_456)).toBe(`−${MASKED_MYR}`);
  });

  it("maskBare drops the prefix and keeps only the sign", () => {
    expect(maskBare(123_456)).toBe("••••");
    expect(maskBare(0)).toBe("••••");
    expect(maskBare(-5)).toBe("−••••");
  });

  it("MASKED_BARE is the prefix-less constant itself — what maskBare prints for any non-negative figure", () => {
    expect(MASKED_BARE).toBe("••••");
    expect(MASKED_BARE).toBe(maskBare(0));
    expect(MASKED_MYR).toBe(`RM ${MASKED_BARE}`);
  });
});

describe("MONEY_RE — exactly formatSen/formatCcy's grammar", () => {
  it("is the ruling-2 regex, global, with the lookbehind and lookahead", () => {
    expect(MONEY_RE.source).toBe("(?<![A-Z])(?:RM|[A-Z]{3}) \\d{1,3}(?:,\\d{3})*\\.\\d{2}(?!\\d)");
    expect(MONEY_RE.flags).toBe("g");
  });

  it("matches every formatter output whole, for every value and currency", () => {
    for (const v of [...SEN_VALUES, ...SEN_VALUES.map((n) => -n)]) {
      const out = formatSen(v);
      const m = [...out.matchAll(MONEY_RE)];
      expect(m.map((x) => x[0])).toEqual([out.replace(/^−/, "")]);
      for (const cur of CURRENCIES) {
        const ccy = formatCcy(cur, v);
        const mm = [...ccy.matchAll(MONEY_RE)];
        expect(mm.map((x) => x[0])).toEqual([ccy.replace(/^−/, "")]);
      }
    }
  });

  it("toLocaleString('en-MY') grouping stays inside the grammar", () => {
    expect(formatSen(12_345_678_901)).toBe("RM 123,456,789.01");
    expect(maskMoneyText(formatSen(12_345_678_901))).toBe(MASKED_MYR);
  });
});

describe("maskMoneyText — sentences", () => {
  it("masks every formatter output to the constant, sign left in place", () => {
    for (const v of SEN_VALUES) {
      expect(maskMoneyText(formatSen(v))).toBe(MASKED_MYR);
      expect(maskMoneyText(formatSen(-v))).toBe(v === 0 ? MASKED_MYR : `−${MASKED_MYR}`);
      for (const cur of CURRENCIES) {
        expect(maskMoneyText(formatCcy(cur, v))).toBe(`${cur} ••••`);
        expect(maskMoneyText(formatCcy(cur, -v))).toBe(v === 0 ? `${cur} ••••` : `−${cur} ••••`);
      }
    }
  });

  it("changes nothing else in the sentence", () => {
    const sentence = `balance ${formatSen(3_840_000)} · minimum ${formatSen(85_000)}/mo`;
    expect(maskMoneyText(sentence)).toBe(`balance ${MASKED_MYR} · minimum ${MASKED_MYR}/mo`);
    const suffixed = `template ${formatSen(18_000)}`;
    expect(maskMoneyText(suffixed)).toBe(`template ${MASKED_MYR}`);
    const signed = `+${formatSen(1_250)} in`;
    expect(maskMoneyText(signed)).toBe(`+${MASKED_MYR} in`);
  });

  it("masks all three figures of a three-figure sentence", () => {
    const s = `${formatSen(100)} of ${formatCcy("USD", 250_000)} and ${formatSen(-99)}`;
    expect(maskMoneyText(s)).toBe(`${MASKED_MYR} of USD •••• and −${MASKED_MYR}`);
  });

  it("returns text with no money byte-identical", () => {
    const plain = [
      "Food · Maybank · Today",
      "1.00%",
      "2.5×",
      "19 months",
      "2077-06-15 · Jun 15",
      "#6",
      "12 rows · 4 entries",
      "3% paid",
      "",
    ];
    for (const t of plain) expect(maskMoneyText(t)).toBe(t);
  });

  it("refuses a longer uppercase token (lookbehind) and a third decimal (lookahead)", () => {
    expect(maskMoneyText("PTPTN 300.00")).toBe("PTPTN 300.00");
    expect(maskMoneyText("RM 12.345")).toBe("RM 12.345");
    // …but the real figure right after a longer token still masks.
    expect(maskMoneyText(`PTPTN ${formatSen(30_000)}`)).toBe(`PTPTN ${MASKED_MYR}`);
  });
});

describe("the per-device cookie (ruling 1)", () => {
  it("is named duit_amounts", () => {
    expect(AMOUNTS_COOKIE).toBe("duit_amounts");
  });

  it("hidden writes the value with path, one-year max-age and SameSite=Lax", () => {
    expect(amountsCookieString(true, false)).toBe(
      "duit_amounts=hidden; path=/; max-age=31536000; SameSite=Lax",
    );
    expect(amountsCookieString(true, true)).toBe(
      "duit_amounts=hidden; path=/; max-age=31536000; SameSite=Lax; Secure",
    );
  });

  it("shown DELETES the cookie (max-age=0, same attributes) — absent means shown", () => {
    expect(amountsCookieString(false, false)).toBe("duit_amounts=; path=/; max-age=0; SameSite=Lax");
    expect(amountsCookieString(false, true)).toBe(
      "duit_amounts=; path=/; max-age=0; SameSite=Lax; Secure",
    );
  });
});

/**
 * Final review A, I2: the client's read of `document.cookie` — the SAME
 * literal comparison the app layout makes on the server (`value === "hidden"`),
 * so a page the service worker served from its cache with a stale
 * `initialHidden` can resync to the device's current choice.
 */
describe("readAmountsCookie — the client-side read of the cookie", () => {
  it("absent means shown", () => {
    expect(readAmountsCookie("")).toBe(false);
    expect(readAmountsCookie("sb-access-token=abc; theme=dark")).toBe(false);
  });

  it("duit_amounts=hidden means hidden, alone or among other cookies, at any position", () => {
    expect(readAmountsCookie("duit_amounts=hidden")).toBe(true);
    expect(readAmountsCookie("duit_amounts=hidden; theme=dark")).toBe(true);
    expect(readAmountsCookie("theme=dark; duit_amounts=hidden; sb-access-token=abc")).toBe(true);
    expect(readAmountsCookie("theme=dark; duit_amounts=hidden")).toBe(true);
  });

  it("any other value — including the deleted form's empty value — means shown", () => {
    expect(readAmountsCookie("duit_amounts=")).toBe(false);
    expect(readAmountsCookie("duit_amounts=shown")).toBe(false);
    expect(readAmountsCookie("duit_amounts=Hidden")).toBe(false);
    expect(readAmountsCookie("duit_amounts=hidden2")).toBe(false);
    expect(readAmountsCookie("duit_amounts=hidden=1")).toBe(false);
  });

  it("matches the whole name — a cookie that merely ends in or contains the name is not it", () => {
    expect(readAmountsCookie("x_duit_amounts=hidden")).toBe(false);
    expect(readAmountsCookie("duit_amounts_old=hidden")).toBe(false);
    expect(readAmountsCookie("x_duit_amounts=hidden; duit_amounts=hidden")).toBe(true);
  });

  it("tolerates the whitespace browsers put around `;` and at the ends", () => {
    expect(readAmountsCookie("theme=dark;duit_amounts=hidden")).toBe(true);
    expect(readAmountsCookie("  duit_amounts=hidden  ")).toBe(true);
    expect(readAmountsCookie("theme=dark;  duit_amounts=hidden ;x=1")).toBe(true);
  });
});
