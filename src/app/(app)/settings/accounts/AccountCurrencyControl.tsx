"use client";

import { startTransition, useState } from "react";
import { setAccountCurrency } from "./actions";
import { ACCOUNT_CURRENCIES } from "@/lib/account-form";

/**
 * Task 5 (ruling 7): brokerage-only currency select. Optimistic-with-
 * rollback like AllocationBucketControl; the server re-validates the whole
 * currency lock inside the RLS session — every balance-moving reference plus
 * the account's own starting balance, enumerated in the RULE comment in
 * src/db/accounts.ts. A blocked change comes back naming WHICH condition bit
 * (activity, or the starting balance) in the error line below, and the select
 * rolls back (currency is fixed, like a holding's symbol).
 */
export function AccountCurrencyControl({
  accountId,
  currency,
}: {
  accountId: string;
  currency: string;
}) {
  const [current, setCurrent] = useState(currency);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function select(next: string) {
    if (next === current || pending) return;
    const prev = current;
    setCurrent(next);
    setPending(true);
    setError(undefined);
    startTransition(() => {
      void setAccountCurrency(accountId, next).then((result) => {
        setPending(false);
        if (!result.ok) {
          setCurrent(prev);
          setError(result.error);
        }
      });
    });
  }

  return (
    <div className="flex flex-shrink-0 flex-col gap-1">
      <select
        value={current}
        disabled={pending}
        onChange={(e) => select(e.target.value)}
        className="rounded-lg px-2 py-1 text-[11px] outline-none"
        style={{
          background: "var(--page)",
          border: "1px solid var(--border)",
          color: "var(--ink-2)",
          opacity: pending ? 0.6 : 1,
        }}
        aria-label="Account currency"
      >
        {ACCOUNT_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {error ? (
        <span className="max-w-48 text-[11px]" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
