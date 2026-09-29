import { z } from "zod";
import { createAdminClient } from "@/db/admin";
import { klToday } from "@/lib/kl-date";
import { performQuickEntry } from "@/lib/quick-entry";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { safeEqual } from "@/lib/safe-equal";
import { hashToken } from "@/lib/tokens";

/**
 * iOS Shortcut quick-entry endpoint. The presented `duit_` token authorizes
 * inserting ONE transaction for its owner — nothing else. This route is the
 * clock boundary (`new Date()` lives here only) and stays thin: guard chain
 * in contract order, then delegate to performQuickEntry.
 */

const bodySchema = z.object({
  text: z.string().min(1).max(200),
  clientId: z.uuid().optional(),
});

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
const rateLimited = () => Response.json({ error: "rate_limited" }, { status: 429 });

export async function POST(request: Request): Promise<Response> {
  const admin = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Pre-auth IP limit: 60/min.
  const ipAllowed = await checkRateLimit(admin, {
    key: `qe-ip:${clientIp(request.headers)}`,
    limit: 60,
    windowSeconds: 60,
    now: nowIso,
  });
  if (!ipAllowed) return rateLimited();

  // 2. Bearer token. Cheap shape check before touching the database.
  const auth = request.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!presented.startsWith("duit_")) return unauthorized();

  const presentedHash = hashToken(presented);
  const { data: tokenRow, error: tokenErr } = await admin
    .from("api_tokens")
    .select("id, user_id, token_hash")
    .eq("token_hash", presentedHash)
    .eq("revoked", false)
    .maybeSingle();
  // Not-found and revoked share one body: no oracle for token probing.
  if (tokenErr || !tokenRow) return unauthorized();
  const row = tokenRow as { id: string; user_id: string; token_hash: string };
  if (!safeEqual(row.token_hash, presentedHash)) return unauthorized();

  // 3. Per-token limit: 30/min.
  const tokenAllowed = await checkRateLimit(admin, {
    key: `qe-token:${row.id}`,
    limit: 30,
    windowSeconds: 60,
    now: nowIso,
  });
  if (!tokenAllowed) return rateLimited();

  await admin.from("api_tokens").update({ last_used_at: nowIso }).eq("id", row.id);

  // 4. Body.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const body = bodySchema.safeParse(raw);
  if (!body.success) return Response.json({ error: "bad_request" }, { status: 400 });

  // 5. The one thing this token may do.
  const result = await performQuickEntry(admin, {
    userId: row.user_id,
    text: body.data.text,
    ...(body.data.clientId !== undefined ? { clientId: body.data.clientId } : {}),
    todayIso: klToday(now),
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({
    ok: true,
    message: result.message,
    transaction_id: result.transaction_id,
    needs_review: result.needs_review,
  });
}
