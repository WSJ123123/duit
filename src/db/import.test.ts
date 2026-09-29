import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { previewImport } from "@/db/import/preview";
import { beginImport, commitImportChunk } from "@/db/import/commit";
import { undoImport } from "@/db/import/undo";
import { listImportBatches } from "@/db/import/history";
import { hashContent, paidImportedTransactionIds, parseImportFile, rawLines, readImportCsv, touchedRows } from "@/db/import/shared";
import { fetchAllPages, IN_CHUNK } from "@/db/paging";
import { getImportMappings } from "@/db/settings";
import { importId, type ImportMapping } from "@/lib/import";
import { IMPORT_MAX_ROWS } from "@/lib/import-limits";

const fixtureText = (name: string): string => readFileSync(path.join(__dirname, "..", "lib", "__fixtures__", "csv", name), "utf8");

/**
 * Plan 8 Task 6: the import's DB layer (rulings 11–13, 16–17). 2077 fixture
 * dates; every fixture name is suite-unique. Every write goes through
 * `performUpsert` — the assertions below read `source = "import"` and the
 * computed ids straight off the rows.
 */

let a: SupabaseClient;
let b: SupabaseClient;
let bank: string;
let usd: string;
let archived: string;
let food: string;
let transport: string;

const PAIR: ImportMapping = {
  date_col: 0,
  date_format: "DD/MM/YYYY",
  description_col: 1,
  amount: { kind: "pair", debit_col: 2, credit_col: 3 },
  note_col: null,
};

/** Six data rows: two identical kopi (ordinals 0/1), a salary credit, a Grab
 *  ride, one unparseable line (31 Feb), and a DuitNow to the owner's own TnG
 *  account (the transfer tell). */
const FILE = [
  "Date,Description,Debit,Credit",
  "05/03/2077,KOPI CORNER,4.50,",
  "05/03/2077,KOPI CORNER,4.50,",
  "06/03/2077,SALARY CREDIT ACME,,3500.00",
  "07/03/2077,GRAB RIDE KL,18.00,",
  "31/02/2077,STATEMENT BALANCE B/F,,,",
  "08/03/2077,DUITNOW TO TNG EWALLET,100.00,",
].join("\n");

const allIncluded = (rows: Array<{ id: string | null }>) =>
  rows.flatMap((r) => (r.id === null ? [] : [{ id: r.id, include: true }]));

async function rowsOf(client: SupabaseClient, batchId: string) {
  const res = await client
    .from("transactions")
    .select("id, type, amount_sen, category_id, date, note, source, needs_review, import_batch_id, fund_id, recurring_rule_id, created_at, updated_at")
    .eq("import_batch_id", batchId)
    .order("date")
    .order("id");
  if (res.error) throw res.error;
  return res.data;
}

async function batchRow(client: SupabaseClient, batchId: string) {
  const res = await client.from("import_batches").select().eq("id", batchId).single();
  if (res.error) throw res.error;
  return res.data;
}

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  bank = (await a.from("accounts").insert({ name: "Import Bank", type: "bank" }).select().single()).data!.id;
  // The transfer tell: a description naming this account is hinted.
  const tng = await a.from("accounts").insert({ name: "TnG eWallet", type: "ewallet" });
  if (tng.error) throw tng.error;
  usd = (await a.from("accounts").insert({ name: "USD broker", type: "brokerage", currency: "USD" }).select().single()).data!.id;
  archived = (await a.from("accounts").insert({ name: "Old bank", type: "bank", archived: true }).select().single()).data!.id;
  food = (await a.from("categories").insert({ name: "Food", kind: "expense" }).select().single()).data!.id;
  transport = (await a.from("categories").insert({ name: "Transport", kind: "expense" }).select().single()).data!.id;
  const aliases = await a.from("parser_aliases").insert([
    { phrase: "kopi", category_id: food },
    { phrase: "grab", category_id: transport },
  ]);
  if (aliases.error) throw aliases.error;
}, 30_000);

