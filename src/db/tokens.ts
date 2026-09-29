import type { SupabaseClient } from "@supabase/supabase-js";
import { generateToken } from "@/lib/tokens";

/**
 * DB cores for api_tokens (spec §6 rev 8, GLOBAL_RULES rule 11). Only the
 * sha-256 hash ever reaches the database; the raw token is returned to the
 * caller exactly once and never logged or persisted. Revoke is an update —
 * the schema grants no DELETE, keeping an audit trail.
 */

export interface ApiTokenRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

export async function performCreateToken(
  supabase: SupabaseClient,
  name?: string,
): Promise<{ token?: string; error?: string }> {
  const { token, hash } = generateToken();
  const trimmed = name?.trim();
  const row: { token_hash: string; name?: string } = { token_hash: hash };
  if (trimmed) row.name = trimmed;

  const { error } = await supabase.from("api_tokens").insert(row);
  if (error) return { error: error.message };
  return { token };
}

export async function performRevokeToken(
  supabase: SupabaseClient,
  id: string,
): Promise<{ error?: string }> {
  const { error } = await supabase.from("api_tokens").update({ revoked: true }).eq("id", id);
  if (error) return { error: error.message };
  return {};
}

/** Revoke the old token and mint a replacement carrying the same name. */
export async function performRegenerateToken(
  supabase: SupabaseClient,
  id: string,
): Promise<{ token?: string; error?: string }> {
  const { data, error } = await supabase.from("api_tokens").select("name").eq("id", id).single();
  if (error) return { error: error.message };

  const revoked = await performRevokeToken(supabase, id);
  if (revoked.error) return { error: revoked.error };

  return performCreateToken(supabase, (data as { name: string }).name);
}
