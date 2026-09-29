import { describe, it, expect } from "vitest";
import { fundLabelFor } from "@/lib/tx-display";

/**
 * The fund label on transaction rows (owner's on-the-spot call at the Task-3
 * audit: "Yes, show the label"). An expense paid from a fund looked like any
 * other expense in Activity and Transactions — the tag was visible only after
 * opening the edit dialog, while the money it draws down is reported in three
 * other places. It is a STATE, so it survives tips off.
 *
 * Pure, and in this non-"use client" module, because BOTH list rows are
 * client components and the pages that feed them are server ones (finding
 * #20).
 */
const FUNDS = [
  { id: "f-emg", name: "Emergency fund" },
  { id: "f-car", name: "Car insurance & road tax" },
];

describe("fundLabelFor", () => {
  it("names the fund a tagged row was paid from", () => {
    expect(fundLabelFor("f-car", FUNDS)).toBe("from Car insurance & road tax");
  });

  it("still discloses the tag when the fund is not in the list", () => {
    // The row carries a fund_id the surface has no name for — a list rendered
    // without the funds prop. Saying "a fund" is honest; saying nothing would
    // hide the one thing this label exists to show.
    expect(fundLabelFor("f-gone", FUNDS)).toBe("from a fund");
    expect(fundLabelFor("f-car", [])).toBe("from a fund");
  });

  it("is absent on an untagged row", () => {
    expect(fundLabelFor(null, FUNDS)).toBeNull();
  });
});
