"use client";

import { useActionState } from "react";
import { createCategory } from "./actions";
import { Button } from "@/components/Button";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface ParentOption {
  id: string;
  name: string;
  kind: string;
}

export function AddCategoryForm({ parents }: { parents: ParentOption[] }) {
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(
    createCategory,
    {},
  );

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
          maxLength={40}
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Kind
        </span>
        <select name="kind" required className="rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle}>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Tag
        </span>
        <select name="tag" className="rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle}>
          <option value="needs">Needs</option>
          <option value="wants">Wants</option>
          <option value="savings">Savings</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Parent (optional)
        </span>
        <select name="parentId" className="rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle}>
          <option value="">None — top level</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {parent.name} ({parent.kind})
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Adding…" : "Add category"}
      </Button>
      {state.error ? (
        <p className="w-full text-sm" style={{ color: "var(--critical)" }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
