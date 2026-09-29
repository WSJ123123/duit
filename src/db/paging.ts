/**
 * Finding #19: PostgREST truncates an unbounded select at 1000 rows and returns
 * HTTP 200 with no error and no flag — a silently wrong money number, which is
 * exactly what rules 15 and 19 forbid. Any read whose correctness depends on
 * seeing EVERY row is paged with this loop (Plan 8 ruling 14 lifted it here
 * from the identical private copies in funds.ts and bills.ts once the export,
 * the stats range read and the import preview made five callers).
 *
 * `PAGE_SIZE` is a REQUEST HINT, never an assumption about the server. A hosted
 * project can set `Max rows` below it, in which case every page comes back
 * capped; a loop that read "shorter than requested" as "last page" would stop
 * at the first one and under-read exactly as the unpaged version did — green on
 * a local stack whose cap is 1000, silently wrong in production. So the loop
 * terminates on an EMPTY page and advances the cursor by the rows it actually
 * received, which is correct for any server cap at or below the request.
 *
 * Every paged query MUST carry a deterministic TOTAL order (append the unique
 * `id` as the last key), or rows can repeat or vanish between pages.
 */
export const PAGE_SIZE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data ?? [];
    if (batch.length === 0) return rows;
    rows.push(...batch);
    from += batch.length;
  }
}

/** An `in (…)` list is sent in the URL, and 1000+ uuids is a 414 (seen at
 *  ruling 14's 1,200-row test): a growing id list is read in chunks of this
 *  many, each chunk paged. */
export const IN_CHUNK = 100;
