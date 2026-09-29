"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import {
  inputStyle,
  Field,
  DialogShell,
  ErrorLine,
  DialogButtons,
  senToInputStr,
} from "@/components/DialogKit";
import { Tip } from "@/components/Tip";
import { parseAmountToSen } from "@/lib/money";
import { useMoney } from "@/components/Money";
import { thisMonthNeedsWrite } from "@/lib/funds-display";
import { createFund, updateFund, setContribution, applyMonthlyContributions } from "@/app/(app)/goals/actions";
import type { FundRow, FundInput } from "@/db/funds";
import type { FundKind } from "@/lib/funds";

/**
 * Fund create/edit dialog + the two write-triggering controls that don't
 * belong to the table (New fund, Apply <month>) — Task 3's `FundDialogs.tsx`.
 * Mirrors HoldingsTable.tsx's dialog shape (DialogKit primitives, useTransition
 * + router.refresh() on success) over the Task-2 FundInput contract.
 */

const KIND_OPTIONS: Array<{ value: FundKind; label: string }> = [
  { value: "emergency", label: "Emergency" },
  { value: "sinking", label: "Sinking" },
  { value: "goal", label: "Goal" },
];

type TargetShape = "none" | "amount" | "months";

function shapeFromFund(fund: FundRow | undefined): TargetShape {
  if (!fund) return "none";
  if (fund.target_sen !== null) return "amount";
  if (fund.target_months !== null) return "months";
  return "none";
}

// ---------------------------------------------------------------------------
// Create / edit dialog — ruling 3's target shape is a 3-way toggle with
// "months" reachable ONLY on the emergency kind (client-side illegal combos
// unreachable; performUpdateFund + the table checks reject them anyway).
// `month` is the KL month ("YYYY-MM") the caller already computed from
// getFunds — used only to prefill/save the edit-mode "this month" override,
// via performSetContribution (ruling 10: the stored row, not a second write
// path re-deriving the fallback).
// ---------------------------------------------------------------------------

