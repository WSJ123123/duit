import { describe, it, expect } from "vitest";
import {
  categoryPathLabels,
  historyCountsLine,
  importedSubLine,
  lastUsedLine,
  preambleLine,
  splitBatchLabel,
  isTickable,
  nothingNewLine,
  signedText,
  skipBreakdown,
  skippedLine,
  withFinishedBatch,
} from "@/lib/import-display";

// Plan 9 Task 4 (R5): the limits and `oversizeError` moved to
// src/lib/import-limits.ts, with their test.

describe("preambleLine — ruling 7's disclosure, as data (Plan 9 Task 4)", () => {
  it("names the count above the header, singular and plural, and is null at 0", () => {
    expect(preambleLine(3)).toBe("3 preamble lines skipped above the header");
    expect(preambleLine(1)).toBe("1 preamble line skipped above the header");
    expect(preambleLine(0)).toBeNull();
  });
});

describe("lastUsedLine — v7's `last used for <account> · <date>` from saved_at (ruling 8h)", () => {
  it("adds the date when the stored mapping carries saved_at, and not for a Plan-8-shaped one", () => {
    expect(lastUsedLine("Maybank", "2077-09-21T03:10:00+00:00")).toBe("last used for Maybank · 21 Sep 2077");
    expect(lastUsedLine("Maybank", undefined)).toBe("last used for Maybank");
  });
});

describe("withFinishedBatch — the Done card lists the batch just finished at once (ruling 8g)", () => {
  const row = (id: string, preamble_lines?: number) => ({ id, filename: `${id}.csv`, ...(preamble_lines === undefined ? {} : { preamble_lines }) });
  it("puts the finished batch first when the fetched history does not hold it yet, and never twice", () => {
    expect(withFinishedBatch([row("b1")], row("b2", 3))).toEqual([row("b2", 3), row("b1")]);
    expect(withFinishedBatch([], row("b2", 3))).toEqual([row("b2", 3)]);
    expect(withFinishedBatch([row("b2", 3), row("b1")], row("b2", 3))).toEqual([row("b2", 3), row("b1")]);
  });

  it("once the refresh holds the batch, the fetched row wins but keeps the preamble count only the wizard knows", () => {
    const fetched = { id: "b2", filename: "b2.csv", touched_count: 1 };
    expect(withFinishedBatch([fetched, row("b1")], { id: "b2", filename: "b2.csv", touched_count: 0, preamble_lines: 3 })).toEqual([
      { ...fetched, preamble_lines: 3 },
      row("b1"),
    ]);
  });
});

type State = "new" | "probable_duplicate" | "already_imported" | "unparseable";
let seq = 0;
const make = (state: State, n: number) =>
  Array.from({ length: n }, () => ({ id: state === "unparseable" ? null : `row-${seq++}`, state }));
const idsOf = (rows: Array<{ id: string | null }>) => rows.flatMap((r) => (r.id === null ? [] : [r.id]));

describe("skipBreakdown — rows = imported + skipped, every skipped row named honestly (I3)", () => {
  it("reconciles the mockup's figures: 143 = 128 + 15 and 15 = 9 + 4 + 2", () => {
    const fresh = make("new", 128);
    const rows = [...fresh, ...make("probable_duplicate", 9), ...make("already_imported", 4), ...make("unparseable", 2)];
    const b = skipBreakdown(rows, new Set(idsOf(fresh)), 128);
    expect(b).toEqual({ skipped: 15, probably_logged: 9, already_imported: 4, left_out: 0, unparseable: 2 });
    expect(rows.length).toBe(128 + b.skipped);
    expect(skippedLine(b)).toBe("15 skipped (9 probably logged · 4 already imported · 2 unparseable)");
  });

  it("an unticked NEW row is left out — never 'already imported'", () => {
    const fresh = make("new", 5);
    const included = new Set(idsOf(fresh).slice(0, 4));
    const b = skipBreakdown(fresh, included, 4);
    expect(b).toEqual({ skipped: 1, probably_logged: 0, already_imported: 0, left_out: 1, unparseable: 0 });
    expect(skippedLine(b)).toBe("1 skipped (1 left out)");
  });

  it("a ticked probable duplicate that was written is imported, not skipped", () => {
    const rows = [...make("new", 2), ...make("probable_duplicate", 2)];
    const ids = idsOf(rows);
    const b = skipBreakdown(rows, new Set([ids[0]!, ids[1]!, ids[2]!]), 3);
    expect(b).toEqual({ skipped: 1, probably_logged: 1, already_imported: 0, left_out: 0, unparseable: 0 });
  });

  it("a write-path 23505 skip (ticked, but the table did not take it) counts as already imported", () => {
    const fresh = make("new", 3);
    const b = skipBreakdown(fresh, new Set(idsOf(fresh)), 2);
    expect(b).toEqual({ skipped: 1, probably_logged: 0, already_imported: 1, left_out: 0, unparseable: 0 });
  });

  it("names all four buckets in the mockup's order, and none when nothing was skipped", () => {
    const fresh = make("new", 3);
    const rows = [...fresh, ...make("probable_duplicate", 1), ...make("already_imported", 1), ...make("unparseable", 1)];
    const b = skipBreakdown(rows, new Set(idsOf(fresh).slice(0, 2)), 2);
    expect(skippedLine(b)).toBe("4 skipped (1 probably logged · 1 already imported · 1 left out · 1 unparseable)");
    expect(skippedLine(skipBreakdown(fresh, new Set(idsOf(fresh)), 3))).toBe("0 skipped");
  });
});

