import { describe, it, expect, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatSen, formatCcy } from "@/lib/money";
import { MASKED_MYR } from "@/lib/money-mask";
import { AmountsToggle, Money, MoneyProvider, MoneyText, useMoney } from "@/components/Money";

/**
 * Plan 9 rulings 1, 2 and 5 — the one renderer and its provider, at markup
 * level (the house shape: `renderToStaticMarkup`, no DOM environment). The
 * cookie contract is pinned through a spied `document.cookie` setter (cookie
 * attributes cannot be read back), both directions and both protocols. The
 * flip is pinned as state parity: the SAME provider renders the toggle's
 * label and a `<Money>` from one `hidden` value, so they cannot disagree.
 */
const MASKED_SPAN = (inner: string) => `<span role="img" aria-label="amount hidden">${inner}</span>`;

function provided(initialHidden: boolean, ...children: ReactNode[]) {
  return renderToStaticMarkup(
    createElement(MoneyProvider, { initialHidden } as Parameters<typeof MoneyProvider>[0], ...children),
  );
}

/** Hand `useMoney()` out of a render so the test can call `toggle` afterwards. */
type MoneyApi = ReturnType<typeof useMoney>;
function Probe({ onRender }: { onRender: (api: MoneyApi) => void }) {
  onRender(useMoney());
  return null;
}
function capture(): { api?: MoneyApi; probe: ReactNode } {
  const box: { api?: MoneyApi; probe: ReactNode } = { probe: null };
  box.probe = createElement(Probe, {
    onRender: (api) => {
      box.api = api;
    },
  });
  return box;
}

/** A node-side stand-in for the browser globals `toggle` writes through. */
function stubBrowser(protocol: "https:" | "http:"): string[] {
  const writes: string[] = [];
  const doc = {};
  Object.defineProperty(doc, "cookie", {
    configurable: true,
    get: () => "",
    set: (v: string) => {
      writes.push(v);
    },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: doc });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { protocol },
  });
  return writes;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { location?: unknown }).location;
});

describe("MoneyProvider + <Money> (ruling 2)", () => {
  it("initialHidden=false renders formatSen's figure as plain text", () => {
    const html = provided(false, createElement(Money, { sen: 123_456 }));
    expect(html).toBe(formatSen(123_456));
    expect(html).not.toContain("amount hidden");
  });

  it("initialHidden=true renders the fixed-width mask in the aria-labelled span", () => {
    const html = provided(true, createElement(Money, { sen: 123_456 }));
    expect(html).toBe(MASKED_SPAN(MASKED_MYR));
  });

  it("no provider → shown (the context default), never throws", () => {
    const html = renderToStaticMarkup(createElement(Money, { sen: 123_456 }));
    expect(html).toBe(formatSen(123_456));
  });

  it("keeps the sign glyph when hidden, OUTSIDE the masked span (direction stays visible and audible)", () => {
    expect(provided(true, createElement(Money, { sen: -1_250 }))).toBe(`−${MASKED_SPAN(MASKED_MYR)}`);
    expect(provided(false, createElement(Money, { sen: -1_250 }))).toBe(formatSen(-1_250));
  });

  it("currency → the formatCcy path, masked to `<CUR> ••••`", () => {
    expect(provided(false, createElement(Money, { sen: 123_456, currency: "USD" }))).toBe(
      formatCcy("USD", 123_456),
    );
    expect(provided(true, createElement(Money, { sen: 123_456, currency: "USD" }))).toBe(
      MASKED_SPAN("USD ••••"),
    );
    expect(provided(true, createElement(Money, { sen: 5, currency: "MYR" }))).toBe(MASKED_SPAN(MASKED_MYR));
    expect(provided(true, createElement(Money, { sen: -5, currency: "USD" }))).toBe(`−${MASKED_SPAN("USD ••••")}`);
  });

  it("bare → the figure without its prefix; masked to `••••`", () => {
    expect(provided(false, createElement(Money, { sen: 123_456, bare: true }))).toBe("1,234.56");
    expect(provided(false, createElement(Money, { sen: -123_456, bare: true }))).toBe("−1,234.56");
    expect(provided(true, createElement(Money, { sen: 123_456, bare: true }))).toBe(MASKED_SPAN("••••"));
    expect(provided(true, createElement(Money, { sen: -123_456, bare: true }))).toBe(`−${MASKED_SPAN("••••")}`);
  });

  it("shown forces the figure through regardless of state (ruling 4 exemptions)", () => {
    expect(provided(true, createElement(Money, { sen: 123_456, shown: true }))).toBe(formatSen(123_456));
  });
});

