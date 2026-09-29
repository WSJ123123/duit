import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { v5 as uuidv5 } from "uuid";
import { parseCsv } from "@/lib/csv";
import {
  IMPORT_NAMESPACE,
  importMappingSchema,
  applyMapping,
  normalizeDescription,
  importId,
  classifyRows,
  summarize,
  type ImportMapping,
  type ExistingTx,
  type ImportContext,
  type PreviewRow,
  type RawRow,
} from "@/lib/import";

const fixture = (name: string): string[][] =>
  parseCsv(readFileSync(path.join(__dirname, "__fixtures__", "csv", name), "utf8"));

const PAIR_MAPPING: ImportMapping = {
  date_col: 0,
  date_format: "DD/MM/YYYY",
  description_col: 1,
  amount: { kind: "pair", debit_col: 2, credit_col: 3 },
  note_col: null,
};

const SIGNED_MAPPING: ImportMapping = {
  date_col: 0,
  date_format: "YYYY-MM-DD",
  description_col: 1,
  amount: { kind: "signed", col: 2 },
  note_col: 3,
};

/** The owner's own accounts and categories, as the Quick Add path would build them. */
const CTX: ImportContext = {
  account_id: "acc-bank",
  aliases: [{ phrase: "kopi corner", category_id: "cat-food", account_id: null }],
  accounts: [
    { id: "acc-bank", name: "Main Bank" },
    { id: "acc-tng", name: "TNG" },
  ],
  categories: [
    { id: "cat-food", name: "Food", kind: "expense" },
    { id: "cat-salary", name: "Salary", kind: "income" },
  ],
};

function parsed(line: number, date: string, description: string, signed_amount_sen: number): RawRow {
  return { line, raw: [], date, description, signed_amount_sen, note: null };
}

describe("importMappingSchema", () => {
  it("accepts both amount shapes and rejects a negative column", () => {
    expect(importMappingSchema.safeParse(PAIR_MAPPING).success).toBe(true);
    expect(importMappingSchema.safeParse(SIGNED_MAPPING).success).toBe(true);
    expect(importMappingSchema.safeParse({ ...SIGNED_MAPPING, date_col: -1 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ ...SIGNED_MAPPING, date_format: "DD.MM.YYYY" }).success).toBe(false);
  });

  // Plan 9 ruling 7 / Standing check 3: the new keys are ADDITIVE. A mapping
  // stored under Plan 8's schema (the demo's Maybank mapping — exactly these
  // five keys) must still parse, to exactly itself: `getImportMappings`
  // drops a zod-failing entry and the next save persists the drop.
  it("parses a Plan-8-shaped stored mapping to exactly itself, and one carrying header_line + saved_at", () => {
    const plan8 = {
      date_col: 0,
      date_format: "DD/MM/YYYY",
      description_col: 1,
      amount: { kind: "pair", debit_col: 2, credit_col: 3 },
      note_col: null,
    };
    const parsed = importMappingSchema.safeParse(plan8);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(plan8);
    const withNew = { ...plan8, header_line: 3, saved_at: "2077-09-21T00:00:00.000Z" };
    const parsedNew = importMappingSchema.safeParse(withNew);
    expect(parsedNew.success).toBe(true);
    if (parsedNew.success) expect(parsedNew.data).toEqual(withNew);
    expect(importMappingSchema.safeParse({ ...plan8, header_line: 0 }).success).toBe(true);
    expect(importMappingSchema.safeParse({ ...plan8, header_line: 11 }).success).toBe(true);
  });

  it("refuses header_line −1, 12 (the picker shows lines 0–11) and a fraction", () => {
    expect(importMappingSchema.safeParse({ ...PAIR_MAPPING, header_line: -1 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ ...PAIR_MAPPING, header_line: 12 }).success).toBe(false);
    expect(importMappingSchema.safeParse({ ...PAIR_MAPPING, header_line: 1.5 }).success).toBe(false);
  });
});

