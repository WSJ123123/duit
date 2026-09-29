/**
 * Display helpers for the import wizard and Settings › Import history —
 * pure, no clock: every date comes in as an ISO string. Shared by server
 * and client components (no "use client" here — finding #20).
 */

import { formatSen } from "@/lib/money";

// The limits (`IMPORT_CHUNK_ROWS`, `IMPORT_MAX_BYTES`, `oversizeError`) live
// in src/lib/import-limits.ts since Plan 9 Task 4 (R5).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "7 Mar" from "2077-03-07" (or a timestamptz, whose first 10 chars are the
 *  UTC date), "7 Mar 2077" with `withYear`. */
export function formatDayMonth(iso: string, withYear = false): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const base = `${d} ${MONTHS[m - 1] ?? "?"}`;
  return withYear ? `${base} ${y}` : base;
}

/** Plan 9 ruling 7's disclosure, as data on the map, preview and Done
 *  screens: preamble lines are not rows (rule 15 — nothing vanishes), and
 *  the line says so. Null when the header is line 0. */
export function preambleLine(preambleLines: number): string | null {
  if (preambleLines <= 0) return null;
  return `${preambleLines} preamble line${preambleLines === 1 ? "" : "s"} skipped above the header`;
}

/** v7's `last used for <account> · <date>` (ruling 8h) from the stored
 *  mapping's `saved_at`; a Plan-8-shaped mapping has none, so no date. */
export function lastUsedLine(accountName: string, savedAt: string | undefined): string {
  return savedAt === undefined ? `last used for ${accountName}` : `last used for ${accountName} · ${formatDayMonth(savedAt, true)}`;
}

/** Ruling 8g: the Done screen's history card lists the batch just finished
 *  at once — first, ahead of the fetched history, until the refresh brings
 *  it back in the list; then the fetched row wins (nothing is doubled) but
 *  keeps the preamble count only the wizard knows (ruling 7 — not stored). */
export function withFinishedBatch<T extends { id: string; preamble_lines?: number }>(history: T[], finished: T): T[] {
  if (!history.some((h) => h.id === finished.id)) return [finished, ...history];
  return history.map((h) => (h.id === finished.id ? { ...h, preamble_lines: finished.preamble_lines } : h));
}

/** "01/08" — the preview table's short date (mockup v7 §12). */
export function formatDdMm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Why each row of a finished import was NOT written. The mockup's
 *  arithmetic: rows = imported + skipped, and the buckets sum to skipped. */
export interface SkipBreakdown {
  skipped: number;
  /** Probable duplicates the owner left unticked. */
  probably_logged: number;
  /** Rows the table already held: the preview's `already imported` state,
   *  plus any ticked row the write path skipped on 23505. */
  already_imported: number;
  /** `new` rows the owner unticked. */
  left_out: number;
  unparseable: number;
}

/**
 * `importedCount` is the batch's derived count(*) from the final chunk, so
 * the write path's 23505 skips enter as the remainder — ticked rows the
 * table did not take. (Summing each chunk's `skipped_in_chunk` would
 * over-count: a replayed chunk re-reports the batch's OWN rows as skips.)
 */
export function skipBreakdown(
  rows: ReadonlyArray<{ id: string | null; state: string }>,
  included: ReadonlySet<string>,
  importedCount: number,
): SkipBreakdown {
  let probably_logged = 0;
  let left_out = 0;
  let unparseable = 0;
  for (const r of rows) {
    if (r.id === null) unparseable += 1;
    else if (included.has(r.id)) continue;
    else if (r.state === "probable_duplicate") probably_logged += 1;
    else if (r.state === "new") left_out += 1;
  }
  const skipped = Math.max(0, rows.length - importedCount);
  const already_imported = Math.max(0, skipped - probably_logged - left_out - unparseable);
  return { skipped, probably_logged, already_imported, left_out, unparseable };
}

/** "15 skipped (9 probably logged · 4 already imported · 2 unparseable)" —
 *  a bucket is named only when it holds rows. */
export function skippedLine(b: SkipBreakdown): string {
  const buckets: Array<[number, string]> = [
    [b.probably_logged, "probably logged"],
    [b.already_imported, "already imported"],
    [b.left_out, "left out"],
    [b.unparseable, "unparseable"],
  ];
  const parts = buckets.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  return parts.length === 0 ? `${b.skipped} skipped` : `${b.skipped} skipped (${parts.join(" · ")})`;
}

/** The history row has only the stored counters: skipped is printed as
 *  rows − imported, so the line reconciles (unparseable rows are inside it). */
export function historyCountsLine(r: { row_count: number; imported_count: number; needs_review_count: number }): string {
  return `${r.row_count} rows · ${r.imported_count} imported · ${Math.max(0, r.row_count - r.imported_count)} skipped · ${r.needs_review_count} review`;
}

/** Only `new` and `probably logged` rows can be ticked. An already-imported
 *  row is drawn unticked and disabled (mockup v7 §12): ticking it could only
 *  ever produce a write-path skip, and would overstate "Will import n". */
export function isTickable(state: string): boolean {
  return state === "new" || state === "probable_duplicate";
}

/** Same file + same mapping: every parseable row is already imported, so
 *  nothing is tickable and Import stays disabled — this line says why. Null
 *  when a (corrected) mapping leaves anything to import. */
export function nothingNewLine(rows: Array<{ state: string }>, batchNo: number): string | null {
  const parseable = rows.filter((r) => r.state !== "unparseable");
  if (parseable.length === 0 || parseable.some((r) => r.state !== "already_imported")) return null;
  return `Nothing new to import — every row is already in batch #${batchNo}`;
}

/** "−RM 18.00" / "+RM 3,500.00" — the preview's signed amount. */
export function signedText(sen: number): string {
  return sen < 0 ? `−${formatSen(-sen)}` : `+${formatSen(sen)}`;
}

/** The `batch #n` inside a message, split out so the history can render it
 *  as a link (ruling 17: "with a link"); null when no batch is named. */
export function splitBatchLabel(message: string): { before: string; label: string; after: string } | null {
  const m = /batch #\d+/.exec(message);
  if (!m) return null;
  return { before: message.slice(0, m.index), label: m[0], after: message.slice(m.index + m[0].length) };
}

/** The already-imported row's sub-line: `imported 24 Aug (batch #6)` when the
 *  batch that wrote the existing row is known, else the row's own note. */
export function importedSubLine(batch: { created_at: string; batch_no: number } | undefined, note: string): string {
  return batch ? `imported ${formatDayMonth(batch.created_at)} (batch #${batch.batch_no})` : `imported earlier · “${note || "(no note)"}”`;
}

/** Category id → `Parent › Child` (the mockup's category column), or the
 *  bare name for a top-level category. */
export function categoryPathLabels(
  categories: ReadonlyArray<{ id: string; name: string; parent_id: string | null }>,
): Record<string, string> {
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  return Object.fromEntries(
    categories.map((c) => {
      const parent = c.parent_id === null ? undefined : nameOf.get(c.parent_id);
      return [c.id, parent === undefined ? c.name : `${parent} › ${c.name}`];
    }),
  );
}