describe("useMoney() — fmt / fmtCcy / text", () => {
  function Figures() {
    const { hidden, fmt, fmtCcy, text } = useMoney();
    return createElement(
      "p",
      null,
      `${String(hidden)}|${fmt(123_456)}|${fmt(-99)}|${fmtCcy("SGD", 250_000)}|${fmt(123_456, { shown: true })}|${text(
        `balance ${formatSen(3_840_000)} · minimum ${formatSen(85_000)}/mo`,
      )}|${text(`balance ${formatSen(3_840_000)}`, { shown: true })}`,
    );
  }

  it("shown: fmt is formatSen, fmtCcy is formatCcy, text is identity", () => {
    const html = provided(false, createElement(Figures));
    expect(html).toBe(
      `<p>false|${formatSen(123_456)}|${formatSen(-99)}|${formatCcy("SGD", 250_000)}|${formatSen(123_456)}|balance ${formatSen(3_840_000)} · minimum ${formatSen(85_000)}/mo|balance ${formatSen(3_840_000)}</p>`,
    );
  });

  it("hidden: fmt masks, fmtCcy masks, text masks every figure; shown:true bypasses", () => {
    const html = provided(true, createElement(Figures));
    expect(html).toBe(
      `<p>true|${MASKED_MYR}|−${MASKED_MYR}|SGD ••••|${formatSen(123_456)}|balance ${MASKED_MYR} · minimum ${MASKED_MYR}/mo|balance ${formatSen(3_840_000)}</p>`,
    );
  });

  it("without a provider, the hook reports shown", () => {
    const html = renderToStaticMarkup(createElement(Figures));
    expect(html.startsWith("<p>false|")).toBe(true);
  });
});

describe("signed P/L figures (Q36) — `+ RM x` / `− RM x` / `RM 0.00`", () => {
  function Signed() {
    const { fmt, fmtCcy } = useMoney();
    return createElement(
      "p",
      null,
      `${fmt(1_250, { signed: true })}|${fmt(-1_250, { signed: true })}|${fmt(0, { signed: true })}|${fmtCcy(
        "USD",
        -500,
        { signed: true },
      )}|${fmtCcy("MYR", 500, { signed: true })}|${fmt(1_250, { signed: true, shown: true })}`,
    );
  }

  it("shown: pl-display's explicit-sign treatment", () => {
    expect(provided(false, createElement(Signed))).toBe(
      "<p>+ RM 12.50|− RM 12.50|RM 0.00|− USD 5.00|+ RM 5.00|+ RM 12.50</p>",
    );
  });

  it("hidden: the sign glyph stays (direction, ruling 4), the magnitude masks", () => {
    expect(provided(true, createElement(Signed))).toBe(
      `<p>+ ${MASKED_MYR}|− ${MASKED_MYR}|${MASKED_MYR}|− USD ••••|+ ${MASKED_MYR}|+ RM 12.50</p>`,
    );
  });

  it("<Money signed>: the sign sits outside the masked span", () => {
    expect(provided(false, createElement(Money, { sen: 1_250, signed: true }))).toBe("+ RM 12.50");
    expect(provided(true, createElement(Money, { sen: -1_250, signed: true }))).toBe(`− ${MASKED_SPAN(MASKED_MYR)}`);
    expect(provided(true, createElement(Money, { sen: 0, signed: true }))).toBe(MASKED_SPAN(MASKED_MYR));
    expect(provided(true, createElement(Money, { sen: 700, currency: "USD", signed: true }))).toBe(
      `+ ${MASKED_SPAN("USD ••••")}`,
    );
  });
});

describe("<MoneyText>", () => {
  const sentence = `balance ${formatSen(3_840_000)} · minimum ${formatSen(85_000)}/mo`;

  it("shown: the string, untouched", () => {
    expect(provided(false, createElement(MoneyText, null, sentence))).toBe(sentence);
  });

  it("hidden: each figure becomes the aria-labelled masked span, the rest untouched", () => {
    expect(provided(true, createElement(MoneyText, null, sentence))).toBe(
      `balance ${MASKED_SPAN(MASKED_MYR)} · minimum ${MASKED_SPAN(MASKED_MYR)}/mo`,
    );
  });

  it("hidden: a sentence without money is unchanged", () => {
    expect(provided(true, createElement(MoneyText, null, "4 entries · 3% paid"))).toBe("4 entries · 3% paid");
  });
});

