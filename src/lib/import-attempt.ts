import type { RunImportResult } from "@/lib/import-run";

/**
 * The wizard's import ATTEMPT as pure state (Plan 9 Task 4 — Q25, R1–R3).
 * An attempt is one press of `Import n rows` and every Retry of it: its
 * batch id is minted on the client ONCE (`crypto.randomUUID()`, the house
 * precedent in the liability dialog) and carried by `begin` and every chunk,
 * so a `begin` whose request died after the server insert is retried under
 * the same id and finds its own batch (the `23505`-is-a-no-op pattern) —
 * no orphan can exist. A terminal failure (R2) ends the attempt: the next
 * press is a new one under a new id. No "use client" here (finding #20).
 */
export interface ImportAttempt {
  /** The client-generated batch id — null until Import is pressed. */
  id: string | null;
  /** The batch the server confirmed under `id` (null until begin answered). */
  batchId: string | null;
  /** The first row of the first chunk not fully saved (R3). */
  resumeFrom: number;
  /** How the last run ended: `retry` keeps the attempt, `terminal` ended it. */
  failure: "retry" | "terminal" | null;
}

export const IDLE_ATTEMPT: ImportAttempt = { id: null, batchId: null, resumeFrom: 0, failure: null };

/** Import (or Retry / Start again) pressed: the id is minted once per attempt. */
export function attemptToRun(a: ImportAttempt, mint: () => string): ImportAttempt {
  return { ...a, id: a.id ?? mint(), failure: null };
}

/** What the run left behind. */
export function attemptAfterRun(a: ImportAttempt, r: RunImportResult<unknown>): ImportAttempt {
  if (!r.failed) return IDLE_ATTEMPT;
  if (r.terminal) return { ...IDLE_ATTEMPT, failure: "terminal" };
  return { id: a.id, batchId: r.batchId, resumeFrom: r.resumeFrom, failure: "retry" };
}

/** Stepping back and previewing again: the same mapping RESUMES the attempt
 *  — its batch and where it stopped (R3) — and the attempt's identity is
 *  its id, not a confirmed batch: after a rejected `begin` (R1) the same
 *  mapping keeps the minted id, so a begin that landed but whose answer was
 *  lost is found under it on the next press (Q25), never orphaned. A changed
 *  mapping is another import (Q30): the caller drops the attempt and the
 *  next press mints a new id. */
export function attemptResumes(a: ImportAttempt, sameMapping: boolean): boolean {
  return a.id !== null && sameMapping;
}