describe("historyCountsLine — the ledger row reconciles from the stored counters alone", () => {
  it("prints skipped as rows − imported, so the unparseable row is inside it", () => {
    expect(historyCountsLine({ row_count: 6, imported_count: 4, needs_review_count: 1 })).toBe("6 rows · 4 imported · 2 skipped · 1 review");
    expect(historyCountsLine({ row_count: 143, imported_count: 128, needs_review_count: 31 })).toBe("143 rows · 128 imported · 15 skipped · 31 review");
  });
});

describe("isTickable — which preview rows the owner may include (m13)", () => {
  it("new and probably-logged rows only: an already-imported row would be a 23505 skip, an unparseable one has no id", () => {
    expect(isTickable("new")).toBe(true);
    expect(isTickable("probable_duplicate")).toBe(true);
    expect(isTickable("already_imported")).toBe(false);
    expect(isTickable("unparseable")).toBe(false);
  });
});

describe("signedText", () => {
  it("signs integer sen with a true minus", () => {
    expect(signedText(-1_800)).toBe("−RM 18.00");
    expect(signedText(350_000)).toBe("+RM 3,500.00");
  });
});

describe("splitBatchLabel — the `batch #n` inside an undo notice, so it can be a link (m7, ruling 17)", () => {
  it("splits around the label, and is null when the message names no batch", () => {
    expect(splitBatchLabel("Nothing to undo — these rows were saved by batch #12")).toEqual({
      before: "Nothing to undo — these rows were saved by ",
      label: "batch #12",
      after: "",
    });
    expect(splitBatchLabel("Nothing to undo — this batch saved no rows")).toBeNull();
  });
});

describe("importedSubLine — the already-imported row's sub-line (m8, mockup v7 §12)", () => {
  it("names the day and the batch when the owning batch is known", () => {
    expect(importedSubLine({ created_at: "2077-08-24T03:10:00+00:00", batch_no: 6 }, "SALARY")).toBe("imported 24 Aug (batch #6)");
  });
  it("falls back to the existing row's note when it is not (a row no batch tagged)", () => {
    expect(importedSubLine(undefined, "earlier import")).toBe("imported earlier · “earlier import”");
    expect(importedSubLine(undefined, "")).toBe("imported earlier · “(no note)”");
  });
});

describe("categoryPathLabels — `Parent › Child` (m8)", () => {
  it("prefixes a child with its parent and leaves a top-level category bare", () => {
    expect(
      categoryPathLabels([
        { id: "t", name: "Transport", parent_id: null },
        { id: "g", name: "Grab", parent_id: "t" },
        { id: "o", name: "Orphan", parent_id: "missing" },
      ]),
    ).toEqual({ t: "Transport", g: "Transport › Grab", o: "Orphan" });
  });
});

describe("nothingNewLine — why Import is disabled on a same-file, same-mapping preview (m-3)", () => {
  it("names the batch when every parseable row is already imported", () => {
    expect(nothingNewLine([...make("already_imported", 3), ...make("unparseable", 1)], 6)).toBe(
      "Nothing new to import — every row is already in batch #6",
    );
  });

  it("is null while anything can still be ticked, or nothing parsed", () => {
    expect(nothingNewLine([...make("already_imported", 3), ...make("new", 1)], 6)).toBeNull();
    expect(nothingNewLine([...make("already_imported", 3), ...make("probable_duplicate", 1)], 6)).toBeNull();
    expect(nothingNewLine(make("unparseable", 2), 6)).toBeNull();
  });
});
