import { describe, it, expect } from "vitest";
import {
  withOptimistic,
  bumpTodayTotal,
  applyPatch,
  removeRow,
  type OptimisticEntry,
  type RowPatch,
} from "@/lib/optimistic-entry";

interface FakeRow {
  id: string;
  label: string;
}

function entry(over: Partial<OptimisticEntry> = {}): OptimisticEntry {
  return {
    clientId: "client-1",
    label: "Nasi lemak",
    amount_sen: 1250,
    isExpense: true,
    pending: true,
    ...over,
  };
}

describe("withOptimistic", () => {
  it("prepends the optimistic entry ahead of the existing recents", () => {
    const recents: FakeRow[] = [{ id: "a", label: "Existing" }];
    const result = withOptimistic(recents, entry());
    expect(result).toEqual([entry(), { id: "a", label: "Existing" }]);
  });

  it("dedupes a retry with the same clientId — chaining calls yields one optimistic row", () => {
    const recents: FakeRow[] = [{ id: "a", label: "Existing" }];
    const once = withOptimistic(recents, entry());
    const twice = withOptimistic(once, entry());
    const optimisticCount = twice.filter(
      (r) => "clientId" in r && r.clientId === "client-1",
    ).length;
    expect(optimisticCount).toBe(1);
    expect(twice).toEqual([entry(), { id: "a", label: "Existing" }]);
  });

  it("dedupes against a real row that already landed under the same id (post-flush retry)", () => {
    const recents: FakeRow[] = [{ id: "client-1", label: "Already synced" }, { id: "b", label: "Other" }];
    const result = withOptimistic(recents, entry());
    expect(result).toEqual([entry(), { id: "b", label: "Other" }]);
  });

  it("does not mutate its inputs", () => {
    const recents: FakeRow[] = [{ id: "a", label: "Existing" }];
    const recentsSnapshot = JSON.parse(JSON.stringify(recents));
    const e = entry();
    const entrySnapshot = JSON.parse(JSON.stringify(e));

    withOptimistic(recents, e);

    expect(recents).toEqual(recentsSnapshot);
    expect(e).toEqual(entrySnapshot);
  });
});

describe("bumpTodayTotal", () => {
  it("adds an expense entry's amount to the running total", () => {
    expect(bumpTodayTotal(25900, entry({ amount_sen: 1800, isExpense: true }))).toBe(27700);
  });

  it("leaves the total untouched for an income entry", () => {
    expect(bumpTodayTotal(25900, entry({ amount_sen: 1800, isExpense: false }))).toBe(25900);
  });

  it("is pure — does not mutate the entry", () => {
    const e = entry({ amount_sen: 500, isExpense: true });
    const snapshot = JSON.parse(JSON.stringify(e));
    bumpTodayTotal(1000, e);
    expect(e).toEqual(snapshot);
  });
});

interface FakeTxRow {
  id: string;
  amount_sen: number;
  note: string;
  category_id: string | null;
  date: string;
  fund_id: string | null;
}

function rows(): FakeTxRow[] {
  return [
    { id: "a", amount_sen: 1800, note: "Nasi lemak", category_id: "cat-food", date: "2026-08-15", fund_id: null },
    { id: "b", amount_sen: 500, note: "Parking", category_id: "cat-transport", date: "2026-08-16", fund_id: "fund-1" },
  ];
}

describe("applyPatch", () => {
  it("patches only the target row", () => {
    const result = applyPatch(rows(), { id: "b", amount_sen: 650 });
    expect(result.find((r) => r.id === "a")).toEqual(rows()[0]);
    expect(result.find((r) => r.id === "b")?.amount_sen).toBe(650);
  });

  it("patches only the fields provided, leaving the rest of the row untouched", () => {
    const result = applyPatch(rows(), { id: "a", note: "Nasi lemak (updated)" });
    const patched = result.find((r) => r.id === "a")!;
    expect(patched.note).toBe("Nasi lemak (updated)");
    expect(patched.amount_sen).toBe(1800);
    expect(patched.category_id).toBe("cat-food");
    expect(patched.date).toBe("2026-08-15");
  });

  it("treats an explicit null as a provided value — clears the category", () => {
    const patch: RowPatch = { id: "a", category_id: null };
    const result = applyPatch(rows(), patch);
    expect(result.find((r) => r.id === "a")?.category_id).toBeNull();
  });

  /**
   * Plan 7 ruling 7: the optimistic overlay is an EDIT SURFACE — a re-edit
   * inside the sub-second window before the server refresh lands builds its
   * form from the patched row. If the patch cannot carry `fund_id`, that
   * second save writes the STALE tag and silently moves a fund balance, which
   * is the one thing every other layer of this feature was shaped to prevent.
   */
  it("carries a fund tag, in both directions", () => {
    const tagged = applyPatch(rows(), { id: "a", fund_id: "fund-9" });
    expect(tagged.find((r) => r.id === "a")?.fund_id).toBe("fund-9");

    const cleared: RowPatch = { id: "b", fund_id: null };
    expect(applyPatch(rows(), cleared).find((r) => r.id === "b")?.fund_id).toBeNull();
  });

  it("is a no-op for an unknown id", () => {
    const result = applyPatch(rows(), { id: "unknown", amount_sen: 999 });
    expect(result).toEqual(rows());
  });

  it("is pure — does not mutate its inputs and returns a new array", () => {
    const original = rows();
    const snapshot = JSON.parse(JSON.stringify(original));
    const patch: RowPatch = { id: "a", amount_sen: 200 };
    const patchSnapshot = JSON.parse(JSON.stringify(patch));

    const result = applyPatch(original, patch);

    expect(original).toEqual(snapshot);
    expect(patch).toEqual(patchSnapshot);
    expect(result).not.toBe(original);
  });
});

describe("removeRow", () => {
  it("removes exactly the row matching the id", () => {
    const result = removeRow(rows(), "a");
    expect(result).toEqual([rows()[1]]);
  });

  it("is a no-op for an unknown id", () => {
    const result = removeRow(rows(), "unknown");
    expect(result).toEqual(rows());
  });

  it("is pure — does not mutate its input and returns a new array", () => {
    const original = rows();
    const snapshot = JSON.parse(JSON.stringify(original));

    const result = removeRow(original, "a");

    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
  });
});
