"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { senToInputStr } from "@/components/DialogKit";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { Portal } from "@/components/Portal";
import { AllocStrip } from "@/components/AllocStrip";
import { AllocationGuideCard } from "@/components/AllocationGuide";
import { parseAmountToSen } from "@/lib/money";
import { useMoney } from "@/components/Money";
import { fundSpendLine } from "@/lib/funds-display";
import {
  meterState,
  unassignedSen as calcUnassigned,
  fundEnvelopeSplit,
  type Tag,
  type MeterState,
} from "@/lib/budget";
import { saveBudgetPlan, moveAllocation } from "@/app/(app)/budget/actions";
import type { BudgetMonthData, BudgetRow } from "@/db/budget";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

type Mode = "edit" | "empty" | "review" | "track";

interface BudgetTableProps {
  month: string;
  monthLabel: string;
  monthName: string;
  prevMonthName: string;
  prevMonthAbbrev: string;
  prevLink: string | null;
  nextLink: string | null;
  isPast: boolean;
  data: BudgetMonthData;
  /** Mount straight into edit mode — the mobile "Start plan" CTA's entry
   *  point into this same editor (Plan 4 Task 5). */
  startInEdit?: boolean;
  /** When set, Cancel/Save navigate here instead of just clearing local
   *  `editing` state — lets the mobile CTA route return to the read-only
   *  mobile view (`BudgetMobile`) rather than leaving the desktop editor
   *  mounted under its `?edit=1` URL. */
  exitEditHref?: string;
}

/** Parse a money input strictly: empty string is 0, anything unparseable is
 *  null (caller must surface an error rather than silently coercing). */
function parseOrNull(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return 0;
  return parseAmountToSen(trimmed);
}

function meterColor(state: MeterState): string {
  if (state === "over") return "var(--critical)";
  if (state === "warn") return "var(--warning)";
  return "var(--accent)";
}

