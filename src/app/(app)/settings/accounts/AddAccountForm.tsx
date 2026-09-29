"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createAccount } from "./actions";
import { ACCOUNT_CURRENCIES } from "@/lib/account-form";
import { Button } from "@/components/Button";

const ACCOUNT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "bank", label: "Bank" },
  { value: "ewallet", label: "eWallet" },
  { value: "cash", label: "Cash" },
  { value: "brokerage", label: "Brokerage" },
  { value: "epf", label: "EPF" },
  { value: "other", label: "Other" },
];

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface AddAccountFormProps {
  /** Called once creation succeeds (e.g. onboarding refreshes its account list). */
  onCreated?: () => void;
}

export function AddAccountForm({ onCreated }: AddAccountFormProps = {}) {
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(
    createAccount,
    {},
  );
  // Ruling 7: the currency select exists on brokerage accounts ONLY — every
  // other type is MYR and shows no control.
  const [type, setType] = useState("bank");
  const [currency, setCurrency] = useState("MYR");

  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!state.error) onCreated?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Name
        </span>
        <input
          type="text"
          name="name"
          required
          maxLength={60}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Type
        </span>
        <select
          name="type"
          required
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        >
          {ACCOUNT_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {type === "brokerage" ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs" style={{ color: "var(--ink-2)" }}>
            Currency
          </span>
          <select
            name="currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          >
            {ACCOUNT_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {/* Ruling 15: currency and starting balance are set together here,
              in one INSERT — so a non-zero starting balance locks the
              currency from the moment the account exists. Say so before the
              choice, not after. */}
          <span className="text-[11px]" style={{ color: "var(--ink-3)" }}>
            fixed once the account has a starting balance or any activity
          </span>
        </label>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Starting balance ({type === "brokerage" ? currency : "RM"})
        </span>
        <input
          type="text"
          name="startingBalance"
          inputMode="decimal"
          placeholder="0.00"
          required
          className="w-32 rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Adding…" : "Add account"}
      </Button>
      {state.error ? (
        <p className="w-full text-sm" style={{ color: "var(--critical)" }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
