import type { ProjectionPoint } from "@/lib/bills";
import type { TxUpsertResult } from "@/lib/transactions";

/**
 * Pure display helpers for the Bills page and the dashboard's `Due soon`
 * card. Plain module (no "use client") so BOTH server components and client
 * components can CALL them — finding #20: a `"use client"` module's exports
 * become client references and throw at request time when a Server Component
 * calls them. Same precedent as `src/lib/tx-display.ts` and
 * `src/lib/funds-display.ts`.
 */

const MS_PER_DAY = 86_400_000;

/** "20 Aug" — the mockup's bill-row and strip date format (no year: every
 *  date on this page is inside a 30–90 day window). */
export function formatDM(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Whole calendar days from `fromIso` to `toIso`; negative when `toIso` is earlier. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / MS_PER_DAY,
  );
}

export type DueTone = "normal" | "warn" | "critical";

/** The desktop status pill ("in 1 day", "3 days overdue") and its tone. */
export function dueLabel(dateIso: string, todayIso: string): { text: string; tone: DueTone } {
  const days = daysBetween(todayIso, dateIso);
  if (days < 0) {
    const n = -days;
    return { text: `${n} day${n === 1 ? "" : "s"} overdue`, tone: "critical" };
  }
  if (days === 0) return { text: "today", tone: "warn" };
  if (days <= 7) return { text: `in ${days} day${days === 1 ? "" : "s"}`, tone: "warn" };
  return { text: `in ${days} days`, tone: "normal" };
}

/** The mobile card's wording — same information, said the way v6 says it. */
export function dueWord(dateIso: string, todayIso: string): string {
  const days = daysBetween(todayIso, dateIso);
  if (days < 0) {
    const n = -days;
    return `${n} day${n === 1 ? "" : "s"} overdue`;
  }
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** The desktop table's group headers (mockup v6 §8 `tr.grp`). */
export function billGroup(dateIso: string, todayIso: string): "Overdue" | "This week" | "Later" {
  const days = daysBetween(todayIso, dateIso);
  if (days < 0) return "Overdue";
  return days <= 7 ? "This week" : "Later";
}

export type BillState = "upcoming" | "overdue" | "recorded";

/** The Transactions page understands `?month=` and every row carries its id
 *  as an anchor, so a recorded occurrence can point at its own entry. */
export function recordedTxHref(txId: string, dateIso: string): string {
  return `/transactions?month=${dateIso.slice(0, 7)}#${txId}`;
}

/** Plan 9 (Q31): the helper sees only `created: false` — the entry may have
 *  been recorded by the daily job OR by an earlier `Record now` — so the
 *  sentence blames nobody. Rule 24 forbids a read of the stored row's
 *  `source` for one sentence. */
export const ALREADY_RECORDED_NOTICE = "Already recorded — edit that entry to change the amount";

/**
 * Q11b: `Record now` after the daily job already materialised the occurrence
 * is `performUpsert`'s 23505 no-op (ruling 11's `created: false`) — the
 * edited amount was NOT applied. A bare success would hide that (rule 15), so
 * the form shows this instead: data, not a Tip, with the entry to edit linked.
 * Null whenever the write happened or failed — those paths speak for themselves.
 */
export function recordNowNotice(
  result: TxUpsertResult,
  dateIso: string,
): { text: string; href: string } | null {
  if (!result.ok || result.created) return null;
  return { text: ALREADY_RECORDED_NOTICE, href: recordedTxHref(result.id, dateIso) };
}

/**
 * The status cell (mockup v6 §8's `.pill`). `recorded ✓` wins outright;
 * otherwise the due label carries the tone, an income row says so, and a
 * variable rule says its amount is a template.
 */
export function statusPill(
  row: { type: "expense" | "income" | "transfer"; variable: boolean; date: string },
  todayIso: string,
  state: BillState,
): { text: string; tone: DueTone | "good" } {
  if (state === "recorded") return { text: "recorded ✓", tone: "good" };
  const due = dueLabel(row.date, todayIso);
  if (row.type === "income") {
    return due.tone === "critical"
      ? { text: `income · ${due.text}`, tone: "critical" }
      : { text: "income", tone: "good" };
  }
  return { text: row.variable ? `${due.text} · variable` : due.text, tone: due.tone };
}

export interface ChartPoint {
  x: number;
  y: number;
  date: string;
  balance_sen: number;
}

const PAD_TOP = 14;
const PAD_BOTTOM = 14;

/**
 * Maps the projection's step series onto the SVG viewBox: x by calendar
 * position inside [fromIso, toIso], y by min/max scaling with a little
 * padding — the same coordinate convention `NetWorthChart` uses.
 *
 * `zeroY` is the y of a zero balance, or null when zero is outside the
 * plotted range: the card draws a baseline only when going negative is
 * actually on the chart.
 */
export function cashflowGeometry(
  series: ProjectionPoint[],
  fromIso: string,
  toIso: string,
  width: number,
  height: number,
): { points: ChartPoint[]; zeroY: number | null } {
  const totalDays = Math.max(1, daysBetween(fromIso, toIso));
  const values = series.map((p) => p.balance_sen);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const plot = height - PAD_TOP - PAD_BOTTOM;
  const yOf = (sen: number) => height - PAD_BOTTOM - ((sen - min) / span) * plot;

  const points = series.map((p) => ({
    x: Math.min(width, Math.max(0, (daysBetween(fromIso, p.date) / totalDays) * width)),
    y: yOf(p.balance_sen),
    date: p.date,
    balance_sen: p.balance_sen,
  }));

  return { points, zeroY: min <= 0 && max >= 0 ? yOf(0) : null };
}

/** Step path (`M x,y H x V y …`) — the shape v6 draws: cash holds flat, then
 *  drops or jumps on the day a bill or a paycheque lands. */
export function stepPath(points: ChartPoint[]): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  let d = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`;
  for (const p of points.slice(1)) {
    d += ` H${p.x.toFixed(1)} V${p.y.toFixed(1)}`;
  }
  return d;
}
