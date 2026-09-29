import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashToken } from "@/lib/tokens";

/**
 * Route guard-chain unit tests for POST /api/quick-entry. The DB behavior of
 * performQuickEntry lives in src/db/quick-entry.test.ts; here everything
 * behind the route boundary is mocked so each row of the route contract table
 * can be pinned in isolation.
 */

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  performQuickEntry: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  tokenMaybeSingle: vi.fn<() => Promise<{ data: unknown; error: unknown }>>(),
  tokenFilters: [] as Array<[string, unknown]>,
  lastUsedUpdate: vi.fn<(values: unknown, id: unknown) => Promise<{ error: null }>>(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: h.checkRateLimit,
}));

vi.mock("@/lib/quick-entry", () => ({ performQuickEntry: h.performQuickEntry }));

vi.mock("@/db/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "api_tokens") throw new Error(`unexpected table: ${table}`);
      const chain = {
        eq: (col: string, val: unknown) => {
          h.tokenFilters.push([col, val]);
          return chain;
        },
        maybeSingle: h.tokenMaybeSingle,
      };
      return {
        select: () => chain,
        update: (values: unknown) => ({
          eq: (_col: string, id: unknown) => h.lastUsedUpdate(values, id),
        }),
      };
    },
  }),
}));

import { POST } from "@/app/api/quick-entry/route";

const RAW_TOKEN = "duit_test-raw-token";
const TOKEN_ROW = { id: "tok-1", user_id: "user-1", token_hash: hashToken(RAW_TOKEN) };

function makeRequest(opts: { auth?: string; body?: unknown; rawBody?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  if (opts.ip !== undefined) headers["x-forwarded-for"] = opts.ip;
  return new Request("http://localhost/api/quick-entry", {
    method: "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(opts.body ?? { text: "grab 18 tng" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tokenFilters.length = 0;
  h.checkRateLimit.mockResolvedValue(true);
  h.tokenMaybeSingle.mockResolvedValue({ data: TOKEN_ROW, error: null });
  h.lastUsedUpdate.mockResolvedValue({ error: null });
  h.performQuickEntry.mockResolvedValue({
    ok: true,
    status: 200,
    message: "✓ RM 18.00 · Grab · TnG eWallet",
    transaction_id: "11111111-1111-4111-8111-111111111111",
    needs_review: false,
  });
});

describe("POST /api/quick-entry", () => {
  it("429 rate_limited on the pre-auth IP limit, before any token lookup", async () => {
    h.checkRateLimit.mockResolvedValueOnce(false);
    const res = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}`, ip: "1.2.3.4" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });

    expect(h.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(h.checkRateLimit.mock.calls[0]![1]).toMatchObject({
      key: "qe-ip:1.2.3.4",
      limit: 60,
      windowSeconds: 60,
    });
    expect(h.tokenMaybeSingle).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["Basic scheme", "Basic x"],
    ["empty Bearer", "Bearer "],
    ["Bearer without duit_ prefix", "Bearer sk-not-ours"],
  ])("401 unauthorized on malformed Authorization: %s", async (_label, auth) => {
    const res = await POST(makeRequest(auth === undefined ? {} : { auth }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(h.tokenMaybeSingle).not.toHaveBeenCalled();
    expect(h.performQuickEntry).not.toHaveBeenCalled();
  });

  it("401 with the identical body when the token hash is not found", async () => {
    h.tokenMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("revoked tokens are excluded by the lookup itself and yield the same 401 body (no oracle)", async () => {
    // The route must filter revoked = false, so a revoked row comes back as
    // data: null — indistinguishable from not-found.
    h.tokenMaybeSingle.mockResolvedValue({ data: null, error: null });
    const revokedRes = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}` }));
    expect(h.tokenFilters).toContainEqual(["revoked", false]);
    expect(h.tokenFilters).toContainEqual(["token_hash", hashToken(RAW_TOKEN)]);
    expect(revokedRes.status).toBe(401);
    const revokedBody = await revokedRes.json();

    const missingRes = await POST(makeRequest({ auth: "Bearer duit_unknown-token" }));
    expect(missingRes.status).toBe(401);
    expect(await missingRes.json()).toEqual(revokedBody);
  });

  it("401 when the stored hash fails the belt-and-braces safeEqual recheck", async () => {
    h.tokenMaybeSingle.mockResolvedValue({
      data: { ...TOKEN_ROW, token_hash: hashToken("duit_some-other-token") },
      error: null,
    });
    const res = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(h.performQuickEntry).not.toHaveBeenCalled();
  });

  it("429 on the per-token limit, keyed by the token row id — not the IP", async () => {
    h.checkRateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}`, ip: "1.2.3.4" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });

    expect(h.checkRateLimit).toHaveBeenCalledTimes(2);
    const tokenCall = h.checkRateLimit.mock.calls[1]![1] as { key: string; limit: number };
    expect(tokenCall).toMatchObject({ key: "qe-token:tok-1", limit: 30, windowSeconds: 60 });
    expect(tokenCall.key).not.toContain("1.2.3.4");
    expect(h.performQuickEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON body", { rawBody: "not json{" }],
    ["missing text", { body: {} }],
    ["empty text", { body: { text: "" } }],
    ["text of 201 chars", { body: { text: "x".repeat(201) } }],
    ["non-uuid clientId", { body: { text: "grab 18", clientId: "not-a-uuid" } }],
  ] as const)("400 bad_request on %s", async (_label, opts) => {
    const res = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}`, ...opts }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(h.performQuickEntry).not.toHaveBeenCalled();
  });

  it("accepts text of exactly 200 chars", async () => {
    const res = await POST(
      makeRequest({ auth: `Bearer ${RAW_TOKEN}`, body: { text: "9 " + "x".repeat(198) } }),
    );
    expect(res.status).toBe(200);
  });

  it.each([["no_amount"], ["no_account"]] as const)("maps a 422 %s result through", async (err) => {
    h.performQuickEntry.mockResolvedValue({ ok: false, status: 422, error: err });
    const res = await POST(makeRequest({ auth: `Bearer ${RAW_TOKEN}` }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: err });
  });

  it("200 success: delegates with the token owner's userId and KL today, touches last_used_at", async () => {
    const clientId = "22222222-2222-4222-8222-222222222222";
    const res = await POST(
      makeRequest({ auth: `Bearer ${RAW_TOKEN}`, body: { text: "grab 18 tng", clientId } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      message: "✓ RM 18.00 · Grab · TnG eWallet",
      transaction_id: "11111111-1111-4111-8111-111111111111",
      needs_review: false,
    });

    expect(h.performQuickEntry).toHaveBeenCalledTimes(1);
    const args = h.performQuickEntry.mock.calls[0]![1] as {
      userId: string;
      text: string;
      clientId?: string;
      todayIso: string;
    };
    expect(args.userId).toBe("user-1");
    expect(args.text).toBe("grab 18 tng");
    expect(args.clientId).toBe(clientId);
    expect(args.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(h.lastUsedUpdate).toHaveBeenCalledTimes(1);
    const [values, id] = h.lastUsedUpdate.mock.calls[0]!;
    expect(id).toBe("tok-1");
    expect(values).toHaveProperty("last_used_at");
  });
});
