/**
 * Pure month-string helpers for the Budget page's ‹ › nav (Plan 4 Task 4).
 * Months are "YYYY-MM"; plain string comparison is safe because the format
 * is fixed-width and zero-padded.
 */

export function shiftMonth(month: string, delta: number): string {
  const [yStr, mStr] = month.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const total = y * 12 + (m - 1) + delta;
  const newY = Math.floor(total / 12);
  const newM = (total % 12) + 1;
  return `${newY}-${String(newM).padStart(2, "0")}`;
}

/** Clamp `month` into [min, max] (inclusive), all "YYYY-MM". */
export function clampMonth(month: string, min: string, max: string): string {
  if (month < min) return min;
  if (month > max) return max;
  return month;
}
