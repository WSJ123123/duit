"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Portal } from "@/components/Portal";

/**
 * Shared primitives for the Net Worth page's dialogs (ManualItemDialogs.tsx,
 * BusinessDialogs.tsx) — the common bottom-sheet-on-mobile / centered-card-
 * on-desktop chrome (TxFormSheet's pattern), field wrapper, inline text-link
 * trigger (mockup's `.act` treatment) and Save/Cancel footer. Split out
 * because three unrelated dialog domains (assets, liabilities, business)
 * sharing this chrome is a "shared UI kit" responsibility, not a "manual
 * item dialogs" one — see task-6-report.md.
 */

/**
 * Ruling 6 (Smoke Minor A): the shared bottom-sheet / centred-card shell.
 * ONE constant, used by both `DialogShell` below and `TxFormSheet`'s sheet —
 * the two hand-written copies are exactly what let the entry dialog's tab row
 * squash on a short viewport while the Net Worth dialogs' did not.
 *
 * `[&>*]:flex-shrink-0` is the fix: this is a `flex-col overflow-y-auto`
 * container capped at 90vh, so without it every child shrinks before the
 * container scrolls, and the child with no intrinsic minimum (the entry
 * form's type-tab row) collapses. Overflow is the container's scroll,
 * never a squashed row. It has to be a rule on the container, not a class on
 * each child, because both shells render caller-supplied children.
 *
 * Callers append their own max-width (`md:max-w-lg` / `md:max-w-md`).
 *
 * ⚠ CLIENT-ONLY IMPORT (finding #20): this module is `"use client"`, so a
 * Server Component importing this constant gets a client reference, not the
 * string. Only `"use client"` modules and node tests may import it; a server
 * surface that needs the shell string must move the constant to `src/lib/`
 * first (and update `dialog-shell.test.ts`, which counts the literal here).
 */
export const DIALOG_SHELL_CLASS =
  "flex max-h-[90vh] w-full flex-col gap-3 overflow-y-auto rounded-t-3xl p-5 pb-8 shadow-[0_-8px_40px_rgba(0,0,0,0.25)] md:rounded-2xl md:border md:pb-5 md:shadow-none [&>*]:flex-shrink-0";

export const inputStyle = {
  background: "var(--page)",
  border: "1px solid var(--border)",
  color: "var(--ink-1)",
} as const;

/** sen -> input string like "12.50" for prefilling amount fields. */
export function senToInputStr(sen: number): string {
  return (sen / 100).toFixed(2);
}

export function ActionLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-shrink-0 whitespace-nowrap text-xs font-medium"
      style={{ color: "var(--accent)" }}
    >
      {children}
    </button>
  );
}

/**
 * The house two-tap confirm as one primitive (Plan 7 ruling 13): first tap
 * arms the critical-colored confirm label, second runs the action. Same
 * vocabulary and treatment as the hand-rolled copies in BusinessDialogs'
 * `EntryRow` and HoldingsTable's archived rows — lifted here because ruling
 * 13 needs it on three more row types (manual asset / liability / business)
 * and a fourth copy would be the drift hazard. Rule 15: a failed write always
 * shows its error rather than silently doing nothing.
 */
export function TwoTapAction({
  label,
  confirmLabel,
  pendingLabel,
  run,
}: {
  label: string;
  confirmLabel: string;
  pendingLabel: string;
  run: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  function handle() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const result = await run();
      if (!result.ok) {
        setConfirming(false);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={handle}
        disabled={pending}
        className="flex-shrink-0 whitespace-nowrap text-xs font-medium"
        style={{ color: confirming || pending ? "var(--critical)" : "var(--accent)" }}
      >
        {pending ? pendingLabel : confirming ? confirmLabel : label}
      </button>
      {error ? (
        <span className="basis-full text-xs font-medium" style={{ color: "var(--critical)" }}>
          {error}
        </span>
      ) : null}
    </>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs" style={{ color: "var(--ink-2)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

export function DialogShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4"
        style={{ background: "var(--dim)" }}
        onClick={onClose}
      >
        <div
          className={`${DIALOG_SHELL_CLASS} md:max-w-md`}
          style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="mx-auto -mt-1 h-1 w-10 flex-shrink-0 rounded-full md:hidden"
            style={{ background: "var(--baseline)" }}
          />
          <h3 className="text-base font-semibold" style={{ color: "var(--ink-1)" }}>
            {title}
          </h3>
          {children}
        </div>
      </div>
    </Portal>
  );
}

export function ErrorLine({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p className="text-sm" style={{ color: "var(--critical)" }}>
      {error}
    </p>
  );
}

export function DialogButtons({
  onCancel,
  onSave,
  pending,
  saveLabel = "Save",
}: {
  onCancel: () => void;
  onSave: () => void;
  pending: boolean;
  saveLabel?: string;
}) {
  return (
    <div className="mt-1 flex gap-3">
      <Button type="button" variant="secondary" className="flex-1" onClick={onSave} disabled={pending}>
        {pending ? "Saving…" : saveLabel}
      </Button>
      <Button type="button" variant="ghost" className="flex-1" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
