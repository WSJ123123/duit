"use client";

import { startTransition, useState } from "react";
import { generateDefaultAliases } from "./actions";
import { Button } from "@/components/Button";

interface GenerateAliasesButtonProps {
  /** Called with the raw result once generation completes (e.g. onboarding re-fetches the alias list). */
  onResult?: (result: { error?: string; inserted?: number }) => void;
}

export function GenerateAliasesButton({ onResult }: GenerateAliasesButtonProps = {}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ error?: string; inserted?: number } | null>(null);

  function generate() {
    setPending(true);
    startTransition(() => {
      void generateDefaultAliases().then((r) => {
        setResult(r);
        setPending(false);
        onResult?.(r);
      });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" variant="secondary" disabled={pending} onClick={generate}>
        {pending ? "Generating…" : "Generate from my names"}
      </Button>
      {result?.error ? (
        <p className="text-sm" style={{ color: "var(--critical)" }}>
          {result.error}
        </p>
      ) : result && result.inserted !== undefined ? (
        <p className="text-sm" style={{ color: "var(--ink-2)" }}>
          {result.inserted === 0
            ? "Nothing new to add — already up to date."
            : `Added ${result.inserted} alias${result.inserted === 1 ? "" : "es"}.`}
        </p>
      ) : null}
    </div>
  );
}
