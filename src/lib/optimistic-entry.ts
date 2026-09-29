/**
 * Pure arithmetic for QuickAdd's optimistic save (Plan 3 Task 5). No React,
 * no clock, no randomness — the useOptimistic wiring in QuickAdd.tsx passes
 * these straight in as reducers, so the pending-row math is testable without
 * mounting anything.
 */

export type OptimisticEntry = {
  clientId: string;
  label: string;
  amount_sen: number;
  isExpense: boolean;
  pending: true;
};

/** Either a real recents row (keyed by its client-generated `id`) or a still-pending optimistic one (keyed by `clientId`). */
type Keyed = { id?: string; clientId?: string };

function keyOf(item: Keyed): string | undefined {
  return item.clientId ?? item.id;
}

/**
 * Recents with the optimistic entry prepended, deduped by clientId. Dedupes
 * against BOTH a previous optimistic row for the same save (a retry must not
 * show twice) and a real row that already landed under the same id (the
 * client-generated UUID doubles as the idempotency key) — either way, the
 * fresh entry wins the front slot.
 */
export function withOptimistic<T extends Keyed>(
  recents: T[],
  entry: OptimisticEntry,
): Array<T | OptimisticEntry> {
  const deduped = recents.filter((row) => keyOf(row) !== entry.clientId);
  return [entry, ...deduped];
}

/**
 * New today-total in sen. todayTotal (src/lib/stats.ts) sums netExpenseSen
 * per row — expense rows contribute amount_sen (minus expected_back, which a
 * fresh quick-add entry never has yet), income and transfers contribute 0 —
 * so the optimistic bump mirrors that: add for expenses, leave untouched for
 * income.
 */
export function bumpTodayTotal(current_sen: number, entry: OptimisticEntry): number {
  return entry.isExpense ? current_sen + entry.amount_sen : current_sen;
}

/**
 * Pure arithmetic for Task 6's optimistic edit/delete (TransactionRow's
 * desktop table body + ActivityList's mobile list). Both own a `T[]` of
 * rows and fold a Save/Delete dispatched from TxFormSheet through these —
 * same "pure reducer, no React" shape as withOptimistic/bumpTodayTotal above.
 */
export type RowPatch = {
  id: string;
  amount_sen?: number;
  note?: string;
  category_id?: string | null;
  date?: string;
  /** Plan 7 ruling 7. The optimistic overlay is an EDIT SURFACE: a re-edit
   *  inside the window before the server refresh lands builds its form from
   *  the patched row, so a patch that cannot carry the tag would hand that
   *  second save a STALE `fund_id` and silently move a fund balance. Like
   *  `category_id`, `null` here IS a provided value — clearing the fund is a
   *  legitimate edit and must survive the overlay. */
  fund_id?: string | null;
};

/**
 * Returns a new array with only the row matching `patch.id` replaced, and on
 * that row only the fields present in `patch` overwritten (a key holding
 * `undefined` — i.e. simply absent from the patch object — leaves the
 * existing value untouched; `category_id: null` IS a provided value, since
 * clearing the category is a legitimate edit). Unknown id ⇒ no-op (same
 * array contents, new array reference). Does not mutate `rows` or `patch`.
 */
export function applyPatch<T extends { id: string }>(rows: T[], patch: RowPatch): T[] {
  return rows.map((row) => {
    if (row.id !== patch.id) return row;
    const patched = { ...row };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "id" || value === undefined) continue;
      (patched as Record<string, unknown>)[key] = value;
    }
    return patched;
  });
}

/** Returns a new array with the row matching `id` removed. Unknown id ⇒ no-op. Does not mutate `rows`. */
export function removeRow<T extends { id: string }>(rows: T[], id: string): T[] {
  return rows.filter((row) => row.id !== id);
}

/**
 * The wiring contract TxFormSheet's edit-mode Save/Delete dispatch through:
 * the row-list owner (TransactionRow's table body, ActivityList) implements
 * this by folding `patch`/`remove` into its own `useOptimistic` state and
 * `settled` into a plain `useState` error banner. Kept here (not in
 * TxFormSheet, a client component) so every consumer imports one shape.
 */
export interface OptimisticRowHandlers {
  patch: (patch: RowPatch) => void;
  remove: (id: string) => void;
  /** Called once the dispatched action resolves: true clears any stale error banner, false shows "Couldn't save — nothing was changed". */
  settled: (ok: boolean) => void;
}
