// pure P/L display helpers — shared by server pages and client components
import { formatCcy, formatSen } from "@/lib/money";

export function plColor(sen: number): string {
  return sen > 0 ? "var(--good-text)" : sen < 0 ? "var(--critical)" : "var(--ink-2)";
}

/** cost_cent/unrealized_cent share the holding's own currency, so their
 *  ratio is FX-free (used for both the strip's total % and each row's %). */
export function unrealizedPct(unrealized: number, cost: number): number {
  return cost > 0 ? (unrealized / cost) * 100 : 0;
}

/** +/- "RM x" with an explicit sign (Unrealized P/L's mockup treatment). */
export function formatSignedSen(sen: number): string {
  if (sen === 0) return formatSen(0);
  return `${sen > 0 ? "+ " : "− "}${formatSen(Math.abs(sen))}`;
}

/** formatSignedSen's explicit-sign treatment for any currency (native-mode
 *  Unrealized P/L column, ruling 8). Moved from HoldingsTable.tsx (Plan 9
 *  Q36): components print it only through `useMoney()`'s `signed` option. */
export function formatSignedCcy(currency: string, minorUnits: number): string {
  if (currency === "MYR") return formatSignedSen(minorUnits);
  if (minorUnits === 0) return formatCcy(currency, 0);
  return `${minorUnits > 0 ? "+ " : "− "}${formatCcy(currency, Math.abs(minorUnits))}`;
}

export function formatPct(pct: number): string {
  if (pct === 0) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}
