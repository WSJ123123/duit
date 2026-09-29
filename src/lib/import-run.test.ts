import { describe, it, expect, vi } from "vitest";
import { CONNECTION_LOST, CONNECTION_LOST_BEGIN, runImportChunks, type ChunkOutcome } from "@/lib/import-run";

/** Plan 8 Task 6 fix wave (I2): the wizard's chunk loop as a pure function —
 *  mocked `begin`/`commit`, node environment. Plan 9 Task 4: R1 (the rejected
 *  begin says what Retry does) and R2 (a non-partial refusal is terminal). */

interface Done {
  imported_count: number;
}

const more: ChunkOutcome<Done> = { ok: true, done: false };
const finished: ChunkOutcome<Done> = { ok: true, done: true, imported_count: 250 };
const opened = async () => ({ ok: true as const, batch_id: "batch-1" });

describe("runImportChunks", () => {
  it("commits 250 rows as [0,100) [100,200) [200,250) under one batch and reports progress", async () => {
    const begin = vi.fn(opened);
    const commit = vi.fn(async (_b: string, _from: number, to: number) => (to === 250 ? finished : more));
    const progress: number[] = [];
    const r = await runImportChunks({ total: 250, chunkRows: 100, from: 0, batchId: null, begin, commit, onProgress: (n) => progress.push(n) });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls).toEqual([
      ["batch-1", 0, 100],
      ["batch-1", 100, 200],
      ["batch-1", 200, 250],
    ]);
    expect(r).toEqual({ failed: false, batchId: "batch-1", done: { ok: true, done: true, imported_count: 250 } });
    expect(progress).toEqual([0, 100, 100, 200, 200, 250]);
  });

  it("a REJECTED chunk is caught, never rethrown: resumeFrom is that chunk's start, the batch is kept, Retry is offered", async () => {
    const commit = vi.fn(async (_b: string, from: number) => {
      if (from === 100) throw new TypeError("Failed to fetch");
      return more;
    });
    const r = await runImportChunks({ total: 250, chunkRows: 100, from: 0, batchId: null, begin: opened, commit });
    expect(r).toEqual({ failed: true, terminal: false, resumeFrom: 100, batchId: "batch-1", error: CONNECTION_LOST });
    expect(CONNECTION_LOST).toBe("Connection lost — Retry replays this chunk");
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("resuming with the batch id never calls begin again and starts at the failed chunk", async () => {
    const begin = vi.fn(opened);
    const commit = vi.fn(async (_b: string, _from: number, to: number) => (to === 250 ? finished : more));
    const r = await runImportChunks({ total: 250, chunkRows: 100, from: 100, batchId: "batch-1", begin, commit });
    expect(begin).not.toHaveBeenCalled();
    expect(commit.mock.calls).toEqual([
      ["batch-1", 100, 200],
      ["batch-1", 200, 250],
    ]);
    expect(r.failed).toBe(false);
  });

  it("a returned partial stops at that chunk, says how many rows of it were saved, and is retryable", async () => {
    const commit = vi.fn(async (_b: string, from: number): Promise<ChunkOutcome<Done>> =>
      from === 100 ? { ok: false, partial: true, saved_in_chunk: 7, error: "boom" } : more,
    );
    const r = await runImportChunks({ total: 250, chunkRows: 100, from: 0, batchId: null, begin: opened, commit });
    expect(r).toEqual({
      failed: true,
      terminal: false,
      resumeFrom: 100,
      batchId: "batch-1",
      error: "boom — 7 rows of this chunk were saved; Retry replays it",
    });
  });

  it("a pre-write DB error reported as partial with 0 saved (Plan 9 R2 controller decision) keeps the batch and the chunk — not terminal", async () => {
    const commit = vi.fn(async (_b: string, from: number): Promise<ChunkOutcome<Done>> =>
      from === 100 ? { ok: false, partial: true, saved_in_chunk: 0, error: "simulated read failure" } : more,
    );
    const r = await runImportChunks({ total: 250, chunkRows: 100, from: 0, batchId: "batch-1", begin: opened, commit });
    expect(r).toEqual({
      failed: true,
      terminal: false,
      resumeFrom: 100,
      batchId: "batch-1",
      error: "simulated read failure — 0 rows of this chunk were saved; Retry replays it",
    });
  });

  it("R2: a returned non-partial refusal is TERMINAL and carries the server's sentence unchanged", async () => {
    const commit = vi.fn(async (): Promise<ChunkOutcome<Done>> => ({ ok: false, partial: false, error: "This batch was undone — start a new import" }));
    const r = await runImportChunks({ total: 250, chunkRows: 100, from: 0, batchId: "batch-1", begin: opened, commit });
    expect(r).toEqual({ failed: true, terminal: true, resumeFrom: 0, batchId: "batch-1", error: "This batch was undone — start a new import" });
  });

  it("a refused begin is terminal with no batch; a REJECTED begin is retryable and says begin runs again (R1)", async () => {
    const commit = vi.fn(async () => more);
    const refused = await runImportChunks({
      total: 250, chunkRows: 100, from: 0, batchId: null, commit,
      begin: async () => ({ ok: false as const, error: "Old bank is archived — pick an active account" }),
    });
    expect(refused).toEqual({ failed: true, terminal: true, resumeFrom: 0, batchId: null, error: "Old bank is archived — pick an active account" });
    const rejected = await runImportChunks({
      total: 250, chunkRows: 100, from: 0, batchId: null, commit,
      begin: async () => {
        throw new Error("network");
      },
    });
    expect(rejected).toEqual({ failed: true, terminal: false, resumeFrom: 0, batchId: null, error: CONNECTION_LOST_BEGIN });
    expect(CONNECTION_LOST_BEGIN).toBe("Connection lost before the import opened — Retry opens it again under the same id; no rows were written");
    expect(CONNECTION_LOST_BEGIN).not.toContain("chunk");
    expect(commit).not.toHaveBeenCalled();
  });
});
