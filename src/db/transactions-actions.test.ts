import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { makeTestUsers } from "@/db/test-clients";
import {
  performUpsert,
  performUpdate,
  performDelete,
  type TxInput,
} from "@/lib/transactions";
import { recordNowTxId } from "@/lib/bills";
import { recordNowNotice } from "@/lib/bills-display";

let a: SupabaseClient;
let acctId: string;
let c1: string, c2: string, c3: string;

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  const { data: acct, error: acctErr } = await a
    .from("accounts")
    .insert({ name: "Maybank", type: "bank" })
    .select()
    .single();
  if (acctErr) throw acctErr;
  acctId = acct!.id;

  const { data: cats, error: catErr } = await a
    .from("categories")
    .insert([
      { name: "Food", kind: "expense" },
      { name: "Transport", kind: "expense" },
      { name: "Shopping", kind: "expense" },
    ])
    .select();
  if (catErr) throw catErr;
  const byName = new Map(cats!.map((c) => [c.name, c.id]));
  c1 = byName.get("Food")!;
  c2 = byName.get("Transport")!;
  c3 = byName.get("Shopping")!;
}, 30_000);

const baseTx = (over: Partial<TxInput> = {}): TxInput => ({
  type: "expense",
  amount: "300.00",
  accountId: acctId,
  date: "2026-08-15",
  ...over,
});

describe("transaction upsert/update/delete with splits", () => {
  it("happy path: expense with 2 summing splits creates tx + split rows", async () => {
    const id = randomUUID();
    const result = await performUpsert(a, baseTx({
      id,
      splits: [
        { categoryId: c1, amount: "100.00" },
        { categoryId: c2, amount: "200.00" },
      ],
    }));
    expect(result).toEqual({ ok: true, id, created: true });

    const { data: tx } = await a.from("transactions").select().eq("id", id).single();
    expect(tx!.amount_sen).toBe(30_000);

    const { data: splits } = await a
      .from("transaction_splits")
      .select()
      .eq("transaction_id", id)
      .order("amount_sen");
    expect(splits!.map((s) => s.amount_sen)).toEqual([10_000, 20_000]);
    expect(splits!.map((s) => s.category_id).sort()).toEqual([c1, c2].sort());
  });

  it("compensating cleanup: failed split insert leaves no orphan tx", async () => {
    const id = randomUUID();
    const result = await performUpsert(a, baseTx({
      id,
      splits: [
        { categoryId: c1, amount: "100.00" },
        { categoryId: randomUUID(), amount: "200.00" }, // FK violation
      ],
    }));
    expect(result.ok).toBe(false);

    const { data } = await a.from("transactions").select().eq("id", id);
    expect(data).toEqual([]);
  });

  it("idempotency: same client id twice → both ok, exactly one row", async () => {
    const id = randomUUID();
    const input = baseTx({ id, categoryId: c1 });
    const first = await performUpsert(a, input);
    const retry = await performUpsert(a, input);
    expect(first).toEqual({ ok: true, id, created: true });
    expect(retry).toEqual({ ok: true, id, created: false });

    const { data } = await a.from("transactions").select().eq("id", id);
    expect(data!.length).toBe(1);
  });

  it("edit: performUpdate changes category and replaces splits", async () => {
    const id = randomUUID();
    const created = await performUpsert(a, baseTx({
      id,
      categoryId: c1,
      splits: [
        { categoryId: c1, amount: "100.00" },
        { categoryId: c2, amount: "200.00" },
      ],
    }));
    expect(created.ok).toBe(true);

    const updated = await performUpdate(a, id, baseTx({
      categoryId: c3,
      splits: [{ categoryId: c3, amount: "300.00" }],
    }));
    expect(updated).toEqual({ ok: true, id });

    const { data: tx } = await a.from("transactions").select().eq("id", id).single();
    expect(tx!.category_id).toBe(c3);

    const { data: splits } = await a
      .from("transaction_splits")
      .select()
      .eq("transaction_id", id);
    expect(splits!.length).toBe(1);
    expect(splits![0].category_id).toBe(c3);
    expect(splits![0].amount_sen).toBe(30_000);
  });

  /**
   * Rulings 6/7: retyping a fund-tagged expense is an explicit act, never a
   * silent one. The lib rejects the payload and the stored row keeps its tag
   * — a dropped tag would move a fund balance with no trace of why.
   */
  it("edit: a tagged expense retyped to income is rejected and keeps its tag", async () => {
    const fund = await a.from("funds").insert({ name: "Actions fund", kind: "sinking" }).select().single();
    if (fund.error) throw fund.error;
    const fundId = fund.data.id as string;

    const id = randomUUID();
    const created = await performUpsert(a, baseTx({ id, categoryId: c1, fundId }));
    expect(created).toEqual({ ok: true, id, created: true });

    const retyped = await performUpdate(a, id, {
      type: "income",
      amount: "300.00",
      accountId: acctId,
      date: "2026-08-15",
      fundId,
    });
    expect(retyped.ok).toBe(false);

    const { data } = await a.from("transactions").select("type, fund_id").eq("id", id).single();
    expect(data!.type).toBe("expense");
    expect(data!.fund_id).toBe(fundId);
  });

  it("edit: dropping fundId from the payload clears the tag (the explicit 'None')", async () => {
    const fund = await a.from("funds").insert({ name: "Actions fund 2", kind: "sinking" }).select().single();
    if (fund.error) throw fund.error;
    const fundId = fund.data.id as string;

    const id = randomUUID();
    expect(await performUpsert(a, baseTx({ id, categoryId: c1, fundId }))).toEqual({ ok: true, id, created: true });
    expect(await performUpdate(a, id, baseTx({ categoryId: c1 }))).toEqual({ ok: true, id });

    const { data } = await a.from("transactions").select("fund_id").eq("id", id).single();
    expect(data!.fund_id).toBeNull();
  });

  it("delete: removes tx and cascades its splits", async () => {
    const id = randomUUID();
    const created = await performUpsert(a, baseTx({
      id,
      splits: [
        { categoryId: c1, amount: "150.00" },
        { categoryId: c2, amount: "150.00" },
      ],
    }));
    expect(created.ok).toBe(true);

    const deleted = await performDelete(a, id);
    expect(deleted).toEqual({ ok: true, id });

    const { data: tx } = await a.from("transactions").select().eq("id", id);
    expect(tx).toEqual([]);
    const { data: splits } = await a
      .from("transaction_splits")
      .select()
      .eq("transaction_id", id);
    expect(splits).toEqual([]);
  });
});

