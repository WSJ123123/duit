import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewRow } from "@/lib/import";
import type { MapForm } from "@/lib/import-form";
import type { ImportBatchRow } from "@/db/import/history";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { MapStep } = await import("@/components/import-wizard/MapStep");
const { PreviewStep } = await import("@/components/import-wizard/PreviewStep");
const { DoneStep } = await import("@/components/import-wizard/DoneStep");

/**
 * Plan 9 Task 4 — the wizard's screens as static markup (no DOM env): the
 * header-line picker and its disclosure (ruling 7, mockup v8 §16), v7's
 * `last used … <date>` and the probable-duplicate source suffix (8h), the
 * Retry / Start again button (R2), and the Done card that lists the batch
 * just finished at once (8g).
 */
const noop = () => {};
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const form: MapForm = {
  date_col: "0",
  date_format: "DD/MM/YYYY",
  description_col: "1",
  kind: "pair",
  signed_col: "2",
  debit_col: "2",
  credit_col: "3",
  note_col: "",
  header_line: 3,
};

const LINES = [
  "Synthetic Bank,Statement of account",
  'Account no,"5123 SYNTHETIC SAVINGS',
  "",
  "Date,Description,Debit,Credit,Balance",
  "05/03/2077,KOPI CORNER,4.50,,1995.50",
  "06/03/2077,SALARY CREDIT ACME,,3500.00,5495.50",
  "07/03/2077,GRAB RIDE KL,18.00,,5477.50",
  "08/03/2077,ROW 8,1.00,,5476.50",
  "09/03/2077,ROW 9,1.00,,5475.50",
  "10/03/2077,ROW 10,1.00,,5474.50",
  "11/03/2077,ROW 11,1.00,,5473.50",
  "12/03/2077,ROW 12,1.00,,5472.50",
];

const inspect = {
  filename: "preamble.csv",
  size: 2_048,
  lines: LINES,
  line_count: 14,
  header_line: 3,
  header: ["Date", "Description", "Debit", "Credit", "Balance"],
  sample: ["05/03/2077", "KOPI CORNER", "4.50", "", "1995.50"],
  row_count: 10,
  error: null,
};

const mapProps = {
  accounts: [{ id: "acct-1", name: "Maybank", type: "bank" }],
  accountId: "acct-1",
  lastUsed: "last used for Maybank · 21 Sep 2077",
  inspect,
  reading: false,
  form,
  error: null,
  pending: false,
  canPreview: true,
  onPickFile: noop,
  onAccount: noop,
  onForm: noop,
  onHeaderLine: noop,
  onPreview: noop,
};

describe("MapStep — the header-line picker (ruling 7, v8 §16)", () => {
  it("lists the first twelve raw lines numbered from 0, marks the chosen one as the header, says more lines exist, and discloses the preamble count", () => {
    const html = renderToStaticMarkup(createElement(MapStep, mapProps));
    const text = strip(html);
    expect(text).toContain("Header line");
    for (let i = 0; i < 12; i++) expect(html).toContain(`aria-label="line ${i}"`);
    expect(html).not.toContain('aria-label="line 12"');
    expect(html).toContain('aria-label="line 3" aria-pressed="true"');
    expect(html).toContain('aria-label="line 4" aria-pressed="false"');
    expect(text).toContain("Date,Description,Debit,Credit,Balance");
    expect(text).toContain("header");
    expect(text).toContain("first 12 lines shown");
    expect(text).toContain("3 preamble lines skipped above the header");
    expect(text).toContain("First row read as: 2077-03-05 · “KOPI CORNER” · debit 4.50 → expense RM 4.50");
    expect(text).toContain("Preview 10 rows →");
  });

  it("with header line 0 there is no disclosure and no `more lines` row for a short file", () => {
    const short = { ...inspect, lines: LINES.slice(3, 7), line_count: 4, header_line: 0, row_count: 3 };
    const html = renderToStaticMarkup(createElement(MapStep, { ...mapProps, inspect: short, form: { ...form, header_line: 0 } }));
    const text = strip(html);
    expect(html).toContain('aria-label="line 0" aria-pressed="true"');
    expect(html).not.toContain('aria-label="line 4"');
    expect(text).not.toContain("skipped above the header");
    expect(text).not.toContain("first 12 lines shown");
  });

  it("a header line that does not read keeps the picker up, names the problem, hides the column pickers, and discloses no slice", () => {
    const bad = { ...inspect, header_line: 0, header: [], sample: null, row_count: 0, error: "Line 2: unterminated quote" };
    const html = renderToStaticMarkup(createElement(MapStep, { ...mapProps, inspect: bad, form: { ...form, header_line: 0 }, canPreview: false }));
    const text = strip(html);
    expect(html).toContain('aria-label="line 0" aria-pressed="true"');
    expect(text).toContain("Line 2: unterminated quote");
    expect(text).not.toContain("Date column");
    expect(text).toContain("Pick the line that names the columns");
    // Review Minor 1: a stored header line past a shorter file's end — the
    // slice did not happen, so rule 15's disclosure says nothing.
    const past = { ...inspect, lines: LINES.slice(3, 6), line_count: 3, header_line: 5, header: [], sample: null, row_count: 0, error: "Header line 5 is past the end of this file (3 lines)" };
    const pastText = strip(renderToStaticMarkup(createElement(MapStep, { ...mapProps, inspect: past, form: { ...form, header_line: 5 }, canPreview: false })));
    expect(pastText).toContain("Header line 5 is past the end of this file (3 lines)");
    expect(pastText).not.toContain("skipped above the header");
  });

  it("v7's `last used for <account> · <date>` is the line the wizard hands it, and absent without a stored mapping", () => {
    expect(strip(renderToStaticMarkup(createElement(MapStep, mapProps)))).toContain("last used for Maybank · 21 Sep 2077");
    expect(strip(renderToStaticMarkup(createElement(MapStep, { ...mapProps, lastUsed: "last used for Maybank" })))).toContain("last used for Maybank ");
    expect(strip(renderToStaticMarkup(createElement(MapStep, { ...mapProps, lastUsed: null })))).not.toContain("last used");
  });
});

