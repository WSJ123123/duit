/**
 * The import wizard's chunk loop (Plan 8 ruling 11), pure so it can be tested
 * without a browser: ONE batch per import, opened at most once; every chunk
 * and every retry carries its id. A request that dies (a rejected promise
 * from `begin` or `commit`) is caught and returned as the same failed shape a
 * refusal has, so the wizard can always offer Retry — nothing is rethrown.
 * Plan 9 Task 4: a refusal that is not partial is TERMINAL (R2) — the wizard
 * ends the attempt rather than offering a Retry that can only repeat it; a
 * rejected `begin` says what Retry does (R1). No "use client" here (finding #20).
 */

export const CONNECTION_LOST = "Connection lost — Retry replays this chunk";

/** R1: no chunk was sent — Retry runs `begin` again under the attempt's id
 *  (Q25), which returns the batch if the lost request had in fact landed. */
export const CONNECTION_LOST_BEGIN =
  "Connection lost before the import opened — Retry opens it again under the same id; no rows were written";

/** What one chunk's commit answers — `commitImportChunk`'s result, structurally. */
export type ChunkOutcome<D> =
  | { ok: true; done: false }
  | ({ ok: true; done: true } & D)
  | { ok: false; partial: true; saved_in_chunk: number; error: string }
  | { ok: false; partial: false; error: string };

export interface RunImportArgs<D> {
  /** Preview rows in the file (unparseable ones count). */
  total: number;
  chunkRows: number;
  /** The first row of the chunk to (re)start at — 0, or a failed run's `resumeFrom`. */
  from: number;
  /** The open batch on a retry; null opens one. */
  batchId: string | null;
  begin: () => Promise<{ ok: true; batch_id: string } | { ok: false; error: string }>;
  commit: (batchId: string, from: number, to: number) => Promise<ChunkOutcome<D>>;
  /** Rows confirmed written so far — before and after every chunk. */
  onProgress?: (written: number) => void;
}

export type RunImportResult<D> =
  | { failed: false; batchId: string; done: Extract<ChunkOutcome<D>, { done: true }> }
  /** `terminal`: the server refused outright (R2) — Retry could only repeat
   *  it; the wizard ends the attempt. Otherwise Retry resumes at `resumeFrom`. */
  | { failed: true; terminal: boolean; resumeFrom: number; batchId: string | null; error: string };

export async function runImportChunks<D>(args: RunImportArgs<D>): Promise<RunImportResult<D>> {
  const { total, chunkRows, commit, onProgress } = args;
  let batchId = args.batchId;
  if (batchId === null) {
    try {
      const begun = await args.begin();
      if (!begun.ok) return { failed: true, terminal: true, resumeFrom: 0, batchId: null, error: begun.error };
      batchId = begun.batch_id;
    } catch {
      return { failed: true, terminal: false, resumeFrom: args.from, batchId: null, error: CONNECTION_LOST_BEGIN };
    }
  }
  for (let from = args.from; from < total; from += chunkRows) {
    const to = Math.min(from + chunkRows, total);
    onProgress?.(from);
    let r: ChunkOutcome<D>;
    try {
      r = await commit(batchId, from, to);
    } catch {
      return { failed: true, terminal: false, resumeFrom: from, batchId, error: CONNECTION_LOST };
    }
    if (!r.ok) {
      if (!r.partial) return { failed: true, terminal: true, resumeFrom: 0, batchId, error: r.error };
      const error = `${r.error} — ${r.saved_in_chunk} rows of this chunk were saved; Retry replays it`;
      return { failed: true, terminal: false, resumeFrom: from, batchId, error };
    }
    onProgress?.(to);
    if (r.done) return { failed: false, batchId, done: r };
  }
  // The server closes the batch on the chunk that reaches the file's end; a
  // run that got here was never told so — replaying from the top is safe
  // (every row is idempotent) and recomputes the counters.
  return { failed: true, terminal: false, resumeFrom: 0, batchId, error: "The import did not finish — Retry replays it" };
}
