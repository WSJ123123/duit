"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { TwoTapAction } from "@/components/DialogKit";
import type { PreviewResult, SameFile } from "@/db/import/preview";
import type { ImportSummary, PreviewRow } from "@/lib/import";
import type { ImportBatchRow } from "@/db/import/history";
import { formatDayMonth, formatDdMm, importedSubLine, isTickable, nothingNewLine, preambleLine, signedText } from "@/lib/import-display";
import { useMoney } from "@/components/Money";

/** Screen B of mockup v7 §12 — the five-stat strip, the two notices, every
 *  row with its state, and the import button with its progress line. */

function Pill({ tone, children }: { tone?: "acc" | "warn" | "crit"; children: ReactNode }) {
  const style =
    tone === "acc"
      ? { background: "var(--accent-soft)", color: "var(--ink-1)" }
      : tone === "warn"
        ? { background: "color-mix(in srgb, var(--warning) 30%, var(--surface))", color: "var(--ink-1)" }
        : tone === "crit"
          ? { background: "color-mix(in srgb, var(--critical) 15%, var(--surface))", color: "var(--critical)" }
          : { background: "var(--chip)", color: "var(--ink-2)" };
  return (
    <span className="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={style}>
      {children}
    </span>
  );
}

function Notice({ critical, children }: { critical?: boolean; children: ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-3 text-sm"
      style={{
        background: critical ? "color-mix(in srgb, var(--critical) 8%, transparent)" : "var(--chip)",
        color: "var(--ink-1)",
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: "warn" | "crit" }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="text-xs" style={{ color: "var(--ink-3)" }}>
        {label}
      </div>
      <div
        className="text-xl font-bold tabular-nums"
        style={{ color: tone === "warn" ? "var(--serious)" : tone === "crit" ? "var(--critical)" : "var(--ink-1)" }}
      >
        {value}
      </div>
      <div className="text-xs" style={{ color: "var(--ink-3)" }}>
        {sub}
      </div>
    </div>
  );
}

function SameFileNotice({
  same,
  continued,
  nothingNew,
  onContinue,
}: {
  same: SameFile;
  continued: boolean;
  /** Why Import is disabled when no row can be ticked (m-3), else null. */
  nothingNew: string | null;
  onContinue: () => void;
}) {
  return (
    <Notice critical>
      <span className="flex flex-wrap items-center gap-x-1">
        <b>
          This exact file was imported on {formatDayMonth(same.created_at)} as batch #{same.batch_no} ({same.imported_count} rows)
        </b>
        <span>— undo that batch first, or</span>
        {continued ? (
          <span style={{ color: "var(--critical)" }}>continuing anyway</span>
        ) : (
          <TwoTapAction
            label="continue anyway"
            confirmLabel="continue anyway"
            pendingLabel="continuing…"
            run={async () => {
              onContinue();
              return { ok: true };
            }}
          />
        )}
        <Tip as="span">Rows already imported stay skipped; a corrected mapping imports them as new rows.</Tip>
      </span>
      {nothingNew ? <span className="block">{nothingNew}</span> : null}
    </Notice>
  );
}

function PreviewTableRow({
  row,
  included,
  acknowledged,
  categoryName,
  importedBy,
  matchImported,
  locked,
  onToggle,
  onSkip,
}: {
  row: PreviewRow;
  included: boolean;
  acknowledged: boolean;
  categoryName: string | null;
  /** The batch that wrote the existing row, for an already-imported row. */
  importedBy: ImportBatchRow | undefined;
  /** Ruling 8h: a probable duplicate's match was written by an import. */
  matchImported: boolean;
  locked: boolean;
  onToggle: () => void;
  onSkip: () => void;
}) {
  // Ruling 4: the preview is the pre-commit verification of a statement —
  // its figures stay SHOWN while amounts are hidden (`shown: true`).
  const { fmt, text } = useMoney();
  const bad = row.state === "unparseable";
  const dim = bad || !included;
  const sub: ReactNode =
    row.state === "unparseable" ? (
      <span style={{ color: "var(--critical)" }}>
        {row.error} · raw: “{row.raw.join(",")}”
      </span>
    ) : row.state === "probable_duplicate" && row.duplicate_of ? (
      <>
        matches {formatDayMonth(row.duplicate_of.date)} · “{row.duplicate_of.note || "(no note)"}” · {fmt(row.duplicate_of.amount_sen, { shown: true })}
        {row.duplicate_of.type === "transfer" ? " · transfer" : matchImported ? " · import" : ""}
      </>
    ) : row.state === "already_imported" && row.duplicate_of ? (
      importedSubLine(importedBy, row.duplicate_of.note)
    ) : row.transfer_hint ? (
      <>
        looks like a transfer to one of your accounts
        <Tip as="span"> — edit it to a transfer after import</Tip>
      </>
    ) : row.note ? (
      <>note · {row.note}</>
    ) : null;

  return (
    <tr style={{ borderBottom: "1px solid var(--grid)", opacity: dim ? 0.7 : 1 }}>
      <td className="px-2 py-2">
        <input
          type="checkbox"
          aria-label={bad ? "unparseable row" : `include ${row.description}`}
          checked={included}
          disabled={locked || !isTickable(row.state)}
          onChange={onToggle}
        />
      </td>
      <td className="px-2 py-2 tabular-nums" style={{ color: bad ? "var(--critical)" : "var(--ink-2)" }}>
        {row.date ? formatDdMm(row.date) : (row.raw[0] ?? "—")}
      </td>
      <td className="px-2 py-2" style={{ color: "var(--ink-1)" }}>
        <div className="font-medium">{row.description || "(blank)"}</div>
        {sub ? (
          <div className="text-xs" style={{ color: "var(--ink-3)" }}>
            {sub}
          </div>
        ) : null}
      </td>
      <td className="px-2 py-2" style={{ color: "var(--ink-2)" }}>
        {bad ? "—" : categoryName ?? <span style={{ color: "var(--ink-3)" }}>— · review</span>}
      </td>
      <td
        className="px-2 py-2 text-right tabular-nums"
        style={{ color: bad ? "var(--ink-3)" : row.signed_amount_sen !== null && row.signed_amount_sen > 0 ? "var(--good-text)" : "var(--ink-1)" }}
      >
        {row.signed_amount_sen === null ? "—" : text(signedText(row.signed_amount_sen), { shown: true })}
      </td>
      <td className="px-2 py-2">
        <span className="flex flex-wrap items-center gap-1">
          {row.state === "new" ? <Pill tone="acc">new</Pill> : null}
          {row.state === "probable_duplicate" ? <Pill tone="warn">probably logged</Pill> : null}
          {row.state === "already_imported" ? <Pill>already imported</Pill> : null}
          {row.state === "unparseable" ? <Pill tone="crit">unparseable</Pill> : null}
          {row.transfer_hint ? <Pill tone="warn">transfer?</Pill> : null}
          {!bad && row.needs_review ? <Pill>review</Pill> : null}
          {bad ? (
            acknowledged ? (
              <span className="text-xs" style={{ color: "var(--ink-3)" }}>
                skipped
              </span>
            ) : (
              <button type="button" className="text-xs font-medium disabled:opacity-60" style={{ color: "var(--accent)" }} onClick={onSkip} disabled={locked}>
                skip
              </button>
            )
          ) : null}
        </span>
      </td>
    </tr>
  );
}

interface Props {
  preview: Extract<PreviewResult, { ok: true }>;
  summary: ImportSummary;
  include: ReadonlySet<string>;
  acknowledged: ReadonlySet<number>;
  continued: boolean;
  categories: Record<string, string>;
  /** The user's batches — names the batch behind an already-imported row. */
  history: ImportBatchRow[];
  /** A batch is open (or opening): the choices it was started with are fixed
   *  until Done or another file — rows already written cannot be unticked. */
  locked: boolean;
  progress: { written: number; total: number } | null;
  error: string | null;
  pending: boolean;
  /** How the last run ended (Plan 9 R2): `retry` — the attempt is open and
   *  the button resumes it; `terminal` — the server refused outright, the
   *  attempt is over and the button starts a new one. */
  failure: "retry" | "terminal" | null;
  onContinue: () => void;
  onToggle: (row: PreviewRow) => void;
  onSkip: (line: number) => void;
  onSkipAll: () => void;
  onImport: () => void;
}

export function PreviewStep({
  preview,
  summary,
  include,
  acknowledged,
  continued,
  categories,
  history,
  locked,
  progress,
  error,
  pending,
  failure,
  onContinue,
  onToggle,
  onSkip,
  onSkipAll,
  onImport,
}: Props) {
  const { fmt, text } = useMoney();
  let out = 0;
  let inn = 0;
  for (const r of preview.rows) {
    if (r.id === null || !include.has(r.id)) continue;
    if (r.signed_amount_sen < 0) out += -r.signed_amount_sen;
    else inn += r.signed_amount_sen;
  }
  const batchById = new Map(history.map((h) => [h.id, h]));
  const unacknowledged = preview.rows.some((r) => r.state === "unparseable" && !acknowledged.has(r.line));
  const disclosure = preambleLine(preview.preamble_lines);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Will import" value={summary.included_count} sub={`${fmt(out, { shown: true })} out · ${fmt(inn, { shown: true })} in`} />
        <Stat
          label="Probably logged already"
          value={preview.rows.filter((r) => r.state === "probable_duplicate").length}
          sub="skipped by default · tick to include"
          tone="warn"
        />
        <Stat label="Already imported" value={preview.rows.filter((r) => r.state === "already_imported").length} sub="same rows, earlier import" />
        <Stat label="Unparseable" value={summary.unparseable_count} sub="must be skipped · shown below" tone="crit" />
        <Stat label="Needs review" value={summary.needs_review_count} sub="no category match · saved flagged" />
      </div>

      {preview.same_file ? <SameFileNotice
          same={preview.same_file}
          continued={continued}
          nothingNew={nothingNewLine(preview.rows, preview.same_file.batch_no)}
          onContinue={onContinue}
        /> : null}
      {preview.reconcile && preview.range ? (
        <Notice>
          <b>
            {preview.reconcile.count} reconcile adjustment{preview.reconcile.count === 1 ? "" : "s"} · {text(signedText(preview.reconcile.net_sen), { shown: true })}
          </b>{" "}
          sit inside {formatDayMonth(preview.range.min)}–{formatDayMonth(preview.range.max)} on {preview.account.name} — they may already cover some of these rows.
          <Tip as="span" className="ml-1">
            If you set the balance by hand for this period, delete that adjustment or expect a double count.
          </Tip>
        </Notice>
      ) : null}
      {disclosure ? (
        <p className="text-xs" style={{ color: "var(--ink-2)" }}>
          {disclosure}
        </p>
      ) : null}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["", "Date", "Description", "Category", "Amount", "State"].map((h, i) => (
                  <th
                    key={i}
                    className={`px-2 py-1.5 text-xs font-semibold ${i === 4 ? "text-right" : "text-left"}`}
                    style={{ color: "var(--ink-3)", borderBottom: "1px solid var(--grid)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <PreviewTableRow
                  key={row.line}
                  row={row}
                  included={row.id !== null && include.has(row.id)}
                  acknowledged={acknowledged.has(row.line)}
                  categoryName={row.category_id ? (categories[row.category_id] ?? null) : null}
                  importedBy={row.duplicate_of ? batchById.get(preview.imported_batch[row.duplicate_of.id] ?? "") : undefined}
                  matchImported={row.duplicate_of !== null && preview.imported_batch[row.duplicate_of.id] !== undefined}
                  locked={locked}
                  onToggle={() => onToggle(row)}
                  onSkip={() => onSkip(row.line)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {progress ? (
        <p className="text-sm tabular-nums" style={{ color: "var(--ink-2)" }}>
          {pending ? "Importing…" : "Imported"} {progress.written} of {progress.total} rows
        </p>
      ) : null}
      {error ? (
        <p className="text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-xs" style={{ color: "var(--ink-2)" }}>
          {summary.included_count} rows will be saved
          <Tip as="span"> through the ordinary entry path · re-importing this file later changes nothing</Tip>
        </span>
        {unacknowledged ? (
          <button type="button" className="text-xs font-medium disabled:opacity-60" style={{ color: "var(--accent)" }} onClick={onSkipAll} disabled={locked}>
            skip all unparseable
          </button>
        ) : null}
        <Link
          href="/transactions"
          className="rounded-lg border px-3.5 py-2 text-sm font-medium"
          style={{ background: "transparent", borderColor: "transparent", color: "var(--critical)" }}
        >
          Cancel
        </Link>
        <Button
          type="button"
          variant="primary"
          onClick={onImport}
          disabled={pending || summary.included_count === 0 || unacknowledged || (preview.same_file !== null && !continued)}
        >
          {pending ? "Importing…" : failure === "retry" ? "Retry" : failure === "terminal" ? "Start again" : `Import ${summary.included_count} rows`}
        </Button>
      </div>
    </>
  );
}