function Meter({ fraction, color }: { fraction: number; color: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <span
      className="inline-block h-2.5 w-28 overflow-hidden rounded-full align-middle"
      style={{ background: "var(--accent-track)" }}
    >
      <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

function TagChip({ tag }: { tag: Tag }) {
  return (
    <span
      className="ml-2 rounded px-1.5 py-0.5 text-[10.5px] font-semibold align-middle"
      style={{ background: "var(--chip)", color: "var(--ink-3)" }}
    >
      {tag}
    </span>
  );
}

interface Envelope {
  id: string | null;
  name: string;
  archived: boolean;
}

export function BudgetTable({
  month,
  monthLabel,
  monthName,
  prevMonthName,
  prevMonthAbbrev,
  prevLink,
  nextLink,
  isPast,
  data,
  startInEdit,
  exitEditHref,
}: BudgetTableProps) {
  const router = useRouter();
  const { fmt, text } = useMoney();
  const [editing, setEditing] = useState(startInEdit ?? false);
  const [expectedIncome, setExpectedIncome] = useState(() => senToInputStr(data.expected_income_sen));
  const [savings, setSavings] = useState(() => senToInputStr(data.savings.allocated_sen));
  const [allocations, setAllocations] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.rows.map((r) => [r.category_id, senToInputStr(r.allocated_sen)])),
  );
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // undefined = closed; null = savings row; string = a category row's id.
  const [moveFor, setMoveFor] = useState<string | null | undefined>(undefined);

  function enterEdit(prefillFromPrev: boolean) {
    if (prefillFromPrev && data.prev) {
      setExpectedIncome(senToInputStr(data.prev.expected_income_sen));
      setSavings(senToInputStr(data.prev.savings_allocated_sen));
      setAllocations(Object.fromEntries(data.rows.map((r) => [r.category_id, senToInputStr(r.prev_allocated_sen)])));
    } else {
      setExpectedIncome(senToInputStr(data.expected_income_sen));
      setSavings(senToInputStr(data.savings.allocated_sen));
      setAllocations(Object.fromEntries(data.rows.map((r) => [r.category_id, senToInputStr(r.allocated_sen)])));
    }
    setSaveError(undefined);
    setEditing(true);
  }

  function cancelEdit() {
    if (exitEditHref) {
      router.push(exitEditHref);
      return;
    }
    setEditing(false);
    setSaveError(undefined);
  }

  async function handleSave() {
    const incomeSen = parseOrNull(expectedIncome);
    const savingsSen = parseOrNull(savings);
    const allocEntries = data.rows.map((r) => ({
      category_id: r.category_id,
      allocated_sen: parseOrNull(allocations[r.category_id] ?? "0"),
    }));
    if (incomeSen === null || savingsSen === null || allocEntries.some((a) => a.allocated_sen === null)) {
      setSaveError("Enter valid amounts (numbers only).");
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    const result = await saveBudgetPlan(month, {
      expected_income_sen: incomeSen,
      savings_sen: savingsSen,
      allocations: allocEntries.map((a) => ({ category_id: a.category_id, allocated_sen: a.allocated_sen as number })),
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.error);
      return;
    }
    if (exitEditHref) {
      router.push(exitEditHref);
      return;
    }
    setEditing(false);
    router.refresh();
  }

  const draftAllocatedSen = data.rows.map((r) => parseAmountToSen(allocations[r.category_id] ?? "0") ?? 0);
  const draftIncomeSen = parseAmountToSen(expectedIncome) ?? 0;
  const draftSavingsSen = parseAmountToSen(savings) ?? 0;
  const draftAllocatedTotal = draftAllocatedSen.reduce((sum, n) => sum + n, 0);
  const draftUnassigned = calcUnassigned(draftIncomeSen, draftAllocatedSen, draftSavingsSen);
  const liveUnassigned = calcUnassigned(
    data.expected_income_sen,
    data.rows.map((r) => r.allocated_sen),
    data.savings.allocated_sen,
  );

  const mode: Mode = editing ? "edit" : !data.planned ? "empty" : isPast ? "review" : "track";
  const canCopy = !data.planned && data.prev !== null;
  // Q19: the Dashboard's helper, so the two pages annotate the same figure
  // the same way (`· incl. archived funds`); null at or below zero.
  const fundSpend = fundSpendLine(data.totals.fund_spend_sen);

  const envelopes: Envelope[] = [
    ...data.rows.map((r) => ({ id: r.category_id as string | null, name: r.name, archived: r.archived })),
    { id: null, name: "Savings & funds", archived: false },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
          Budget
        </h2>
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--ink-2)" }}>
          {prevLink ? (
            <Link href={prevLink} className="rounded-lg border px-2 py-1" style={{ borderColor: "var(--border)" }}>
              ‹
            </Link>
          ) : (
            <span className="rounded-lg border px-2 py-1" style={{ borderColor: "var(--border)", color: "var(--ink-3)" }}>
              ‹
            </span>
          )}
          <span className="rounded-lg border px-3 py-1.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            {monthLabel}
          </span>
          {nextLink ? (
            <Link href={nextLink} className="rounded-lg border px-2 py-1" style={{ borderColor: "var(--border)" }}>
              ›
            </Link>
          ) : (
            <span className="rounded-lg border px-2 py-1" style={{ borderColor: "var(--border)", color: "var(--ink-3)" }}>
              ›
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {mode === "edit" ? (
            <>
              {canCopy ? (
                <Button type="button" variant="secondary" onClick={() => enterEdit(true)}>
                  Copy {prevMonthName}&apos;s plan
                </Button>
              ) : null}
              <Button type="button" variant="ghost" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save plan"}
              </Button>
            </>
          ) : mode === "empty" ? (
            <>
              {canCopy ? (
                <Button type="button" variant="secondary" onClick={() => enterEdit(true)}>
                  Copy {prevMonthName}&apos;s plan
                </Button>
              ) : null}
              <Button type="button" variant="primary" onClick={() => enterEdit(false)}>
                Start {monthName}&apos;s plan
              </Button>
            </>
          ) : mode === "track" ? (
            <Button type="button" variant="primary" onClick={() => enterEdit(false)}>
              Edit plan
            </Button>
          ) : null}
        </div>
      </div>

      <AllocStrip
        expectedIncomeSen={mode === "edit" ? draftIncomeSen : data.expected_income_sen}
        allocatedSen={mode === "edit" ? draftAllocatedTotal : data.totals.allocated_sen}
        savingsSen={mode === "edit" ? draftSavingsSen : data.savings.allocated_sen}
        unassignedSen={mode === "edit" ? draftUnassigned : liveUnassigned}
        editable={mode === "edit"}
        expectedIncomeInput={expectedIncome}
        onExpectedIncomeChange={setExpectedIncome}
      />

      {/* Ruling 7: a disclosure of the one term `spend_by_category` drops —
          not a reconciliation of the rows below (uncategorised spend and
          spend in categories with no allocation row are already carried by
          the Unbudgeted card). */}
      {fundSpend ? (
        <p className="-mt-1 text-xs tabular-nums" style={{ color: "var(--ink-2)" }}>
          {text(fundSpend)}
          <Tip as="span">
            {" "}
            · money you set aside earlier, so it counts against no category limit here
          </Tip>
        </p>
      ) : null}

      <Card>
        <h3 className="mb-1 text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
          Categories · {monthName}
        </h3>
        {mode === "empty" ? (
          <Tip className="mb-3">
            Zero-based planning: give every ringgit of {fmt(data.expected_income_sen)} a job — categories plus
            savings should add up to what you expect to earn.
          </Tip>
        ) : mode === "review" ? (
          <p className="mb-3 text-xs" style={{ color: "var(--ink-2)" }}>
            {data.change_count} adjustment{data.change_count === 1 ? "" : "s"} this month
          </p>
        ) : (
          <Tip className="mb-3">
            every ringgit of {fmt(mode === "edit" ? draftIncomeSen : data.expected_income_sen)} has a job ·
            adjust anytime — changes are logged for month-end review
          </Tip>
        )}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {(mode === "review"
                  ? ["Category", "Planned", "Adjusted", "Actual"]
                  : ["Category", `${prevMonthAbbrev} spent`, "Allocated", "Spent so far", "Left", ""]
                ).map((h, i, arr) => (
                  <th
                    key={h || i}
                    className={`px-2 py-1.5 text-xs font-semibold ${i === 0 ? "text-left" : "text-right"} ${
                      i === arr.length - 1 && h === "" ? "w-16" : ""
                    }`}
                    style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <BudgetTableRow
                  key={row.category_id}
                  row={row}
                  mode={mode}
                  allocationInput={allocations[row.category_id] ?? "0.00"}
                  onAllocationChange={(v) => setAllocations((prev) => ({ ...prev, [row.category_id]: v }))}
                  onMove={() => setMoveFor(row.category_id)}
                />
              ))}
              <SavingsRow
                data={data}
                mode={mode}
                savingsInput={savings}
                onSavingsChange={setSavings}
                onMove={() => setMoveFor(null)}
              />
            </tbody>
          </table>
        </div>
      </Card>

      <SavingsFundsCard savings={data.savings} />

      <AllocationGuideCard
        rows={data.rows}
        savingsAllocatedSen={data.savings.allocated_sen}
        benchmark={data.benchmark}
      />

      {mode !== "empty" && mode !== "review" ? (
        <Tip>
          Savings &amp; funds tracks money that stayed with you this month (income − spending) — not a separate
          ledger. Give it named jobs in{" "}
          <Link href="/goals" style={{ color: "var(--accent)" }}>
            Goals
          </Link>
          .
        </Tip>
      ) : null}

      {data.unbudgeted.length > 0 ? (
        <Card title="Unbudgeted">
          <Tip className="-mt-1 mb-2">spending outside any category limit · still counts toward this month&apos;s totals</Tip>
          <ul className="flex flex-col">
            {data.unbudgeted.map((u) => (
              <li
                key={u.category_id ?? "null"}
                className="flex items-center justify-between py-1.5 text-sm"
                style={{ borderBottom: "1px solid var(--grid)" }}
              >
                <span style={{ color: "var(--ink-1)" }}>{u.name}</span>
                <span className="tabular-nums" style={{ color: "var(--ink-2)" }}>
                  {fmt(u.spent_sen)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {saveError ? (
        <p className="text-sm" style={{ color: "var(--critical)" }}>
          {saveError}
        </p>
      ) : null}

      {moveFor !== undefined ? (
        <MoveDialog
          month={month}
          envelopes={envelopes}
          defaultFromId={moveFor}
          onClose={() => setMoveFor(undefined)}
        />
      ) : null}
    </div>
  );
}

/**
 * Mockup v6 §9's middle fragment: the savings row's fund breakdown and its one
 * click through to Goals. Ruling 4 puts this on the Budget page; the amounts
 * are each fund's earmark for THIS month (stored row when applied, planned
 * amount otherwise — `getBudgetMonth` resolves that), and `Unassigned` is what
 * the envelope has left for investing.
 *
 * Hidden entirely when no active fund exists — an empty breakdown would be a
 * card of nothing; the Tip under the categories table is the discovery path.
 */
function SavingsFundsCard({ savings }: { savings: BudgetMonthData["savings"] }) {
  const { fmt } = useMoney();
  if (savings.funds.length === 0) return null;
  const { planned_sen, unassigned_sen } = fundEnvelopeSplit(
    savings.funds.map((f) => f.contribution_sen),
    savings.allocated_sen,
  );

  return (
    <Card title="Savings & funds">
      <Tip className="-mt-1 mb-1">
        each fund is a labelled slice of money you already have — filling one moves nothing
      </Tip>
      <p className="mb-2 text-xs tabular-nums" style={{ color: "var(--ink-2)" }}>
        envelope {fmt(savings.allocated_sen)} · {fmt(planned_sen)} planned to funds
      </p>
      <ul className="flex flex-col">
        {savings.funds.map((f) => (
          <li
            key={f.id}
            className="flex items-center justify-between py-1.5 text-sm"
            style={{ borderBottom: "1px solid var(--grid)" }}
          >
            <span style={{ color: "var(--ink-1)" }}>{f.name}</span>
            <span className="tabular-nums" style={{ color: "var(--ink-2)" }}>
              {fmt(f.contribution_sen)}
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between py-1.5 text-sm">
          <span style={{ color: "var(--ink-1)" }}>
            Unassigned
            {/* v6 §9 marks this `.sub`, not `.tip`: it names what the money is
                for, so it survives tips-off like every other figure here. */}
            <span style={{ color: "var(--ink-3)" }}> · available to invest</span>
          </span>
          <span className="tabular-nums" style={{ color: "var(--ink-2)" }}>
            {fmt(unassigned_sen)}
          </span>
        </li>
      </ul>
      <div
        className="mt-1 flex items-center justify-between pt-2 text-sm font-semibold"
        style={{ borderTop: "1px solid var(--baseline)" }}
      >
        <Link href="/goals" style={{ color: "var(--accent)" }}>
          Open Goals
        </Link>
        <span className="tabular-nums" style={{ color: "var(--ink-1)" }}>
          {fmt(savings.allocated_sen)}
        </span>
      </div>
    </Card>
  );
}

interface RowProps {
  row: BudgetRow;
  mode: Mode;
  allocationInput: string;
  onAllocationChange: (value: string) => void;
  onMove: () => void;
}

function BudgetTableRow({ row, mode, allocationInput, onAllocationChange, onMove }: RowProps) {
  const { fmt } = useMoney();
  const state = meterState(row.spent_sen, row.allocated_sen);
  const left = row.allocated_sen - row.spent_sen;
  const fraction = row.allocated_sen > 0 ? row.spent_sen / row.allocated_sen : row.spent_sen > 0 ? 1 : 0;

  return (
    <tr style={{ borderBottom: "1px solid var(--grid)" }}>
      <td className="px-2 py-2 font-medium" style={{ color: row.archived ? "var(--ink-3)" : "var(--ink-1)" }}>
        <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--accent)" }} />
        {row.name}
        {row.archived ? " (archived)" : ""}
        <TagChip tag={row.tag} />
      </td>

      {mode === "review" ? (
        <>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
            {fmt(row.planned_sen)}
          </td>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
            {fmt(row.allocated_sen)}
          </td>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-1)" }}>
            {fmt(row.spent_sen)}
          </td>
        </>
      ) : (
        <>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-3)" }}>
            {fmt(row.prev_spent_sen)}
          </td>
          <td className="px-2 py-2 text-right">
            {mode === "edit" ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
                style={{ background: "var(--chip)", border: "1px solid var(--border)" }}
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={allocationInput}
                  onChange={(e) => onAllocationChange(e.target.value)}
                  className="w-20 bg-transparent text-right text-sm font-semibold tabular-nums outline-none"
                  style={{ color: "var(--ink-1)" }}
                />
                <span className="text-xs" style={{ color: "var(--ink-3)" }}>
                  RM
                </span>
              </span>
            ) : (
              <span className="tabular-nums" style={{ color: "var(--ink-1)" }}>
                {fmt(row.allocated_sen)}
              </span>
            )}
          </td>
          <td className="px-2 py-2 text-right">
            <span className="inline-flex items-center justify-end gap-2.5 tabular-nums" style={{ color: "var(--ink-1)" }}>
              <Meter fraction={fraction} color={meterColor(state)} />
              {fmt(row.spent_sen)}
            </span>
          </td>
          <td className="px-2 py-2 text-right">
            {state === "over" ? (
              <span className="font-semibold" style={{ color: "var(--critical)" }}>
                ▲ −{fmt(Math.abs(left))}
              </span>
            ) : (
              <span className="tabular-nums" style={{ color: "var(--ink-3)" }}>
                {fmt(left)}
              </span>
            )}
          </td>
          <td className="px-2 py-2 text-right">
            {mode === "track" ? (
              <button type="button" onClick={onMove} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
                ⇄ move
              </button>
            ) : null}
          </td>
        </>
      )}
    </tr>
  );
}

interface SavingsRowProps {
  data: BudgetMonthData;
  mode: Mode;
  savingsInput: string;
  onSavingsChange: (value: string) => void;
  onMove: () => void;
}

function SavingsRow({ data, mode, savingsInput, onSavingsChange, onMove }: SavingsRowProps) {
  const { fmt } = useMoney();
  const { savings } = data;
  const left = savings.allocated_sen - savings.set_aside_sen;
  const fraction =
    savings.allocated_sen > 0 ? savings.set_aside_sen / savings.allocated_sen : savings.set_aside_sen > 0 ? 1 : 0;

  return (
    <tr>
      <td className="px-2 py-2 font-medium" style={{ color: "var(--ink-1)" }}>
        <span className="mr-2 inline-block h-2 w-2 rounded-full align-middle" style={{ background: "var(--good)" }} />
        Savings &amp; funds
        <TagChip tag="savings" />
      </td>

      {mode === "review" ? (
        <>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
            {fmt(savings.planned_sen)}
          </td>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-2)" }}>
            {fmt(savings.allocated_sen)}
          </td>
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-1)" }}>
            {fmt(savings.set_aside_sen)}
          </td>
        </>
      ) : (
        <>
          {/* No comparable "previous month actual set-aside" figure exists in
              BudgetMonthData (only the prior month's allocation is exposed);
              showing that would misrepresent a plan value as an actual. */}
          <td className="px-2 py-2 text-right tabular-nums" style={{ color: "var(--ink-3)" }}>
            —
          </td>
          <td className="px-2 py-2 text-right">
            {mode === "edit" ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
                style={{ background: "var(--chip)", border: "1px solid var(--border)" }}
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={savingsInput}
                  onChange={(e) => onSavingsChange(e.target.value)}
                  className="w-20 bg-transparent text-right text-sm font-semibold tabular-nums outline-none"
                  style={{ color: "var(--ink-1)" }}
                />
                <span className="text-xs" style={{ color: "var(--ink-3)" }}>
                  RM
                </span>
              </span>
            ) : (
              <span className="tabular-nums" style={{ color: "var(--ink-1)" }}>
                {fmt(savings.allocated_sen)}
              </span>
            )}
          </td>
          <td className="px-2 py-2 text-right">
            <span className="inline-flex items-center justify-end gap-2.5 tabular-nums" style={{ color: "var(--ink-1)" }}>
              <Meter fraction={fraction} color="var(--good)" />
              {fmt(savings.set_aside_sen)}
            </span>
            <div className="text-[11px]" style={{ color: "var(--ink-3)" }}>
              set aside so far
            </div>
          </td>
          <td className="px-2 py-2 text-right">
            <span className="tabular-nums" style={{ color: "var(--ink-3)" }}>
              {fmt(left)}
            </span>
          </td>
          <td className="px-2 py-2 text-right">
            {mode === "track" ? (
              <button type="button" onClick={onMove} className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
                ⇄ move
              </button>
            ) : null}
          </td>
        </>
      )}
    </tr>
  );
}

interface MoveDialogProps {
  month: string;
  envelopes: Envelope[];
  defaultFromId: string | null;
  onClose: () => void;
}

function MoveDialog({ month, envelopes, defaultFromId, onClose }: MoveDialogProps) {
  const router = useRouter();
  const [fromId, setFromId] = useState<string>(defaultFromId ?? "__savings__");
  const [toId, setToId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function submit() {
    const amountSen = parseAmountToSen(amount);
    if (amountSen === null || amountSen <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (!toId) {
      setError("Choose a destination envelope.");
      return;
    }
    setError(undefined);
    setPending(true);
    const from = fromId === "__savings__" ? null : fromId;
    const to = toId === "__savings__" ? null : toId;
    const result = await moveAllocation(month, from, to, amountSen);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: "var(--dim)" }}
        onClick={onClose}
      >
        <div
          className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border p-5"
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <h4 className="text-sm font-semibold" style={{ color: "var(--ink-1)" }}>
            Move money
          </h4>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              From
            </span>
            <select
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            >
              {envelopes.map((env) => (
                <option key={env.id ?? "__savings__"} value={env.id ?? "__savings__"}>
                  {env.name}
                  {env.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              To
            </span>
            <select
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            >
              <option value="">Choose…</option>
              {envelopes.map((env) => (
                <option key={env.id ?? "__savings__"} value={env.id ?? "__savings__"}>
                  {env.name}
                  {env.archived ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              Amount (RM)
            </span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </label>
          {error ? (
            <p className="text-xs" style={{ color: "var(--critical)" }}>
              {error}
            </p>
          ) : null}
          <div className="mt-1 flex gap-3">
            <Button type="button" variant="primary" className="flex-1" onClick={submit} disabled={pending}>
              {pending ? "Moving…" : "Move"}
            </Button>
            <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
