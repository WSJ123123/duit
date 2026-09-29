"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  selectAllocationPreset,
  updateAllocationPreset,
  updateEquitiesTarget,
  setHoldingTarget,
} from "@/app/(app)/investments/actions";
import type { AllocationData } from "@/db/networth";
import {
  RETURN_BP,
  bucketPcts,
  accessibleMonthsTenths,
  blendedReturnBp,
  stressLossSen,
  planInRinggit,
  driftLine,
  equitiesSplit,
  rebalanceHint,
  type PresetKey,
  type Bucket,
} from "@/lib/allocation";
import { useMoney } from "@/components/Money";
import type { sinkingReserveRow } from "@/lib/funds-display";
import { Button } from "@/components/Button";
import { Tip } from "@/components/Tip";
import { inputStyle, Field, DialogShell, ErrorLine, DialogButtons } from "@/components/DialogKit";

/**
 * Investments page › Allocation plan (Task 8, mockup v4 §5 binding; rulings
 * 12-16). Everything here is advisory — nothing blocks or moves money.
 * Single client component: preset cards + edit-targets dialog share local
 * "which preset is in focus" state that the page-level getAllocation() data
 * doesn't carry, so they can't be split across a server/client boundary
 * without duplicating that state.
 */

type PotBucket = "bank" | "cashlike" | "equities";
const POT_BUCKET_ORDER: PotBucket[] = ["bank", "cashlike", "equities"];
const POT_BUCKET_META: Record<Bucket, { label: string; color: string }> = {
  bank: { label: "Bank", color: "var(--accent)" },
  cashlike: { label: "Cash-like", color: "var(--series-2)" },
  equities: { label: "Equities", color: "var(--series-3)" },
  exclude: { label: "Exclude", color: "var(--ink-3)" },
};

const PRESET_ORDER: PresetKey[] = ["balanced", "growth", "aggressive", "barbell"];
const PRESET_META: Record<PresetKey, { letter: string; label: string; caption: string }> = {
  balanced: { letter: "A", label: "Balanced", caption: "Lowest volatility" },
  growth: { letter: "B", label: "Growth", caption: "Equity tilt" },
  aggressive: { letter: "C", label: "Aggressive", caption: "Max equities" },
  barbell: { letter: "D", label: "Barbell", caption: "Deep safety, then max growth" },
};

const KIND_PILL_LABEL: Record<string, string> = { etf: "ETF", stock: "stock", crypto: "crypto" };

type Pcts = { bank_pct: number; cashlike_pct: number; equities_pct: number };
type RinggitSplit = { bank_sen: number; cashlike_sen: number; equities_sen: number };

function pctOf(pcts: Pcts, bucket: PotBucket): number {
  return bucket === "bank" ? pcts.bank_pct : bucket === "cashlike" ? pcts.cashlike_pct : pcts.equities_pct;
}
function senOf(split: RinggitSplit, bucket: PotBucket): number {
  return bucket === "bank" ? split.bank_sen : bucket === "cashlike" ? split.cashlike_sen : split.equities_sen;
}

function monthsOneDecimal(tenths: number | null): string {
  return tenths === null ? "—" : `${(tenths / 10).toFixed(1)} mo`;
}

