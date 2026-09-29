"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { Button } from "@/components/Button";
import { planSplit, parsePercent, type Tag } from "@/lib/budget";
import { updateBenchmark } from "@/app/(app)/budget/actions";

/**
 * "Monthly split" allocation-guide card (mockup v3 lines 345–366, `.g-row` /
 * `.tick` / `.g-note`). Reads from the same `BudgetMonthData` the desktop
 * `BudgetTable` and mobile `BudgetMobile` already render — advisory only,
 * never blocks saving a plan.
 */

interface SplitRow {
  tag: Tag;
  allocated_sen: number;
}

export interface Benchmark {
  needs_pct: number;
  wants_pct: number;
  savings_pct: number;
}

interface GuideBarProps {
  label: string;
  actualPct: number;
  targetPct: number;
  color?: string;
}

/** One `.g-row`: label, track+fill+tick, "n% · target m%" value text. */
function GuideBar({ label, actualPct, targetPct, color }: GuideBarProps) {
  const fillPct = Math.max(0, Math.min(100, actualPct));
  const tickPct = Math.max(0, Math.min(100, targetPct));
  return (
    <div className="grid grid-cols-[64px_1fr_112px] items-center gap-3 py-1.5 sm:grid-cols-[88px_1fr_120px]">
      <span className="text-[13px] font-semibold" style={{ color: "var(--ink-1)" }}>
        {label}
      </span>
      <span className="relative block h-2.5 rounded-full" style={{ background: "var(--accent-track)" }}>
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${fillPct}%`, background: color ?? "var(--accent)" }}
        />
        <span
          className="absolute -top-[3px] -bottom-[3px] w-[2px] rounded-sm"
          style={{ left: `${tickPct}%`, background: "var(--ink-2)" }}
        />
      </span>
      <span className="text-right text-[12.5px] tabular-nums" style={{ color: "var(--ink-3)" }}>
        <b style={{ color: "var(--ink-1)" }}>{actualPct}%</b> · target {targetPct}%
      </span>
    </div>
  );
}

function GuideBars({ split, benchmark }: { split: Benchmark; benchmark: Benchmark }) {
  return (
    <>
      <GuideBar label="Needs" actualPct={split.needs_pct} targetPct={benchmark.needs_pct} />
      <GuideBar label="Wants" actualPct={split.wants_pct} targetPct={benchmark.wants_pct} />
      <GuideBar label="Savings" actualPct={split.savings_pct} targetPct={benchmark.savings_pct} color="var(--good)" />
    </>
  );
}

interface AllocationGuideCardProps {
  rows: SplitRow[];
  savingsAllocatedSen: number;
  benchmark: Benchmark;
}

/** Desktop card: bars + editable benchmark ("edit" affordance, mockup's
 *  `.alloc-strip .edit` style). */
export function AllocationGuideCard({ rows, savingsAllocatedSen, benchmark }: AllocationGuideCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const split = planSplit(rows, savingsAllocatedSen);

  if (editing) {
    return (
      <BenchmarkEditor
        benchmark={benchmark}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
          Monthly split
        </h3>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-semibold"
          style={{ color: "var(--accent)" }}
        >
          edit
        </button>
      </div>
      <Tip className="mb-2">
        vs your targets · sinking funds &amp; goals live in <b>Goals</b> · portfolio allocation in <b>Investments</b>
      </Tip>
      <GuideBars split={split} benchmark={benchmark} />
      <p className="mt-2 text-xs" style={{ color: "var(--ink-3)" }}>
        Tick = target. Categories tagged in the table above.
      </p>
    </Card>
  );
}

interface BenchmarkEditorProps {
  benchmark: Benchmark;
  onSaved: () => void;
  onCancel: () => void;
}

function BenchmarkEditor({ benchmark, onSaved, onCancel }: BenchmarkEditorProps) {
  const [needsInput, setNeedsInput] = useState(String(benchmark.needs_pct));
  const [wantsInput, setWantsInput] = useState(String(benchmark.wants_pct));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const needsPct = parsePercent(needsInput);
  const wantsPct = parsePercent(wantsInput);
  const savingsPct = needsPct !== null && wantsPct !== null ? 100 - needsPct - wantsPct : null;

  async function submit() {
    if (needsPct === null || wantsPct === null) {
      setError("Enter whole percentages, 0–100.");
      return;
    }
    if (needsPct + wantsPct > 100) {
      setError("Needs + wants can't exceed 100%.");
      return;
    }
    setSaving(true);
    setError(undefined);
    const result = await updateBenchmark(needsPct, wantsPct);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved();
  }

  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Monthly split targets
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Needs %
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={needsInput}
            onChange={(e) => setNeedsInput(e.target.value)}
            className="w-20 rounded-lg px-2.5 py-1.5 text-sm tabular-nums outline-none"
            style={{ background: "var(--chip)", border: "1px solid var(--border)", color: "var(--ink-1)" }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Wants %
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={wantsInput}
            onChange={(e) => setWantsInput(e.target.value)}
            className="w-20 rounded-lg px-2.5 py-1.5 text-sm tabular-nums outline-none"
            style={{ background: "var(--chip)", border: "1px solid var(--border)", color: "var(--ink-1)" }}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Savings %
          </span>
          <span className="w-20 rounded-lg px-2.5 py-1.5 text-sm tabular-nums" style={{ color: "var(--ink-3)" }}>
            {savingsPct !== null ? `${savingsPct}%` : "—"}
          </span>
        </div>
        <Button type="button" variant="primary" onClick={submit} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      ) : null}
    </Card>
  );
}

interface AllocationGuideMobileProps {
  rows: SplitRow[];
  savingsAllocatedSen: number;
  benchmark: Benchmark;
}

/** Mobile compact equivalent — display-only. Benchmark editing is not a
 *  daily-path action, so it stays desktop-only rather than cramming an
 *  inline editor into the phone layout. */
export function AllocationGuideMobile({ rows, savingsAllocatedSen, benchmark }: AllocationGuideMobileProps) {
  const split = planSplit(rows, savingsAllocatedSen);
  return (
    <div className="mt-4 rounded-2xl p-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
        Monthly split
      </h3>
      <Tip className="mb-2">
        vs your targets · sinking funds &amp; goals live in <b>Goals</b> · portfolio allocation in <b>Investments</b>
      </Tip>
      <GuideBars split={split} benchmark={benchmark} />
      <p className="mt-2 text-xs" style={{ color: "var(--ink-3)" }}>
        Tick = target. Categories tagged in the table above.
      </p>
    </div>
  );
}
