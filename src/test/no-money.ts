import { MONEY_RE } from "../lib/money-mask";

/**
 * Plan 9 ruling 6 — the THREE rules of the masked-state assertion, in one
 * place, used verbatim by the route walk (`e2e/amounts-hidden.spec.ts`) and
 * by Tasks 2–3's masked-state component tests, so a false positive is fixed
 * once:
 *
 *  1. zero matches of the PREFIXED grammar (formatSen/formatCcy's output) and
 *     of the BARE grammar in the visible-tree text — every text node under
 *     the root, skipping `script`, `style`, `noscript` and `template`
 *     subtrees (the RSC flight payload lives in `<script>` and carries every
 *     `sen` prop — out of scope by ruling 4) and `[data-not-money]` subtrees
 *     (ruling 3's allowlist, enforced here a second time), but KEEPING
 *     `display:none` subtrees, `<option>` labels and SVG text;
 *  2. zero matches in every attribute value of every element, except
 *     `value`, `defaultValue` and `placeholder` on `input` / `textarea`
 *     (ruling 4's input exemption — SSR emits a prefilled amount as an
 *     attribute) and `class` / `style` on any element (owner ruling Q32:
 *     they never carry a rendered figure — `opacity: 0.45`,
 *     `grid-cols-[1.35fr_1fr]` were the bare grammar's false positives);
 *  3. none of the seeded values anywhere in that text or those attributes.
 */

export const PREFIXED_MONEY_RE = MONEY_RE;

/** A bare `1,234.56` not glued to more digits/dots and not a percent, a
 *  multiplier (`2.5×`, `2.5x`), a unit count or a rate (`p.a.`); the
 *  lookbehind refuses a version-ish `v1.00` and mid-number positions. */
export const BARE_MONEY_RE = /(?<![\d.,vV])\d{1,3}(?:,\d{3})*\.\d{2}(?![\d.]|\s?(?:%|×|x\b|units?\b|p\.a\.))/g;

export interface MoneySurfaces {
  /** Visible-tree text nodes, newline-joined. */
  text: string;
  /** Every non-exempt attribute value under the root. */
  attrs: string[];
}

/**
 * Collects the surfaces from a live DOM. SELF-CONTAINED (no closures over
 * module scope) so Playwright can ship it into the page as-is:
 * `page.evaluate(collectMoneySurfaces, bodyHandle)`.
 */
export function collectMoneySurfaces(root: Element): MoneySurfaces {
  const SKIP = ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"];
  const INPUTS = ["INPUT", "TEXTAREA"];
  const EXEMPT = ["value", "defaultvalue", "placeholder"];
  const NEVER_FIGURE = ["class", "style"];
  const texts: string[] = [];
  const attrs: string[] = [];
  const skipped = (el: Element) =>
    SKIP.indexOf(el.tagName.toUpperCase()) !== -1 || el.hasAttribute("data-not-money");
  const takeAttrs = (el: Element) => {
    const isInput = INPUTS.indexOf(el.tagName.toUpperCase()) !== -1;
    for (const name of el.getAttributeNames()) {
      if (NEVER_FIGURE.indexOf(name.toLowerCase()) !== -1) continue;
      if (isInput && EXEMPT.indexOf(name.toLowerCase()) !== -1) continue;
      attrs.push(el.getAttribute(name) ?? "");
    }
  };
  if (!skipped(root)) takeAttrs(root);
  const walker = root.ownerDocument.createTreeWalker(root, 0x1 | 0x4, {
    acceptNode: (node: Node) => (node.nodeType === 1 && skipped(node as Element) ? 2 : 1),
  });
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === 3) texts.push(node.nodeValue ?? "");
    else takeAttrs(node as Element);
    node = walker.nextNode();
  }
  return { text: texts.join("\n"), attrs };
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * The same three rules over STATIC markup (`renderToStaticMarkup` output, or
 * `page.content()` of a JavaScript-disabled load) — the house's component
 * tests have no DOM environment. A small tag tokenizer with a skip stack.
 */
