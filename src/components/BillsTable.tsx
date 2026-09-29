import { Fragment, type ReactNode } from "react";
import { RecordNow } from "@/components/RecordNow";
import { Tip } from "@/components/Tip";
import type { FundOption } from "@/db/funds";
import type { BillRow, RecordedBillRow } from "@/db/bills";
import { Money } from "@/components/Money";
import { billGroup, dueWord, formatDM, statusPill, type BillState } from "@/lib/bills-display";

/**
 * Mockup v6 §8's `Upcoming` table (desktop) and §10 phone 2's card list
 * (mobile). Server components: the only interactive thing on either is the
 * `Record now` sheet, which is `TxFormSheet` — the ordinary transaction form,
 * ruling 14's single write surface on this page.
 *
 * ⚠ v6 draws no `Record now` affordance at all (it predates ruling 14's
 * wording). It lands as a trailing cell in the desktop table and an inline
 * action on each mobile card — the minimal placement that does not disturb
 * the six columns v6 does draw.
 */

export interface BillFormOptions {
  accounts: Array<{ id: string; name: string; currency: string; archived: boolean }>;
  categories: Array<{ id: string; name: string; kind: "expense" | "income"; archived: boolean }>;
  funds: FundOption[];
  todayStr: string;
}

const TONE_COLOR: Record<string, { bg: string; fg: string }> = {
  normal: { bg: "var(--chip)", fg: "var(--ink-2)" },
  warn: { bg: "color-mix(in srgb, var(--warning) 18%, transparent)", fg: "var(--warning)" },
  critical: { bg: "color-mix(in srgb, var(--critical) 16%, transparent)", fg: "var(--critical)" },
  good: { bg: "color-mix(in srgb, var(--good) 16%, transparent)", fg: "var(--good-text)" },
};

function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  const color = TONE_COLOR[tone] ?? TONE_COLOR.normal!;
  return (
    <span
      className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
      style={{ background: color.bg, color: color.fg }}
    >
      {children}
    </span>
  );
}

/**
 * Q11a: a Paid row shows what ACTUALLY left the account, not the rule's
 * template — a variable bill is variable precisely because the two differ,
 * and `Record now` keeps the amount editable for exactly that reason. The
 * template rides along in the sub-line, and ONLY when it disagrees.
 */
function amountCell(row: BillRow, actualSen: number): { text: ReactNode; color?: string } {
  return row.type === "income"
    ? { text: <>+ <Money sen={actualSen} /></>, color: "var(--good-text)" }
    : { text: <Money sen={actualSen} /> };
}

function templateNote(row: BillRow, actualSen: number): ReactNode {
  return actualSen === row.amount_sen ? null : <>template <Money sen={row.amount_sen} /></>;
}

// `Record now` (and the recorded row's entry link) live in RecordNow.tsx — a
// client module, see its header.

interface BillsProps {
  upcoming: BillRow[];
  overdue: BillRow[];
  recorded: RecordedBillRow[];
  todayIso: string;
  form: BillFormOptions;
}

/** `actual_sen` is the recorded transaction's amount on a Paid row and the
 *  rule's own amount everywhere else — carried on the entry rather than read
 *  back off the row, so neither renderer has to narrow a union per cell. */
type Entry = { row: BillRow; state: BillState; actual_sen: number; recorded_tx_id: string | null };
type GroupedEntry = Entry & { header: string | null };

/** Overdue first, then upcoming in date order, then the recorded rows the
 *  cron (or `Record now`) has already written — v6 keeps those visible,
 *  greyed, for as long as their date is inside the window. The cron advancing
 *  `next_run` past a recorded occurrence does not remove it: the row is
 *  recovered from its transaction (question 12). */
function entriesOf({ upcoming, overdue, recorded }: BillsProps): Entry[] {
  return [
    ...overdue.map((row) => ({ row, state: "overdue" as const, actual_sen: row.amount_sen, recorded_tx_id: null })),
    ...upcoming.map((row) => ({ row, state: "upcoming" as const, actual_sen: row.amount_sen, recorded_tx_id: null })),
    ...recorded.map((row) => ({
      row,
      state: "recorded" as const,
      actual_sen: row.recorded_amount_sen,
      recorded_tx_id: row.recorded_tx_id,
    })),
  ];
}

/** Attaches each row's group header up front — the header is a property of
 *  the list, not something to accumulate while React renders it. */
function withGroupHeaders(entries: Entry[], todayIso: string): GroupedEntry[] {
  let last = "";
  return entries.map((entry) => {
    const group = entry.state === "recorded" ? "Recorded" : billGroup(entry.row.date, todayIso);
    const header = group !== last ? group : null;
    last = group;
    return { ...entry, header };
  });
}

