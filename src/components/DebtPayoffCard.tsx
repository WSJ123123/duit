"use client";

import { useState, type ReactNode } from "react";
import { Tip } from "@/components/Tip";
import { inputStyle } from "@/components/DialogKit";
import { parseAmountToSen } from "@/lib/money";
import { useMoney } from "@/components/Money";
import { ratePct } from "@/lib/debt";
import {
  BEYOND_COPY,
  NEVER_COPY,
  NO_BALANCE_COPY,
  NO_RATE_COPY,
  isCritical,
  mobileLine,
  progressLine,
  toView,
  whatIfWord,
  type Payoff,
} from "@/lib/debt-display";
import type { LiabilityListRow } from "@/db/networth";

/**
 * Debt payoff card (Plan 8 rulings 9–10; mockup v7 §11 desktop table, §13
 * mobile stacked cards). One row per ACTIVE liability, rendered from the
 * rows getNetWorth computed — the server projection is the initial render.
 * The extra-per-month what-if at the foot recomputes every row client-side
 * through the same pure lib (src/lib/debt.ts, finding #20) and saves
 * nothing. Tips-off baseline (ruling 23 carried): balance, payoff month,
 * months, interest, progress and the no-date states are data and stay; only
 * the two explanatory lines are Tips.
 *
 * Visual choices the mockup leaves open (ruling 20 — its arithmetic is
 * illustrative): the desktop sub-line leads with the balance so every row
 * keeps it tips-off as ruling 10 lists; the track is critical for the two
 * no-date states and accent otherwise (the mockup's green/plain split has no
 * stated rule); the card is omitted while there is no active liability.
 */

function Track({ pct, critical }: { pct: number | null; critical: boolean }) {
  return (
    <span className="block h-[7px] w-full overflow-hidden rounded" style={{ background: "var(--accent-track)" }}>
      <span
        className="block h-full rounded"
        style={{ width: `${pct ?? 0}%`, background: critical ? "var(--critical)" : "var(--accent)" }}
      />
    </span>
  );
}

function Sub({ children, critical }: { children: ReactNode; critical?: boolean }) {
  return (
    <span className="mt-0.5 block text-[11.5px] font-normal" style={{ color: critical ? "var(--critical)" : "var(--ink-3)" }}>
      {children}
    </span>
  );
}

function PayoffCell({ p }: { p: Payoff }) {
  const { fmt } = useMoney();
  switch (p.kind) {
    case "dated":
      return (
        <>
          <span className="font-semibold" style={{ color: "var(--ink-1)" }}>
            {p.month}
          </span>
          <Sub>{p.months} months</Sub>
        </>
      );
    case "never":
      return (
        <>
          <span className="font-semibold" style={{ color: "var(--critical)" }}>
            {NEVER_COPY}
          </span>
          <Sub critical>
            {fmt(p.required_sen)}/mo would clear it by {p.by}
          </Sub>
        </>
      );
    case "beyond":
      return (
        <>
          <span className="font-semibold" style={{ color: "var(--critical)" }}>
            {BEYOND_COPY}
          </span>
          <Sub critical>
            {fmt(p.required_sen)}/mo would clear it by {p.by}
          </Sub>
        </>
      );
    case "paid":
      return (
        <span className="font-semibold" style={{ color: "var(--ink-1)" }}>
          paid off
        </span>
      );
    case "no_rate":
      return <span style={{ color: "var(--ink-3)" }}>{NO_RATE_COPY}</span>;
    case "no_balance":
      return <span style={{ color: "var(--ink-3)" }}>{NO_BALANCE_COPY}</span>;
  }
}

function ExtraInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span style={{ color: "var(--ink-3)" }}>RM</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        aria-label="Extra per month (RM)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-[110px] rounded-lg px-2.5 py-1.5 text-sm tabular-nums outline-none"
        style={inputStyle}
      />
    </span>
  );
}

