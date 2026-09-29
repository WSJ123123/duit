import { describe, it, expect } from "vitest";
import { groupByDay, type ActivityTxLike } from "@/lib/activity";

function mkRow(overrides: Partial<ActivityTxLike> & { id: string; date: string }): ActivityTxLike {
  return {
    type: "expense",
    amount_sen: 1_000,
    expected_back_sen: 0,
    ...overrides,
  };
}

describe("groupByDay", () => {
  it("orders days newest-first regardless of input order", () => {
    const rows = [
      mkRow({ id: "a", date: "2026-08-10" }),
      mkRow({ id: "b", date: "2026-08-15" }),
      mkRow({ id: "c", date: "2026-08-12" }),
    ];
    const days = groupByDay(rows);
    expect(days.map((d) => d.date)).toEqual(["2026-08-15", "2026-08-12", "2026-08-10"]);
  });

  it("preserves row order within a day (stable, not re-sorted)", () => {
    const rows = [
      mkRow({ id: "second", date: "2026-08-15", note: "b" } as never),
      mkRow({ id: "first", date: "2026-08-15", note: "a" } as never),
    ];
    const days = groupByDay(rows);
    expect(days).toHaveLength(1);
    expect(days[0]!.rows.map((r) => r.id)).toEqual(["second", "first"]);
  });

  it("excludes transfers entirely from the day total", () => {
    const rows = [
      mkRow({ id: "t1", date: "2026-08-15", type: "transfer", amount_sen: 50_000 }),
      mkRow({ id: "e1", date: "2026-08-15", type: "expense", amount_sen: 1_000 }),
    ];
    const days = groupByDay(rows);
    expect(days[0]!.total_sen).toBe(1_000);
    // transfer row still present in the day's rows
    expect(days[0]!.rows.map((r) => r.id)).toEqual(["t1", "e1"]);
  });

  it("nets reimbursements: amount_sen 30000, expected_back_sen 24000 contributes 6000", () => {
    const rows = [mkRow({ id: "e1", date: "2026-08-15", amount_sen: 30_000, expected_back_sen: 24_000 })];
    const days = groupByDay(rows);
    expect(days[0]!.total_sen).toBe(6_000);
  });

  it("includes income rows in the day's rows but excludes them from the total", () => {
    const rows = [
      mkRow({ id: "i1", date: "2026-08-15", type: "income", amount_sen: 5_000 }),
      mkRow({ id: "e1", date: "2026-08-15", type: "expense", amount_sen: 1_000 }),
    ];
    const days = groupByDay(rows);
    expect(days[0]!.total_sen).toBe(1_000);
    expect(days[0]!.rows).toHaveLength(2);
  });
});

describe("groupByDay — ruling 7 trend guard", () => {
  it("a non-MYR account's expense row lists but moves no day total", () => {
    const rows = [
      mkRow({ id: "myr", date: "2077-06-08", amount_sen: 2_000 }),
      mkRow({ id: "usd", date: "2077-06-08", amount_sen: 888, accountCurrency: "USD" }),
    ];
    const days = groupByDay(rows);
    expect(days).toHaveLength(1);
    expect(days[0]!.rows).toHaveLength(2); // still listed — never hidden
    expect(days[0]!.total_sen).toBe(2_000); // its sen are not MYR sen
  });
});