/**
 * Plan 7 ruling 14: `Record now` writes the recurring link once; every
 * ordinary edit afterwards must leave it alone. If an edit nulled it, a
 * variable bill whose real figure the owner types in would un-record itself
 * and the projection would subtract it a second time.
 */
describe("recurring link survives an ordinary edit (ruling 14)", () => {
  it("sets the link on Record now and preserves it through performUpdate", async () => {
    const { data: rule, error: ruleErr } = await a
      .from("recurring_rules")
      .insert({
        name: "Insurance",
        type: "expense",
        amount_sen: 21_000,
        variable: true,
        account_id: acctId,
        freq: "monthly",
        day_of_month: 20,
        next_run: "2077-09-20",
      })
      .select("id")
      .single();
    expect(ruleErr).toBeNull();
    const ruleId = rule!.id as string;

    const id = recordNowTxId(ruleId, "2077-09-20");
    const created = await performUpsert(a, {
      id,
      type: "expense",
      amount: "210.00",
      accountId: acctId,
      date: "2077-09-20",
      recurringRuleId: ruleId,
    });
    expect(created).toEqual({ ok: true, id, created: true });

    // The owner corrects the variable bill's real figure — no rule field in
    // the payload, exactly as every ordinary edit surface sends it.
    const edited = await performUpdate(a, id, {
      type: "expense",
      amount: "231.45",
      accountId: acctId,
      date: "2077-09-20",
    });
    expect(edited.ok).toBe(true);

    const { data: row } = await a
      .from("transactions")
      .select("amount_sen, recurring_rule_id")
      .eq("id", id)
      .single();
    expect(row!.amount_sen).toBe(23_145);
    expect(row!.recurring_rule_id).toBe(ruleId);
  });

  /**
   * Plan 8 ruling 11: the success result says whether the row was WRITTEN.
   * `created` is false only on the 23505 branch — the retry that found the
   * row already there — so a caller can tell a no-op from a write without a
   * pre-flight read (Q11b reads it; the import counts skips off it).
   */
  it("is idempotent on a double press (the 23505 retry branch) and reports created", async () => {
    const { data: rule } = await a
      .from("recurring_rules")
      .insert({
        name: "Phone",
        type: "expense",
        amount_sen: 6_800,
        account_id: acctId,
        freq: "monthly",
        day_of_month: 8,
        next_run: "2077-09-08",
      })
      .select("id")
      .single();
    const ruleId = rule!.id as string;
    const id = recordNowTxId(ruleId, "2077-09-08");
    const input: TxInput = {
      id,
      type: "expense",
      amount: "68.00",
      accountId: acctId,
      date: "2077-09-08",
      recurringRuleId: ruleId,
    };
    expect(await performUpsert(a, input)).toEqual({ ok: true, id, created: true });
    expect(await performUpsert(a, input)).toEqual({ ok: true, id, created: false });

    const { data: rows } = await a.from("transactions").select("id").eq("recurring_rule_id", ruleId);
    expect(rows).toHaveLength(1);
  });
});