describe("applyMapping", () => {
  it("maps a debit/credit pair: blank credit = money out, credit = money in, both filled / both blank named", () => {
    const rows = applyMapping(fixture("bank-pair-ddmmyyyy.csv").slice(1), PAIR_MAPPING);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ line: 2, date: "2026-03-01", description: "KOPI CORNER SDN BHD", signed_amount_sen: -450, note: null });
    expect(rows[0]!.error).toBeUndefined();
    expect(rows[1]).toMatchObject({ line: 3, date: "2026-03-02", signed_amount_sen: 350_000 });
    expect(rows[2]).toMatchObject({ line: 4, signed_amount_sen: -5000 });
    expect(rows[3]).toMatchObject({ line: 5, date: "2026-03-04", signed_amount_sen: null, error: "debit and credit both filled" });
    expect(rows[4]).toMatchObject({ line: 6, signed_amount_sen: null, error: "debit and credit both blank" });
    expect(rows[3]!.raw).toEqual(["04/03/2026", "BOTH FILLED ROW", "1.00", "2.00", "5,446.50"]);
  });

  it("maps a signed column with a note column", () => {
    const rows = applyMapping(fixture("ewallet-signed-iso.csv").slice(1), SIGNED_MAPPING);
    expect(rows).toEqual([
      { line: 2, raw: ["2026-03-01", "Nasi Lemak Stall", "-8.00", "NL-001"], date: "2026-03-01", description: "Nasi Lemak Stall", signed_amount_sen: -800, note: "NL-001" },
      { line: 3, raw: ["2026-03-02", "Top-up from Main Bank", "50.00", "TU-002"], date: "2026-03-02", description: "Top-up from Main Bank", signed_amount_sen: 5000, note: "TU-002" },
      { line: 4, raw: ["2026-03-03", "Grab*Food #A-1", "-23.40", ""], date: "2026-03-03", description: "Grab*Food #A-1", signed_amount_sen: -2340, note: null },
    ]);
  });

  it("names a bad date, a bad amount, an empty line and a zero amount — and drops nothing", () => {
    const rows = applyMapping(fixture("bad-rows.csv").slice(1), { ...SIGNED_MAPPING, date_format: "DD/MM/YYYY", note_col: null });
    expect(rows.map((r) => [r.line, r.error])).toEqual([
      [2, "bad date"],
      [3, "bad amount"],
      [4, "empty line"],
      [5, "zero amount"],
      [6, undefined],
    ]);
    expect(rows[0]).toMatchObject({ date: null, description: "BAD DATE ROW", signed_amount_sen: -100 });
    expect(rows[1]).toMatchObject({ date: "2026-03-03", signed_amount_sen: null });
    expect(rows[4]).toMatchObject({ date: "2026-03-05", signed_amount_sen: -250 });
  });

  it("reads the quirks file under D MMM YYYY with parentheses / DR / CR amounts", () => {
    const rows = applyMapping(fixture("quirks-bom-crlf.csv").slice(1), {
      date_col: 0,
      date_format: "D MMM YYYY",
      description_col: 1,
      amount: { kind: "signed", col: 2 },
      note_col: null,
    });
    expect(rows.map((r) => r.signed_amount_sen)).toEqual([-4590, 4590, -1200, null]);
    expect(rows[3]!.error).toBe("bad amount");
    expect(rows[2]!.description).toBe("Two line\ndescription");
  });

  it("names a whitespace-only row as an empty line", () => {
    const rows = applyMapping([[" ", "", "  ", "\t"]], SIGNED_MAPPING);
    expect(rows[0]).toMatchObject({ line: 2, date: null, signed_amount_sen: null, error: "empty line" });
  });

  it("takes the file line of the first data row", () => {
    const rows = applyMapping([["2026-03-01", "x", "-1.00", ""]], SIGNED_MAPPING, 7);
    expect(rows[0]!.line).toBe(7);
  });
});