/** Basis points → "4.6%" (the Compare plans return column). */
function returnPctOneDecimal(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`;
}

/** Basis points → "3.5%" as written (the return-assumption Tip). */
function returnPctPlain(bp: number): string {
  return `${bp / 100}%`;
}

/** "10.0" — months of expenses, one decimal (Plan in ringgit's closing Tip). */
function monthsTenthsLabel(tenths: number): string {
  return (tenths / 10).toFixed(1);
}

/** Small line-icon check (contract: "not emoji") for the selected preset. */
function CheckIcon({ color = "var(--accent)" }: { color?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="inline-block h-3 w-3 flex-shrink-0" aria-hidden="true">
      <path d="M3 8.3l3 3 7-7" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Stacked bar (Target vs current)
// ---------------------------------------------------------------------------

function StackRow({ label, pcts, right }: { label: string; pcts: Pcts; right: string }) {
  return (
    <div className="grid grid-cols-[56px_1fr_88px] items-center gap-3 py-1.5">
      <span className="text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
        {label}
      </span>
      <div className="flex h-[26px] gap-0.5 overflow-hidden rounded-md">
        {POT_BUCKET_ORDER.map((b) => {
          const pct = pctOf(pcts, b);
          if (pct <= 0) return null;
          return (
            <div
              key={b}
              className="flex items-center justify-center text-[11px] font-bold text-white"
              style={{ width: `${pct}%`, background: POT_BUCKET_META[b].color }}
            >
              {pct}%
            </div>
          );
        })}
      </div>
      <span className="text-right text-xs tabular-nums" style={{ color: "var(--ink-3)" }}>
        {right}
      </span>
    </div>
  );
}

function TargetVsCurrentCard({ data, currentPcts }: { data: AllocationData; currentPcts: Pcts }) {
  const { fmt } = useMoney();
  const target = data.selected ? data.presets[data.selected] : null;
  const drifts = target ? driftLine(target, currentPcts) : null;

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Target vs current
      </h3>
      <Tip className="mb-3">
        whole pot, {fmt(data.buckets.pot_sen)} · cash-like = ASM &amp; MMF (no lock-in) · drift shows what to
        fix with future top-ups, not forced selling
      </Tip>
      <div className="mb-3 flex gap-4 text-xs" style={{ color: "var(--ink-2)" }}>
        {POT_BUCKET_ORDER.map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: POT_BUCKET_META[b].color }} />
            {POT_BUCKET_META[b].label}
          </span>
        ))}
      </div>
      {target ? (
        <StackRow label="Target" pcts={target} right={`${PRESET_META[data.selected!].letter} · ${PRESET_META[data.selected!].label}`} />
      ) : (
        <p className="py-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
          No plan selected yet — pick a card above, then Set as plan.
        </p>
      )}
      <StackRow label="Current" pcts={currentPcts} right="today" />
      {drifts ? (
        (() => {
          const worstUnder = drifts.reduce((a, b) => (b.pts < a.pts ? b : a));
          const worstOver = drifts.reduce((a, b) => (b.pts > a.pts ? b : a));
          if (worstUnder.pts >= 0) {
            return (
              <p className="mt-2.5 text-xs" style={{ color: "var(--good-text)" }}>
                On target — current allocation matches the plan.
              </p>
            );
          }
          return (
            <p className="mt-2.5 text-xs" style={{ color: "var(--ink-2)" }}>
              {POT_BUCKET_META[worstUnder.bucket].label}{" "}
              <b style={{ color: "var(--critical)" }}>{Math.abs(worstUnder.pts)} pts under</b> target ·{" "}
              {POT_BUCKET_META[worstOver.bucket].label}{" "}
              <b style={{ color: "var(--good-text)" }}>{worstOver.pts} pts over</b> —{" "}
              <b style={{ color: "var(--ink-1)" }}>
                route new savings to {POT_BUCKET_META[worstUnder.bucket].label.toLowerCase()} until level
              </b>
            </p>
          );
        })()
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare plans table
// ---------------------------------------------------------------------------

function ComparePlansCard({ data }: { data: AllocationData }) {
  const { fmt } = useMoney();
  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Compare plans
      </h3>
      <Tip className="mb-3">
        accessible = months of expenses reachable without selling a share (bank + ASM/MMF) · stress column = paper
        loss on {fmt(data.buckets.pot_sen)} if equities drop 40%
      </Tip>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {["Plan", "Bank", "Cash-like", "Equities", "Accessible", "Exp. return", "If equities −40%"].map(
                (h, i) => (
                  <th
                    key={h}
                    className={`px-2 py-1.5 text-xs font-semibold ${i === 0 ? "text-left" : "text-right"}`}
                    style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {PRESET_ORDER.map((key) => {
              const pcts = data.presets[key];
              const ringgit = planInRinggit(data.buckets.pot_sen, pcts);
              const accessible = accessibleMonthsTenths(
                ringgit.bank_sen + ringgit.cashlike_sen,
                data.avg_monthly_expense_sen,
              );
              const returnBp = blendedReturnBp(pcts);
              const stress = stressLossSen(ringgit.equities_sen);
              const isSelected = data.selected === key;
              return (
                <tr
                  key={key}
                  style={{
                    borderBottom: "1px solid var(--grid)",
                    background: isSelected ? "color-mix(in srgb, var(--accent) 7%, transparent)" : undefined,
                    fontWeight: isSelected ? 650 : 400,
                  }}
                >
                  <td className="px-2 py-2 text-left" style={{ color: "var(--ink-1)", fontWeight: 550 }}>
                    {PRESET_META[key].letter} · {PRESET_META[key].label}
                    {isSelected ? (
                      <span className="ml-1 inline-block align-middle">
                        <CheckIcon />
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                    {pcts.bank_pct}%
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                    {pcts.cashlike_pct}%
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                    {pcts.equities_pct}%
                  </td>
                  <td data-not-money className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                    {monthsOneDecimal(accessible)}
                  </td>
                  <td data-not-money className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
                    {returnPctOneDecimal(returnBp)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--critical)" }}>
                    {fmt(-stress)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Tip className="mt-3">
        assumes {returnPctPlain(RETURN_BP.bank)} / {returnPctPlain(RETURN_BP.cashlike)} /{" "}
        {returnPctPlain(RETURN_BP.equities)} annual return
        for bank / cash-like / equities (ruling 14) — accessible = (bank + cash-like) ÷ average monthly expense;
        stress = a 40% drop applied to the plan&rsquo;s equities slice on today&rsquo;s pot
      </Tip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan in ringgit
// ---------------------------------------------------------------------------

function PlanInRinggitCard({ data, reserve }: { data: AllocationData; reserve: SinkingReserve }) {
  const { fmt } = useMoney();
  if (!data.selected) return null;
  const pcts = data.presets[data.selected];
  const ringgit = planInRinggit(data.buckets.pot_sen, pcts);
  const accessible = accessibleMonthsTenths(
    ringgit.bank_sen + ringgit.cashlike_sen,
    data.avg_monthly_expense_sen,
  );
  const rows: Array<{ label: string; tip: string; pct: number; sen: number }> = [
    { label: "Spending float", tip: "everyday bank buffer", pct: pcts.bank_pct, sen: ringgit.bank_sen },
    {
      label: "Emergency buffer",
      tip: "cash-like — ASM/MMF, no lock-in",
      pct: pcts.cashlike_pct,
      sen: ringgit.cashlike_sen,
    },
    { label: "Growth", tip: "equities — ETFs & stocks", pct: pcts.equities_pct, sen: ringgit.equities_sen },
  ];

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Plan in ringgit
      </h3>
      <Tip className="mb-2">the selected plan mapped onto your real accounts</Tip>
      <div>
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-3 py-2.5 text-sm"
            style={{ borderBottom: "1px solid var(--grid)" }}
          >
            <span className="flex-1 font-medium" style={{ color: "var(--ink-1)" }}>
              {r.label}
              <Tip as="span" className="mt-0.5 block">
                {r.tip}
              </Tip>
            </span>
            <span className="w-11 flex-shrink-0 text-right text-xs tabular-nums" style={{ color: "var(--ink-3)" }}>
              {r.pct}%
            </span>
            <span className="flex-shrink-0 whitespace-nowrap font-bold tabular-nums" style={{ color: "var(--ink-1)" }}>
              {fmt(r.sen)}
            </span>
          </div>
        ))}
        {/*
          Ruling 20: the ONE row this plan adds. Below a divider, NO percentage
          (an em-dash in the % column) and part of NO sum in this card — it is
          an earmark over money the three rows above already count, so the
          pot's arithmetic does not move by one sen (ruling 1). The existing
          `Emergency buffer` row above is a different thing entirely (the
          preset's cash-like TARGET) and is deliberately untouched.
        */}
        {reserve ? (
          <div
            className="flex items-center gap-3 pt-2.5 pb-2.5 text-sm"
            style={{ borderTop: "1px solid var(--baseline)", marginTop: "6px" }}
          >
            <span className="flex-1 font-medium" style={{ color: "var(--ink-1)" }}>
              Sinking fund reserve
              <Tip as="span" className="mt-0.5 block">
                what Goals has earmarked out of the money above
              </Tip>
              {/* Data, not a Tip — stays visible with tips off (ruling 23). */}
              <span className="mt-0.5 block text-[11.5px] font-normal" style={{ color: "var(--ink-3)" }}>
                {reserve.sub}
              </span>
            </span>
            <span className="w-11 flex-shrink-0 text-right text-xs tabular-nums" style={{ color: "var(--ink-3)" }}>
              —
            </span>
            <span
              className="flex-shrink-0 whitespace-nowrap font-bold tabular-nums"
              style={{ color: reserve.total_sen < 0 ? "var(--critical)" : "var(--ink-1)" }}
            >
              {fmt(reserve.total_sen)}
            </span>
          </div>
        ) : null}
      </div>
      {reserve ? (
        <div
          className="mt-2 flex items-center justify-between gap-3 pt-2.5 text-xs font-semibold"
          style={{ borderTop: "1px solid var(--grid)", color: "var(--ink-2)" }}
        >
          <span>Earmarked, not extra — the plan above already counts it</span>
          <span className="tabular-nums">{fmt(reserve.total_sen)}</span>
        </div>
      ) : null}
      <Tip className="mt-3">
        {accessible === null
          ? "add spending history to see how many months this covers"
          : (
            <>
              ✓ <span data-not-money>{monthsTenthsLabel(accessible)}</span> months reachable without selling a
              single share.
            </>
          )}
      </Tip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Equities split
// ---------------------------------------------------------------------------

function EquitiesSplitCard({ data }: { data: AllocationData }) {
  if (data.equities_rows.length === 0) return null;
  const split = equitiesSplit(data.equities_rows, data.target_etf_pct);
  const hintId = rebalanceHint(split);
  const hintRow = hintId ? data.equities_rows.find((r) => r.id === hintId) : undefined;
  const bySplitId = new Map(split.holdings.map((h) => [h.id, h]));

  return (
    <div className="rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Equities split
      </h3>
      <Tip className="mb-2">
        inside the {data.selected ? `${data.presets[data.selected].equities_pct}%` : ""} growth slice · targets
        editable · tick = per-holding target
      </Tip>
      <div className="my-1.5 flex h-[22px] gap-0.5 overflow-hidden rounded-md">
        {split.etf_pct > 0 ? (
          <div
            className="flex items-center justify-center text-[11px] font-bold text-white"
            style={{ width: `${split.etf_pct}%`, background: "var(--series-3)" }}
          >
            ETF {split.etf_pct}%
          </div>
        ) : null}
        {split.stock_pct > 0 ? (
          <div
            className="flex items-center justify-center text-[11px] font-bold"
            style={{
              width: `${split.stock_pct}%`,
              background: "color-mix(in srgb, var(--series-3) 45%, var(--surface))",
              color: "var(--ink-1)",
            }}
          >
            Stocks {split.stock_pct}%
          </div>
        ) : null}
      </div>
      <div className="mb-2.5 flex justify-between text-xs" style={{ color: "var(--ink-3)" }}>
        <span>target {data.target_etf_pct}% ETF</span>
        <span>target {100 - data.target_etf_pct}% stocks</span>
      </div>
      <div>
        {data.equities_rows.map((row) => {
          const h = bySplitId.get(row.id);
          const pct = h?.pct ?? 0;
          return (
            <div
              key={row.id}
              className="grid grid-cols-[1fr_74px_150px] items-center gap-2.5 py-2 text-sm"
              style={{ borderBottom: "1px solid var(--grid)" }}
            >
              <span className="flex items-center gap-2 font-semibold" style={{ color: "var(--ink-1)" }}>
                {row.symbol}
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold"
                  style={{ background: "var(--chip)", color: "var(--ink-2)" }}
                >
                  {KIND_PILL_LABEL[row.kind] ?? row.kind}
                </span>
              </span>
              <span className="text-right text-xs tabular-nums" style={{ color: "var(--ink-3)" }}>
                <b style={{ color: "var(--ink-1)" }}>{pct}%</b> / {row.target_pct === null ? "—" : `${row.target_pct}%`}
              </span>
              <span
                className="relative h-2 rounded-full"
                style={{ background: "var(--chip)" }}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${pct}%`, background: "var(--series-3)" }}
                />
                {row.target_pct !== null ? (
                  <span
                    className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-sm"
                    style={{ left: `${row.target_pct}%`, background: "var(--ink-2)" }}
                  />
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {hintRow ? (
        <p className="mt-3 text-xs font-semibold" style={{ color: "var(--accent)" }}>
          → Next top-up: {hintRow.symbol} (most under target)
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset cards + edit-targets dialog
// ---------------------------------------------------------------------------

function PresetCard({
  presetKey,
  pcts,
  potSen,
  avgExpenseSen,
  isFocused,
  isSelected,
  onClick,
}: {
  presetKey: PresetKey;
  pcts: Pcts;
  potSen: number;
  avgExpenseSen: number;
  isFocused: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  const meta = PRESET_META[presetKey];
  const ringgit = planInRinggit(potSen, pcts);
  const monthsTenths = accessibleMonthsTenths(ringgit.bank_sen + ringgit.cashlike_sen, avgExpenseSen);
  const monthsLabel = monthsTenths === null ? "—" : `${Math.round(monthsTenths / 10)}`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-1 rounded-2xl p-3.5 text-left"
      style={{
        background: "var(--surface)",
        border: `1.5px solid ${isSelected || isFocused ? "var(--accent)" : "var(--border)"}`,
        boxShadow: isSelected ? "0 0 0 1px var(--accent)" : "none",
      }}
    >
      <span className="flex items-center gap-1.5 text-sm font-bold" style={{ color: "var(--ink-1)" }}>
        {meta.letter} · {meta.label}
        {isSelected ? <CheckIcon /> : null}
      </span>
      <span className="text-xs" style={{ color: "var(--ink-2)" }}>
        ~{monthsLabel}-mo buffer · {pcts.equities_pct}% equities
      </span>
      <Tip className="mt-0">{meta.caption}</Tip>
    </button>
  );
}

function EditTargetsDialog({
  presetKey,
  pcts,
  targetEtfPct,
  holdings,
  onClose,
}: {
  presetKey: PresetKey;
  pcts: Pcts;
  targetEtfPct: number;
  holdings: AllocationData["equities_rows"];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [bank, setBank] = useState(String(pcts.bank_pct));
  const [cashlike, setCashlike] = useState(String(pcts.cashlike_pct));
  const [equities, setEquities] = useState(String(pcts.equities_pct));
  const [etfTarget, setEtfTarget] = useState(String(targetEtfPct));
  const [holdingTargets, setHoldingTargets] = useState<Record<string, string>>(
    Object.fromEntries(holdings.map((h) => [h.id, h.target_pct === null ? "" : String(h.target_pct)])),
  );
  const [error, setError] = useState<string>();

  const sum = (Number(bank) || 0) + (Number(cashlike) || 0) + (Number(equities) || 0);

  function submit() {
    const bankN = Number(bank);
    const cashN = Number(cashlike);
    const eqN = Number(equities);
    for (const [n, label] of [
      [bankN, "Bank"],
      [cashN, "Cash-like"],
      [eqN, "Equities"],
    ] as const) {
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        setError(`${label} must be a whole number 0–100.`);
        return;
      }
    }
    if (bankN + cashN + eqN !== 100) {
      setError("Bank + cash-like + equities must sum to 100.");
      return;
    }
    const etfN = Number(etfTarget);
    if (!Number.isInteger(etfN) || etfN < 0 || etfN > 100) {
      setError("Target ETF % must be a whole number 0–100.");
      return;
    }
    const parsedHoldingTargets: Record<string, number | null> = {};
    for (const h of holdings) {
      const raw = (holdingTargets[h.id] ?? "").trim();
      if (raw === "") {
        parsedHoldingTargets[h.id] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        setError(`${h.symbol}'s target must be a whole number 0–100, or blank.`);
        return;
      }
      parsedHoldingTargets[h.id] = n;
    }
    setError(undefined);
    startTransition(async () => {
      const results = await Promise.all([
        updateAllocationPreset(presetKey, { bank_pct: bankN, cashlike_pct: cashN, equities_pct: eqN }),
        updateEquitiesTarget(etfN),
        ...holdings.map((h) => setHoldingTarget(h.id, parsedHoldingTargets[h.id]!)),
      ]);
      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok) {
        setError(failed.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title={`Edit targets — ${PRESET_META[presetKey].letter} · ${PRESET_META[presetKey].label}`} onClose={onClose}>
      <div className="flex gap-2.5">
        <Field label="Bank %">
          <input type="number" min={0} max={100} value={bank} onChange={(e) => setBank(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
        </Field>
        <Field label="Cash-like %">
          <input type="number" min={0} max={100} value={cashlike} onChange={(e) => setCashlike(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
        </Field>
        <Field label="Equities %">
          <input type="number" min={0} max={100} value={equities} onChange={(e) => setEquities(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
        </Field>
      </div>
      <p className="text-xs" style={{ color: sum === 100 ? "var(--good-text)" : "var(--critical)" }}>
        Sum: {sum}%{sum === 100 ? "" : " — must total 100%"}
      </p>
      <Field label="Target ETF % (of the equities slice)">
        <input type="number" min={0} max={100} value={etfTarget} onChange={(e) => setEtfTarget(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle} />
      </Field>
      {holdings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Per-holding targets — blank leaves it out of the rebalance hint
          </span>
          {holdings.map((h) => (
            <div key={h.id} className="flex items-center gap-2.5">
              <span className="flex-1 text-sm" style={{ color: "var(--ink-1)" }}>
                {h.symbol}
                <span className="ml-1.5 text-xs" style={{ color: "var(--ink-3)" }}>
                  {KIND_PILL_LABEL[h.kind] ?? h.kind}
                </span>
              </span>
              <input
                type="number"
                min={0}
                max={100}
                placeholder="—"
                value={holdingTargets[h.id] ?? ""}
                onChange={(e) => setHoldingTargets((prev) => ({ ...prev, [h.id]: e.target.value }))}
                className="w-20 rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
            </div>
          ))}
        </div>
      ) : null}
      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/** Ruling 20's row payload, built server-side by `sinkingReserveRow`; null
 *  when there is no active fund to earmark anything. */
type SinkingReserve = ReturnType<typeof sinkingReserveRow>;

export function AllocationPlan({ data, reserve }: { data: AllocationData; reserve: SinkingReserve }) {
  const router = useRouter();
  const [focusedKey, setFocusedKey] = useState<PresetKey>(data.selected ?? "balanced");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const currentPcts = bucketPcts(data.buckets);

  function setAsPlan() {
    setError(undefined);
    startTransition(async () => {
      const result = await selectAllocationPreset(focusedKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold" style={{ color: "var(--ink-1)" }}>
          Allocation plan
        </h2>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={() => setDialogOpen(true)}>
            Edit targets
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={setAsPlan}
            disabled={pending || focusedKey === data.selected}
          >
            Set as plan
          </Button>
        </div>
      </div>
      <ErrorLine error={error} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PRESET_ORDER.map((key) => (
          <PresetCard
            key={key}
            presetKey={key}
            pcts={data.presets[key]}
            potSen={data.buckets.pot_sen}
            avgExpenseSen={data.avg_monthly_expense_sen}
            isFocused={focusedKey === key}
            isSelected={data.selected === key}
            onClick={() => setFocusedKey(key)}
          />
        ))}
      </div>

      <TargetVsCurrentCard data={data} currentPcts={currentPcts} />
      <ComparePlansCard data={data} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <PlanInRinggitCard data={data} reserve={reserve} />
        <EquitiesSplitCard data={data} />
      </div>

      {dialogOpen ? (
        <EditTargetsDialog
          presetKey={focusedKey}
          pcts={data.presets[focusedKey]}
          targetEtfPct={data.target_etf_pct}
          holdings={data.equities_rows}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
