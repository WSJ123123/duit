"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Tip } from "@/components/Tip";
import { inputStyle } from "@/components/DialogKit";
import type { InspectResult } from "@/app/(app)/transactions/import/actions";
import { DATE_FORMATS, type DateFormat } from "@/lib/import";
import { preambleLine } from "@/lib/import-display";
import { firstRowLine, type MapForm } from "@/lib/import-form";
import { IMPORT_PICKER_LINES } from "@/lib/import-limits";
import { useMoney } from "@/components/Money";
import { MASKED_BARE, maskRawLine } from "@/lib/money-mask";

/** Screen A of mockup v7 §12 — file & account, columns, the first-row check —
 *  with mockup v8 §16's header-line picker (Plan 9 ruling 7). */

export interface ImportAccountOption {
  id: string;
  name: string;
  type: string;
}

const selectClass = "w-full rounded-lg px-3 py-2 text-sm outline-none";

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 mb-1 text-xs font-medium" style={{ color: "var(--ink-2)" }}>
      {children}
    </div>
  );
}

function ColumnSelect({
  value,
  onChange,
  header,
  allowNone,
}: {
  value: string;
  onChange: (v: string) => void;
  header: string[];
  allowNone?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass} style={inputStyle}>
      {allowNone ? <option value="">none</option> : null}
      {header.map((h, i) => (
        <option key={i} value={String(i)}>
          {h.trim() === "" ? `Column ${i + 1}` : h}
        </option>
      ))}
    </select>
  );
}

/** The drop zone's file size — not money; named so the money fence's
 *  allowlist can name it. */
function fileSizeKb(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1024));
}

/** Ruling 7's picker: the first twelve raw lines, numbered from 0; the
 *  chosen one is the header, the lines above it are preamble, the lines
 *  below are dimmed as data. Under the amounts mask the raw lines' bare
 *  figures mask too (Q40's rule for file text). */
function HeaderLinePicker({
  lines,
  lineCount,
  headerLine,
  hidden,
  disabled,
  onPick,
}: {
  lines: string[];
  lineCount: number;
  headerLine: number;
  hidden: boolean;
  disabled: boolean;
  onPick: (n: number) => void;
}) {
  return (
    <>
      <Label>
        Header line <span className="font-normal">— tap the line that names the columns</span>
      </Label>
      <div className="overflow-hidden rounded-lg text-xs" style={{ border: "1px solid var(--border)" }}>
        {lines.map((line, i) => {
          const chosen = i === headerLine;
          return (
            <button
              key={i}
              type="button"
              aria-label={`line ${i}`}
              aria-pressed={chosen}
              disabled={disabled}
              onClick={() => onPick(i)}
              className="flex w-full items-center gap-2 px-2 py-1 text-left font-mono disabled:opacity-60"
              style={{
                background: chosen ? "var(--accent-soft)" : "transparent",
                color: chosen ? "var(--ink-1)" : i > headerLine ? "var(--ink-3)" : "var(--ink-2)",
                borderBottom: "1px solid var(--grid)",
              }}
            >
              <span className="w-5 shrink-0 text-right tabular-nums" style={{ color: "var(--ink-3)" }}>
                {i}
              </span>
              <span className="min-w-0 flex-1 truncate">{hidden ? maskRawLine(line) : line}</span>
              {chosen ? (
                <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: "var(--accent)", color: "#fff" }}>
                  header
                </span>
              ) : null}
            </button>
          );
        })}
        {lineCount > IMPORT_PICKER_LINES ? (
          <div className="flex items-center gap-2 px-2 py-1" style={{ color: "var(--ink-3)" }}>
            <span className="w-5 shrink-0 text-right">…</span>
            <span>first {IMPORT_PICKER_LINES} lines shown</span>
          </div>
        ) : null}
      </div>
    </>
  );
}

interface Props {
  accounts: ImportAccountOption[];
  accountId: string;
  /** v7's `last used for <account> · <date>` when a mapping is stored. */
  lastUsed: string | null;
  inspect: InspectResult | null;
  /** A file is picked and being read. */
  reading: boolean;
  form: MapForm;
  error: string | null;
  pending: boolean;
  canPreview: boolean;
  onPickFile: (file: File | null) => void;
  onAccount: (id: string) => void;
  onForm: (form: MapForm) => void;
  onHeaderLine: (line: number) => void;
  onPreview: () => void;
}