const rows: PreviewRow[] = [
  {
    id: "r1",
    line: 2,
    raw: ["05/03/2077", "KOPI", "-18.00"],
    state: "new",
    date: "2077-03-05",
    description: "KOPI",
    note: null,
    signed_amount_sen: -1_800,
    type: "expense",
    category_id: null,
    needs_review: true,
    transfer_hint: false,
    duplicate_of: null,
    default_include: true,
  },
  {
    id: "r2",
    line: 3,
    raw: ["06/03/2077", "GRAB", "-27.90"],
    state: "probable_duplicate",
    date: "2077-03-06",
    description: "GRAB",
    note: null,
    signed_amount_sen: -2_790,
    type: "expense",
    category_id: null,
    needs_review: true,
    transfer_hint: false,
    duplicate_of: { id: "tx-imported", date: "2077-03-05", note: "grab via import", amount_sen: 2_790, type: "expense" },
    default_include: false,
  },
  {
    id: "r3",
    line: 4,
    raw: ["07/03/2077", "DUITNOW", "-100.00"],
    state: "probable_duplicate",
    date: "2077-03-07",
    description: "DUITNOW",
    note: null,
    signed_amount_sen: -10_000,
    type: "expense",
    category_id: null,
    needs_review: true,
    transfer_hint: false,
    duplicate_of: { id: "tx-transfer", date: "2077-03-07", note: "tng top-up", amount_sen: 10_000, type: "transfer" },
    default_include: false,
  },
  {
    id: "r4",
    line: 5,
    raw: ["08/03/2077", "TEH", "-2.00"],
    state: "probable_duplicate",
    date: "2077-03-08",
    description: "TEH",
    note: null,
    signed_amount_sen: -200,
    type: "expense",
    category_id: null,
    needs_review: true,
    transfer_hint: false,
    duplicate_of: { id: "tx-hand", date: "2077-03-08", note: "teh by hand", amount_sen: 200, type: "expense" },
    default_include: false,
  },
];

const summary = { row_count: 4, included_count: 1, skipped_count: 3, needs_review_count: 1, unparseable_count: 0 };
const previewProps = {
  preview: {
    ok: true as const,
    account: { id: "acct-1", name: "Maybank" },
    content_sha256: "0".repeat(64),
    rows,
    summary,
    same_file: null,
    reconcile: null,
    range: { min: "2077-03-05", max: "2077-03-08" },
    imported_batch: { "tx-imported": "batch-earlier" },
    preamble_lines: 3,
  },
  summary,
  include: new Set(["r1"]),
  acknowledged: new Set<number>(),
  continued: false,
  categories: {},
  history: [] as ImportBatchRow[],
  locked: false,
  progress: null,
  error: null,
  pending: false,
  failure: null as "retry" | "terminal" | null,
  onContinue: noop,
  onToggle: noop,
  onSkip: noop,
  onSkipAll: noop,
  onImport: noop,
};

