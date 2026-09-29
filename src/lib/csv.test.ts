import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { toCsv, parseCsv, CsvParseError } from "@/lib/csv";

describe("toCsv", () => {
  it("renders a header row and plain data rows in column order", () => {
    const out = toCsv(
      [
        { id: "1", name: "Groceries", amount_sen: 1800 },
        { id: "2", name: "Petrol", amount_sen: 5000 },
      ],
      ["id", "name", "amount_sen"],
    );
    expect(out).toBe(
      "id,name,amount_sen\r\n" + "1,Groceries,1800\r\n" + "2,Petrol,5000\r\n",
    );
  });

  it("uses CRLF line endings", () => {
    const out = toCsv([{ a: "x" }], ["a"]);
    expect(out).toContain("\r\n");
    // No lone \n without a preceding \r.
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("quotes and escapes a note containing comma, double-quote and newline", () => {
    const note = 'Lunch, "the good place"\nwith Sam';
    const out = toCsv([{ note }], ["note"]);
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("note");
    // The quoted, escaped field round-trips: outer quotes, doubled inner quotes,
    // and the embedded \n survives literally inside the quoted field.
    expect(lines[1]).toBe('"Lunch, ""the good place""\nwith Sam"');
  });

  it("renders null and undefined as an empty field", () => {
    const out = toCsv([{ a: null, b: undefined, c: "x" }], ["a", "b", "c"]);
    expect(out).toBe("a,b,c\r\n,,x\r\n");
  });

  it("keeps integer sen amounts verbatim — never a derived decimal", () => {
    const out = toCsv([{ amount_sen: 1800 }], ["amount_sen"]);
    expect(out).toContain("1800");
    expect(out).not.toMatch(/18\.00|18,00/);
  });

  it("renders booleans as true/false", () => {
    const out = toCsv([{ archived: true }, { archived: false }], ["archived"]);
    expect(out).toBe("archived\r\ntrue\r\nfalse\r\n");
  });

  it("follows the given column order regardless of row key order", () => {
    const out = toCsv([{ b: "2", a: "1" }], ["a", "b"]);
    expect(out).toBe("a,b\r\n1,2\r\n");
  });

  it("produces a header-only file for an empty rows array", () => {
    const out = toCsv([], ["a", "b"]);
    expect(out).toBe("a,b\r\n");
  });
});

// --- parseCsv (Plan 8 Task 5) -------------------------------------------

const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "__fixtures__", "csv", name), "utf8");

describe("parseCsv", () => {
  it("reads a bank-shaped debit/credit file (LF, quoted thousands commas)", () => {
    const rows = parseCsv(fixture("bank-pair-ddmmyyyy.csv"));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(["Date", "Description", "Debit", "Credit", "Balance"]);
    expect(rows[1]).toEqual(["01/03/2026", "KOPI CORNER SDN BHD", "4.50", "", "1,995.50"]);
    expect(rows[2]).toEqual(["02/03/2026", "SALARY CREDIT ACME", "", "3,500.00", "5,495.50"]);
  });

  it("reads an e-wallet-shaped signed-amount file", () => {
    const rows = parseCsv(fixture("ewallet-signed-iso.csv"));
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual(["2026-03-03", "Grab*Food #A-1", "-23.40", ""]);
  });

  it("strips a BOM, handles CRLF, quoted commas/quotes/newlines, pads a ragged row and drops trailing blank lines", () => {
    const rows = parseCsv(fixture("quirks-bom-crlf.csv"));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(["Date", "Description", "Amount"]);
    expect(rows[0]![0]).toBe("Date"); // no U+FEFF prefix
    expect(rows[1]).toEqual(["3 Mar 2026", "Bookshop, Main Street", "(45.90)"]);
    expect(rows[2]).toEqual(["4 MAR 2026", 'Refund "Bookshop"', "45.90 CR"]);
    expect(rows[3]).toEqual(["5 mar 2026", "Two line\ndescription", "RM 12.00 DR"]);
    expect(rows[4]).toEqual(["6 Mar 2026", "Ragged row", ""]);
  });

  it("keeps two identical rows as two rows", () => {
    const rows = parseCsv(fixture("identical-rows.csv"));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual(rows[2]);
  });

  it("keeps an empty line inside the data as an all-blank row padded to the header width", () => {
    const rows = parseCsv(fixture("bad-rows.csv"));
    expect(rows).toHaveLength(6);
    expect(rows[3]).toEqual(["", "", ""]);
    expect(rows[5]).toEqual(["05/03/2026", "GOOD ROW", "-2.50"]);
  });

  it("accepts a file without a trailing newline and an empty file", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("keeps the extra cells of a row longer than the header", () => {
    expect(parseCsv("a,b\n1,2,3")).toEqual([["a", "b"], ["1", "2", "3"]]);
  });

  it("round-trips a quoted field containing CRLF with both characters", () => {
    expect(parseCsv('a,b\r\n"x\r\ny",2\r\n')).toEqual([["a", "b"], ["x\r\ny", "2"]]);
  });

  it("throws a typed error on an unterminated quote", () => {
    expect(() => parseCsv('a,b\n1,"open')).toThrow(CsvParseError);
  });
});
