import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import {
  performRecordReimbursement,
  getOpenReimbursements,
} from "@/lib/reimbursements";
import { performUpsert, performUpdate, type TxInput } from "@/lib/transactions";

let a: SupabaseClient;
let b: SupabaseClient;
let acctId: string;
let txId: string;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
  const { data: acct, error: acctErr } = await a
    .from("accounts")
    .insert({ name: "Maybank", type: "bank" })
    .select()
    .single();
  if (acctErr) throw acctErr;
  acctId = acct!.id;

  const { data: tx, error: txErr } = await a
    .from("transactions")
    .insert({
      type: "expense",
      amount_sen: 30_000,
      account_id: acctId,
      date: "2026-08-15",
      note: "dinner",
      expected_back_sen: 24_000,
    })
    .select()
    .single();
  if (txErr) throw txErr;
  txId = tx!.id;
}, 30_000);

describe("reimbursement payments and owed-to-me tracking", () => {
  it("partial payment: RM160 leaves 8_000 owed, listed as open", async () => {
    const result = await performRecordReimbursement(a, txId, acctId, "160.00");
    expect(result.ok).toBe(true);

    const open = await getOpenReimbursements(a);
    expect(open).toEqual([
      {
        transaction_id: txId,
        note: "dinner",
        date: "2026-08-15",
        expected_back_sen: 24_000,
        paid_sen: 16_000,
        owed_sen: 8_000,
      },
    ]);
  });

  it("RLS: user b sees no open reimbursements", async () => {
    expect(await getOpenReimbursements(b)).toEqual([]);
  });

  it("overpayment: RM90 rejected with 'more than owed', no row inserted", async () => {
    const result = await performRecordReimbursement(a, txId, acctId, "90.00");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("more than owed");

    const { data } = await a
      .from("reimbursement_payments")
      .select("amount_sen")
      .eq("transaction_id", txId);
    expect(data!.map((p) => p.amount_sen)).toEqual([16_000]);
  });

  it("exact remainder: RM80 closes it; getOpenReimbursements returns []", async () => {
    const result = await performRecordReimbursement(a, txId, acctId, "80.00");
    expect(result.ok).toBe(true);

    expect(await getOpenReimbursements(a)).toEqual([]);
  });
});

/**
 * Plan 8 ruling 5: ruling 6 holds at every write, not just the first. The
 * edit-path guards live in performUpdate (they need Σ recorded payments — a
 * query — so validateTransactionInput stays pure). One test per guard,
 * asserting on that guard's OWN message: a combined sequence would pass off
 * guard (a) alone. 2077 dates; fresh rows per test, written through the real
 * performUpsert path.
 */
describe("performUpdate — ruling 5's durable edit-path guards (Plan 8)", () => {
  let fundId: string;
  const base = (over: Partial<TxInput> = {}): TxInput => ({
    type: "expense",
    amount: "300.00",
    accountId: acctId,
    date: "2077-09-01",
    ...over,
  });
  const create = async (over: Partial<TxInput> = {}): Promise<string> => {
    const id = randomUUID();
    const res = await performUpsert(a, base({ id, ...over }));
    if (!res.ok) throw new Error(res.error);
    return id;
  };
  const stored = async (id: string) => {
    const { data, error } = await a
      .from("transactions")
      .select("expected_back_sen, fund_id")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data as { expected_back_sen: number; fund_id: string | null };
  };

  beforeAll(async () => {
    const fund = await a.from("funds").insert({ name: "Guard fund", kind: "sinking" }).select("id").single();
    if (fund.error) throw fund.error;
    fundId = fund.data.id as string;
  });

  it("(a) owed-back can't be lowered below Σ payments — never to 0 — and exactly Σ is accepted", async () => {
    const id = await create({ expectedBack: "240.00" });
    expect((await performRecordReimbursement(a, id, acctId, "160.00")).ok).toBe(true);

    const below = await performUpdate(a, id, base({ expectedBack: "100.00" }));
    expect(below).toEqual({
      ok: false,
      error: "Owed-back can't go below RM 160.00 — RM 160.00 has already been paid back",
    });
    // Clearing the field writes 0 — the same lowering, the same refusal.
    const cleared = await performUpdate(a, id, base());
    expect(cleared).toEqual({
      ok: false,
      error: "Owed-back can't go below RM 160.00 — RM 160.00 has already been paid back",
    });
    expect((await stored(id)).expected_back_sen).toBe(24_000); // untouched by either refusal

    // A settled reimbursement stays settled: exactly the paid sum is the floor.
    expect(await performUpdate(a, id, base({ expectedBack: "160.00" }))).toEqual({ ok: true, id });
    expect((await stored(id)).expected_back_sen).toBe(16_000);
  });

  it("(b) a fund can't be added to a row with a recorded payback, whatever else the patch says", async () => {
    const id = await create({ expectedBack: "240.00" });
    expect((await performRecordReimbursement(a, id, acctId, "160.00")).ok).toBe(true);

    // The patch adds the fund and leaves expected-back alone (unmentioned).
    const tagged = await performUpdate(a, id, base({ fundId }));
    expect(tagged).toEqual({
      ok: false,
      error:
        "A fund can't pay an expense that has already been paid back — RM 160.00 came back to an account, not to a fund. Save it without the fund.",
    });
    expect(await stored(id)).toEqual({ expected_back_sen: 24_000, fund_id: null });
  });

  it("(c) an update is full-replace: a patch that omits the fund and adds owed-back writes the coherent untagged row", async () => {
    const id = await create({ fundId }); // no payments, no expected-back
    expect((await stored(id)).fund_id).toBe(fundId);

    // The form's "None" omits fundId, so the row that will be WRITTEN is
    // {fund_id: null, expected_back_sen: 5_000} — coherent, one save.
    expect(await performUpdate(a, id, base({ expectedBack: "50.00" }))).toEqual({ ok: true, id });
    expect(await stored(id)).toEqual({ expected_back_sen: 5_000, fund_id: null });
  });

  it("(c) a patch carrying BOTH the fund and owed-back is refused with ruling 6's message and the row is unchanged", async () => {
    const id = await create({ fundId }); // no payments, no expected-back
    expect((await stored(id)).fund_id).toBe(fundId);

    const both = await performUpdate(a, id, base({ fundId, expectedBack: "50.00" }));
    expect(both).toEqual({
      ok: false,
      error: "A fund can't pay an expense that has money owed back — clear the expected-back amount first",
    });
    expect(await stored(id)).toEqual({ expected_back_sen: 0, fund_id: fundId });
  });

  it("Session 12's sequence end-to-end: owed-back → payback recorded → edit clears owed-back AND adds the fund → refused", async () => {
    const id = await create({ expectedBack: "240.00" });
    expect((await performRecordReimbursement(a, id, acctId, "240.00")).ok).toBe(true);
    // Fully paid back: no longer open ((b)'s row above legitimately still is).
    expect((await getOpenReimbursements(a)).map((r) => r.transaction_id)).not.toContain(id);

    const rewritten = await performUpdate(a, id, base({ fundId }));
    // Guard (b)'s own string — (a)'s also says "has already been paid back".
    expect(rewritten).toEqual({
      ok: false,
      error:
        "A fund can't pay an expense that has already been paid back — RM 240.00 came back to an account, not to a fund. Save it without the fund.",
    });
    // Nothing moved: the money really came back to an account, and the row
    // can never coherently become fund-paid.
    expect(await stored(id)).toEqual({ expected_back_sen: 24_000, fund_id: null });
  });
});
