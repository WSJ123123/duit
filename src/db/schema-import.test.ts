import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { makeTestUsers } from "@/db/test-clients";

/**
 * Plan 8 Task 1: the debt-payoff + import schema's own guarantees (ruling 19).
 * Error CODES are pinned, not just "an error happened": 23514 check,
 * 23503 foreign key.
 */

let a: SupabaseClient;
let b: SupabaseClient;
let acctId: string;
let bAcctId: string;
let aBatchId: string;

const sha256 = () => randomBytes(32).toString("hex");

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());

  const acct = await a.from("accounts")
    .insert({ name: "Maybank", type: "bank" }).select().single();
  if (acct.error) throw acct.error;
  acctId = acct.data.id;

  const bAcct = await b.from("accounts")
    .insert({ name: "B's bank", type: "bank" }).select().single();
  if (bAcct.error) throw bAcct.error;
  bAcctId = bAcct.data.id;

  const batch = await a.from("import_batches")
    .insert({ account_id: acctId, filename: "maybank-2077-01.csv", content_sha256: sha256(), row_count: 12 })
    .select().single();
  if (batch.error) throw batch.error;
  aBatchId = batch.data.id;
}, 30_000);

describe("liabilities.planned_payment_sen", () => {
  it("rejects a negative planned payment", async () => {
    const { error } = await a.from("liabilities")
      .insert({ name: "Car loan", kind: "loan", planned_payment_sen: -1 });
    expect(error?.code).toBe("23514");
  });

  it("defaults to 0", async () => {
    const { data, error } = await a.from("liabilities")
      .insert({ name: "PTPTN", kind: "ptptn" }).select().single();
    expect(error).toBeNull();
    expect(data!.planned_payment_sen).toBe(0);
  });
});

describe("import_batches", () => {
  it("rejects an empty filename", async () => {
    const { error } = await a.from("import_batches")
      .insert({ account_id: acctId, filename: "", content_sha256: sha256(), row_count: 1 });
    expect(error?.code).toBe("23514");
  });

  it("composite FK rejects another user's account_id", async () => {
    const { error } = await b.from("import_batches")
      .insert({ account_id: acctId, filename: "evil.csv", content_sha256: sha256(), row_count: 1 });
    expect(error?.code).toBe("23503");
  });

  it("defaults undone_at to null and the three counters to 0", async () => {
    const { data, error } = await a.from("import_batches")
      .select().eq("id", aBatchId).single();
    expect(error).toBeNull();
    expect(data!.undone_at).toBeNull();
    expect(data!.skipped_count).toBe(0);
    expect(data!.needs_review_count).toBe(0);
    expect(data!.unparseable_count).toBe(0);
  });
});

describe("transactions.import_batch_id", () => {
  it("composite FK rejects another user's import_batch_id", async () => {
    const { error } = await b.from("transactions").insert({
      type: "expense", amount_sen: 5_000, account_id: bAcctId,
      date: "2077-01-05", source: "import", import_batch_id: aBatchId,
    });
    expect(error?.code).toBe("23503");
  });
});

describe("user_settings.import_mappings", () => {
  it("defaults to {}", async () => {
    const { data, error } = await a.from("user_settings")
      .upsert({ show_tips: true }).select().single();
    expect(error).toBeNull();
    expect(data!.import_mappings).toEqual({});
  });
});
