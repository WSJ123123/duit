"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { formatCcy, formatSen } from "@/lib/money";
import { formatSignedCcy } from "@/lib/pl-display";
import {
  MONEY_RE,
  amountsCookieString,
  maskBare,
  maskCcy,
  maskMoneyText,
  maskSen,
  readAmountsCookie,
} from "@/lib/money-mask";

/**
 * Plan 9 ruling 2 — ONE renderer, ONE mask. Every money figure the app shows
 * at rest reaches the screen through this module: server pages render
 * `<Money sen>` / `<MoneyText>`, client components call `fmt` / `fmtCcy` /
 * `text` from `useMoney()`. The pure formatters stay in `src/lib/money.ts`
 * and are fenced there (ruling 3, `money-guard.test.ts`).
 *
 * State is a per-device cookie (ruling 1) read once by the app layout so the
 * first paint is already masked, and flipped here on the client without a
 * round trip — every figure is client-rendered by this module, so the flip
 * is instant; the cookie only makes the next server render agree.
 */

interface MoneyState {
  hidden: boolean;
  toggle: () => void;
}

// Default = shown, toggle = no-op: `useMoney()` outside a provider never
// throws, so existing component tests keep their `RM x` assertions unwrapped.
const MoneyContext = createContext<MoneyState>({ hidden: false, toggle: () => {} });

