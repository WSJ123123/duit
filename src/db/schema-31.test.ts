import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";

/** Phase-3.1 columns (Plan 6 Task 1): user_settings.holdings_display and
 *  transactions.received_sen (FX-transfer destination amount). */

let a: SupabaseClient;
let src: string, dst: string;

beforeAll(async () => {
  ({ a } = await makeTestUsers());
  src = (await a.from("accounts")
    .insert({ name: "Maybank", type: "bank", starting_balance_sen: 100_000 })
    .select().single()).data!.id;
  dst = (await a.from("accounts")
    .insert({ name: "Wise SGD", type: "ewallet" }).select().single()).data!.id;
}, 30_000);

describe("user_settings.holdings_display", () => {
  it("defaults to 'myr'; accepts 'native'; rejects anything else", async () => {
    const row = await a.from("user_settings").upsert({ show_tips: true }).select().single();
    expect(row.error).toBeNull();
    expect(row.data!.holdings_display).toBe("myr");

    const native = await a.from("user_settings")
      .update({ holdings_display: "native" }).eq("user_id", row.data!.user_id)
      .select().single();
    expect(native.error).toBeNull();
    expect(native.data!.holdings_display).toBe("native");

    const bad = await a.from("user_settings")
      .update({ holdings_display: "usd" }).eq("user_id", row.data!.user_id);
    expect(bad.error).not.toBeNull();
  });
});

describe("transactions.received_sen", () => {
  it("is null by default; a transfer may set it; negatives are rejected", async () => {
    const plain = await a.from("transactions")
      .insert({ type: "transfer", amount_sen: 5_000, account_id: src, transfer_account_id: dst })
      .select().single();
    expect(plain.error).toBeNull();
    expect(plain.data!.received_sen).toBeNull();

    const fx = await a.from("transactions")
      .insert({
        type: "transfer", amount_sen: 10_000, received_sen: 3_400,
        account_id: src, transfer_account_id: dst,
      })
      .select().single();
    expect(fx.error).toBeNull();
    expect(fx.data!.received_sen).toBe(3_400);

    const negative = await a.from("transactions")
      .insert({
        type: "transfer", amount_sen: 10_000, received_sen: -1,
        account_id: src, transfer_account_id: dst,
      });
    expect(negative.error).not.toBeNull();
  });
});