export function BillsTable(props: BillsProps) {
  const { todayIso, form } = props;
  const entries = withGroupHeaders(entriesOf(props), todayIso);

  if (entries.length === 0) {
    return (
      <p className="py-4 text-sm" style={{ color: "var(--ink-3)" }}>
        Nothing scheduled inside this window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {["Date", "Bill", "Category", "Account", "Amount", "Status", ""].map((h, i) => (
              <th
                key={h || `col-${i}`}
                className={`px-2 py-1.5 text-xs font-semibold ${i === 0 || i === 1 ? "text-left" : "text-right"}`}
                style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(({ row, state, header, actual_sen, recorded_tx_id }) => {
            const pill = statusPill(row, todayIso, state);
            const amount = amountCell(row, actual_sen);
            const template = templateNote(row, actual_sen);
            const muted = state === "recorded";
            return (
              <Fragment key={`${row.rule_id}:${row.date}`}>
              {header ? (
                <tr>
                  <td colSpan={7} className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>
                    {header}
                  </td>
                </tr>
              ) : null}
              <tr style={{ borderBottom: "1px solid var(--grid)" }}>
                <td className="px-2 py-2 text-left" style={{ color: muted ? "var(--ink-3)" : "var(--ink-2)" }}>
                  {formatDM(row.date)}
                </td>
                <td className="px-2 py-2 text-left font-semibold" style={{ color: muted ? "var(--ink-3)" : "var(--ink-1)" }}>
                  {row.name}
                </td>
                <td className="px-2 py-2 text-right" style={{ color: "var(--ink-3)" }}>
                  {row.category_name ?? "—"}
                </td>
                <td className="px-2 py-2 text-right" style={{ color: "var(--ink-3)" }}>
                  {row.account_name}
                </td>
                <td
                  className="px-2 py-2 text-right font-semibold tabular-nums"
                  style={{ color: muted ? "var(--ink-3)" : (amount.color ?? "var(--ink-1)") }}
                >
                  {amount.text}
                  {template ? (
                    <span className="mt-0.5 block text-[10.5px] font-normal" style={{ color: "var(--ink-3)" }}>
                      {template}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-2 text-right">
                  <Pill tone={pill.tone}>{pill.text}</Pill>
                </td>
                <td className="px-2 py-2 text-right">
                  <RecordNow row={row} form={form} recordedTxId={recorded_tx_id} />
                </td>
              </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Mockup v6 §10 phone 2 — one card per occurrence, the soonest first. */
export function BillsList(props: BillsProps) {
  const { todayIso, form } = props;
  const entries = entriesOf(props);

  if (entries.length === 0) {
    return (
      <p className="py-4 text-sm" style={{ color: "var(--ink-3)" }}>
        Nothing scheduled inside this window.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map(({ row, state, actual_sen, recorded_tx_id }) => {
        const pill = statusPill(row, todayIso, state);
        const amount = amountCell(row, actual_sen);
        const template = templateNote(row, actual_sen);
        const muted = state === "recorded";
        const urgent = pill.tone === "warn" || pill.tone === "critical";
        return (
          <div
            key={`${row.rule_id}:${row.date}`}
            className="rounded-xl px-3 py-2.5"
            style={{
              background: muted
                ? "transparent"
                : urgent
                  ? `color-mix(in srgb, var(--${pill.tone === "critical" ? "critical" : "warning"}) 14%, var(--chip))`
                  : "var(--chip)",
              border: muted ? "1px solid var(--grid)" : "1px solid transparent",
            }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13.5px] font-semibold" style={{ color: muted ? "var(--ink-3)" : "var(--ink-1)" }}>
                {row.name}
              </span>
              <span
                className="whitespace-nowrap text-[13.5px] font-bold tabular-nums"
                style={{ color: muted ? "var(--ink-3)" : (amount.color ?? "var(--ink-1)") }}
              >
                {amount.text}
              </span>
            </div>
            <div
              className="mt-0.5 text-[11.5px]"
              style={{
                color: urgent && !muted ? TONE_COLOR[pill.tone]!.fg : "var(--ink-3)",
                fontWeight: urgent && !muted ? 600 : 400,
              }}
            >
              {muted ? `${formatDM(row.date)} · recorded ✓` : `${dueWord(row.date, todayIso)} · ${formatDM(row.date)} · ${row.account_name}`}
              {template ? <> · {template}</> : ""}
              {!muted && row.category_name ? ` · ${row.category_name}` : ""}
              {!muted && row.variable ? " · amount varies, confirm when it lands" : ""}
            </div>
            <div className="mt-2">
              <RecordNow row={row} form={form} recordedTxId={recorded_tx_id} />
            </div>
          </div>
        );
      })}
      <Tip>a bill flips to recorded the moment its transaction exists — the daily job writes most of them for you</Tip>
    </div>
  );
}