describe("previewImport — validation (rulings 11, 16, 18)", () => {
  it("rejects a non-MYR account, naming the currency", async () => {
    const r = await previewImport(a, { account_id: usd, filename: "usd.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("USD");
  });

  it("rejects an archived account", async () => {
    const r = await previewImport(a, { account_id: archived, filename: "old.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/archived/);
  });

  it("refuses a file over the row cap, naming the limit", async () => {
    const big = ["Date,Description,Debit,Credit"]
      .concat(Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `0${(i % 9) + 1}/03/2077,ROW ${i},1.00,`))
      .join("\n");
    const r = await previewImport(a, { account_id: bank, filename: "big.csv", text: big, mapping: PAIR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(IMPORT_MAX_ROWS));
  });

  it("refuses a file over 1 MB, naming the limit", async () => {
    const huge = "Date,Description,Debit,Credit\n" + "x".repeat(1_100_000);
    const r = await previewImport(a, { account_id: bank, filename: "huge.csv", text: huge, mapping: PAIR });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("1 MB");
  });

  it("stores the mapping for the account (and only the mapping)", async () => {
    const r = await previewImport(a, { account_id: bank, filename: "map.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(true);
    const mappings = await getImportMappings(a);
    // Ruling 8h: the save stamps `saved_at` for v7's `last used … <date>`.
    expect(mappings[bank]).toEqual({ ...PAIR, saved_at: expect.any(String) });
    const batches = await a.from("import_batches").select("id");
    expect(batches.data).toEqual([]); // preview never opens a batch
  });
});

describe("previewImport — classification off the paged range read (rulings 12, 13, 16)", () => {
  it("flags a ±1-day same-amount row as probable_duplicate and leaves ±2 alone", async () => {
    // Existing: RM 18.00 expense on 8 Mar (Grab is 7 Mar → 1 day) and a
    // RM 4.50 expense on 3 Mar (kopi is 5 Mar → 2 days, not a match).
    const seed = await a.from("transactions").insert([
      { type: "expense", amount_sen: 1_800, account_id: bank, date: "2077-03-08", note: "grab 18" },
      { type: "expense", amount_sen: 450, account_id: bank, date: "2077-03-03", note: "kopi 4.50" },
    ]);
    if (seed.error) throw seed.error;
    const r = await previewImport(a, { account_id: bank, filename: "dup.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const grab = r.rows.find((x) => x.description === "GRAB RIDE KL")!;
    expect(grab.state).toBe("probable_duplicate");
    expect(grab.default_include).toBe(false);
    expect(grab.duplicate_of?.note).toBe("grab 18");
    const kopi = r.rows.filter((x) => x.description === "KOPI CORNER");
    expect(kopi.map((k) => k.state)).toEqual(["new", "new"]);
    expect(kopi[0]!.category_id).toBe(food); // the alias, through the Quick Add parser
    const bad = r.rows.find((x) => x.state === "unparseable")!;
    expect(bad.id).toBeNull();
    expect(bad.error).toBe("bad date");
    const duitnow = r.rows.find((x) => x.description === "DUITNOW TO TNG EWALLET")!;
    expect(duitnow.transfer_hint).toBe(true);
    expect(duitnow.needs_review).toBe(true);
    expect(r.summary).toEqual({ row_count: 6, included_count: 4, skipped_count: 1, needs_review_count: 2, unparseable_count: 1 });
    expect(r.same_file).toBeNull();
    expect(r.range).toEqual({ min: "2077-03-05", max: "2077-03-08" });
  });

  it("discloses reconcile adjustments inside the file's range with their count and net sum", async () => {
    const seed = await a.from("transactions").insert([
      { type: "income", amount_sen: 31_240, account_id: bank, date: "2077-03-06", note: "Reconcile", source: "reconcile" },
      { type: "expense", amount_sen: 1_000, account_id: bank, date: "2077-03-07", note: "Reconcile", source: "reconcile" },
      // Outside the range: not counted.
      { type: "income", amount_sen: 99_999, account_id: bank, date: "2077-03-20", note: "Reconcile", source: "reconcile" },
    ]);
    if (seed.error) throw seed.error;
    const r = await previewImport(a, { account_id: bank, filename: "rec.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reconcile).toEqual({ count: 2, net_sen: 30_240 });
  });

  it("counts a logged transfer as a probable duplicate: out of the target matches the debit, into it matches the credit", async () => {
    const target = (await a.from("accounts").insert({ name: "Import transfer bank", type: "bank" }).select().single()).data!.id;
    const other = (await a.from("accounts").insert({ name: "Import transfer savings", type: "bank" }).select().single()).data!.id;
    const seed = await a
      .from("transactions")
      .insert([
        // OUT of the target on 7 Mar; the statement's RM 100.00 debit is 8 Mar.
        { type: "transfer", amount_sen: 10_000, account_id: target, transfer_account_id: other, date: "2077-03-07", note: "tng top-up" },
        // INTO the target on 6 Mar: the statement's RM 3,500.00 credit.
        { type: "transfer", amount_sen: 350_000, account_id: other, transfer_account_id: target, date: "2077-03-06", note: "from savings" },
        // INTO the target for RM 18.00: the wrong sign for the Grab debit.
        { type: "transfer", amount_sen: 1_800, account_id: other, transfer_account_id: target, date: "2077-03-07", note: "refund leg" },
      ])
      .select("id, note");
    if (seed.error) throw seed.error;
    // A reconcile adjustment on the OTHER account is not the target's.
    const rec = await a
      .from("transactions")
      .insert({ type: "income", amount_sen: 5, account_id: other, date: "2077-03-06", note: "Reconcile", source: "reconcile" });
    if (rec.error) throw rec.error;
    const idOf = (note: string) => seed.data.find((t) => t.note === note)!.id;
    const r = await previewImport(a, { account_id: target, filename: "transfers.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const duitnow = r.rows.find((x) => x.description === "DUITNOW TO TNG EWALLET")!;
    expect(duitnow).toMatchObject({ state: "probable_duplicate", default_include: false });
    expect(duitnow.duplicate_of).toEqual({ id: idOf("tng top-up"), date: "2077-03-07", note: "tng top-up", amount_sen: 10_000, type: "transfer" });
    const salary = r.rows.find((x) => x.description === "SALARY CREDIT ACME")!;
    expect(salary).toMatchObject({ state: "probable_duplicate", default_include: false });
    expect(salary.duplicate_of?.id).toBe(idOf("from savings"));
    expect(r.rows.find((x) => x.description === "GRAB RIDE KL")!.state).toBe("new");
    expect(r.reconcile).toBeNull();
  });


  it("derives already_imported from the PAGED range read (an exact-id row past the 1000-row cap)", async () => {
    const acct = (await a.from("accounts").insert({ name: "Import paging bank", type: "bank" }).select().single()).data!.id;
    // 1,100 filler rows sort before the exact hit on (date, id); an unpaged
    // read returns the first 1000 and never sees it.
    const filler = Array.from({ length: 1100 }, () => ({
      type: "income", amount_sen: 7, account_id: acct, date: "2077-03-04", note: "filler",
    }));
    const f = await a.from("transactions").insert(filler);
    if (f.error) throw f.error;
    const exactId = importId(acct, { date: "2077-03-08", signed_amount_sen: -10_000, description: "DUITNOW TO TNG EWALLET" }, 0);
    const hit = await a.from("transactions").insert({
      id: exactId, type: "expense", amount_sen: 10_000, account_id: acct, date: "2077-03-08", note: "earlier import", source: "import",
    });
    if (hit.error) throw hit.error;
    const r = await previewImport(a, { account_id: acct, filename: "paged.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const duitnow = r.rows.find((x) => x.description === "DUITNOW TO TNG EWALLET")!;
    expect(duitnow.state).toBe("already_imported");
    expect(duitnow.duplicate_of?.id).toBe(exactId);
  }, 60_000);
});

describe("beginImport + commitImportChunk (rulings 11, 12, 13)", () => {
  let acct: string;
  let text: string;
  let batch1: string;

  beforeAll(async () => {
    acct = (await a.from("accounts").insert({ name: "Import commit bank", type: "bank" }).select().single()).data!.id;
    text = FILE;
  });

  it("writes the included rows through performUpsert with source 'import', the batch tag and the computed ids", async () => {
    const p = await previewImport(a, { account_id: acct, filename: "commit.csv", text, mapping: PAIR });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "commit.csv", content_sha256: p.content_sha256, row_count: p.summary.row_count });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    batch1 = begun.batch_id;
    const choices = allIncluded(p.rows);
    const c = await commitImportChunk(a, { batch_id: batch1, text, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.saved_in_chunk).toBe(5);
    expect(c.skipped_in_chunk).toBe(0);
    expect(c.done).toBe(true);
    if (c.done) {
      expect(c.imported_count).toBe(5);
      expect(c.needs_review_count).toBe(2); // salary (no category) + the DuitNow transfer hint
      expect(c.skipped_count).toBe(0);
      expect(c.unparseable_count).toBe(1);
      expect(c.batch_no).toBe(1);
    }
    const rows = await rowsOf(a, batch1);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["import"]));
    const ids = new Set(rows.map((r) => r.id));
    for (const row of p.rows) if (row.id !== null) expect(ids.has(row.id)).toBe(true);
    const kopi = rows.filter((r) => r.note === "KOPI CORNER");
    expect(kopi.map((r) => r.amount_sen)).toEqual([450, 450]);
    expect(kopi.map((r) => r.category_id)).toEqual([food, food]);
    const salary = rows.find((r) => r.note === "SALARY CREDIT ACME")!;
    expect(salary.type).toBe("income");
    expect(salary.amount_sen).toBe(350_000);
    // Rule 17 (ruling 17's precondition): fund and recurring tags never
    // arrive through an import.
    expect(rows.every((r) => r.fund_id === null && r.recurring_rule_id === null)).toBe(true);
    // Ruling 17's equality must be REACHABLE: a fresh performUpsert row has
    // updated_at = created_at.
    expect(rows.every((r) => r.updated_at === r.created_at)).toBe(true);
    const stored = await batchRow(a, batch1);
    expect(stored.skipped_count).toBe(0);
    expect(stored.needs_review_count).toBe(2);
    expect(stored.unparseable_count).toBe(1);
  });

  it("the same file committed again writes nothing: rows keep the FIRST batch's tag and updated_at; skips come from created === false", async () => {
    const before = await rowsOf(a, batch1);
    const p = await previewImport(a, { account_id: acct, filename: "commit.csv", text, mapping: PAIR });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // The preview already says so — every parseable row is already imported.
    expect(p.rows.filter((r) => r.id !== null).every((r) => r.state === "already_imported")).toBe(true);
    // Ruling 12c: the same hash names the earlier batch.
    expect(p.same_file?.batch_id).toBe(batch1);
    expect(p.same_file?.batch_no).toBe(1);
    expect(p.same_file?.imported_count).toBe(5);
    // m8: which batch wrote each already-imported row — off the SAME read.
    const hits = p.rows.flatMap((r) => (r.duplicate_of ? [r.duplicate_of.id] : []));
    expect(hits).toHaveLength(5);
    expect(hits.map((id) => p.imported_batch[id])).toEqual(Array(5).fill(batch1));
    // Continue anyway, forcing every row in: the write path's 23505 branch is
    // what skips them, pinned here rather than on the classifier.
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "commit.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const c = await commitImportChunk(a, { batch_id: begun.batch_id, text, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 6 } });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.saved_in_chunk).toBe(0);
    expect(c.skipped_in_chunk).toBe(5);
    expect(c.done).toBe(true);
    if (c.done) {
      expect(c.imported_count).toBe(0);
      expect(c.skipped_count).toBe(5);
      expect(c.batch_no).toBe(2);
    }
    const after = await rowsOf(a, batch1);
    expect(after).toEqual(before);
    expect(await rowsOf(a, begun.batch_id)).toEqual([]);

    // Ruling 17: undo on the second batch owns nothing — undone_at is set
    // either way, the count and message carry the truth.
    const u = await undoImport(a, begun.batch_id);
    expect(u).toEqual({ ok: true, deleted: 0, message: "Nothing to undo — these rows were saved by batch #1", owner_batch_id: batch1 });
    expect((await batchRow(a, begun.batch_id)).undone_at).not.toBeNull();
    expect(await rowsOf(a, batch1)).toEqual(before);
  });

  it("rejects an unknown id in choices and a batch that is not this file", async () => {
    // A distinct file (never committed), so the row-less undo below reads as
    // an abandoned wizard rather than a re-import of batch 1's file.
    const text2 = text + "\n09/03/2077,EXTRA,1.00,";
    const p = await previewImport(a, { account_id: acct, filename: "x.csv", text: text2, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "x.csv", content_sha256: p.content_sha256, row_count: 7 });
    if (!begun.ok) throw new Error(begun.error);
    const bad = await commitImportChunk(a, {
      batch_id: begun.batch_id, text: text2, mapping: PAIR,
      choices: [{ id: "00000000-0000-0000-0000-000000000000", include: true }], chunk: { from: 0, to: 7 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.partial).toBe(false);
    const other = await commitImportChunk(a, {
      batch_id: begun.batch_id, text, mapping: PAIR, choices: [], chunk: { from: 0, to: 6 },
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toMatch(/file/);
    expect(await rowsOf(a, begun.batch_id)).toEqual([]);
    // A row-less abandoned batch closes the same way (an `Undo` reads `Discard`).
    const u = await undoImport(a, begun.batch_id);
    expect(u).toEqual({ ok: true, deleted: 0, message: "Nothing to undo — this batch owns no rows" });
  });

  it("user B cannot commit into or undo A's batch", async () => {
    const c = await commitImportChunk(b, { batch_id: batch1, text, mapping: PAIR, choices: [], chunk: { from: 0, to: 6 } });
    expect(c.ok).toBe(false);
    const u = await undoImport(b, batch1);
    expect(u.ok).toBe(false);
    expect((await batchRow(a, batch1)).undone_at).toBeNull();
  });
});

describe("rule 16 on the write path: only a live MYR account takes an import (risk 12)", () => {
  const kopiChoice = (accountId: string) => [
    { id: importId(accountId, { date: "2077-03-05", signed_amount_sen: -450, description: "KOPI CORNER" }, 0), include: true },
  ];
  const txCount = async (accountId: string) => {
    const res = await a.from("transactions").select("id", { count: "exact", head: true }).eq("account_id", accountId);
    if (res.error) throw res.error;
    return res.count ?? 0;
  };

  it("beginImport refuses the USD and the archived account and opens no batch", async () => {
    for (const [id, word] of [[usd, "USD"], [archived, "archived"]] as const) {
      const r = await beginImport(a, { id: randomUUID(), account_id: id, filename: "refused.csv", content_sha256: hashContent(FILE), row_count: 6 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(word);
      const batches = await a.from("import_batches").select("id").eq("account_id", id);
      expect(batches.data).toEqual([]);
    }
  });

  it("a batch row forged directly on the USD account cannot be committed into", async () => {
    const forged = await a
      .from("import_batches")
      .insert({ account_id: usd, filename: "forged.csv", content_sha256: hashContent(FILE), row_count: 6 })
      .select("id")
      .single();
    if (forged.error) throw forged.error;
    const c = await commitImportChunk(a, { batch_id: forged.data.id, text: FILE, mapping: PAIR, choices: kopiChoice(usd), chunk: { from: 0, to: 6 } });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.partial).toBe(false);
      expect(c.error).toContain("USD");
    }
    expect(await txCount(usd)).toBe(0);
  });

  it("an account archived between begin and commit refuses the commit", async () => {
    const acct = (await a.from("accounts").insert({ name: "Import soon-archived bank", type: "bank" }).select().single()).data!.id;
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "late.csv", content_sha256: hashContent(FILE), row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const arch = await a.from("accounts").update({ archived: true }).eq("id", acct);
    if (arch.error) throw arch.error;
    const c = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices: kopiChoice(acct), chunk: { from: 0, to: 6 } });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.partial).toBe(false);
      expect(c.error).toMatch(/archived/);
    }
    expect(await txCount(acct)).toBe(0);
  });
});

describe("partial failure, replay and chunk order-independence (rulings 11, 13)", () => {
  let acct: string;

  beforeAll(async () => {
    acct = (await a.from("accounts").insert({ name: "Import chunk bank", type: "bank" }).select().single()).data!.id;
  });

  /** A client whose Nth `transactions` insert fails hard — the killed-request case. */
  function failingOnInsert(client: SupabaseClient, failAt: number): SupabaseClient {
    let inserts = 0;
    return new Proxy(client, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table);
          if (table !== "transactions") return builder;
          return new Proxy(builder, {
            get(bt, p, r) {
              if (p !== "insert") return Reflect.get(bt, p, r);
              return (...args: unknown[]) => {
                inserts += 1;
                if (inserts === failAt) {
                  return {
                    select: () => ({
                      single: async () => ({ data: null, error: { message: "simulated network failure", code: "XX000" } }),
                    }),
                  };
                }
                return (bt.insert as (...a: unknown[]) => unknown)(...args);
              };
            },
          });
        };
      },
    }) as SupabaseClient;
  }

  it("a mid-chunk failure keeps the rows before it, returns partial, and the replay completes under the SAME batch", async () => {
    const p = await previewImport(a, { account_id: acct, filename: "chunk.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "chunk.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const choices = allIncluded(p.rows);

    const flaky = failingOnInsert(a, 3);
    const first = await commitImportChunk(flaky, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.partial).toBe(true);
    if (first.partial) expect(first.saved_in_chunk).toBe(2);
    expect(first.error).toContain("simulated");
    // m-2: the failing row is named by its file line (the third insert is the salary, line 4).
    expect(first.error).toMatch(/^Line 4: /);
    expect(await rowsOf(a, begun.batch_id)).toHaveLength(2);

    const replay = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.saved_in_chunk).toBe(3);
    expect(replay.skipped_in_chunk).toBe(2); // the two already there: 23505, not a re-write
    expect(replay.done).toBe(true);
    if (replay.done) expect(replay.imported_count).toBe(5);
    const batches = await a.from("import_batches").select("id").eq("account_id", acct);
    expect(batches.data).toHaveLength(1); // one batch, however many attempts
    expect(await rowsOf(a, begun.batch_id)).toHaveLength(5);

    const u = await undoImport(a, begun.batch_id);
    expect(u).toEqual({ ok: true, deleted: 5, message: null });
    expect(await rowsOf(a, begun.batch_id)).toEqual([]);
    expect((await batchRow(a, begun.batch_id)).undone_at).not.toBeNull();
  });

  it("the same file in two chunks and in one yields identical rows, and a mid-import preview is not refused by its own batch", async () => {
    const p = await previewImport(a, { account_id: acct, filename: "order.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const choices = allIncluded(p.rows);
    const two = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "order.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!two.ok) throw new Error(two.error);
    const c1 = await commitImportChunk(a, { batch_id: two.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 3 } });
    expect(c1.ok && !c1.done).toBe(true);
    // Ruling 12c: stepping back to the map screen mid-import previews with the
    // in-flight batch id and must not be refused against it — nor may chunk
    // 1's own rows turn chunk 2's neighbours into duplicates.
    const mid = await previewImport(a, { account_id: acct, filename: "order.csv", text: FILE, mapping: PAIR, batch_id: two.batch_id });
    expect(mid.ok && mid.same_file).toBeNull();
    if (mid.ok) expect(mid.rows.map((r) => r.state)).toEqual(p.rows.map((r) => r.state));
    const without = await previewImport(a, { account_id: acct, filename: "order.csv", text: FILE, mapping: PAIR });
    expect(without.ok && without.same_file?.batch_id).toBe(two.batch_id);
    const c2 = await commitImportChunk(a, { batch_id: two.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 3, to: 6 } });
    expect(c2.ok && c2.done).toBe(true);
    const strip = (r: Record<string, unknown>) => {
      const { created_at: _c, updated_at: _u, import_batch_id: _b, ...rest } = r;
      void _c; void _u; void _b;
      return rest;
    };
    const twoChunks = (await rowsOf(a, two.batch_id)).map(strip);
    expect(twoChunks).toHaveLength(5);

    const undone = await undoImport(a, two.batch_id);
    expect(undone.ok && undone.deleted).toBe(5);

    const one = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "order.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!one.ok) throw new Error(one.error);
    const c = await commitImportChunk(a, { batch_id: one.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(c.ok && c.done).toBe(true);
    const oneChunk = (await rowsOf(a, one.batch_id)).map(strip);
    expect(oneChunk).toEqual(twoChunks);
  });
});

describe("undoImport refuses a touched batch (ruling 17) and the history reads as a ledger", () => {
  let acct: string;
  let batchId: string;

  beforeAll(async () => {
    acct = (await a.from("accounts").insert({ name: "Import undo bank", type: "bank" }).select().single()).data!.id;
    const p = await previewImport(a, { account_id: acct, filename: "undo.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "undo.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    batchId = begun.batch_id;
    const c = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 6 } });
    if (!c.ok) throw new Error(c.error);
  });

  it("refuses after one row is edited, naming it; the rows stay", async () => {
    const rows = await rowsOf(a, batchId);
    const grab = rows.find((r) => r.note === "GRAB RIDE KL")!;
    const edit = await a.from("transactions").update({ note: "GRAB RIDE KL (edited)" }).eq("id", grab.id);
    if (edit.error) throw edit.error;
    const u = await undoImport(a, batchId);
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.error).toMatch(/1 row/);
      expect(u.error).toContain("GRAB RIDE KL (edited)");
    }
    expect(await rowsOf(a, batchId)).toHaveLength(5);
    expect((await batchRow(a, batchId)).undone_at).toBeNull();

    const history = await listImportBatches(a);
    const row = history.find((h) => h.id === batchId)!;
    expect(row.touched_count).toBe(1);
    expect(row.imported_count).toBe(5);
    expect(row.account_name).toBe("Import undo bank");
    expect(row.undone_at).toBeNull();
    // Batch numbers are derived from (created_at, id) order across the user,
    // newest first in the list.
    expect(history[0]!.batch_no).toBe(Math.max(...history.map((h) => h.batch_no)));
  });

  it("also refuses a row that gained a reimbursement payment", async () => {
    const acct2 = (await a.from("accounts").insert({ name: "Import undo bank 2", type: "bank" }).select().single()).data!.id;
    const p = await previewImport(a, { account_id: acct2, filename: "undo2.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct2, filename: "undo2.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const c = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 6 } });
    if (!c.ok) throw new Error(c.error);
    const kopi = (await rowsOf(a, begun.batch_id)).find((r) => r.note === "KOPI CORNER")!;
    // expected_back is set by an edit (touching updated_at too), so the
    // payment row is what this pins: it is checked on its own.
    const pay = await a.from("reimbursement_payments").insert({ transaction_id: kopi.id, account_id: acct2, amount_sen: 100 });
    if (pay.error) throw pay.error;
    const u = await undoImport(a, begun.batch_id);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.error).toMatch(/paid back|payment/);
  });

  it("succeeds when untouched, and a second undo is refused", async () => {
    const acct3 = (await a.from("accounts").insert({ name: "Import undo bank 3", type: "bank" }).select().single()).data!.id;
    const p = await previewImport(a, { account_id: acct3, filename: "undo3.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct3, filename: "undo3.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const c = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 6 } });
    if (!c.ok) throw new Error(c.error);
    const u = await undoImport(a, begun.batch_id);
    expect(u).toEqual({ ok: true, deleted: 5, message: null });
    expect(await rowsOf(a, begun.batch_id)).toEqual([]);
    const again = await undoImport(a, begun.batch_id);
    expect(again.ok).toBe(false);
    const history = await listImportBatches(a);
    const row = history.find((h) => h.id === begun.batch_id)!;
    expect(row.undone_at).not.toBeNull();
    expect(row.imported_count).toBe(5); // reconstructed from the final chunk's counters once the rows are gone
    // Undone, the file may be imported again — and the same ids come back.
    const p2 = await previewImport(a, { account_id: acct3, filename: "undo3.csv", text: FILE, mapping: PAIR });
    expect(p2.ok && p2.same_file).toBeNull();
    if (!p2.ok) return;
    const b2 = await beginImport(a, { id: randomUUID(), account_id: acct3, filename: "undo3.csv", content_sha256: p2.content_sha256, row_count: 6 });
    if (!b2.ok) throw new Error(b2.error);
    const c2 = await commitImportChunk(a, { batch_id: b2.batch_id, text: FILE, mapping: PAIR, choices: allIncluded(p2.rows), chunk: { from: 0, to: 6 } });
    expect(c2.ok && c2.saved_in_chunk).toBe(5);
    const ids = (await rowsOf(a, b2.batch_id)).map((r) => r.id).sort();
    expect(ids).toEqual(p.rows.flatMap((r) => (r.id === null ? [] : [r.id])).sort());
  });
});

/** A client whose `import_batches` UPDATE fails — the counters / undone_at
 *  write dying after the rows were already written or deleted. */
function failingBatchUpdate(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== "import_batches") return builder;
        return new Proxy(builder, {
          get(bt, p, r) {
            if (p !== "update") return Reflect.get(bt, p, r);
            return () => ({ eq: async () => ({ data: null, error: { message: "simulated update failure" } }) });
          },
        });
      };
    },
  }) as SupabaseClient;
}