export function DebtPayoffCard({ rows, todayIso }: { rows: LiabilityListRow[]; todayIso: string }) {
  const [extra, setExtra] = useState("");
  const { fmt, text } = useMoney();
  const extra_sen = extra.trim() === "" ? 0 : (parseAmountToSen(extra) ?? 0);
  const views = rows.map((r) => toView(r, extra_sen, todayIso));
  const whatIf = extra_sen > 0 ? views.map((v) => `${v.name} ${whatIfWord(v.payoff)}`).join(" · ") : null;

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Debt payoff
      </h3>
      {/* Data, not a Tip: which payments and which balances the card is projecting at. */}
      <p className="mb-3 text-xs" style={{ color: "var(--ink-2)" }}>
        at planned payments · from each latest balance
        <Tip as="span"> — projected month by month with each loan&apos;s own rate; nothing here moves your net worth</Tip>
      </p>

      {/* Desktop: v7 §11 table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Liability", "Payoff", "Interest to go", "Progress"].map((h, i) => (
                <th
                  key={h}
                  className={`px-2 py-1.5 text-[11.5px] font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                  style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {views.map((v) => {
              const critical = isCritical(v.payoff);
              const subParts = [fmt(v.balance_sen)];
              if (v.payment_sen !== null) subParts.push(`${fmt(v.payment_sen)}/mo`);
              if (v.rate_bp > 0) subParts.push(ratePct(v.rate_bp), `${fmt(v.interest_this_month_sen)} interest this month`);
              return (
                <tr key={v.id}>
                  <td
                    className="px-2 py-2.5 text-left align-top font-semibold"
                    style={{ color: "var(--ink-1)", borderBottom: "1px solid var(--grid)" }}
                  >
                    {v.name}
                    <Sub>{subParts.join(" · ")}</Sub>
                  </td>
                  <td
                    className="px-2 py-2.5 text-right align-top tabular-nums"
                    style={{ color: "var(--ink-2)", borderBottom: "1px solid var(--grid)" }}
                  >
                    <PayoffCell p={v.payoff} />
                  </td>
                  <td
                    className="px-2 py-2.5 text-right align-top font-semibold tabular-nums"
                    style={{ color: critical ? "var(--critical)" : "var(--ink-1)", borderBottom: "1px solid var(--grid)" }}
                  >
                    {v.payoff.kind === "dated" ? fmt(v.payoff.interest_sen) : "—"}
                  </td>
                  <td
                    className="px-2 py-2.5 text-right align-top tabular-nums"
                    style={{ color: "var(--ink-2)", borderBottom: "1px solid var(--grid)" }}
                  >
                    <span className="ml-auto block w-[220px] max-w-full">
                      <Track pct={v.progress_pct} critical={critical} />
                    </span>
                    <Sub>{text(progressLine(v))}</Sub>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div
          className="mt-3 flex flex-wrap items-center gap-2.5 pt-3 text-[12.5px]"
          style={{ color: "var(--ink-2)", borderTop: "1px solid var(--grid)" }}
        >
          <span>Extra per month</span>
          <ExtraInput value={extra} onChange={setExtra} />
          <Tip as="span">recomputes every row · nothing is saved</Tip>
          {whatIf ? (
            <span className="ml-auto font-semibold" style={{ color: "var(--ink-1)" }}>
              {whatIf}
            </span>
          ) : null}
        </div>
      </div>

      {/* Mobile: v7 §13 stacked cards */}
      <div className="flex flex-col gap-2.5 md:hidden">
        {views.map((v) => {
          const critical = isCritical(v.payoff);
          return (
            <div key={v.id} className="rounded-2xl px-3.5 py-3" style={{ background: "var(--chip)" }}>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[14.5px] font-semibold" style={{ color: "var(--ink-1)" }}>
                  {v.name}
                </span>
                <span className="text-sm font-bold tabular-nums" style={{ color: "var(--ink-1)" }}>
                  {fmt(-v.balance_sen)}
                </span>
              </div>
              <div className="mt-2">
                <Track pct={v.progress_pct} critical={critical} />
              </div>
              <div
                className="mt-1.5 text-[11.5px]"
                style={{ color: critical ? "var(--critical)" : "var(--ink-3)", fontWeight: critical ? 600 : 400 }}
              >
                {text(mobileLine(v))}
              </div>
            </div>
          );
        })}
        <div className="rounded-2xl px-3.5 py-3" style={{ border: "1px dashed var(--border)" }}>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            <span>Extra per month</span>
            <ExtraInput value={extra} onChange={setExtra} />
            {whatIf ? (
              <span className="font-semibold" style={{ color: "var(--ink-1)" }}>
                → {views.map((v) => whatIfWord(v.payoff)).join(" · ")}
              </span>
            ) : null}
            <Tip as="span"> — nothing is saved</Tip>
          </div>
        </div>
      </div>
    </div>
  );
}