export function MoneyProvider({
  initialHidden,
  children,
}: {
  initialHidden: boolean;
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const toggle = useCallback(() => {
    const next = !hidden;
    document.cookie = amountsCookieString(next, location.protocol === "https:");
    setHidden(next);
  }, [hidden]);
  // Final review A, I2: offline, the service worker's page cache can serve a
  // document (and its RSC payload) with the `initialHidden` baked in when
  // that URL was last fetched — the cookie may have flipped since. Adopt the
  // cookie's state on mount and whenever the page comes back (bfcache
  // `pageshow`, tab `visibilitychange`); no cookie write, no refresh. Online
  // the server rendered from the same cookie, so `setHidden` bails out
  // unchanged. Residual: one frame of the cached paint before the resync.
  useEffect(() => {
    const resync = () => setHidden(readAmountsCookie(document.cookie));
    resync();
    window.addEventListener("pageshow", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.removeEventListener("pageshow", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, []);
  return <MoneyContext.Provider value={{ hidden, toggle }}>{children}</MoneyContext.Provider>;
}

interface FmtOptions {
  /** Force the figure through regardless of state — the ruling-4 exemptions. */
  shown?: boolean;
  /** Q36 — the Unrealized P/L treatment (`+ RM x` / `− RM x` / `RM 0.00`,
   *  pl-display's `formatSignedCcy`); masked, the sign glyph stays. */
  signed?: boolean;
}

export function useMoney() {
  const { hidden, toggle } = useContext(MoneyContext);
  const masked = (opts?: FmtOptions) => hidden && !opts?.shown;
  const text = (str: string, opts?: FmtOptions) => (masked(opts) ? maskMoneyText(str) : str);
  const fmtCcy = (currency: string, minorUnits: number, opts?: FmtOptions) => {
    if (opts?.signed) return text(formatSignedCcy(currency, minorUnits), opts);
    return masked(opts) ? maskCcy(currency, minorUnits) : formatCcy(currency, minorUnits);
  };
  return {
    hidden,
    toggle,
    fmt: (sen: number, opts?: FmtOptions) => {
      if (opts?.signed) return text(formatSignedCcy("MYR", sen), opts);
      return masked(opts) ? maskSen(sen) : formatSen(sen);
    },
    fmtCcy,
    text,
  };
}

function Masked({ children }: { children: string }) {
  return (
    <span role="img" aria-label="amount hidden">
      {children}
    </span>
  );
}

/** The prefix-less figure the Activity/Transactions rows print today. */
function bareSen(sen: number): string {
  return formatSen(sen).replace(/^(−?)RM /, "$1");
}

export function Money({
  sen,
  currency,
  bare,
  shown,
  signed,
}: {
  sen: number;
  currency?: string;
  bare?: boolean;
  shown?: boolean;
  /** Q36 — `+ RM x` / `− RM x`; masked, the sign stays outside the span. */
  signed?: boolean;
}) {
  const { hidden } = useMoney();
  if (signed) return <MoneyText shown={shown}>{formatSignedCcy(currency ?? "MYR", sen)}</MoneyText>;
  if (!hidden || shown) {
    if (bare) return <>{bareSen(sen)}</>;
    return <>{currency ? formatCcy(currency, sen) : formatSen(sen)}</>;
  }
  // The sign sits OUTSIDE the masked span (review m3): direction stays visible
  // and audible (ruling 4), only the magnitude is behind `amount hidden` —
  // the same shape `<MoneyText>` gives a figure inside a sentence.
  const sign = sen < 0 ? "−" : "";
  const abs = Math.abs(sen);
  const masked = bare ? maskBare(abs) : currency ? maskCcy(currency, abs) : maskSen(abs);
  return (
    <>
      {sign}
      <Masked>{masked}</Masked>
    </>
  );
}

/** A lib-built sentence (`balance RM 38,400.00 · minimum RM 850.00/mo`): each
 *  figure in the grammar becomes the masked span, the rest is untouched. */
export function MoneyText({ children, shown }: { children: string; shown?: boolean }) {
  const { hidden } = useMoney();
  if (!hidden || shown) return <>{children}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of children.matchAll(MONEY_RE)) {
    if (m.index > last) parts.push(children.slice(last, m.index));
    parts.push(<Masked key={m.index}>{maskMoneyText(m[0])}</Masked>);
    last = m.index + m[0].length;
  }
  if (last < children.length) parts.push(children.slice(last));
  return <>{parts}</>;
}

/** Mockup v8 §14/§15's eye; the slash is drawn only while amounts are hidden.
 *  Decorative — every button that draws it carries the accessible name. */
function IconEye({ slashed, size }: { slashed: boolean; size: number }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" style={{ width: size, height: size }}>
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      {slashed && <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

/**
 * Ruling 5 — one control per personality, one component. A plain button whose
 * label states the ACTION (`Hide amounts` / `Show amounts`, the show/hide-
 * password idiom, no `aria-pressed`); the state is what the page shows.
 * `sidebar` is the footer row between the email line and Logout (v8 §14;
 * collapsed = icon-only with `title` + `aria-label`, the Logout treatment);
 * `mobile` is the fixed 44 × 44 eye, top-right on every mobile screen (v8 §15).
 * Mounted by Task 3 Step 5, not before — a live control that hides nothing
 * would be a lying state on a privacy feature.
 */
export function AmountsToggle(
  props: { variant: "sidebar"; collapsed: boolean } | { variant: "mobile" },
) {
  const { hidden, toggle } = useMoney();
  const label = hidden ? "Show amounts" : "Hide amounts";

  if (props.variant === "mobile") {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={toggle}
        className="fixed z-40 flex items-center justify-center rounded-full md:hidden"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 10px)",
          right: 14,
          width: 44,
          height: 44,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--ink-2)",
          boxShadow: "0 2px 10px rgba(0,0,0,.08)",
        }}
      >
        <IconEye slashed={hidden} size={18} />
      </button>
    );
  }

  const { collapsed } = props;
  return (
    <button
      type="button"
      onClick={toggle}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={`flex w-full items-center gap-2.5 overflow-hidden whitespace-nowrap rounded-[9px] text-[12.5px] font-semibold ${
        collapsed ? "justify-center px-0 py-[9px]" : "px-2.5 py-2"
      }`}
      style={{ color: "var(--ink-2)" }}
    >
      <span className="flex-shrink-0" style={{ width: 16, height: 16 }}>
        <IconEye slashed={hidden} size={16} />
      </span>
      {!collapsed && <span>{label}</span>}
    </button>
  );
}