describe("fix wave — chunk bounds, fund-shaped input, isolation, error paths (review m1, m4, m5, m10, m12)", () => {
  let acct: string;
  const open = async (accountId: string, filename: string, text: string) => {
    const p = await previewImport(a, { account_id: accountId, filename, text, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: accountId, filename, content_sha256: p.content_sha256, row_count: p.summary.row_count });
    if (!begun.ok) throw new Error(begun.error);
    return { p, batchId: begun.batch_id };
  };
  const freshAccount = async (name: string) =>
    (await a.from("accounts").insert({ name, type: "bank" }).select().single()).data!.id as string;

  beforeAll(async () => {
    acct = await freshAccount("Import fixwave bank");
  });

  it("refuses a chunk wider than IMPORT_CHUNK_ROWS and an empty or inverted one, writing nothing (m1)", async () => {
    const { p, batchId } = await open(acct, "bounds.csv", FILE);
    const choices = allIncluded(p.rows);
    for (const chunk of [{ from: 0, to: 101 }, { from: 3, to: 3 }, { from: 4, to: 2 }]) {
      const c = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices, chunk });
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.partial).toBe(false);
    }
    const wide = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 101 } });
    if (!wide.ok) expect(wide.error).toContain("100");
    expect(await rowsOf(a, batchId)).toEqual([]);
    await undoImport(a, batchId);
  });

  it("a fund_id column in the file and extra keys on a choice never tag a row: zod STRIPS the keys, fund_id stays null (m4, rule 16)", async () => {
    const fund = await a.from("funds").insert({ name: "Import guard fund", kind: "sinking" }).select("id").single();
    if (fund.error) throw fund.error;
    const fundAcct = await freshAccount("Import fund-shaped bank");
    const text = [
      "Date,Description,Debit,Credit,fund_id",
      `05/03/2077,KOPI CORNER,4.50,,${fund.data.id}`,
      `07/03/2077,GRAB RIDE KL,18.00,,${fund.data.id}`,
    ].join("\n");
    const { p, batchId } = await open(fundAcct, "fund-shaped.csv", text);
    const choices = allIncluded(p.rows).map((c) => ({ ...c, fund_id: fund.data.id, fundId: fund.data.id, recurring_rule_id: fund.data.id }));
    const c = await commitImportChunk(a, { batch_id: batchId, text, mapping: PAIR, choices, chunk: { from: 0, to: 2 } });
    expect(c.ok).toBe(true); // stripped, not rejected
    if (c.ok) expect(c.saved_in_chunk).toBe(2);
    const rows = await rowsOf(a, batchId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.fund_id)).toEqual([null, null]);
    expect(rows.map((r) => r.recurring_rule_id)).toEqual([null, null]);
  });

  it("undo refuses rows since paid from a fund or linked to a bill, naming each reason (m4)", async () => {
    const tagAcct = await freshAccount("Import tagged bank");
    const { p, batchId } = await open(tagAcct, "tagged.csv", FILE);
    const c = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 6 } });
    if (!c.ok) throw new Error(c.error);
    const fund = await a.from("funds").insert({ name: "Import undo fund", kind: "sinking" }).select("id").single();
    if (fund.error) throw fund.error;
    const rule = await a
      .from("recurring_rules")
      .insert({ name: "Import undo rule", type: "expense", amount_sen: 1_800, account_id: tagAcct, freq: "monthly", day_of_month: 7, next_run: "2077-04-07" })
      .select("id")
      .single();
    if (rule.error) throw rule.error;
    const rows = await rowsOf(a, batchId);
    const kopi = rows.find((r) => r.note === "KOPI CORNER")!;
    const grab = rows.find((r) => r.note === "GRAB RIDE KL")!;
    const t1 = await a.from("transactions").update({ fund_id: fund.data.id }).eq("id", kopi.id);
    if (t1.error) throw t1.error;
    const t2 = await a.from("transactions").update({ recurring_rule_id: rule.data.id }).eq("id", grab.id);
    if (t2.error) throw t2.error;
    const u = await undoImport(a, batchId);
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.error).toMatch(/2 rows changed/);
      expect(u.error).toContain('"KOPI CORNER" (paid from a fund)');
      expect(u.error).toContain('"GRAB RIDE KL" (linked to a bill)');
    }
    expect(await rowsOf(a, batchId)).toHaveLength(5);
  });

  it("user B cannot preview against user A's account, and no mapping is stored for it (m4)", async () => {
    const r = await previewImport(b, { account_id: acct, filename: "b.csv", text: FILE, mapping: PAIR });
    expect(r).toEqual({ ok: false, error: "Account not found" });
    expect((await getImportMappings(b))[acct]).toBeUndefined();
  });

  it("names an unterminated quote once: 'Line n: unterminated quote' (m10)", async () => {
    const text = 'Date,Description,Debit,Credit\n05/03/2077,"KOPI CORNER,4.50,';
    const r = await previewImport(a, { account_id: acct, filename: "quote.csv", text, mapping: PAIR });
    expect(r).toEqual({ ok: false, error: "Line 2: unterminated quote" });
  });

  it("a finalize failure after the rows were written returns PARTIAL, and the replay closes the batch (m5)", async () => {
    const finAcct = await freshAccount("Import finalize bank");
    const { p, batchId } = await open(finAcct, "finalize.csv", FILE);
    const choices = allIncluded(p.rows);
    const c = await commitImportChunk(failingBatchUpdate(a), { batch_id: batchId, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.partial).toBe(true);
    if (c.partial) expect(c.saved_in_chunk).toBe(5);
    expect(await rowsOf(a, batchId)).toHaveLength(5);
    const replay = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(replay.ok && replay.done).toBe(true);
    expect((await batchRow(a, batchId)).unparseable_count).toBe(1);
  });

  it("an undo whose delete landed but whose undone_at write failed says so and reports the rows as gone (m5)", async () => {
    const markAcct = await freshAccount("Import mark bank");
    const { p, batchId } = await open(markAcct, "mark.csv", FILE);
    const c = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 6 } });
    if (!c.ok) throw new Error(c.error);
    const u = await undoImport(failingBatchUpdate(a), batchId);
    expect(u.ok).toBe(false);
    if (u.ok) return;
    expect(u.deleted).toBe(5);
    expect(u.error).toMatch(/5 rows were removed/);
    expect(await rowsOf(a, batchId)).toEqual([]);
    expect((await batchRow(a, batchId)).undone_at).toBeNull();
    // The retry closes it. R4 (Plan 9): the second pass deletes nothing, so
    // it must NOT settle the counters from a derived count of 0 — the
    // finalized counters stay, and the history keeps reading 5 imported.
    const again = await undoImport(a, batchId);
    expect(again).toEqual({ ok: true, deleted: 0, message: "Nothing to undo — this batch owns no rows" });
    const stored = await batchRow(a, batchId);
    expect(stored.undone_at).not.toBeNull();
    expect([stored.skipped_count, stored.needs_review_count, stored.unparseable_count]).toEqual([0, 2, 1]);
    const row = (await listImportBatches(a)).find((h) => h.id === batchId)!;
    expect(row.imported_count).toBe(5);
    expect(row.undone_at).not.toBeNull();
  });

  it("an undone batch that was never finalized shows what undo removed, not row_count (m12)", async () => {
    const halfAcct = await freshAccount("Import half bank");
    const { p, batchId } = await open(halfAcct, "half.csv", FILE);
    // Chunk 1 of 2 only: the two kopi and the salary. The final chunk — the
    // one that writes the counters — never runs.
    const c1 = await commitImportChunk(a, { batch_id: batchId, text: FILE, mapping: PAIR, choices: allIncluded(p.rows), chunk: { from: 0, to: 3 } });
    expect(c1.ok && !c1.done).toBe(true);
    const u = await undoImport(a, batchId);
    expect(u).toEqual({ ok: true, deleted: 3, message: null });
    const row = (await listImportBatches(a)).find((h) => h.id === batchId)!;
    expect(row.row_count).toBe(6);
    expect(row.imported_count).toBe(3);
    expect(row.needs_review_count).toBe(1); // the salary credit
  });
});

