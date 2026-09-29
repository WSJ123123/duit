import { describe, it, expect, beforeAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeTestUsers } from "@/db/test-clients";
import { performCreateToken, performRevokeToken } from "@/db/tokens";
import { hashToken } from "@/lib/tokens";

let a: SupabaseClient, b: SupabaseClient;

beforeAll(async () => {
  ({ a, b } = await makeTestUsers());
}, 30_000);

describe("api_tokens", () => {
  let rawToken: string;
  let rowId: string;

  it("performCreateToken stores a 64-hex hash, never the raw token in any column", async () => {
    const result = await performCreateToken(a, "Test shortcut");
    expect(result.error).toBeUndefined();
    expect(result.token).toBeDefined();
    rawToken = result.token!;

    const { data, error } = await a.from("api_tokens").select("*");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const row = data![0] as Record<string, unknown>;
    rowId = row.id as string;

    expect(row.name).toBe("Test shortcut");
    expect(row.revoked).toBe(false);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(rawToken);
    for (const value of Object.values(row)) {
      expect(String(value)).not.toContain(rawToken);
    }
  });

  it("the returned raw token hashes to the stored hash", async () => {
    const { data } = await a.from("api_tokens").select("token_hash").eq("id", rowId).single();
    expect(data!.token_hash).toBe(hashToken(rawToken));
  });

  it("performRevokeToken flips revoked to true", async () => {
    const result = await performRevokeToken(a, rowId);
    expect(result.error).toBeUndefined();

    const { data } = await a.from("api_tokens").select("revoked").eq("id", rowId).single();
    expect(data!.revoked).toBe(true);
  });

  it("B sees zero rows of A's tokens (RLS)", async () => {
    const { data, error } = await b.from("api_tokens").select("*");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
