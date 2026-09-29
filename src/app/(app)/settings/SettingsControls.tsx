"use client";

import { startTransition, useState } from "react";
import { updateSettings } from "./actions";

const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

interface AccountOption {
  id: string;
  name: string;
}

interface SettingsControlsProps {
  initialShowTips: boolean;
  initialDefaultAccountId: string | null;
  accounts: AccountOption[];
}

export function SettingsControls({
  initialShowTips,
  initialDefaultAccountId,
  accounts,
}: SettingsControlsProps) {
  const [showTips, setShowTips] = useState(initialShowTips);
  const [defaultAccountId, setDefaultAccountId] = useState(initialDefaultAccountId ?? "");

  function setTips(next: boolean) {
    setShowTips(next); // optimistic: flips instantly, independent of the round trip
    startTransition(() => {
      void updateSettings({ showTips: next });
    });
  }

  function setDefaultAccount(next: string) {
    setDefaultAccountId(next);
    startTransition(() => {
      void updateSettings({ defaultAccountId: next || null });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm" style={{ color: "var(--ink-1)" }}>
          Show tips
        </span>
        <div
          className="flex overflow-hidden rounded-lg text-xs"
          style={{ border: "1px solid var(--border)" }}
        >
          <button
            type="button"
            onClick={() => setTips(true)}
            className="px-3 py-1.5"
            style={{
              background: showTips ? "var(--chip)" : "transparent",
              color: showTips ? "var(--ink-1)" : "var(--ink-3)",
              fontWeight: showTips ? 650 : 400,
            }}
          >
            On
          </button>
          <button
            type="button"
            onClick={() => setTips(false)}
            className="px-3 py-1.5"
            style={{
              background: !showTips ? "var(--chip)" : "transparent",
              color: !showTips ? "var(--ink-1)" : "var(--ink-3)",
              fontWeight: !showTips ? 650 : 400,
            }}
          >
            Off
          </button>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="text-sm" style={{ color: "var(--ink-1)" }}>
          Default account
        </span>
        <select
          value={defaultAccountId}
          onChange={(e) => setDefaultAccount(e.target.value)}
          className="rounded-lg px-3 py-1.5 text-sm outline-none"
          style={inputStyle}
        >
          <option value="">None</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