describe("normalizeDescription", () => {
  // Stated verbatim: lowercase → collapse whitespace runs → strip every
  // character outside [a-z0-9 ] → trim. Every import id hangs off this; a
  // change here silently re-keys every row ever imported (ruling 12).
  it("pins three examples", () => {
    expect(normalizeDescription("  KOPI   Corner SDN. BHD ")).toBe("kopi corner sdn bhd");
    expect(normalizeDescription("TRANSFER TO TNG EWALLET*12345")).toBe("transfer to tng ewallet12345");
    expect(normalizeDescription("Grab*Food  #A-1")).toBe("grabfood a1");
  });
});

describe("importId", () => {
  const kopi = { date: "2026-03-01", description: "KOPI CORNER SDN BHD", signed_amount_sen: -450 };
  const salary = { date: "2026-03-02", description: "Salary  Credit ACME", signed_amount_sen: 350_000 };

  it("is stable: three fixed inputs → three fixed uuids", () => {
    expect(importId("acc-bank", kopi, 0)).toBe("b4d56bbc-5a1d-5efb-bab4-7b2e0468993a");
    expect(importId("acc-bank", kopi, 1)).toBe("fde7c360-0345-5515-8785-ea4809491098");
    expect(importId("acc-bank", salary, 0)).toBe("4390567c-03fd-5c7f-8c7a-f1e9786dac7e");
  });

  it("is ruling 12's key under IMPORT_NAMESPACE", () => {
    expect(IMPORT_NAMESPACE).toBe("38f7c1e6-c3f3-464c-a4e4-a65d7233c8c9");
    expect(importId("acc-bank", kopi, 0)).toBe(
      uuidv5("acc-bank:2026-03-01:-450:kopi corner sdn bhd:0", IMPORT_NAMESPACE),
    );
  });

  it("separates identical rows by ordinal and accounts by id", () => {
    expect(importId("acc-bank", kopi, 0)).not.toBe(importId("acc-bank", kopi, 1));
    expect(importId("acc-bank", kopi, 0)).not.toBe(importId("acc-tng", kopi, 0));
  });
});

