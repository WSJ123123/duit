import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MASKED_MYR } from "@/lib/money-mask";
import type { PreviewRow } from "@/lib/import";
import type { MapForm } from "@/lib/import-form";
import { assertNoMoney } from "@/test/no-money";
import { renderMasked } from "@/test/render-money";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));

const { MapStep } = await import("@/components/import-wizard/MapStep");
const { PreviewStep } = await import("@/components/import-wizard/PreviewStep");
const { DoneStep } = await import("@/components/import-wizard/DoneStep");

/**
 * Plan 9 Task 3b — the import wizard under the amounts mask (ruling 4):
 * the Map screen's `First row read as:` outcome masks, the Preview screen is
 * SHOWN (the pre-commit verification of a statement — duplicates are judged
 * by their amounts), and Done / the history carry counts only.
 */
const noop = () => {};

const form: MapForm = {
  date_col: "0",
  date_format: "DD/MM/YYYY",
  description_col: "1",
  kind: "pair",
  signed_col: "2",
  debit_col: "2",
  credit_col: "3",
  note_col: "",
  header_line: 1,
};
const mapProps = {
  accounts: [{ id: "acct-1", name: "Maybank", type: "bank" }],
  accountId: "acct-1",
  lastUsed: "last used for Maybank",
  inspect: {
    filename: "synthetic.csv",
    size: 2_048,
    lines: ["Statement,balance 1,234.56", "Date,Description,Debit,Credit", "01/09/2077,CARD PAYMENT,1,234.56,", "02/09/2077,REFUND,,250.00"],
    line_count: 4,
    header_line: 1,
    header: ["Date", "Description", "Debit", "Credit"],
    sample: ["01/09/2077", "CARD PAYMENT", "1,234.56", ""],
    row_count: 12,
    error: null,
  },
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

describe("MapStep — First row read as", () => {
  it("shown: the outcome prints the figure the app read", () => {
    const html = renderToStaticMarkup(createElement(MapStep, mapProps));
    expect(html).toContain("→ expense RM 1,234.56");
  });

  it("hidden (Q40): the whole line masks — the file's raw amount cell AND the app-read figure", () => {
    const html = renderMasked(createElement(MapStep, mapProps));
    expect(html).toContain(`debit •••• → expense ${MASKED_MYR}`);
    expect(html).toContain("last used for Maybank");
    assertNoMoney(html, ["1,234.56"]);
  });

  it("shown: the header-line picker prints the file's raw lines as they are", () => {
    const html = renderToStaticMarkup(createElement(MapStep, mapProps));
    expect(html).toContain("01/09/2077,CARD PAYMENT,1,234.56,");
    expect(html).toContain("02/09/2077,REFUND,,250.00");
  });

  it("hidden: the picker's raw lines mask their figures too (Q40's rule for file text), the rest of the line stays", () => {
    const html = renderMasked(createElement(MapStep, mapProps));
    expect(html).toContain("01/09/2077,CARD PAYMENT,••••,");
    expect(html).toContain("02/09/2077,REFUND,,••••");
    expect(html).toContain("Statement,balance ••••");
    expect(html).toContain("1 preamble line skipped above the header");
    assertNoMoney(html, ["1,234.56", "250.00"]);
  });
});

const rows: PreviewRow[] = [
  {
    id: "r1",
    line: 2,
    raw: ["01/09/2077", "KOPI", "-18.00"],
    state: "new",
    date: "2077-09-01",
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
    raw: ["02/09/2077", "GRAB", "-27.90"],
    state: "probable_duplicate",
    date: "2077-09-02",
    description: "GRAB",
    note: null,
    signed_amount_sen: -2_790,
    type: "expense",
    category_id: null,
    needs_review: true,
    transfer_hint: false,
    duplicate_of: { id: "tx-9", date: "2077-09-01", note: "grab home", amount_sen: 2_790, type: "expense" },
    default_include: false,
  },
  {
    id: "r3",
    line: 4,
    raw: ["03/09/2077", "SALARY", "3500.00"],
    state: "new",
    date: "2077-09-03",
    description: "SALARY",
    note: null,
    signed_amount_sen: 350_000,
    type: "income",
    category_id: null,
    needs_review: true,
    transfer_hint: false,
    duplicate_of: null,
    default_include: true,
  },
];
const previewProps = {
  preview: {
    ok: true as const,
    account: { id: "acct-1", name: "Maybank" },
    content_sha256: "0".repeat(64),
    rows,
    summary: { row_count: 3, included_count: 2, skipped_count: 1, needs_review_count: 3, unparseable_count: 0 },
    same_file: null,
    reconcile: { count: 1, net_sen: 4_500 },
    range: { min: "2077-09-01", max: "2077-09-03" },
    imported_batch: {},
    preamble_lines: 0,
  },
  summary: { row_count: 3, included_count: 2, skipped_count: 1, needs_review_count: 3, unparseable_count: 0 },
  include: new Set(["r1", "r3"]),
  acknowledged: new Set<number>(),
  continued: false,
  categories: {},
  history: [],
  locked: false,
  progress: null,
  error: null,
  pending: false,
  failure: null,
  onContinue: noop,
  onToggle: noop,
  onSkip: noop,
  onSkipAll: noop,
  onImport: noop,
};

describe("PreviewStep — shown by ruling 4 even while amounts are hidden", () => {
  it("hidden: the stat sub-line, row amounts, the duplicate match and the reconcile net all print", () => {
    const html = renderMasked(createElement(PreviewStep, previewProps));
    expect(html).toContain("RM 18.00 out · RM 3,500.00 in");
    expect(html).toContain("−RM 18.00");
    expect(html).toContain("+RM 3,500.00");
    expect(html).toContain("“grab home” · RM 27.90");
    expect(html).toContain("1 reconcile adjustment · +RM 45.00");
    expect(html).not.toContain("••••");
  });
});

describe("DoneStep and the import history — counts, never a figure", () => {
  it("hidden: nothing on the Done screen is money", () => {
    const history = [
      {
        id: "b1",
        batch_no: 2,
        filename: "synthetic.csv",
        account_name: "Maybank",
        row_count: 12,
        imported_count: 11,
        skipped_count: 1,
        needs_review_count: 4,
        unparseable_count: 0,
        touched_count: 0,
        created_at: "2077-09-04T02:00:00Z",
        undone_at: null,
      },
    ];
    const done = {
      batch_no: 2,
      imported_count: 11,
      needs_review_count: 4,
      skipped_count: 1,
      unparseable_count: 0,
      created_at: "2077-09-04T02:00:00Z",
      breakdown: { skipped: 1, probably_logged: 1, already_imported: 0, left_out: 0, unparseable: 0 },
    };
    const html = renderMasked(
      createElement(DoneStep, { done, filename: "synthetic.csv", accountName: "Maybank", month: "2077-09", history, finished: { ...history[0]!, preamble_lines: 3 }, onAnother: noop }),
    );
    expect(html).toContain("11 rows");
    assertNoMoney(html);
  });
});
