"use client";

import { useActionState } from "react";
import { saveAlias } from "./actions";
import { Button } from "@/components/Button";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface Option {
  id: string;
  name: string;
}

interface AddAliasFormProps {
  categories: Option[];
  accounts: Option[];
}

export function AddAliasForm({ categories, accounts }: AddAliasFormProps) {
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(
    saveAlias,
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Phrase
        </span>
        <input
          type="text"
          name="phrase"
          required
          maxLength={60}
          placeholder="e.g. mamak"
          className="rounded-lg px-3 py-2 text-sm outline-none"
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: "var(--ink-2)" }}>
          Points to
        </span>
        <select name="target" required className="rounded-lg px-3 py-2 text-sm outline-none" style={inputStyle}>
          <option value="">Choose one…</option>
          {categories.length > 0 ? (
            <optgroup label="Categories">
              {categories.map((c) => (
                <option key={c.id} value={`category:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {accounts.length > 0 ? (
            <optgroup label="Accounts">
              {accounts.map((a) => (
                <option key={a.id} value={`account:${a.id}`}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving…" : "Add alias"}
      </Button>
      {state.error ? (
        <p className="w-full text-sm" style={{ color: "var(--critical)" }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
