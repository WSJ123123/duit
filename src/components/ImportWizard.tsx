"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { MapStep, type ImportAccountOption } from "@/components/import-wizard/MapStep";
import { PreviewStep } from "@/components/import-wizard/PreviewStep";
import { DoneStep } from "@/components/import-wizard/DoneStep";
import type { HistoryRow } from "@/components/ImportHistory";
import type { ImportBatchRow } from "@/db/import/history";
import type { PreviewResult } from "@/db/import/preview";
import type { CommitDone } from "@/db/import/commit";
import type { InspectResult } from "@/app/(app)/transactions/import/actions";
import {
  beginImportAction,
  commitImportChunkAction,
  inspectImportFile,
  previewImportAction,
} from "@/app/(app)/transactions/import/actions";
import { summarize, type ImportMapping } from "@/lib/import";
import { IDLE_ATTEMPT, attemptAfterRun, attemptResumes, attemptToRun, type ImportAttempt } from "@/lib/import-attempt";
import { isTickable, lastUsedLine, skipBreakdown, type SkipBreakdown } from "@/lib/import-display";
import { formFrom, mappingFrom, type MapForm } from "@/lib/import-form";
import { IMPORT_CHUNK_ROWS, oversizeError } from "@/lib/import-limits";
import { runImportChunks } from "@/lib/import-run";

/**
 * CSV statement import — mockup v7 §12's three screens on one route
 * (rulings 11–13, 16–18), with v8 §16's header-line picker (Plan 9 ruling
 * 7). This file is the state and the orchestration; the screens are in
 * ./import-wizard/, the pure helpers in src/lib/import-*.ts. The client
 * holds no mapping logic beyond the map screen's one-line "first row read
 * as" check: the server parses the file for the raw lines and the header
 * (again for each header line picked), for the preview and again for every
 * 100-row chunk; the client sends back only `{ id, include }` choices plus
 * the file. One batch is opened before the first chunk under an id the
 * wizard minted (Q25), and every chunk and retry carries it.
 */

interface Props {
  accounts: ImportAccountOption[];
  mappings: Record<string, ImportMapping>;
  categories: Record<string, string>;
  defaultAccountId: string | null;
  history: ImportBatchRow[];
}

type Step = "map" | "preview" | "done";

/** A request that never answered (dropped connection, a refused body). */
const REQUEST_FAILED = "The request did not complete — check the connection and try again";

function Steps({ step }: { step: Step }) {
  const order: Step[] = ["map", "preview", "done"];
  const labels = ["Upload & map", "Preview", "Done"];
  const at = order.indexOf(step);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--ink-3)" }}>
      {order.map((s, i) => (
        <span key={s} className="flex items-center gap-2">
          {i > 0 ? <span className="h-px w-6" style={{ background: "var(--grid)" }} /> : null}
          <span
            className="flex items-center gap-1.5 font-medium"
            style={{ color: i === at ? "var(--ink-1)" : i < at ? "var(--ink-2)" : "var(--ink-3)" }}
          >
            <b
              className="flex h-5 w-5 items-center justify-center rounded-full text-[11px]"
              style={{
                background: i <= at ? "var(--accent)" : "var(--chip)",
                color: i <= at ? "#fff" : "var(--ink-3)",
              }}
            >
              {i < at ? "✓" : i + 1}
            </b>
            {labels[i]}
          </span>
        </span>
      ))}
    </div>
  );
}