describe("toggle — the cookie contract (ruling 1)", () => {
  it("shown → hidden writes the one-year cookie; https adds Secure", () => {
    const writes = stubBrowser("https:");
    const c = capture();
    provided(false, c.probe);
    c.api!.toggle();
    expect(writes).toEqual(["duit_amounts=hidden; path=/; max-age=31536000; SameSite=Lax; Secure"]);
  });

  it("shown → hidden over http omits Secure", () => {
    const writes = stubBrowser("http:");
    const c = capture();
    provided(false, c.probe);
    c.api!.toggle();
    expect(writes).toEqual(["duit_amounts=hidden; path=/; max-age=31536000; SameSite=Lax"]);
  });

  it("hidden → shown DELETES the cookie (max-age=0), both protocols", () => {
    const secure = stubBrowser("https:");
    const a = capture();
    provided(true, a.probe);
    a.api!.toggle();
    expect(secure).toEqual(["duit_amounts=; path=/; max-age=0; SameSite=Lax; Secure"]);

    const plain = stubBrowser("http:");
    const b = capture();
    provided(true, b.probe);
    b.api!.toggle();
    expect(plain).toEqual(["duit_amounts=; path=/; max-age=0; SameSite=Lax"]);
  });

  it("provider-less toggle() is a no-op: no throw, no cookie write", () => {
    const writes = stubBrowser("https:");
    const c = capture();
    renderToStaticMarkup(c.probe);
    expect(() => c.api!.toggle()).not.toThrow();
    expect(writes).toEqual([]);
  });
});

describe("AmountsToggle (ruling 5, mockup v8 §14/§15)", () => {
  const EYE_PATH = "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z";
  const SLASH_PATH = "M3 13L13 3";

  it("sidebar, expanded, shown: a plain button reading `Hide amounts`, eye without slash", () => {
    const html = provided(false, createElement(AmountsToggle, { variant: "sidebar", collapsed: false }));
    expect(html).toContain('type="button"');
    expect(html).toContain(">Hide amounts<");
    expect(html).not.toContain("Show amounts");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain(EYE_PATH);
    expect(html).not.toContain(SLASH_PATH);
    // The eye is decorative — the button carries the name (final review A, M4).
    expect(html).toContain('<svg aria-hidden="true" focusable="false"');
  });

  it("sidebar, expanded, hidden: the label flips to `Show amounts` and the slash appears", () => {
    const html = provided(true, createElement(AmountsToggle, { variant: "sidebar", collapsed: false }));
    expect(html).toContain(">Show amounts<");
    expect(html).not.toContain("Hide amounts");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain(SLASH_PATH);
  });

  it("sidebar, collapsed: icon-only with title + aria-label carrying the same text", () => {
    const shown = provided(false, createElement(AmountsToggle, { variant: "sidebar", collapsed: true }));
    expect(shown).toContain('title="Hide amounts"');
    expect(shown).toContain('aria-label="Hide amounts"');
    expect(shown).not.toContain(">Hide amounts<");
    const hidden = provided(true, createElement(AmountsToggle, { variant: "sidebar", collapsed: true }));
    expect(hidden).toContain('title="Show amounts"');
    expect(hidden).toContain('aria-label="Show amounts"');
    expect(hidden).not.toContain(">Show amounts<");
  });

  it("mobile: a fixed 44×44 round eye, md:hidden, z-40, named by aria-label only", () => {
    const shown = provided(false, createElement(AmountsToggle, { variant: "mobile" }));
    expect(shown).toContain('type="button"');
    expect(shown).toContain('aria-label="Hide amounts"');
    expect(shown).not.toContain(">Hide amounts<");
    expect(shown).toContain("md:hidden");
    expect(shown).toContain("fixed");
    expect(shown).toContain("z-40");
    expect(shown).toContain("width:44px");
    expect(shown).toContain("height:44px");
    expect(shown).toContain("top:calc(env(safe-area-inset-top, 0px) + 10px)");
    expect(shown).toContain("right:14px");
    expect(shown).toContain("var(--surface)");
    expect(shown).toContain("var(--border)");
    expect(shown).not.toContain("aria-pressed");
    expect(shown).toContain('<svg aria-hidden="true" focusable="false"');
    const hidden = provided(true, createElement(AmountsToggle, { variant: "mobile" }));
    expect(hidden).toContain('aria-label="Show amounts"');
    expect(hidden).toContain(SLASH_PATH);
  });

  it("the label and a <Money> under the same provider flip together, in one render", () => {
    const tree = (hidden: boolean) =>
      provided(
        hidden,
        createElement(AmountsToggle, { variant: "sidebar", collapsed: false }),
        createElement(Money, { sen: 123_456 }),
      );
    const shown = tree(false);
    expect(shown).toContain(">Hide amounts<");
    expect(shown).toContain(formatSen(123_456));
    expect(shown).not.toContain(MASKED_MYR);
    const masked = tree(true);
    expect(masked).toContain(">Show amounts<");
    expect(masked).toContain(MASKED_SPAN(MASKED_MYR));
    expect(masked).not.toContain(formatSen(123_456));
  });
});