/**
 * Plan 9 ruling 7 — the header-line picker. The raw text is sliced from the
 * chosen line BEFORE the CSV reader runs (a preamble line may hold an
 * unbalanced quote that would kill it); `content_sha256` stays over the whole
 * text; row `line` numbers stay 1-based ROW numbers relative to the header.
 */
describe("readImportCsv / parseImportFile — the header line (ruling 7)", () => {
  const text = fixtureText("preamble-3-lines.csv");
  const PAIR5: ImportMapping = { ...PAIR, header_line: 3 };

  it("lists the raw lines on \\r?\\n, without a trailing empty segment", () => {
    expect(rawLines(text)).toEqual([
      "Synthetic Bank,Statement of account",
      'Account no,"5123 SYNTHETIC SAVINGS',
      "",
      "Date,Description,Debit,Credit,Balance",
      "05/03/2077,KOPI CORNER,4.50,,1995.50",
      "06/03/2077,SALARY CREDIT ACME,,3500.00,5495.50",
      "07/03/2077,GRAB RIDE KL,18.00,,5477.50",
      "Closing balance,,,,5477.50",
    ]);
    expect(rawLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(rawLines("\uFEFFa\nb")).toEqual(["a", "b"]);
    expect(rawLines("")).toEqual([]);
  });

  it("header line 0 (the default) reads as before — the open quote on line 1 kills the reader", () => {
    expect(readImportCsv(text)).toEqual({ ok: false, error: "Line 2: unterminated quote" });
    expect(readImportCsv(text, 0)).toEqual({ ok: false, error: "Line 2: unterminated quote" });
  });

  it("header line 3 slices the preamble off before parseCsv: row 0 is the header, preamble_lines = 3", () => {
    const r = readImportCsv(text, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preamble_lines).toBe(3);
    expect(r.rows[0]).toEqual(["Date", "Description", "Debit", "Credit", "Balance"]);
    expect(r.rows).toHaveLength(5);
    expect(r.rows[4]).toEqual(["Closing balance", "", "", "", "5477.50"]);
  });

  it("a reader error after a picked header names the FILE line (csv.ts's 1-based meaning), not the sliced one", () => {
    // The same fixture with an open quote on file line 6 (raw index 5), two
    // lines below the header on line 4 — the preamble's own open quote is
    // sliced away, so only this one reaches the reader.
    const lines = rawLines(text);
    lines[5] = '06/03/2077,"SALARY CREDIT ACME,,3500.00,5495.50';
    const broken = lines.join("\n") + "\n";
    expect(readImportCsv(broken, 3)).toEqual({ ok: false, error: "Line 6: unterminated quote" });
  });

  it("a \\r\\n file slices the same way, line endings kept", () => {
    const crlf = text.replace(/\n/g, "\r\n");
    const r = readImportCsv(crlf, 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toEqual((readImportCsv(text, 3) as { ok: true; rows: string[][] }).rows);
  });

  it("refuses a header line past the end, naming the line count", () => {
    expect(readImportCsv(text, 8)).toEqual({ ok: false, error: "Header line 8 is past the end of this file (8 lines)" });
    expect(readImportCsv(text, 11)).toEqual({ ok: false, error: "Header line 11 is past the end of this file (8 lines)" });
    expect(readImportCsv(text, 7).ok).toBe(true); // the last line as the header: no data rows, still a file
  });

  it("parseImportFile applies mapping.header_line: rows keep 1-based row numbers from the header, the footer stays unparseable", () => {
    const r = parseImportFile(text, PAIR5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preamble_lines).toBe(3);
    expect(r.raw.map((row) => [row.line, row.date, row.signed_amount_sen, row.error])).toEqual([
      [2, "2077-03-05", -450, undefined],
      [3, "2077-03-06", 350_000, undefined],
      [4, "2077-03-07", -1_800, undefined],
      [5, null, null, "bad date"],
    ]);
    const without = parseImportFile(text, PAIR);
    expect(without).toEqual({ ok: false, error: "Line 2: unterminated quote" });
  });

  it("previewImport carries preamble_lines, hashes the WHOLE text, stores header_line; the commit writes the rows under it", async () => {
    const acct = (await a.from("accounts").insert({ name: "Import preamble bank", type: "bank" }).select().single()).data!.id;
    const p = await previewImport(a, { account_id: acct, filename: "preamble.csv", text, mapping: PAIR5 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preamble_lines).toBe(3);
    expect(p.content_sha256).toBe(hashContent(text));
    expect(p.summary).toEqual({ row_count: 4, included_count: 3, skipped_count: 0, needs_review_count: 1, unparseable_count: 1 });
    expect(p.rows.map((r) => r.line)).toEqual([2, 3, 4, 5]);
    expect((await getImportMappings(a))[acct]).toEqual({ ...PAIR5, saved_at: expect.any(String) });
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "preamble.csv", content_sha256: p.content_sha256, row_count: 4 });
    if (!begun.ok) throw new Error(begun.error);
    const c = await commitImportChunk(a, { batch_id: begun.batch_id, text, mapping: PAIR5, choices: allIncluded(p.rows), chunk: { from: 0, to: 4 } });
    expect(c.ok && c.done).toBe(true);
    if (c.ok && c.done) expect(c.imported_count).toBe(3);
    expect((await rowsOf(a, begun.batch_id)).map((r) => r.amount_sen)).toEqual([450, 350_000, 1_800]);
  });
});

/**
 * Plan 9 Q25 (ruling 8f): the wizard generates the batch id. A begin whose
 * request dies after the insert is retried under the SAME id — the house
 * `23505`-is-a-no-op pattern returns the existing batch when it is the
 * caller's, on the same account and not undone.
 */
describe("beginImport — the client-generated batch id (Q25)", () => {
  let acct: string;
  let other: string;
  let bAcct: string;
  const sha = hashContent(FILE);

  beforeAll(async () => {
    acct = (await a.from("accounts").insert({ name: "Import id bank", type: "bank" }).select().single()).data!.id;
    other = (await a.from("accounts").insert({ name: "Import id other bank", type: "bank" }).select().single()).data!.id;
    bAcct = (await b.from("accounts").insert({ name: "Import id B bank", type: "bank" }).select().single()).data!.id;
  });

  it("double-fire: the second begin under the same id returns the same batch and opens no second row", async () => {
    const id = randomUUID();
    const input = { id, account_id: acct, filename: "id.csv", content_sha256: sha, row_count: 6 };
    const first = await beginImport(a, input);
    expect(first).toEqual({ ok: true, batch_id: id });
    const second = await beginImport(a, input);
    expect(second).toEqual({ ok: true, batch_id: id });
    const rows = await a.from("import_batches").select("id").eq("account_id", acct);
    expect(rows.data).toEqual([{ id }]);
  });

  it("another user's id: RLS shows no row, so the refusal is the generic sentence and nothing is written", async () => {
    const id = randomUUID();
    const mine = await beginImport(a, { id, account_id: acct, filename: "mine.csv", content_sha256: sha, row_count: 6 });
    if (!mine.ok) throw new Error(mine.error);
    const stolen = await beginImport(b, { id, account_id: bAcct, filename: "b.csv", content_sha256: sha, row_count: 6 });
    expect(stolen).toEqual({ ok: false, error: "Import id already used — start the import again" });
    expect((await b.from("import_batches").select("id")).data).toEqual([]);
    expect((await batchRow(a, id)).account_id).toBe(acct);
  });

  it("the caller's own id on another account, or an undone batch, is refused by name", async () => {
    const id = randomUUID();
    const begun = await beginImport(a, { id, account_id: acct, filename: "own.csv", content_sha256: sha, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const elsewhere = await beginImport(a, { id, account_id: other, filename: "own.csv", content_sha256: sha, row_count: 6 });
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.error).toMatch(/another account/);
    const u = await undoImport(a, id);
    expect(u.ok).toBe(true);
    const undone = await beginImport(a, { id, account_id: acct, filename: "own.csv", content_sha256: sha, row_count: 6 });
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.error).toMatch(/undone/);
    expect((await a.from("import_batches").select("id").eq("account_id", acct)).data!.length).toBeGreaterThan(0);
  });

  it("refuses a non-uuid id", async () => {
    const r = await beginImport(a, { id: "not-a-uuid", account_id: acct, filename: "bad.csv", content_sha256: sha, row_count: 6 });
    expect(r.ok).toBe(false);
  });
});

describe("previewImport — the probable-duplicate source suffix (Plan 9 ruling 8h)", () => {
  // Ruling 8h: the probable-duplicate row's `· import` suffix — the matched
  // existing row was written by an import (its batch tag), off the same read
  // that names the batch behind an already-imported row.
  it("names the batch behind a PROBABLE duplicate's match when an import wrote it, and not for a hand entry", async () => {
    const acct = (await a.from("accounts").insert({ name: "Import dup-source bank", type: "bank" }).select().single()).data!.id;
    const batch = await a
      .from("import_batches")
      .insert({ account_id: acct, filename: "earlier.csv", content_sha256: hashContent("earlier"), row_count: 1 })
      .select("id")
      .single();
    if (batch.error) throw batch.error;
    const seed = await a.from("transactions").insert([
      // Same RM 18.00 debit a day off the Grab line, tagged by an earlier batch (its id differs — a different description).
      { type: "expense", amount_sen: 1_800, account_id: acct, date: "2077-03-08", note: "grab via import", source: "import", import_batch_id: batch.data.id },
      // Same RM 4.50 debit a day off the kopi lines, entered by hand.
      { type: "expense", amount_sen: 450, account_id: acct, date: "2077-03-04", note: "kopi by hand", source: "manual" },
    ]);
    if (seed.error) throw seed.error;
    const r = await previewImport(a, { account_id: acct, filename: "dup-source.csv", text: FILE, mapping: PAIR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const grab = r.rows.find((x) => x.description === "GRAB RIDE KL")!;
    expect(grab.state).toBe("probable_duplicate");
    expect(r.imported_batch[grab.duplicate_of!.id]).toBe(batch.data.id);
    const kopi = r.rows.find((x) => x.description === "KOPI CORNER")!;
    expect(kopi.state).toBe("probable_duplicate");
    expect(r.imported_batch[kopi.duplicate_of!.id]).toBeUndefined();
  });
});

/** A client whose SELECT on one table fails — a PostgREST hiccup on a
 *  pre-write read (the batch row, the account). */
function failingRead(client: SupabaseClient, table: string, message: string): SupabaseClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "from") return Reflect.get(target, prop, receiver);
      return (t: string) => {
        const builder = target.from(t);
        if (t !== table) return builder;
        return new Proxy(builder, {
          get(bt, p, r) {
            if (p !== "select") return Reflect.get(bt, p, r);
            return () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message } }) }) });
          },
        });
      };
    },
  }) as SupabaseClient;
}

