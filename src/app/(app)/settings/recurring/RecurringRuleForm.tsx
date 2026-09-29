"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { senToInputStr } from "@/components/DialogKit";
import { Tip } from "@/components/Tip";
import {
  RECURRING_TYPES,
  RECURRING_FREQS,
  WEEKDAY_LABELS,
  MONTH_LABELS,
  type RecurringType,
  type RecurringFreq,
} from "@/lib/recurring-form";
import { createRecurringRule, updateRecurringRule } from "./actions";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

const TYPE_LABELS: Record<RecurringType, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
};

const FREQ_LABELS: Record<RecurringFreq, string> = {
  monthly: "Monthly",
  weekly: "Weekly",
  yearly: "Yearly",
};

interface Option {
  id: string;
  name: string;
}

interface CategoryOption extends Option {
  kind: "expense" | "income";
}

/** Defaults for edit mode — the DB row shape minus id/user_id/next_run/active. */
export interface RecurringRuleDefaults {
  id: string;
  name: string;
  type: RecurringType;
  amount_sen: number;
  variable: boolean;
  account_id: string;
  transfer_account_id: string | null;
  category_id: string | null;
  freq: RecurringFreq;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
}

interface RecurringRuleFormProps {
  accounts: Option[];
  categories: CategoryOption[];
  /** Present → edit mode (updateRecurringRule bound to rule.id). Absent → create. */
  rule?: RecurringRuleDefaults;
  /** Called once the action completes without error (e.g. to close an inline editor). */
  onSaved?: () => void;
  onCancel?: () => void;
}

/**
 * Reusable expense/income/transfer recurring-rule form: type, name, amount +
 * variable checkbox, account, conditional transfer destination / category,
 * and freq-conditional day-of-month / weekday / month fields. Shared between
 * Settings › Recurring (create + inline edit) and the Task 15 onboarding
 * wizard.
 */
export function RecurringRuleForm({ accounts, categories, rule, onSaved, onCancel }: RecurringRuleFormProps) {
  const action = rule ? updateRecurringRule.bind(null, rule.id) : createRecurringRule;
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(action, {});
  const [type, setType] = useState<RecurringType>(rule?.type ?? "expense");
  const [freq, setFreq] = useState<RecurringFreq>(rule?.freq ?? "monthly");

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!state.error) onSaved?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const categoryKind = type === "income" ? "income" : "expense";
  const visibleCategories = categories.filter((c) => c.kind === categoryKind);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Type
        </span>
        <select
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value as RecurringType)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {RECURRING_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Name
        </span>
        <input
          type="text"
          name="name"
          required
          maxLength={60}
          defaultValue={rule?.name}
          placeholder="e.g. Rent"
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Amount (RM)
        </span>
        <input
          type="text"
          name="amount"
          inputMode="decimal"
          required
          placeholder="0.00"
          defaultValue={rule ? senToInputStr(rule.amount_sen) : undefined}
          className="w-28 rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>

      <label className="flex items-center gap-1.5 pb-2.5 text-xs" style={{ color: "var(--ink-2)" }}>
        <input type="checkbox" name="variable" defaultChecked={rule?.variable ?? false} />
        Variable amount
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Account
        </span>
        <select
          name="accountId"
          required
          defaultValue={rule?.account_id}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          <option value="" disabled>
            Choose…
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      {type === "transfer" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            To account
          </span>
          <select
            name="transferAccountId"
            required
            defaultValue={rule?.transfer_account_id ?? ""}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            <option value="" disabled>
              Choose…
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Category
          </span>
          <select
            name="categoryId"
            defaultValue={rule?.category_id ?? ""}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            <option value="">None</option>
            {visibleCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Frequency
        </span>
        <select
          name="freq"
          value={freq}
          onChange={(e) => setFreq(e.target.value as RecurringFreq)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {RECURRING_FREQS.map((f) => (
            <option key={f} value={f}>
              {FREQ_LABELS[f]}
            </option>
          ))}
        </select>
      </label>

      {freq === "monthly" || freq === "yearly" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Day of month
          </span>
          <input
            type="number"
            name="dayOfMonth"
            min={1}
            max={31}
            required
            defaultValue={rule?.day_of_month ?? undefined}
            className="w-20 rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
        </label>
      ) : null}

      {freq === "weekly" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Weekday
          </span>
          <select
            name="weekday"
            required
            defaultValue={rule?.weekday ?? ""}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            <option value="" disabled>
              Choose…
            </option>
            {WEEKDAY_LABELS.map((label, i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {freq === "yearly" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Month
          </span>
          <select
            name="monthOfYear"
            required
            defaultValue={rule?.month_of_year ?? ""}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            <option value="" disabled>
              Choose…
            </option>
            {MONTH_LABELS.map((label, i) => (
              <option key={label} value={i + 1}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="flex items-end gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : rule ? "Save changes" : "Add rule"}
        </Button>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      <Tip className="w-full">
        Variable rules create entries flagged for review — confirm the amount each month.
      </Tip>

      {state.error ? (
        <p className="w-full text-sm" style={{ color: "var(--critical)" }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