export function ImportWizard({ accounts, mappings, categories, defaultAccountId, history }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("map");
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [accountId, setAccountId] = useState<string>(
    defaultAccountId && accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : (accounts[0]?.id ?? ""),
  );
  const [form, setForm] = useState<MapForm>(() => formFrom(undefined, 4));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [preview, setPreview] = useState<Extract<PreviewResult, { ok: true }> | null>(null);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [acknowledged, setAcknowledged] = useState<Set<number>>(new Set());
  const [continued, setContinued] = useState(false);

  /** The import attempt (Q25, R1–R3): its client-minted id, the batch the
   *  server confirmed, where a retry resumes, how the last run ended. */
  const [attempt, setAttempt] = useState<ImportAttempt>(IDLE_ATTEMPT);
  /** The mapping the open batch was started with — a re-preview under a
   *  different one is a different import. */
  const [batchMapping, setBatchMapping] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ written: number; total: number } | null>(null);
  const [done, setDone] = useState<(CommitDone & { breakdown: SkipBreakdown; finished: HistoryRow }) | null>(null);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const storedMapping = mappings[accountId];

  /** Another file, account or mapping is another import: the open batch (it
   *  stays in the history, undoable) and everything chosen under it go. */
  function dropBatch() {
    setPreview(null);
    setInclude(new Set());
    setAcknowledged(new Set());
    setContinued(false);
    setAttempt(IDLE_ATTEMPT);
    setBatchMapping(null);
    setProgress(null);
  }

  function resetAll() {
    setStep("map");
    setFile(null);
    setInspect(null);
    setForm(formFrom(mappings[accountId], 4));
    setError(null);
    dropBatch();
    setDone(null);
  }

  /** Read the file's raw lines and its header under `headerLine` (ruling
   *  7); the column pickers are rebuilt from that line's width, the stored
   *  mapping re-applied when it fits. */
  async function inspectWith(next: File, headerLine: number, stored: ImportMapping | undefined) {
    const fd = new FormData();
    fd.set("file", next);
    fd.set("header_line", String(headerLine));
    setPending(true);
    try {
      const r = await inspectImportFile(fd);
      if (!r.ok) {
        setError(r.error);
        setFile(null);
        setInspect(null);
        return;
      }
      setInspect(r);
      setForm({ ...formFrom(stored, r.header.length), header_line: r.header_line });
    } catch {
      setError(REQUEST_FAILED);
      setFile(null);
      setInspect(null);
    } finally {
      setPending(false);
    }
  }

  async function pickFile(next: File | null) {
    setError(null);
    dropBatch();
    setFile(next);
    setInspect(null);
    if (!next) return;
    // The server's own sentence, said before the upload: a body over Next's
    // action limit would otherwise die as a rejected request with no name.
    const tooLarge = oversizeError(next.size);
    if (tooLarge !== null) {
      setError(tooLarge);
      setFile(null);
      return;
    }
    // A stored header line is re-applied to the next file: a shorter
    // preamble shows at a glance (the picker's highlight, the first-row
    // line), never silently mis-sliced.
    await inspectWith(next, storedMapping?.header_line ?? 0, storedMapping);
  }

  function pickHeaderLine(line: number) {
    if (!file) return;
    setError(null);
    void inspectWith(file, line, storedMapping);
  }

  function chooseAccount(id: string) {
    setAccountId(id);
    dropBatch();
    if (file) void inspectWith(file, mappings[id]?.header_line ?? 0, mappings[id]);
  }

  async function runPreview() {
    if (!file || !inspect || !account) return;
    setError(null);
    setPending(true);
    const mapping = JSON.stringify(mappingFrom(form));
    // Stepping back mid-import and previewing the SAME mapping resumes the
    // attempt (ruling 12c) with the owner's choices intact — they are locked
    // once a batch is open — where it stopped (R3), and under its minted id
    // even when `begin` never answered (Q25). A changed mapping yields other
    // rows (Q30): another import — dropBatch resets the attempt.
    const resumes = attemptResumes(attempt, mapping === batchMapping);
    if (!resumes) dropBatch();
    const fd = new FormData();
    fd.set("file", file);
    fd.set("account_id", account.id);
    fd.set("mapping", mapping);
    if (resumes && attempt.batchId) fd.set("batch_id", attempt.batchId);
    let r: PreviewResult;
    try {
      r = await previewImportAction(fd);
    } catch {
      setError(REQUEST_FAILED);
      return;
    } finally {
      setPending(false);
    }
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setPreview(r);
    if (!resumes) setInclude(new Set(r.rows.flatMap((row) => (row.id !== null && row.default_include ? [row.id] : []))));
    setStep("preview");
  }

  const choices = useMemo(
    () => (preview ? preview.rows.flatMap((r) => (r.id === null ? [] : [{ id: r.id, include: include.has(r.id) }])) : []),
    [preview, include],
  );
  const summary = useMemo(() => (preview ? summarize(preview.rows, choices) : null), [preview, choices]);

  async function runImport() {
    if (!file || !preview || !summary) return;
    setError(null);
    setPending(true);
    const total = preview.rows.length;
    const mapping = JSON.stringify(mappingFrom(form));
    setBatchMapping(mapping);
    const choiceJson = JSON.stringify(choices);
    // Q25: the batch id is minted here, once per attempt, and kept for every
    // Retry of it (the house precedent: the liability dialog's client uuid).
    const running = attemptToRun(attempt, () => crypto.randomUUID());
    setAttempt(running);
    const result = await runImportChunks<CommitDone>({
      total,
      chunkRows: IMPORT_CHUNK_ROWS,
      from: running.resumeFrom,
      batchId: running.batchId,
      begin: () =>
        beginImportAction({
          id: running.id!,
          account_id: preview.account.id,
          filename: file.name,
          content_sha256: preview.content_sha256,
          row_count: summary.row_count,
        }),
      commit: (id, from, to) => {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("batch_id", id);
        fd.set("mapping", mapping);
        fd.set("choices", choiceJson);
        fd.set("from", String(from));
        fd.set("to", String(to));
        return commitImportChunkAction(fd);
      },
      onProgress: (written) => setProgress({ written, total }),
    });
    setPending(false);
    setAttempt(attemptAfterRun(running, result));
    if (result.failed) {
      setError(result.error);
      return;
    }
    const finished: HistoryRow = {
      id: result.batchId,
      batch_no: result.done.batch_no,
      filename: file.name,
      account_name: preview.account.name,
      row_count: total,
      imported_count: result.done.imported_count,
      skipped_count: result.done.skipped_count,
      needs_review_count: result.done.needs_review_count,
      unparseable_count: result.done.unparseable_count,
      touched_count: 0,
      created_at: result.done.created_at,
      undone_at: null,
      preamble_lines: preview.preamble_lines,
    };
    setDone({ ...result.done, breakdown: skipBreakdown(preview.rows, include, result.done.imported_count), finished });
    setStep("done");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="eye-clear flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold" style={{ color: "var(--ink-1)" }}>
          Import a statement
        </h2>
        <div className="ml-auto text-sm">
          {step === "map" ? (
            <Link href="/transactions" style={{ color: "var(--accent)" }}>
              ← Transactions
            </Link>
          ) : step === "preview" ? (
            <button type="button" onClick={() => setStep("map")} style={{ color: "var(--accent)" }} disabled={pending}>
              ← Back to columns
            </button>
          ) : null}
        </div>
      </div>
      <Steps step={step} />

      {step === "map" ? (
        <MapStep
          accounts={accounts}
          accountId={accountId}
          lastUsed={storedMapping && account ? lastUsedLine(account.name, storedMapping.saved_at) : null}
          inspect={inspect}
          reading={pending && file !== null}
          form={form}
          error={error}
          pending={pending}
          canPreview={inspect !== null && inspect.error === null && account !== null}
          onPickFile={(next) => void pickFile(next)}
          onAccount={chooseAccount}
          onForm={setForm}
          onHeaderLine={pickHeaderLine}
          onPreview={() => void runPreview()}
        />
      ) : null}

      {step === "preview" && preview && summary ? (
        <PreviewStep
          preview={preview}
          summary={summary}
          include={include}
          acknowledged={acknowledged}
          continued={continued}
          categories={categories}
          history={history}
          locked={pending || attempt.batchId !== null}
          progress={progress}
          error={error}
          pending={pending}
          failure={attempt.failure}
          onContinue={() => setContinued(true)}
          onToggle={(row) => {
            if (row.id === null || !isTickable(row.state) || pending || attempt.batchId !== null) return;
            const next = new Set(include);
            if (next.has(row.id)) next.delete(row.id);
            else next.add(row.id);
            setInclude(next);
          }}
          onSkip={(line) => setAcknowledged(new Set(acknowledged).add(line))}
          onSkipAll={() => setAcknowledged(new Set(preview.rows.filter((r) => r.state === "unparseable").map((r) => r.line)))}
          onImport={() => void runImport()}
        />
      ) : null}

      {step === "done" && done && preview ? (
        <DoneStep
          done={done}
          filename={file?.name ?? ""}
          accountName={preview.account.name}
          month={preview.range ? preview.range.max.slice(0, 7) : null}
          history={history}
          finished={done.finished}
          onAnother={resetAll}
        />
      ) : null}
    </div>
  );
}
