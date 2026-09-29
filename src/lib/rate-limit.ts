import type { SupabaseClient } from "@supabase/supabase-js";

/** Single source of truth for the login rate limit (attempts per fixed window). */
export const LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 300 } as const;

export function windowStart(nowIso: string, windowSeconds: number): string {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(Date.parse(nowIso) / ms) * ms).toISOString();
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : "local";
}

export async function checkRateLimit(
  admin: SupabaseClient,
  opts: { key: string; limit: number; windowSeconds: number; now: string }
): Promise<boolean> {
  const { data, error } = await admin.rpc("bump_rate_limit", {
    p_key: opts.key,
    p_window_start: windowStart(opts.now, opts.windowSeconds),
  });
  if (error) return false; // fail closed
  return (data as number) <= opts.limit;
}
