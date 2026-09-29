import { describe, it, expect } from "vitest";
import { computeOwed, shapeOpenReimbursements } from "@/lib/reimbursements";

describe("computeOwed", () => {
  it("full payment → 0", () => {
    expect(computeOwed({ expected_back_sen: 24_000 }, [{ amount_sen: 24_000 }])).toBe(0);
  });
  it("partial payment → remainder", () => {
    expect(computeOwed({ expected_back_sen: 24_000 }, [{ amount_sen: 16_000 }])).toBe(8_000);
  });
  it("multiple partial payments sum", () => {
    expect(
      computeOwed({ expected_back_sen: 24_000 }, [{ amount_sen: 16_000 }, { amount_sen: 8_000 }]),
    ).toBe(0);
  });
  it("overpayment → 0, never negative", () => {
    expect(computeOwed({ expected_back_sen: 24_000 }, [{ amount_sen: 30_000 }])).toBe(0);
  });
  it("no payments → full expected_back", () => {
    expect(computeOwed({ expected_back_sen: 24_000 }, [])).toBe(24_000);
  });
});

describe("shapeOpenReimbursements", () => {
  const row = (
    id: string,
    date: string,
    expected: number,
    paid: number[],
    note = "",
  ) => ({
    id,
    note,
    date,
    expected_back_sen: expected,
    payments: paid.map((amount_sen) => ({ amount_sen })),
  });

  it("filters out fully-paid rows and computes paid/owed", () => {
    const shaped = shapeOpenReimbursements([
      row("t1", "2026-08-10", 24_000, [24_000]), // closed
      row("t2", "2026-08-11", 24_000, [16_000], "dinner"), // open
    ]);
    expect(shaped).toEqual([
      {
        transaction_id: "t2",
        note: "dinner",
        date: "2026-08-11",
        expected_back_sen: 24_000,
        paid_sen: 16_000,
        owed_sen: 8_000,
      },
    ]);
  });

  it("sorts newest first by date desc, tiebreak transaction_id asc", () => {
    const shaped = shapeOpenReimbursements([
      row("b", "2026-08-01", 10_000, []),
      row("d", "2026-08-03", 10_000, []),
      row("c", "2026-08-03", 10_000, []),
      row("a", "2026-08-02", 10_000, []),
    ]);
    expect(shaped.map((r) => r.transaction_id)).toEqual(["c", "d", "a", "b"]);
  });

  it("empty input → empty output", () => {
    expect(shapeOpenReimbursements([])).toEqual([]);
  });
});