export function FundFormDialog({
  fund,
  month,
  onClose,
}: {
  fund?: FundRow;
  month: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(fund?.name ?? "");
  const [kind, setKind] = useState<FundKind>(fund?.kind ?? "sinking");
  const [shape, setShape] = useState<TargetShape>(shapeFromFund(fund));
  const [amountStr, setAmountStr] = useState(fund?.target_sen != null ? senToInputStr(fund.target_sen) : "");
  const [monthsStr, setMonthsStr] = useState(fund?.target_months != null ? String(fund.target_months) : "");
  const [targetDate, setTargetDate] = useState(fund?.target_date ?? "");
  const [monthlyStr, setMonthlyStr] = useState(fund ? senToInputStr(fund.monthly_contribution_sen) : "0.00");
  const [priorityStr, setPriorityStr] = useState(fund ? String(fund.priority) : "0");
  const [thisMonthStr, setThisMonthStr] = useState(fund ? senToInputStr(fund.contribution_sen) : "");
  const [error, setError] = useState<string>();

  function selectKind(next: FundKind) {
    setKind(next);
    // Months-of-expenses is emergency-only — switching away must not leave
    // an unreachable shape selected.
    if (next !== "emergency" && shape === "months") setShape("none");
  }

  function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) return setError("Name is required.");

    let target_sen: number | null = null;
    let target_months: number | null = null;
    if (shape === "amount") {
      const sen = parseAmountToSen(amountStr);
      if (sen === null || sen <= 0) return setError("Enter a valid target amount.");
      target_sen = sen;
    } else if (shape === "months") {
      const n = Number(monthsStr);
      if (!Number.isInteger(n) || n < 1 || n > 60) return setError("Months must be a whole number from 1 to 60.");
      target_months = n;
    }

    const monthlySen = parseAmountToSen(monthlyStr);
    if (monthlySen === null || monthlySen < 0) return setError("Enter a valid monthly contribution.");

    const priorityNum = Number(priorityStr);
    if (!Number.isInteger(priorityNum)) return setError("Priority must be a whole number.");

    let thisMonthSen: number | null = null;
    if (fund) {
      const parsed = parseAmountToSen(thisMonthStr);
      if (parsed === null || parsed < 0) return setError("Enter a valid contribution for this month.");
      thisMonthSen = parsed;
    }

    const input: FundInput = {
      name: trimmedName,
      kind,
      target_sen,
      target_months,
      target_date: targetDate.trim() === "" ? null : targetDate,
      monthly_contribution_sen: monthlySen,
      priority: priorityNum,
    };

    startTransition(async () => {
      const result = fund ? await updateFund(fund.id, input) : await createFund(input);
      if (!result.ok) return setError(result.error);
      // Never `thisMonthSen !== fund.contribution_sen`: that value is the
      // stored row OR the monthly fallback, and the fallback moves with the
      // `monthlySen` this very save is writing (see thisMonthNeedsWrite).
      if (
        fund &&
        thisMonthSen !== null &&
        thisMonthNeedsWrite({
          contribution_applied: fund.contribution_applied,
          contribution_sen: fund.contribution_sen,
          monthly_contribution_sen: monthlySen,
          this_month_sen: thisMonthSen,
        })
      ) {
        const contribResult = await setContribution(fund.id, month, thisMonthSen);
        if (!contribResult.ok) return setError(contribResult.error);
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <DialogShell title={fund ? `Edit fund — ${fund.name}` : "New fund"} onClose={onClose}>
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>

      <div className="flex gap-3">
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => selectKind(e.target.value as FundKind)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <input
            type="text"
            inputMode="numeric"
            value={priorityStr}
            onChange={(e) => setPriorityStr(e.target.value)}
            className="w-20 rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      </div>
      <Tip className="-mt-2">Lower priority numbers fill first in the savings waterfall.</Tip>

      {/* Not a Field/<label> here on purpose: a <label> associates with ONE
          form control, and this is a 3-way button group — wrapping it broke
          each button's accessible name (caught by the manual verification
          script's Playwright locators, a real a11y smell, not just a test
          nuisance). Same visual treatment as Field, plain <div> instead. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Target
        </span>
        <div className="flex overflow-hidden rounded-lg" style={{ border: "1px solid var(--border)" }}>
          {(["none", "amount", "months"] as const).map((s) => {
            const disabled = s === "months" && kind !== "emergency";
            return (
              <button
                key={s}
                type="button"
                disabled={disabled}
                onClick={() => setShape(s)}
                className="flex-1 px-2 py-1.5 text-xs"
                style={{
                  background: shape === s ? "var(--chip)" : "transparent",
                  color: disabled ? "var(--ink-3)" : shape === s ? "var(--ink-1)" : "var(--ink-2)",
                  fontWeight: shape === s ? 650 : 400,
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                {s === "none" ? "None" : s === "amount" ? "Amount" : "Months of expenses"}
              </button>
            );
          })}
        </div>
      </div>

      {shape === "amount" ? (
        <Field label="Target amount (RM)">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      ) : null}
      {shape === "months" ? (
        <Field label="Months of expenses">
          <input
            type="text"
            inputMode="numeric"
            value={monthsStr}
            onChange={(e) => setMonthsStr(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </Field>
      ) : null}

      <Field label="Target date — optional">
        <input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>

      <Field label="Monthly contribution (RM)">
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={monthlyStr}
          onChange={(e) => setMonthlyStr(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </Field>

      {fund ? (
        <>
          <Field label="This month's contribution (RM)">
            <input
              type="text"
              inputMode="decimal"
              value={thisMonthStr}
              onChange={(e) => setThisMonthStr(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none"
              style={inputStyle}
            />
          </Field>
          <Tip className="-mt-2">
            Overrides just this month — the monthly contribution above is the default from next month on.
          </Tip>
        </>
      ) : null}

      <ErrorLine error={error} />
      <DialogButtons onCancel={onClose} onSave={submit} pending={pending} saveLabel={fund ? "Save" : "Create fund"} />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// New fund trigger — "primary"/"secondary" render as the house Button
// (desktop header, empty state); "mini" renders as the mockup's plain
// text-link mini-btn (mobile m-title row). `month` is passed straight
// through to FundFormDialog's (unused, create-mode) prop so every caller
// shares the one KL-month value the page already computed — no second
// clock read.
// ---------------------------------------------------------------------------

export function NewFundButton({
  month,
  variant = "secondary",
}: {
  month: string;
  variant?: "primary" | "secondary" | "mini";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === "mini" ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[12.5px] font-semibold"
          style={{ color: "var(--accent)" }}
        >
          New fund
        </button>
      ) : (
        <Button type="button" variant={variant} onClick={() => setOpen(true)}>
          New fund
        </Button>
      )}
      {open ? <FundFormDialog month={month} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Apply <month> — ruling 4. "button" is the desktop banner's compact primary
// button; "card" is the mobile banner's whole-card tap target (mockup §10
// ph1: the amount + sub-line sit inside the same tappable surface).
// ---------------------------------------------------------------------------

export function ApplyMonthButton({
  month,
  monthLabel,
  variant = "button",
  plannedSen = 0,
  fundsCount = 0,
  envelopeSen = 0,
}: {
  month: string;
  monthLabel: string;
  variant?: "button" | "card";
  plannedSen?: number;
  fundsCount?: number;
  envelopeSen?: number;
}) {
  const { fmt } = useMoney();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();

  function apply() {
    startTransition(async () => {
      const result = await applyMonthlyContributions(month);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  if (variant === "card") {
    return (
      <button
        type="button"
        onClick={apply}
        disabled={pending}
        className="w-full rounded-2xl p-3.5 text-left"
        style={{ background: "var(--accent-soft)" }}
      >
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[14.5px] font-semibold" style={{ color: "var(--ink-1)" }}>
            {pending ? "Applying…" : `Apply ${monthLabel}`}
          </span>
          <span className="text-sm font-bold tabular-nums" style={{ color: "var(--ink-1)" }}>
            {fmt(plannedSen)}
          </span>
        </div>
        <div className="mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          {fundsCount} fund{fundsCount === 1 ? "" : "s"} · not applied yet · envelope {fmt(envelopeSen)}
        </div>
        {error ? (
          <div className="mt-1 text-[11.5px] font-semibold" style={{ color: "var(--critical)" }}>
            {error}
          </div>
        ) : null}
      </button>
    );
  }

  return (
    <div className="flex flex-shrink-0 flex-col items-end gap-1">
      <Button type="button" variant="primary" onClick={apply} disabled={pending}>
        {pending ? "Applying…" : `Apply ${monthLabel}`}
      </Button>
      {error ? (
        <span className="text-xs" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
