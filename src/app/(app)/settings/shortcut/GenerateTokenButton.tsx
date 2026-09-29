"use client";

import { startTransition, useState } from "react";
import { createApiToken } from "./actions";
import { Button } from "@/components/Button";

/**
 * Runs the generate action and shows the returned raw token once. The token
 * lives only in this component's state for the current render — it is never
 * stored anywhere else and cannot be fetched again.
 */
export function GenerateTokenButton({ label }: { label: string }) {
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function generate() {
    setPending(true);
    setCopied(false);
    startTransition(() => {
      void createApiToken().then((r) => {
        setToken(r.token ?? null);
        setError(r.error ?? null);
        setPending(false);
      });
    });
  }

  function copy() {
    if (!token) return;
    void navigator.clipboard.writeText(token).then(() => setCopied(true));
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button type="button" variant="primary" disabled={pending} onClick={generate}>
          {pending ? "Generating…" : label}
        </Button>
      </div>
      {error ? (
        <p className="text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      ) : null}
      {token ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={token}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Your new API token"
              className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-xs outline-none"
              style={{
                background: "var(--page)",
                border: "1px solid var(--border)",
                color: "var(--ink-1)",
              }}
            />
            <Button type="button" variant="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs" style={{ color: "var(--critical)" }}>
            Copy this token now — it will not be shown again.
          </p>
        </div>
      ) : null}
    </div>
  );
}
