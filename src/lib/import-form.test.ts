import { describe, it, expect } from "vitest";
import { firstRowLine, formFrom, mappingFrom } from "@/lib/import-form";
import type { ImportMapping } from "@/lib/import";

/** Plan 8 Task 6 fix wave (m11): the wizard's map-screen helpers, lifted out
 *  of the client component and pinned. */

const PAIR: ImportMapping = {
  date_col: 0,
  date_format: "DD/MM/YYYY",
  description_col: 1,
  amount: { kind: "pair", debit_col: 2, credit_col: 3 },
  note_col: null,
};
const SIGNED: ImportMapping = {
  date_col: 2,
  date_format: "YYYY-MM-DD",
  description_col: 0,
  amount: { kind: "signed", col: 1 },
  note_col: 3,
};

describe("formFrom / mappingFrom", () => {
  it("round-trips a stored mapping of either amount kind", () => {
    expect(mappingFrom(formFrom(PAIR, 4))).toEqual({ ...PAIR, header_line: 0 });
    expect(mappingFrom(formFrom(SIGNED, 4))).toEqual({ ...SIGNED, header_line: 0 });
  });

  it("with nothing stored: date 0, description 1, one signed amount column 2, no note, header line 0", () => {
    expect(formFrom(undefined, 4)).toEqual({
      date_col: "0", date_format: "DD/MM/YYYY", description_col: "1", kind: "signed",
      signed_col: "2", debit_col: "2", credit_col: "3", note_col: "", header_line: 0,
    });
  });

  // Plan 9 ruling 7: the stored header line rides in the form and out again
  // in the mapping (always emitted, so the stored shape says what was used);
  // it survives the width fallback — it is what DEFINES the width.
  it("carries a stored header_line through, and emits it in the mapping", () => {
    expect(formFrom({ ...PAIR, header_line: 3 }, 4).header_line).toBe(3);
    expect(formFrom(PAIR, 4).header_line).toBe(0);
    expect(mappingFrom(formFrom({ ...PAIR, header_line: 3 }, 4))).toEqual({ ...PAIR, header_line: 3 });
    expect(mappingFrom(formFrom(PAIR, 4))).toEqual({ ...PAIR, header_line: 0 });
    expect(formFrom({ ...PAIR, date_col: 9, header_line: 3 }, 4)).toEqual({ ...formFrom(undefined, 4), header_line: 3 });
    // A stored saved_at never travels back out.
    expect(mappingFrom(formFrom({ ...PAIR, saved_at: "2077-09-21T00:00:00.000Z" }, 4))).toEqual({ ...PAIR, header_line: 0 });
  });

  it("never points past a narrow file", () => {
    const f = formFrom(undefined, 2);
    expect([f.description_col, f.signed_col, f.debit_col, f.credit_col]).toEqual(["1", "1", "1", "1"]);
  });

  it("drops a stored mapping whose date or description column is past the file's width", () => {
    expect(formFrom({ ...PAIR, date_col: 9 }, 4)).toEqual(formFrom(undefined, 4));
  });
});

describe("formFrom — every mapped column is range-checked against the file's width (m6)", () => {
  it("falls back to unset when a stored debit, credit, signed or note column is past the width", () => {
    const unset = formFrom(undefined, 4);
    expect(formFrom({ ...PAIR, amount: { kind: "pair", debit_col: 2, credit_col: 7 } }, 4)).toEqual(unset);
    expect(formFrom({ ...PAIR, amount: { kind: "pair", debit_col: 4, credit_col: 3 } }, 4)).toEqual(unset);
    expect(formFrom({ ...SIGNED, amount: { kind: "signed", col: 4 } }, 4)).toEqual(unset);
    expect(formFrom({ ...SIGNED, note_col: 5 }, 4)).toEqual(unset);
    // In range, including the last column and a null note: kept.
    expect(mappingFrom(formFrom(SIGNED, 4))).toEqual({ ...SIGNED, header_line: 0 });
  });
});

describe("firstRowLine", () => {
  const sample = ["05/03/2077", "KOPI CORNER", "4.50", ""];

  it("reads a debit as an expense and a credit as income", () => {
    expect(firstRowLine(sample, formFrom(PAIR, 4))).toBe("First row read as: 2077-03-05 · “KOPI CORNER” · debit 4.50 → expense RM 4.50");
    expect(firstRowLine(["06/03/2077", "SALARY", "", "3500.00"], formFrom(PAIR, 4))).toBe(
      "First row read as: 2077-03-06 · “SALARY” · credit 3500.00 → income RM 3,500.00",
    );
  });

  it("says when the date format or the amount does not read, and when there is no data row", () => {
    expect(firstRowLine(sample, { ...formFrom(PAIR, 4), date_format: "D MMM YYYY" })).toContain("date not read — try another format");
    expect(firstRowLine(["05/03/2077", "KOPI", "abc", ""], formFrom(PAIR, 4))).toContain("amount not read");
    expect(firstRowLine(null, formFrom(PAIR, 4))).toBe("No data rows in this file");
  });

  it("Q40: the raw amount cell goes through the caller's cell renderer (the Map screen's mask); blank stays `(blank)`", () => {
    const mask = () => "••••";
    expect(firstRowLine(sample, formFrom(PAIR, 4), mask)).toBe(
      "First row read as: 2077-03-05 · “KOPI CORNER” · debit •••• → expense RM 4.50",
    );
    expect(firstRowLine(["06/03/2077", "SALARY", "", "3500.00"], formFrom(PAIR, 4), mask)).toContain("· credit •••• →");
    expect(firstRowLine(["06/03/2077", "SALARY", "", ""], formFrom(PAIR, 4), mask)).toContain("· credit (blank) →");
    const signed = { ...formFrom(PAIR, 4), kind: "signed" as const, signed_col: "2" };
    expect(firstRowLine(["06/03/2077", "KOPI", "-4.50", ""], signed, mask)).toContain("· amount •••• →");
    expect(firstRowLine(["06/03/2077", "KOPI", "", ""], signed, mask)).toContain("· amount (blank) →");
  });
});
