import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatSen } from "@/lib/money";
import { MASKED_MYR } from "@/lib/money-mask";
import { Money, MoneyProvider, MoneyText } from "@/components/Money";
import { BARE_MONEY_RE, assertNoMoney, findMoney, surfacesFromMarkup } from "@/test/no-money";

/** The shared masked-state helper, pinned on static markup (ruling 6's three rules). */
describe("assertNoMoney — static markup path", () => {
  it("passes on markup that only carries the mask", () => {
    const html = renderToStaticMarkup(
      createElement(
        MoneyProvider,
        { initialHidden: true } as Parameters<typeof MoneyProvider>[0],
        createElement("p", { title: "total" }, createElement(Money, { sen: 123_456 })),
        createElement(MoneyText, null, `balance ${formatSen(3_840_000)} · 3% paid · 4 entries`),
      ),
    );
    expect(html).toContain(MASKED_MYR);
    expect(() => assertNoMoney(html, ["1,234.56", "38,400.00"])).not.toThrow();
  });

  it("names a prefixed figure, a bare figure, an attribute figure and a seeded value", () => {
    const html = `<div title="RM 5.00"><b>${formatSen(123_456)}</b><i>87.65</i><u>abc</u></div>`;
    const f = findMoney(surfacesFromMarkup(html), ["abc"]);
    expect(f.prefixed).toEqual(["RM 1,234.56"]);
    expect(f.bare).toEqual(["1,234.56", "87.65"]);
    expect(f.attrs).toEqual(["RM 5.00", "5.00"]);
    expect(f.seeded).toEqual(["abc"]);
    expect(() => assertNoMoney(html)).toThrow(/money survived the mask/);
  });

  it("skips script/style/noscript/template subtrees and [data-not-money] subtrees", () => {
    const html =
      `<div><script>self.__next_f.push([1,"<b>RM 9.99</b> 1,234.56"])</script>` +
      `<style>.x{content:"RM 1.00"}</style><noscript>RM 2.00</noscript><template>RM 3.00</template>` +
      `<span data-not-money="" title="RM 4.00">1.2345 <i>0.50</i></span><p>ok</p></div>`;
    const s = surfacesFromMarkup(html);
    expect(s.text.replace(/\s+/g, " ").trim()).toBe("ok");
    expect(s.attrs).toEqual([]);
    expect(() => assertNoMoney(html)).not.toThrow();
  });

  it("keeps display:none subtrees, <option> labels and SVG text", () => {
    const html =
      `<div style="display:none">RM 1.00</div><select><option value="a">RM 2.00</option></select>` +
      `<svg><title>RM 3.00</title><text>4.00</text></svg>`;
    const f = findMoney(surfacesFromMarkup(html));
    expect(f.prefixed).toEqual(["RM 1.00", "RM 2.00", "RM 3.00"]);
    expect(f.bare).toEqual(["1.00", "2.00", "3.00", "4.00"]);
  });

  it("exempts value / defaultValue / placeholder on input and textarea only", () => {
    const ok = `<input type="text" value="1,234.56" placeholder="0.00"/><textarea placeholder="12.00"></textarea>`;
    expect(() => assertNoMoney(ok)).not.toThrow();
    const bad = `<input type="text" aria-label="RM 12.00" value="1.00"/>`;
    expect(findMoney(surfacesFromMarkup(bad)).attrs).toEqual(["RM 12.00", "12.00"]);
    const notInput = `<div value="1,234.56"></div>`;
    expect(findMoney(surfacesFromMarkup(notInput)).attrs).toEqual(["1,234.56"]);
  });

  it("ignores class and style attributes — they never carry a rendered figure (owner ruling Q32)", () => {
    const html =
      `<div class="lg:grid-cols-[1.35fr_1fr]" style="opacity:0.45"><span style="width:12.50%">ok</span></div>`;
    expect(surfacesFromMarkup(html).attrs).toEqual([]);
    expect(() => assertNoMoney(html)).not.toThrow();
    // Every other attribute is still read.
    expect(findMoney(surfacesFromMarkup(`<div class="x" title="RM 1.00"></div>`)).attrs).toEqual(["RM 1.00", "1.00"]);
  });

  it("decodes entities before matching", () => {
    expect(findMoney(surfacesFromMarkup("<p>RM&#x20;1.00</p>")).prefixed).toEqual(["RM 1.00"]);
  });
});

describe("BARE_MONEY_RE", () => {
  const bare = (s: string) => s.match(BARE_MONEY_RE) ?? [];

  it("matches a prefix-less figure and grouped figures", () => {
    expect(bare("87.65 and 1,234.56 and 123,456,789.01")).toEqual(["87.65", "1,234.56", "123,456,789.01"]);
  });

  it("refuses percents, multipliers, unit counts, rates, versions and longer decimals", () => {
    for (const s of ["1.00%", "1.00 %", "2.50×", "2.50x", "3.00 units", "1.00 unit", "4.00 p.a.", "v1.00", "12.345", "1.2345"]) {
      expect(bare(s), s).toEqual([]);
    }
  });
});