describe("classifyRows", () => {
  const kopiId = "b4d56bbc-5a1d-5efb-bab4-7b2e0468993a";
  const existing = (over: Partial<ExistingTx>): ExistingTx => ({
    id: "11111111-1111-4111-8111-111111111111",
    date: "2026-03-01",
    note: "kopi",
    signed_amount_sen: -450,
    type: "expense",
    ...over,
  });

  it("classifies a fresh row as new with type from the sign and category from the parser", () => {
    const [row] = classifyRows([parsed(2, "2026-03-01", "KOPI CORNER SDN BHD", -450)], [], CTX);
    expect(row).toEqual({
      id: kopiId,
      line: 2,
      raw: [],
      state: "new",
      date: "2026-03-01",
      description: "KOPI CORNER SDN BHD",
      note: null,
      signed_amount_sen: -450,
      type: "expense",
      category_id: "cat-food",
      needs_review: false,
      transfer_hint: false,
      duplicate_of: null,
      default_include: true,
    });
  });

  it("marks a credit as income and resolves an income category", () => {
    const [row] = classifyRows([parsed(2, "2026-03-02", "SALARY CREDIT ACME", 350_000)], [], CTX);
    expect(row).toMatchObject({ type: "income", category_id: "cat-salary", needs_review: false });
  });

  it("flags needs_review with category null when the parser cannot categorise", () => {
    const [row] = classifyRows([parsed(2, "2026-03-02", "MYSTERY MERCHANT 8821", -1000)], [], CTX);
    expect(row).toMatchObject({ state: "new", category_id: null, needs_review: true, transfer_hint: false });
  });

  it("raises the transfer hint when the description names another own account, never the target", () => {
    const rows = classifyRows(
      [
        parsed(2, "2026-03-03", "TRANSFER TO TNG EWALLET", -5000),
        parsed(3, "2026-03-03", "MAIN BANK SERVICE FEE", -100),
      ],
      [],
      CTX,
    );
    expect(rows[0]).toMatchObject({ type: "expense", transfer_hint: true, needs_review: true });
    expect(rows[1]).toMatchObject({ transfer_hint: false });
  });

  it("marks a probable duplicate on the same signed amount within ±1 day, default-skipped, with the existing row beside it", () => {
    const dayBefore = existing({ id: "aaaaaaaa-0000-4000-8000-000000000001", date: "2026-02-28" });
    const dayAfter = existing({ id: "aaaaaaaa-0000-4000-8000-000000000002", date: "2026-03-02" });
    const r1 = classifyRows([parsed(2, "2026-03-01", "KOPI CORNER SDN BHD", -450)], [dayAfter, dayBefore], CTX)[0]!;
    expect(r1.state).toBe("probable_duplicate");
    expect(r1.default_include).toBe(false);
    expect(r1.duplicate_of).toEqual({ id: dayBefore.id, date: "2026-02-28", note: "kopi", amount_sen: 450, type: "expense" });
  });

  it("does not match two days away or a different sign", () => {
    const twoDays = existing({ date: "2026-03-03" });
    const income = existing({ type: "income", signed_amount_sen: 450 });
    const incoming = existing({ type: "transfer", signed_amount_sen: 450 });
    const rows = classifyRows([parsed(2, "2026-03-01", "KOPI CORNER SDN BHD", -450)], [twoDays, income, incoming], CTX);
    expect(rows[0]).toMatchObject({ state: "new", duplicate_of: null });
  });

  // Ruling 12b's text: ANY existing transaction on the account. A logged
  // transfer is one — signed on the target account by the DB layer.
  it("matches a logged transfer OUT of the account against the statement's debit", () => {
    const out = existing({ type: "transfer", note: "tng top-up", signed_amount_sen: -5000, date: "2026-03-02" });
    const [row] = classifyRows([parsed(2, "2026-03-03", "DUITNOW TO 5123", -5000)], [out], CTX);
    expect(row).toMatchObject({ state: "probable_duplicate", default_include: false });
    expect(row!.duplicate_of).toEqual({ id: out.id, date: "2026-03-02", note: "tng top-up", amount_sen: 5000, type: "transfer" });
  });

  it("matches a logged transfer INTO the account against the statement's credit, never its debit", () => {
    const into = existing({ type: "transfer", note: "from savings", signed_amount_sen: 5000 });
    const rows = classifyRows(
      [parsed(2, "2026-03-01", "IBG TRANSFER", 5000), parsed(3, "2026-03-01", "IBG TRANSFER", -5000)],
      [into],
      CTX,
    );
    expect(rows[0]).toMatchObject({ state: "probable_duplicate", default_include: false });
    expect(rows[0]!.duplicate_of?.id).toBe(into.id);
    expect(rows[1]).toMatchObject({ state: "new", duplicate_of: null });
  });

  it("counts the day difference across a month boundary", () => {
    const eve = existing({ date: "2026-02-28", signed_amount_sen: -100 });
    const rows = classifyRows([parsed(2, "2026-03-01", "x", -100)], [eve], CTX);
    expect(rows[0]!.state).toBe("probable_duplicate");
  });

  it("counts the day difference across a year boundary", () => {
    const eve = existing({ date: "2026-12-31", signed_amount_sen: -100 });
    const rows = classifyRows([parsed(2, "2027-01-01", "x", -100)], [eve], CTX);
    expect(rows[0]!.state).toBe("probable_duplicate");
  });

  it("derives already_imported from an existing row carrying the computed id, winning over a probable duplicate", () => {
    const exact = existing({ id: kopiId, date: "2026-03-01" });
    const near = existing({ id: "aaaaaaaa-0000-4000-8000-000000000009", date: "2026-03-02" });
    const rows = classifyRows([parsed(2, "2026-03-01", "KOPI CORNER SDN BHD", -450)], [near, exact], CTX);
    expect(rows[0]).toMatchObject({ state: "already_imported", id: kopiId, default_include: false });
    expect(rows[0]!.duplicate_of).toEqual({ id: kopiId, date: "2026-03-01", note: "kopi", amount_sen: 450, type: "expense" });
  });

  it("matches already_imported by id alone, whatever the existing row's type", () => {
    const exact = existing({ id: kopiId, type: "transfer" });
    const rows = classifyRows([parsed(2, "2026-03-01", "KOPI CORNER SDN BHD", -450)], [exact], CTX);
    expect(rows[0]!.state).toBe("already_imported");
  });

  it("gives two identical rows in one file distinct ids by ordinal", () => {
    const rows = classifyRows(applyMapping(fixture("identical-rows.csv").slice(1), PAIR_MAPPING), [], CTX);
    expect(rows.map((r) => r.id)).toEqual([
      "b4d56bbc-5a1d-5efb-bab4-7b2e0468993a",
      "fde7c360-0345-5515-8785-ea4809491098",
      "4390567c-03fd-5c7f-8c7a-f1e9786dac7e",
    ]);
    expect(rows.every((r) => r.state === "new")).toBe(true);
  });

  it("gives a third identical row ordinal 2", () => {
    const kopi = { date: "2026-03-01", description: "KOPI CORNER SDN BHD", signed_amount_sen: -450 };
    const rows = classifyRows(
      [2, 3, 4].map((line) => parsed(line, kopi.date, kopi.description, kopi.signed_amount_sen)),
      [],
      CTX,
    );
    expect(rows[2]!.id).toBe("5de85ded-8aa6-50b7-9b96-96b3cccf62e1");
    expect(rows[2]!.id).toBe(importId("acc-bank", kopi, 2));
  });

  it("passes an unparseable row through with its reason, no id, never included", () => {
    const rows = classifyRows(
      applyMapping(fixture("bad-rows.csv").slice(1), { ...SIGNED_MAPPING, date_format: "DD/MM/YYYY", note_col: null }),
      [],
      CTX,
    );
    expect(rows.map((r) => r.state)).toEqual(["unparseable", "unparseable", "unparseable", "unparseable", "new"]);
    expect(rows[0]).toMatchObject({ id: null, line: 2, error: "bad date", default_include: false, raw: ["31/02/2026", "BAD DATE ROW", "-1.00"] });
    expect(rows[2]).toMatchObject({ id: null, line: 4, error: "empty line" });
  });
});