export function MapStep({
  accounts,
  accountId,
  lastUsed,
  inspect,
  reading,
  form,
  error,
  pending,
  canPreview,
  onPickFile,
  onAccount,
  onForm,
  onHeaderLine,
  onPreview,
}: Props) {
  const { hidden, text } = useMoney();
  const header = inspect?.header ?? [];
  // Rule 15's disclosure only for a slice that happened: a stored header
  // line past a shorter file's end reads nothing above it.
  const disclosure = inspect && inspect.error === null ? preambleLine(inspect.header_line) : null;
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="File & account">
          <Tip className="-mt-1 mb-3">
            export a CSV from your bank or e-wallet app · up to 1 MB / 500 rows — split a long export by month · the file is read once and not kept
          </Tip>
          <label
            className="block cursor-pointer rounded-xl px-4 py-5 text-center text-sm"
            style={{ border: "1px dashed var(--baseline)", color: "var(--ink-2)" }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onPickFile(e.dataTransfer.files[0] ?? null);
            }}
          >
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            {inspect ? (
              <>
                <b style={{ color: "var(--ink-1)" }}>{inspect.filename}</b> · {inspect.line_count} lines · {fileSizeKb(inspect.size)} KB
                <br />
                <Tip as="span">drop another file to replace</Tip>
              </>
            ) : reading ? (
              "Reading…"
            ) : (
              "Choose a CSV file, or drop one here"
            )}
          </label>
          <Label>Into account</Label>
          <select value={accountId} onChange={(e) => onAccount(e.target.value)} className={selectClass} style={inputStyle}>
            {accounts.length === 0 ? <option value="">No active ringgit account</option> : null}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · MYR · {a.type}
              </option>
            ))}
          </select>
          <Tip className="mt-2">only ringgit accounts can take an import — a foreign brokerage statement would corrupt the budget</Tip>
          {inspect ? (
            <>
              <HeaderLinePicker
                lines={inspect.lines}
                lineCount={inspect.line_count}
                headerLine={inspect.header_line}
                hidden={hidden}
                disabled={pending}
                onPick={onHeaderLine}
              />
              {disclosure ? (
                <p className="mt-2 text-xs" style={{ color: "var(--ink-2)" }}>
                  {disclosure}
                  <Tip as="span"> — they are not rows and are never imported; the file&apos;s hash still covers the whole text</Tip>
                </p>
              ) : null}
              {inspect.error ? (
                <p className="mt-2 text-sm" style={{ color: "var(--critical)" }}>
                  {inspect.error}
                </p>
              ) : null}
            </>
          ) : null}
        </Card>

        <Card title="Columns">
          {lastUsed !== null ? (
            <p className="-mt-1 mb-2 text-xs" style={{ color: "var(--ink-2)" }}>
              {lastUsed}
              <Tip as="span"> — remembered per account, header line included; change anything and it is remembered again</Tip>
            </p>
          ) : null}
          {inspect && inspect.error === null ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Date column</Label>
                  <ColumnSelect value={form.date_col} onChange={(v) => onForm({ ...form, date_col: v })} header={header} />
                </div>
                <div>
                  <Label>Date format</Label>
                  <select
                    value={form.date_format}
                    onChange={(e) => onForm({ ...form, date_format: e.target.value as DateFormat })}
                    className={selectClass}
                    style={inputStyle}
                  >
                    {DATE_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Label>Description column</Label>
              <ColumnSelect value={form.description_col} onChange={(v) => onForm({ ...form, description_col: v })} header={header} />
              <Label>Amount</Label>
              <div className="flex overflow-hidden rounded-lg text-xs" style={{ border: "1px solid var(--border)" }}>
                {(["signed", "pair"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onForm({ ...form, kind: k })}
                    className="flex-1 px-3 py-1.5"
                    style={{
                      background: form.kind === k ? "var(--chip)" : "transparent",
                      color: form.kind === k ? "var(--ink-1)" : "var(--ink-3)",
                      fontWeight: form.kind === k ? 650 : 400,
                    }}
                  >
                    {k === "signed" ? "One signed column" : "Debit + credit columns"}
                  </button>
                ))}
              </div>
              {form.kind === "signed" ? (
                <>
                  <Label>Amount column</Label>
                  <ColumnSelect value={form.signed_col} onChange={(v) => onForm({ ...form, signed_col: v })} header={header} />
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Debit (money out)</Label>
                    <ColumnSelect value={form.debit_col} onChange={(v) => onForm({ ...form, debit_col: v })} header={header} />
                  </div>
                  <div>
                    <Label>Credit (money in)</Label>
                    <ColumnSelect value={form.credit_col} onChange={(v) => onForm({ ...form, credit_col: v })} header={header} />
                  </div>
                </div>
              )}
              <Label>
                Note column <span className="font-normal">(optional)</span>
              </Label>
              <ColumnSelect value={form.note_col} onChange={(v) => onForm({ ...form, note_col: v })} header={header} allowNone />
              <Tip className="mt-2">the format is chosen, never guessed — 03/04 could be either month</Tip>
            </>
          ) : (
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>
              {inspect ? "Pick the line that names the columns." : "Choose a file to map its columns."}
            </p>
          )}
        </Card>
      </div>
      {error ? (
        <p className="text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-xs tabular-nums" style={{ color: "var(--ink-2)" }}>
          {inspect && inspect.error === null
            ? // Q40: the whole line masks — the file's raw amount cell too
              // (fixed-width `••••`, no digit count), then the app-read figure.
              text(firstRowLine(inspect.sample, form, hidden ? () => MASKED_BARE : undefined))
            : null}
        </span>
        <Link
          href="/transactions"
          className="rounded-lg border px-3.5 py-2 text-sm font-medium"
          style={{ background: "transparent", borderColor: "transparent", color: "var(--critical)" }}
        >
          Cancel
        </Link>
        <Button type="button" variant="primary" onClick={onPreview} disabled={pending || !canPreview}>
          {pending && inspect ? "Reading…" : inspect && inspect.error === null ? `Preview ${inspect.row_count} rows →` : "Preview →"}
        </Button>
      </div>
    </>
  );
}
