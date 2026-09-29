import { describe, it, expect } from "vitest";
import {
  billGroup,
  statusPill,
  cashflowGeometry,
  daysBetween,
  dueLabel,
  dueWord,
  formatDM,
  recordNowNotice,
  recordedTxHref,
  stepPath,
} from "@/lib/bills-display";

const TODAY = "2026-08-19";

describe("date labels", () => {
  it("formats a bill date the way v6 draws it", () => {
    expect(formatDM("2026-08-20")).toBe("20 Aug");
  });

  it("counts whole calendar days in both directions", () => {
    expect(daysBetween(TODAY, "2026-08-20")).toBe(1);
    expect(daysBetween(TODAY, "2026-08-19")).toBe(0);
    expect(daysBetween(TODAY, "2026-08-10")).toBe(-9);
    expect(daysBetween("2026-08-19", "2026-09-18")).toBe(30);
  });
});

describe("dueLabel", () => {
  it("warns inside the week and stays neutral beyond it", () => {
    expect(dueLabel("2026-08-19", TODAY)).toEqual({ text: "today", tone: "warn" });
    expect(dueLabel("2026-08-20", TODAY)).toEqual({ text: "in 1 day", tone: "warn" });
    expect(dueLabel("2026-08-26", TODAY)).toEqual({ text: "in 7 days", tone: "warn" });
    expect(dueLabel("2026-09-01", TODAY)).toEqual({ text: "in 13 days", tone: "normal" });
  });

  it("says how late an overdue bill is, in the critical tone", () => {
    expect(dueLabel("2026-08-18", TODAY)).toEqual({ text: "1 day overdue", tone: "critical" });
    expect(dueLabel("2026-08-10", TODAY)).toEqual({ text: "9 days overdue", tone: "critical" });
  });
});

describe("dueWord", () => {
  it("uses the mobile wording", () => {
    expect(dueWord("2026-08-19", TODAY)).toBe("today");
    expect(dueWord("2026-08-20", TODAY)).toBe("tomorrow");
    expect(dueWord("2026-09-01", TODAY)).toBe("in 13 days");
    expect(dueWord("2026-08-18", TODAY)).toBe("1 day overdue");
  });
});

describe("billGroup", () => {
  it("splits the table into Overdue / This week / Later", () => {
    expect(billGroup("2026-08-10", TODAY)).toBe("Overdue");
    expect(billGroup("2026-08-19", TODAY)).toBe("This week");
    expect(billGroup("2026-08-26", TODAY)).toBe("This week");
    expect(billGroup("2026-08-27", TODAY)).toBe("Later");
  });
});

describe("cashflowGeometry", () => {
  const series = [
    { date: "2026-08-19", balance_sen: 648_000 },
    { date: "2026-08-20", balance_sen: 627_000 },
    { date: "2026-09-18", balance_sen: 1_002_000 },
  ];

  it("spreads x by calendar position across the window", () => {
    const { points } = cashflowGeometry(series, "2026-08-19", "2026-09-18", 1000, 180);
    expect(points[0]!.x).toBe(0);
    expect(points[2]!.x).toBe(1000);
    // 1 day into a 30-day window.
    expect(Math.round(points[1]!.x)).toBe(33);
  });

  it("puts the highest balance at the top of the plot and the lowest at the bottom", () => {
    const { points } = cashflowGeometry(series, "2026-08-19", "2026-09-18", 1000, 180);
    expect(points[1]!.y).toBeGreaterThan(points[0]!.y);
    expect(points[2]!.y).toBeLessThan(points[0]!.y);
  });

  it("offers a zero baseline only when zero is inside the plotted range", () => {
    const positive = cashflowGeometry(series, "2026-08-19", "2026-09-18", 1000, 180);
    expect(positive.zeroY).toBeNull();

    const negative = cashflowGeometry(
      [
        { date: "2026-08-19", balance_sen: 10_000 },
        { date: "2026-09-18", balance_sen: -5_000 },
      ],
      "2026-08-19",
      "2026-09-18",
      1000,
      180,
    );
    expect(negative.zeroY).not.toBeNull();
  });

  it("survives a completely flat series", () => {
    const { points } = cashflowGeometry(
      [
        { date: "2026-08-19", balance_sen: 500_000 },
        { date: "2026-09-18", balance_sen: 500_000 },
      ],
      "2026-08-19",
      "2026-09-18",
      1000,
      180,
    );
    expect(points.every((p) => Number.isFinite(p.y))).toBe(true);
  });
});

describe("stepPath", () => {
  it("holds flat then steps on the day the money moves", () => {
    const { points } = cashflowGeometry(
      [
        { date: "2026-08-19", balance_sen: 100_000 },
        { date: "2026-08-29", balance_sen: 50_000 },
      ],
      "2026-08-19",
      "2026-09-18",
      1000,
      180,
    );
    expect(stepPath(points)).toBe("M0.0,14.0 H333.3 V166.0");
  });

  it("returns an empty path for an empty series", () => {
    expect(stepPath([])).toBe("");
  });
});

describe("statusPill", () => {
  const bill = { type: "expense" as const, variable: false, date: "2026-08-20" };

  it("says recorded and nothing else once the transaction exists", () => {
    expect(statusPill(bill, TODAY, "recorded")).toEqual({ text: "recorded \u2713", tone: "good" });
  });

  it("carries the due label and flags a variable amount", () => {
    expect(statusPill(bill, TODAY, "upcoming")).toEqual({ text: "in 1 day", tone: "warn" });
    expect(statusPill({ ...bill, variable: true }, TODAY, "upcoming")).toEqual({
      text: "in 1 day \u00b7 variable",
      tone: "warn",
    });
  });

  it("labels income, and says so loudly when the paycheque is late", () => {
    const income = { type: "income" as const, variable: false, date: "2026-08-28" };
    expect(statusPill(income, TODAY, "upcoming")).toEqual({ text: "income", tone: "good" });
    expect(statusPill({ ...income, date: "2026-08-15" }, TODAY, "overdue")).toEqual({
      text: "income \u00b7 4 days overdue",
      tone: "critical",
    });
  });
});

/**
 * Q11b: `Record now` on an occurrence the daily job already materialised is
 * `performUpsert`'s 23505 no-op (ruling 11's `created: false`). A bare
 * success would hide that the edited amount was NOT applied — rule 15 — so
 * the form shows a notice that names the entry to edit instead.
 */
describe("recordNowNotice (Q11b)", () => {
  const id = "3b1f0d7e-6c2a-5e4b-9a8d-1f2e3d4c5b6a";

  it("is null when the write actually happened", () => {
    expect(recordNowNotice({ ok: true, id, created: true }, "2077-09-08")).toBeNull();
  });

  it("is null on a failure — the error path already speaks for itself", () => {
    expect(recordNowNotice({ ok: false, error: "nope" }, "2077-09-08")).toBeNull();
  });

  it("says it is already recorded and links to the existing entry on the no-op branch (Plan 9: the helper cannot see who recorded it)", () => {
    expect(recordNowNotice({ ok: true, id, created: false }, "2077-09-08")).toEqual({
      text: "Already recorded — edit that entry to change the amount",
      href: `/transactions?month=2077-09#${id}`,
    });
  });

  it("recordedTxHref lands on the month the Transactions page already understands, at the row", () => {
    expect(recordedTxHref(id, "2077-12-31")).toBe(`/transactions?month=2077-12#${id}`);
  });
});
