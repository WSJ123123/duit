import { describe, it, expect } from "vitest";
import { planReconciliation } from "@/lib/reconcile";

describe("planReconciliation", () => {
  it("stated above current plans an income of the difference", () => {
    expect(planReconciliation(24_750, 25_264)).toEqual({
      kind: "income",
      amount_sen: 514,
    });
  });

  it("stated below current plans an expense of the difference", () => {
    expect(planReconciliation(24_750, 24_350)).toEqual({
      kind: "expense",
      amount_sen: 400,
    });
  });

  it("equal balances plan nothing", () => {
    expect(planReconciliation(24_750, 24_750)).toEqual({ kind: "none" });
  });

  it("throws via assertSen when the difference is not a safe integer", () => {
    expect(() => planReconciliation(0, Number.MAX_SAFE_INTEGER + 2)).toThrow(
      /invalid sen amount/,
    );
  });
});