describe("summarize", () => {
  const rows: PreviewRow[] = classifyRows(
    [
      parsed(2, "2026-03-01", "KOPI CORNER SDN BHD", -450),
      parsed(3, "2026-03-01", "MYSTERY MERCHANT", -1000),
      parsed(4, "2026-03-02", "SALARY CREDIT ACME", 350_000),
      { line: 5, raw: ["x"], date: null, description: "", signed_amount_sen: null, note: null, error: "bad date" },
    ],
    [{ id: "22222222-2222-4222-8222-222222222222", date: "2026-03-01", note: "same kopi", signed_amount_sen: -450, type: "expense" }],
    CTX,
  );

  it("counts rows, included, skipped, needs_review and unparseable from the rows and the owner's choices", () => {
    const ids = rows.map((r) => r.id);
    // Owner keeps the default: the probable duplicate skipped, the two new rows in.
    expect(summarize(rows, [{ id: ids[1]!, include: true }, { id: ids[2]!, include: true }])).toEqual({
      row_count: 4,
      included_count: 2,
      skipped_count: 1,
      needs_review_count: 1,
      unparseable_count: 1,
    });
    // Owner includes the duplicate with one click.
    expect(summarize(rows, [{ id: ids[0]!, include: true }, { id: ids[1]!, include: true }, { id: ids[2]!, include: true }])).toMatchObject({
      included_count: 3,
      skipped_count: 0,
    });
    // No choices at all: every parseable row is skipped.
    expect(summarize(rows, [])).toMatchObject({ included_count: 0, skipped_count: 3, needs_review_count: 0, unparseable_count: 1 });
  });
});
