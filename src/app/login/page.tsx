"use client";

import { useActionState } from "react";
import { login } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<{ error?: string }, FormData>(login, {});

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div
        className="w-full max-w-sm rounded-2xl p-8"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
        }}
      >
        <h1
          className="mb-8 text-3xl font-semibold tracking-tight"
          style={{ color: "var(--ink-1)" }}
        >
          Duit.
        </h1>
        <form action={formAction} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm" style={{ color: "var(--ink-2)" }}>
              Email
            </span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              className="rounded-lg px-3 py-2 text-base outline-none focus:ring-2"
              style={{
                background: "var(--page)",
                border: "1px solid var(--border)",
                color: "var(--ink-1)",
              }}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm" style={{ color: "var(--ink-2)" }}>
              Password
            </span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              className="rounded-lg px-3 py-2 text-base outline-none focus:ring-2"
              style={{
                background: "var(--page)",
                border: "1px solid var(--border)",
                color: "var(--ink-1)",
              }}
            />
          </label>
          {state.error ? (
            <p className="text-sm" style={{ color: "var(--critical)" }}>
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className="mt-2 rounded-lg px-4 py-2.5 text-base font-medium disabled:opacity-60"
            style={{ background: "var(--accent)", color: "#ffffff" }}
          >
            {pending ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
