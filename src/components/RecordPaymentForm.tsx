"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { recordReimbursementPayment } from "@/app/(app)/transactions/reimburse-actions";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface AccountOption {
  id: string;
  name: string;
}

interface RecordPaymentFormProps {
  transactionId: string;
  accounts: AccountOption[];
}

interface PaymentState {
  error?: string;
}

export function RecordPaymentForm({ transactionId, accounts }: RecordPaymentFormProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function submit(_prev: PaymentState, formData: FormData): Promise<PaymentState> {
    const accountId = String(formData.get("accountId") ?? "");
    const amount = String(formData.get("amount") ?? "");
    const result = await recordReimbursementPayment(transactionId, accountId, amount);
    if (!result.ok) return { error: result.error };
    router.refresh();
    setOpen(false);
    return {};
  }
  const [state, formAction, pending] = useActionState<PaymentState, FormData>(submit, {});

  if (!open) {
    return (
      <Button type="button" variant="secondary" className="px-2 py-1 text-xs" onClick={() => setOpen(true)}>
        Record payment
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-2 pt-2">
      <div className="flex gap-2">
        <select
          name="accountId"
          required
          defaultValue={accounts[0]?.id ?? ""}
          className="flex-1 rounded-lg px-2 py-1 text-xs outline-none"
          style={inputStyle}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="amount"
          inputMode="decimal"
          placeholder="0.00"
          required
          className="w-24 rounded-lg px-2 py-1 text-xs outline-none"
          style={inputStyle}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" className="px-2 py-1 text-xs" disabled={pending}>
          {pending ? "Recording…" : "Confirm"}
        </Button>
        <Button type="button" variant="secondary" className="px-2 py-1 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {state.error ? (
        <p className="text-xs" style={{ color: "var(--critical)" }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