export function surfacesFromMarkup(html: string): MoneySurfaces {
  const texts: string[] = [];
  const attrs: string[] = [];
  const TAG_RE =
    /<!--[\s\S]*?-->|<!(?:DOCTYPE|doctype)[^>]*>|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  const skipStack: boolean[] = []; // one entry per open element: did it start a skipped subtree?
  let depthSkipped = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > last && depthSkipped === 0) texts.push(decodeEntities(html.slice(last, m.index)));
    last = TAG_RE.lastIndex;
    if (m[0].startsWith("<!")) continue;
    const closing = m[1];
    if (closing) {
      if (skipStack.pop()) depthSkipped--;
      continue;
    }
    const tag = (m[2] ?? "").toLowerCase();
    const attrText = m[3] ?? "";
    const selfClosing = m[4] === "/" || VOID_TAGS.has(tag);
    const isSkipTag = tag === "script" || tag === "style" || tag === "noscript" || tag === "template";
    let notMoney = false;
    const own: { name: string; value: string }[] = [];
    let a: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrText)) !== null) {
      const name = (a[1] ?? "").toLowerCase();
      if (name === "data-not-money") notMoney = true;
      own.push({ name, value: decodeEntities(a[2] ?? a[3] ?? a[4] ?? "") });
    }
    if (depthSkipped === 0 && !isSkipTag && !notMoney) {
      const isInput = tag === "input" || tag === "textarea";
      for (const { name, value } of own) {
        if (name === "class" || name === "style") continue;
        if (isInput && (name === "value" || name === "defaultvalue" || name === "placeholder")) continue;
        attrs.push(value);
      }
    }
    if (isSkipTag && !selfClosing) {
      // Raw-text content (the RSC payload, inline CSS): jump past the closing
      // tag rather than tokenizing what is inside it.
      const close = new RegExp(`</${tag}\\s*>`, "ig");
      close.lastIndex = last;
      const c = close.exec(html);
      last = c ? close.lastIndex : html.length;
      TAG_RE.lastIndex = last;
      continue;
    }
    if (!selfClosing) {
      skipStack.push(notMoney);
      if (notMoney) depthSkipped++;
    }
  }
  if (last < html.length && depthSkipped === 0) texts.push(decodeEntities(html.slice(last)));
  return { text: texts.join("\n"), attrs };
}

export interface MoneyFindings {
  prefixed: string[];
  bare: string[];
  attrs: string[];
  seeded: string[];
}

export function findMoney(surfaces: MoneySurfaces, seeded: readonly string[] = []): MoneyFindings {
  const prefixed = surfaces.text.match(PREFIXED_MONEY_RE) ?? [];
  const bare = surfaces.text.match(BARE_MONEY_RE) ?? [];
  const attrs = surfaces.attrs.flatMap((v) => [
    ...(v.match(PREFIXED_MONEY_RE) ?? []),
    ...(v.match(BARE_MONEY_RE) ?? []),
  ]);
  const seededHits = seeded.filter(
    (v) => surfaces.text.includes(v) || surfaces.attrs.some((a) => a.includes(v)),
  );
  return { prefixed: [...prefixed], bare: [...bare], attrs, seeded: seededHits };
}

export function isClean(f: MoneyFindings): boolean {
  return f.prefixed.length === 0 && f.bare.length === 0 && f.attrs.length === 0 && f.seeded.length === 0;
}

export function describeFindings(f: MoneyFindings): string {
  return `prefixed ${JSON.stringify(f.prefixed)} · bare ${JSON.stringify(f.bare)} · attrs ${JSON.stringify(
    f.attrs,
  )} · seeded ${JSON.stringify(f.seeded)}`;
}

/**
 * Throws naming every survivor when any money grammar or seeded value is
 * found under `container` — a live element, or static markup as a string.
 */
export function assertNoMoney(container: Element | string, seeded: readonly string[] = []): void {
  const surfaces =
    typeof container === "string" ? surfacesFromMarkup(container) : collectMoneySurfaces(container);
  const findings = findMoney(surfaces, seeded);
  if (!isClean(findings)) {
    throw new Error(`money survived the mask: ${describeFindings(findings)}`);
  }
}
