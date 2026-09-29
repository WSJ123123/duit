"use client";

import { Card } from "@/components/Card";
import { useMoney } from "@/components/Money";

const inputStyle = {
  background: "var(--chip)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

/** Check icon (mockup v3 §3, `.zero-ok`) — exact unassigned RM 0 state. */
function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5.5 9.5l2.4 2.4L12.8 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface AllocStripProps {
  expectedIncomeSen: number;
  allocatedSen: number;
  savingsSen: number;
  unassignedSen: number;
  /** Edit mode: expected income becomes an input. */
  editable: boolean;
  expectedIncomeInput: string;
  onExpectedIncomeChange: (value: string) => void;
}

/** The mockup's 4-card alloc strip (v3 §3 `.alloc-strip`). Every value is
 *  functional data — visible with tips off. */
export function AllocStrip({
  expectedIncomeSen,
  allocatedSen,
  savingsSen,
  unassignedSen,
  editable,
  expectedIncomeInput,
  onExpectedIncomeChange,
}: AllocStripProps) {
  const { fmt } = useMoney();
  const unassignedColor =
    unassignedSen === 0 ? "var(--good-text)" : unassignedSen < 0 ? "var(--warning)" : "var(--ink-1)";

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <div className="text-xs" style={{ color: "var(--ink-3)" }}>
          Expected income
        </div>
        {editable ? (
          <input
            type="text"
            inputMode="decimal"
            value={expectedIncomeInput}
            onChange={(e) => onExpectedIncomeChange(e.target.value)}
            className="mt-1.5 w-full rounded-lg px-2 py-1 text-2xl font-semibold tracking-tight tabular-nums outline-none"
            style={inputStyle}
          />
        ) : (
          <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
            {fmt(expectedIncomeSen)}
          </div>
        )}
      </Card>
      <Card>
        <div className="text-xs" style={{ color: "var(--ink-3)" }}>
          Allocated to categories
        </div>
        <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
          {fmt(allocatedSen)}
        </div>
      </Card>
      <Card>
        <div className="text-xs" style={{ color: "var(--ink-3)" }}>
          To savings &amp; funds
        </div>
        <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums" style={{ color: "var(--ink-1)" }}>
          {fmt(savingsSen)}
        </div>
      </Card>
      <Card>
        <div className="text-xs" style={{ color: "var(--ink-3)" }}>
          Unassigned
        </div>
        <div
          className="mt-1.5 flex items-center gap-2 text-2xl font-semibold tracking-tight tabular-nums"
          style={{ color: unassignedColor }}
        >
          {unassignedSen === 0 ? <IconCheck /> : null}
          {fmt(unassignedSen)}
        </div>
      </Card>
    </div>
  );
}