/**
 * Q11b: the daily job materialised the occurrence first; the owner then
 * presses `Record now` with the real (edited) figure. The write is the 23505
 * no-op, so the edited amount is NOT applied — and a bare success would hide
 * exactly that (rule 15). The path reports `created: false`, the form turns
 * it into a visible notice pointing at the entry to edit, and the stored row
 * is untouched.
 */
describe("Record now on an occurrence the daily job already materialised (Q11b)", () => {
  it("returns created:false with the notice, and leaves the stored amount alone", async () => {
    const { data: rule } = await a
      .from("recurring_rules")
      .insert({
        name: "Electricity",
        type: "expense",
        amount_sen: 6_800,
        variable: true,
        account_id: acctId,
        freq: "monthly",
        day_of_month: 8,
        next_run: "2077-10-08",
      })
      .select("id")
      .single();
    const ruleId = rule!.id as string;
    const id = recordNowTxId(ruleId, "2077-10-08");
    // The materializer's own write shape, at its own id.
    const { error: cronErr } = await a.from("transactions").insert({
      id,
      type: "expense",
      amount_sen: 6_800,
      account_id: acctId,
      date: "2077-10-08",
      note: "Electricity",
      source: "recurring",
      needs_review: true,
      recurring_rule_id: ruleId,
    });
    expect(cronErr).toBeNull();

    const result = await performUpsert(a, {
      id,
      type: "expense",
      amount: "72.50",
      accountId: acctId,
      date: "2077-10-08",
      note: "Electricity",
      recurringRuleId: ruleId,
    });
    expect(result).toEqual({ ok: true, id, created: false });
    expect(recordNowNotice(result, "2077-10-08")).toEqual({
      text: "Already recorded — edit that entry to change the amount",
      href: `/transactions?month=2077-10#${id}`,
    });

    const { data: rows } = await a
      .from("transactions")
      .select("amount_sen")
      .eq("recurring_rule_id", ruleId);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.amount_sen).toBe(6_800);
  });
});

describe("import batch tag round-trips through performUpsert (Plan 8 ruling 11)", () => {
  it("writes import_batch_id and source 'import', and an ordinary edit keeps the tag", async () => {
    const batch = await a
      .from("import_batches")
      .insert({ account_id: acctId, filename: "tag-roundtrip.csv", content_sha256: "a".repeat(64), row_count: 1 })
      .select("id")
      .single();
    if (batch.error) throw batch.error;
    const id = randomUUID();
    const result = await performUpsert(a, baseTx({ id, source: "import", importBatchId: batch.data.id }));
    expect(result).toEqual({ ok: true, id, created: true });
    const { data: row } = await a.from("transactions").select("source, import_batch_id").eq("id", id).single();
    expect(row).toEqual({ source: "import", import_batch_id: batch.data.id });

    // The tag is provenance: an edit that does not mention it leaves it alone.
    const edited = await performUpdate(a, id, baseTx({ amount: "301.00", source: "import" }));
    expect(edited.ok).toBe(true);
    const { data: after } = await a.from("transactions").select("amount_sen, import_batch_id").eq("id", id).single();
    expect(after).toEqual({ amount_sen: 30_100, import_batch_id: batch.data.id });
  });

  /**
   * Plan 9 Q27: `source` is provenance and survives EVERY edit. The form
   * never sends it, and the update path never writes it — an ordinary edit of
   * an imported row must not rewrite `import` to `manual` (the create path
   * still sets it, pinned above).
   */
  it("an ordinary edit with no source in the payload keeps source 'import' (Plan 9 Q27)", async () => {
    const batch = await a
      .from("import_batches")
      .insert({ account_id: acctId, filename: "source-survives.csv", content_sha256: "b".repeat(64), row_count: 1 })
      .select("id")
      .single();
    if (batch.error) throw batch.error;
    const id = randomUUID();
    expect(await performUpsert(a, baseTx({ id, source: "import", importBatchId: batch.data.id }))).toEqual({ ok: true, id, created: true });

    const edited = await performUpdate(a, id, baseTx({ amount: "302.00", note: "edited by hand" }));
    expect(edited).toEqual({ ok: true, id });
    const { data: after } = await a.from("transactions").select("amount_sen, note, source, import_batch_id").eq("id", id).single();
    expect(after).toEqual({ amount_sen: 30_200, note: "edited by hand", source: "import", import_batch_id: batch.data.id });
    // And a payload that DOES carry a source still cannot rewrite provenance.
    expect((await performUpdate(a, id, baseTx({ amount: "303.00", source: "manual" }))).ok).toBe(true);
    expect((await a.from("transactions").select("source").eq("id", id).single()).data).toEqual({ source: "import" });
  });
});
