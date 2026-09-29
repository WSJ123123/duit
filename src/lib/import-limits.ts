/**
 * The CSV import's limits (Plan 8 ruling 18; Plan 9 Task 4 R5 — one constant
 * module, named in every refusal). Pure; shared by the wizard, the server
 * actions and the DB layer. No "use client" here (finding #20).
 */

/** Ruling 11: the wizard commits in chunks of this many preview rows, and
 *  the server refuses a wider one. */
export const IMPORT_CHUNK_ROWS = 100;

/** Ruling 18's size cap (1 MiB, shown as "1 MB"). */
export const IMPORT_MAX_BYTES = 1_048_576;

/** Ruling 18's row cap — data rows below the header. */
export const IMPORT_MAX_ROWS = 500;

/** Plan 9 ruling 7: the header-line picker shows this many raw lines
 *  (0-based lines 0–11), so `header_line`'s ceiling is one less. */
export const IMPORT_PICKER_LINES = 12;

/** The size refusal, or null — ONE sentence, said by the wizard before it
 *  uploads and by the server, which stays authoritative. */
export function oversizeError(bytes: number): string | null {
  if (bytes <= IMPORT_MAX_BYTES) return null;
  return `File is ${Math.ceil(bytes / 1024)} KB — the limit is 1 MB; split the export by month`;
}