/**
 * Plan 9 Task 4 review I2 — controller decision: R2 applies to REFUSALS; a
 * transient pre-write DB error is retryable. A hiccup on chunk 2's batch
 * read or account read must keep the batch and the resume index (the runner
 * maps `partial: true` to Retry) — ending the attempt there would open a
 * second batch over rows the first still owns.
 */
describe("commitImportChunk — a transient pre-write DB error is retryable, a refusal is terminal (Plan 9 R2)", () => {
  it("the batch-row read failing reports partial with 0 saved; the replay under the same batch completes", async () => {
    const acct = (await a.from("accounts").insert({ name: "Import hiccup bank", type: "bank" }).select().single()).data!.id;
    const p = await previewImport(a, { account_id: acct, filename: "hiccup.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "hiccup.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const choices = allIncluded(p.rows);
    const c1 = await commitImportChunk(failingRead(a, "import_batches", "simulated batch read failure"), { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(c1).toEqual({ ok: false, partial: true, saved_in_chunk: 0, error: "simulated batch read failure" });
    const c2 = await commitImportChunk(failingRead(a, "accounts", "simulated account read failure"), { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(c2).toEqual({ ok: false, partial: true, saved_in_chunk: 0, error: "simulated account read failure" });
    expect(await rowsOf(a, begun.batch_id)).toEqual([]);
    const replay = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(replay.ok && replay.done).toBe(true);
    expect(await rowsOf(a, begun.batch_id)).toHaveLength(5);
    const batches = await a.from("import_batches").select("id").eq("account_id", acct);
    expect(batches.data).toHaveLength(1);
  });

  it("a refusal stays terminal: an undone batch, the wrong file, an archived account all answer partial: false", async () => {
    const acct = (await a.from("accounts").insert({ name: "Import refusal bank", type: "bank" }).select().single()).data!.id;
    const p = await previewImport(a, { account_id: acct, filename: "refusal.csv", text: FILE, mapping: PAIR });
    if (!p.ok) throw new Error(p.error);
    const begun = await beginImport(a, { id: randomUUID(), account_id: acct, filename: "refusal.csv", content_sha256: p.content_sha256, row_count: 6 });
    if (!begun.ok) throw new Error(begun.error);
    const choices = allIncluded(p.rows);
    const wrongFile = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE + "\n09/03/2077,EXTRA,1.00,", mapping: PAIR, choices: [], chunk: { from: 0, to: 6 } });
    expect(wrongFile).toEqual({ ok: false, partial: false, error: "This file is not the one this batch was opened for" });
    const arch = await a.from("accounts").update({ archived: true }).eq("id", acct);
    if (arch.error) throw arch.error;
    const archived = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.partial).toBe(false);
    const un = await a.from("accounts").update({ archived: false }).eq("id", acct);
    if (un.error) throw un.error;
    const u = await undoImport(a, begun.batch_id);
    expect(u.ok).toBe(true);
    const undone = await commitImportChunk(a, { batch_id: begun.batch_id, text: FILE, mapping: PAIR, choices, chunk: { from: 0, to: 6 } });
    expect(undone).toEqual({ ok: false, partial: false, error: "This batch was undone — start a new import" });
    expect(await rowsOf(a, begun.batch_id)).toEqual([]);
  });
});

describe("hashContent", () => {
  it("is lowercase hex sha-256 of the utf-8 text", () => {
    expect(hashContent("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashContent(FILE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * Plan 9 ruling 10c: the touched/paid check that history and undo share was
 * a sequential per-100-id `in (…)` loop over every live batch's rows; it is
 * now ONE paged inner-join read (`reimbursement_payments` ⋈
 * `transactions!inner(import_batch_id)`) filtered to the live batches. The
 * old helper is kept HERE verbatim (from src/db/import/shared.ts at
 * `6a3bb43`) so the new shape is pinned EQUAL to it at 250 imported rows
 * with payments and splits — and the history's per-batch touched counts
 * equal what the old shape produced.
 */
async function oldPaidTransactionIds(supabase: SupabaseClient, txIds: string[]): Promise<Set<string>> {
  const paid = new Set<string>();
  for (let i = 0; i < txIds.length; i += IN_CHUNK) {
    const chunk = txIds.slice(i, i + IN_CHUNK);
    const rows = await fetchAllPages<{ transaction_id: string }>((from, to) =>
      supabase
        .from("reimbursement_payments")
        .select("transaction_id")
        .in("transaction_id", chunk)
        .order("id")
        .range(from, to),
    );
    for (const r of rows) paid.add(r.transaction_id);
  }
  return paid;
}

describe("paidImportedTransactionIds equals the old per-100-id loop at 250 imported rows (Plan 9 ruling 10c)", () => {
  let acct: string;
  let live: string;
  let live2: string;
  let undone: string;
  let liveRows: Array<{ id: string; import_batch_id: string; created_at: string; updated_at: string; fund_id: string | null; recurring_rule_id: string | null }>;

  beforeAll(async () => {
    acct = (await a.from("accounts").insert({ name: "Import equality bank", type: "bank" }).select().single()).data!.id;
    const batch = async (filename: string, undone_at: string | null) => {
      const res = await a
        .from("import_batches")
        .insert({ account_id: acct, filename, content_sha256: hashContent(filename), row_count: 250, undone_at })
        .select("id")
        .single();
      if (res.error) throw res.error;
      return res.data.id as string;
    };
    live = await batch("equality-250.csv", null);
    live2 = await batch("equality-10.csv", null);
    undone = await batch("equality-undone.csv", "2077-09-02T00:00:00Z");
    const rows = (n: number, batchId: string) =>
      Array.from({ length: n }, (_, i) => ({
        type: "expense",
        amount_sen: 1_000,
        account_id: acct,
        date: "2077-09-01",
        note: `equality row ${i}`,
        source: "import",
        import_batch_id: batchId,
      }));
    const ins = await a
      .from("transactions")
      .insert([...rows(250, live), ...rows(10, live2), ...rows(5, undone)])
      .select("id, import_batch_id");
    if (ins.error) throw ins.error;
    // Every row split in two; a payment on every 7th row of the big batch,
    // on 3 rows of the small one, and on ALL five rows of the undone batch
    // (which the live-batch filter must leave out).
    const splits = await a.from("transaction_splits").insert(
      ins.data.flatMap((t) => [
        { transaction_id: t.id, category_id: food, amount_sen: 400 },
        { transaction_id: t.id, category_id: transport, amount_sen: 600 },
      ]),
    );
    if (splits.error) throw splits.error;
    const paidIds = [
      ...ins.data.filter((t) => t.import_batch_id === live).filter((_, i) => i % 7 === 0),
      ...ins.data.filter((t) => t.import_batch_id === live2).slice(0, 3),
      ...ins.data.filter((t) => t.import_batch_id === undone),
    ].map((t) => t.id);
    const pay = await a
      .from("reimbursement_payments")
      .insert(paidIds.map((id) => ({ transaction_id: id, account_id: acct, amount_sen: 100 })));
    if (pay.error) throw pay.error;
    const tagged = await a
      .from("transactions")
      .select("id, import_batch_id, created_at, updated_at, fund_id, recurring_rule_id")
      .in("import_batch_id", [live, live2])
      .order("id");
    if (tagged.error) throw tagged.error;
    liveRows = tagged.data;
  }, 60_000);

  it("the paid set over the live batches equals the old shape's (36 + 3 rows; the undone batch's 5 are out)", async () => {
    const expected = await oldPaidTransactionIds(a, liveRows.map((r) => r.id));
    expect(expected.size).toBe(36 + 3);
    const actual = await paidImportedTransactionIds(a, [live, live2]);
    expect(actual).toEqual(expected);
    expect(await paidImportedTransactionIds(a, [live])).toEqual(
      new Set(liveRows.filter((r) => r.import_batch_id === live && expected.has(r.id)).map((r) => r.id)),
    );
    expect(await paidImportedTransactionIds(a, [])).toEqual(new Set());
  });

  it("the history's per-batch touched and imported counts equal the old shape's", async () => {
    const expected = await oldPaidTransactionIds(a, liveRows.map((r) => r.id));
    const touchedOld = new Map<string, number>();
    for (const { row } of touchedRows(liveRows, expected)) {
      touchedOld.set(row.import_batch_id, (touchedOld.get(row.import_batch_id) ?? 0) + 1);
    }
    const history = await listImportBatches(a);
    const big = history.find((h) => h.id === live)!;
    const small = history.find((h) => h.id === live2)!;
    expect([big.imported_count, big.touched_count]).toEqual([250, touchedOld.get(live)]);
    expect([small.imported_count, small.touched_count]).toEqual([10, touchedOld.get(live2)]);
    expect(big.touched_count).toBe(36);
    expect(small.touched_count).toBe(3);
  });

  it("undo still refuses the paid batch by name, off the same read", async () => {
    const u = await undoImport(a, live2);
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.error).toMatch(/3 rows changed since import/);
  });
});
