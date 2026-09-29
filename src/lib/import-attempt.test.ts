import { describe, it, expect } from "vitest";
import { IDLE_ATTEMPT, attemptAfterRun, attemptResumes, attemptToRun } from "@/lib/import-attempt";

/**
 * Plan 9 Task 4 — the wizard's import attempt as pure state (Q25 client
 * batch id, R1–R3): the id is minted ONCE when Import is pressed and kept
 * for every retry of that attempt; a terminal failure clears it (the next
 * press is a new attempt under a new id); a changed mapping drops it (Q30);
 * a same-mapping re-preview keeps the resume index (R3).
 */

let n = 0;
const mint = () => `id-${++n}`;

describe("attemptToRun — the client-generated batch id (Q25)", () => {
  it("mints once and keeps the id across retries", () => {
    const first = attemptToRun(IDLE_ATTEMPT, mint);
    expect(first).toEqual({ id: "id-1", batchId: null, resumeFrom: 0, failure: null });
    const failed = attemptAfterRun(first, { failed: true, terminal: false, resumeFrom: 100, batchId: "id-1", error: "Connection lost" });
    expect(failed).toEqual({ id: "id-1", batchId: "id-1", resumeFrom: 100, failure: "retry" });
    const retry = attemptToRun(failed, mint);
    expect(retry).toEqual({ id: "id-1", batchId: "id-1", resumeFrom: 100, failure: null });
  });

  it("R1: a rejected begin keeps the id and no batch — Retry runs begin again under the same id", () => {
    const first = attemptToRun(IDLE_ATTEMPT, mint);
    const failed = attemptAfterRun(first, { failed: true, terminal: false, resumeFrom: 0, batchId: null, error: "lost" });
    expect(failed).toEqual({ id: first.id, batchId: null, resumeFrom: 0, failure: "retry" });
    expect(attemptToRun(failed, mint).id).toBe(first.id);
  });

  it("R2: a terminal failure clears the id and the batch, and keeps nothing to resume — the next press is a new attempt", () => {
    const first = attemptToRun(IDLE_ATTEMPT, mint);
    const opened = attemptAfterRun(first, { failed: true, terminal: false, resumeFrom: 100, batchId: first.id!, error: "lost" });
    const terminal = attemptAfterRun(opened, { failed: true, terminal: true, resumeFrom: 0, batchId: first.id, error: "This batch was undone — start a new import" });
    expect(terminal).toEqual({ id: null, batchId: null, resumeFrom: 0, failure: "terminal" });
    const again = attemptToRun(terminal, mint);
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ batchId: null, resumeFrom: 0, failure: null });
  });

  it("a finished run returns to idle", () => {
    const first = attemptToRun(IDLE_ATTEMPT, mint);
    expect(attemptAfterRun(first, { failed: false, batchId: first.id!, done: { ok: true, done: true } })).toEqual(IDLE_ATTEMPT);
  });
});

describe("attemptResumes — stepping back and previewing again (the attempt's identity is its id)", () => {
  const open = { id: "id-9", batchId: "id-9", resumeFrom: 200, failure: "retry" as const };
  /** R1: begin's request died — the id is minted, no batch is confirmed. */
  const lostBegin = { id: "id-9", batchId: null, resumeFrom: 0, failure: "retry" as const };

  it("R3: the same mapping resumes an open batch — the attempt (its batch, its resume index) is kept", () => {
    expect(attemptResumes(open, true)).toBe(true);
  });

  it("Q25 review I1: after a rejected begin, a same-mapping re-preview keeps the minted id — a landed-but-lost begin is found under it, never orphaned", () => {
    expect(attemptResumes(lostBegin, true)).toBe(true);
  });

  it("Q30: a changed mapping is another import — the next press mints a new id; and nothing resumes before Import was ever pressed", () => {
    expect(attemptResumes(open, false)).toBe(false);
    expect(attemptResumes(lostBegin, false)).toBe(false);
    expect(attemptResumes(IDLE_ATTEMPT, true)).toBe(false);
  });
});