describe("PreviewStep — the disclosure, the source suffix, the button (ruling 7, 8h, R2)", () => {
  it("carries `n preamble lines skipped above the header` as data, and not at 0", () => {
    expect(strip(renderToStaticMarkup(createElement(PreviewStep, previewProps)))).toContain("3 preamble lines skipped above the header");
    const none = { ...previewProps, preview: { ...previewProps.preview, preamble_lines: 0 } };
    expect(strip(renderToStaticMarkup(createElement(PreviewStep, none)))).not.toContain("preamble");
  });

  it("suffixes a probable duplicate's match with `· import` when a batch wrote it, `· transfer` for a transfer, nothing for a hand entry", () => {
    const text = strip(renderToStaticMarkup(createElement(PreviewStep, previewProps)));
    expect(text).toContain("“grab via import” · RM 27.90 · import");
    expect(text).toContain("“tng top-up” · RM 100.00 · transfer");
    expect(text).toMatch(/“teh by hand” · RM 2\.00 (?!·)/);
  });

  it("reads `Import n rows`, `Retry` after a retryable failure, `Start again` after a terminal one", () => {
    expect(strip(renderToStaticMarkup(createElement(PreviewStep, previewProps)))).toContain("Import 1 rows");
    expect(strip(renderToStaticMarkup(createElement(PreviewStep, { ...previewProps, failure: "retry", error: "Connection lost" })))).toContain("Retry");
    const terminal = strip(renderToStaticMarkup(createElement(PreviewStep, { ...previewProps, failure: "terminal", error: "This batch was undone — start a new import" })));
    expect(terminal).toContain("Start again");
    expect(terminal).not.toContain("Retry");
  });
});

describe("DoneStep — the batch just finished is on the history card at once (ruling 8g)", () => {
  const finished: ImportBatchRow & { preamble_lines: number } = {
    id: "batch-new",
    batch_no: 2,
    filename: "preamble.csv",
    account_name: "Maybank",
    row_count: 4,
    imported_count: 3,
    skipped_count: 0,
    needs_review_count: 1,
    unparseable_count: 1,
    touched_count: 0,
    created_at: "2077-03-09T02:00:00Z",
    undone_at: null,
    preamble_lines: 3,
  };
  const done = {
    batch_no: 2,
    imported_count: 3,
    needs_review_count: 1,
    skipped_count: 0,
    unparseable_count: 1,
    created_at: "2077-03-09T02:00:00Z",
    breakdown: { skipped: 1, probably_logged: 0, already_imported: 0, left_out: 0, unparseable: 1 },
  };
  const older: ImportBatchRow = { ...finished, id: "batch-old", batch_no: 1, filename: "older.csv", preamble_lines: undefined } as ImportBatchRow;

  it("never reads `No imports yet` for the batch on screen: the finished batch is listed before the fetched history", () => {
    const html = renderToStaticMarkup(
      createElement(DoneStep, { done, filename: "preamble.csv", accountName: "Maybank", month: "2077-03", history: [], finished, onAnother: noop }),
    );
    const text = strip(html);
    expect(text).not.toContain("No imports yet");
    expect(text).toContain("1 import · 0 undone");
    expect(html).toContain('id="import-batch-batch-new"');
    expect(text).toContain("4 rows · 3 imported · 1 skipped · 1 review");
    expect(text).toContain("· 3 preamble lines");
    expect(text).toContain("3 preamble lines skipped above the header");
    expect(text).toContain("1 skipped (1 unparseable)");
  });

  it("merges without duplicating once the refreshed history holds it, and the preamble count survives the fetched row", () => {
    const fetched = { ...finished, preamble_lines: undefined } as ImportBatchRow;
    const html = renderToStaticMarkup(
      createElement(DoneStep, { done, filename: "preamble.csv", accountName: "Maybank", month: "2077-03", history: [fetched, older], finished, onAnother: noop }),
    );
    const text = strip(html);
    expect(text).toContain("2 imports · 0 undone");
    expect(html.split('id="import-batch-batch-new"')).toHaveLength(2);
    expect(html).toContain('id="import-batch-batch-old"');
    expect(text).toContain("· 3 preamble lines");
  });
});
