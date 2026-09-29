"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { reconcileAccount } from "@/app/(app)/transactions/reconcile-actions";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface CategoryOption {
  id: string;
  name: string;
}

interface AccountReconcileProps {
  accountId: string;
  incomeCategories: CategoryOption[];
}

interface ReconcileState {
  error?: string;
}

export function AccountReconcile({ accountId, incomeCategories }: AccountReconcileProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const preselected = incomeCategories.find((c) => c.name === "Interest")?.id ?? incomeCategories[0]?.id ?? "";

  async function submit(_prev: ReconcileState, formData: FormData): Promise<ReconcileState> {
    const statedBalance = String(formData.get("statedBalance") ?? "");
    const categoryId = String(formData.get("categoryId") ?? "");
    const result = await reconcileAccount(accountId, statedBalance, categoryId);
    if (!result.ok) return { error: result.error };
    router.refresh();
    setOpen(false);
    return {};
  }
  const [state, formAction, pending] = useActionState<ReconcileState, FormData>(submit, {});

  if (!open) {
    return (
      <Button type="button" variant="secondary" className="px-2 py-1 text-xs" onClick={() => setOpen(true)}>
        Reconcile
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-2 pt-2">
      <div className="flex gap-2">
        <input
          type="text"
          name="statedBalance"
          inputMode="decimal"
          placeholder="Stated balance"
          required
          className="w-28 rounded-lg px-2 py-1 text-xs outline-none"
          style={inputStyle}
        />
        <select
          name="categoryId"
          defaultValue={preselected}
          required
          className="flex-1 rounded-lg px-2 py-1 text-xs outline-none"
          style={inputStyle}
        >
          {incomeCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" className="px-2 py-1 text-xs" disabled={pending}>
          {pending ? "Reconciling…" : "Confirm"}
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
