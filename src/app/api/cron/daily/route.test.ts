import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResolvedQuote } from "@/lib/prices";

vi.mock("@/lib/recurring", () => ({ materializeDueRules: vi.fn() }));
vi.mock("@/lib/prices", () => ({ fetchQuotes: vi.fn(), fetchFx: vi.fn() }));
vi.mock("@/db/snapshots", () => ({ writeSnapshot: vi.fn() }));

// admin.ts imports "server-only", which throws outside a server bundle. The
// fake exposes just what the route touches: select (thenable, chainable
// .eq() that actually filters — so tests exercise the real symbol
// enumeration semantics, e.g. archived holdings are genuinely excluded) and
// upsert, backed by per-test table state.
// ⚠ `selectFails` RESOLVES with `{ data: null, error }` — the shape
// supabase-js actually produces for a failed PostgREST select. It deliberately
// does NOT reject: an earlier version of this fake did, and that made the
// wholesale-enumeration tests pass against a try/catch that real failures can
// never reach. If a fake ever has to lie about a library's contract to make a
// guard fire, the guard is not the one that runs in production.
const state = vi.hoisted(() => ({
  holdings: [] as Record<string, unknown>[],
  accounts: [] as Record<string, unknown>[],
  selectFails: {} as Record<string, string | null>,
  upserts: {} as Record<string, unknown[]>,
}));
vi.mock("@/db/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const source = table === "holdings" ? state.holdings : table === "accounts" ? state.accounts : [];
      const fails = state.selectFails[table] ?? null;
      const makeQuery = (data: Record<string, unknown>[]) => ({
        eq: (field: string, value: unknown) => makeQuery(data.filter((row) => row[field] === value)),
        then: (
          onFulfilled: (v: { data: unknown; error: { message: string } | null }) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) =>
          Promise.resolve(
            fails ? { data: null, error: { message: fails } } : { data, error: null },
          ).then(onFulfilled as (v: unknown) => unknown, onRejected),
      });
      return {
        select: () => makeQuery(source),
        upsert: (rows: unknown[]) => {
          state.upserts[table] = rows;
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

import { GET } from "./route";
import { fetchQuotes, fetchFx } from "@/lib/prices";
import { materializeDueRules } from "@/lib/recurring";
import { writeSnapshot } from "@/db/snapshots";

const AUTH = { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } };
const quote = (price_e8: number, source = "yahoo"): ResolvedQuote => ({
  price_e8, currency: "USD", as_of: "2077-01-01", source,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  state.holdings = [];
  state.accounts = [];
  state.selectFails = {};
  state.upserts = {};
  vi.mocked(materializeDueRules).mockResolvedValue({ inserted: 3, skipped: [] });
  vi.mocked(fetchQuotes).mockResolvedValue(new Map());
  vi.mocked(fetchFx).mockResolvedValue(new Map());
  vi.mocked(writeSnapshot).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/cron/daily", () => {
  it("rejects a missing bearer token", async () => {
    const res = await GET(new Request("http://localhost/api/cron/daily"));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await GET(
      new Request("http://localhost/api/cron/daily", {
        headers: { authorization: "Bearer not-the-secret" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("accepts the correct bearer but rejects wrong-length garbage", async () => {
    const ok = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(ok.status).toBe(200);

    const garbage = await GET(
      new Request("http://localhost/api/cron/daily", {
        headers: {
          authorization: `Bearer ${"x".repeat((process.env.CRON_SECRET?.length ?? 0) + 7)}`,
        },
      }),
    );
    expect(garbage.status).toBe(401);
  });

  it("materializes first and reports all counts (empty holdings day) — clean run yields errors: []", async () => {
    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      inserted: 3, prices_updated: 0, prices_failed: 0,
      fx_updated: 0, fx_failed: 0, snapshots_written: 0, errors: [],
    });
    expect(materializeDueRules).toHaveBeenCalledTimes(1);
    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(fetchFx).not.toHaveBeenCalled();
  });

  it("fetches auto, non-archived symbols only, upserts winners, counts failures + errors (stale grace)", async () => {
    state.holdings = [
      { symbol: "VWRA.L", kind: "etf", currency: "USD", price_source: "auto", archived: false },
      { symbol: "BTC", kind: "crypto", currency: "USD", price_source: "auto", archived: false },
      { symbol: "ASNB", kind: "stock", currency: "MYR", price_source: "manual", archived: false },
      { symbol: "MAYBANK", kind: "stock", currency: "MYR", price_source: "auto", archived: false },
      // archived holding: must never reach symbol enumeration, even though
      // price_source is "auto" — proves the fake's .eq("archived", false)
      // filter is real, not a no-op.
      { symbol: "OLDSTOCK", kind: "stock", currency: "USD", price_source: "auto", archived: true },
    ];
    // Task 5: account currencies join the FX-pair enumeration — u2's ZCU
    // brokerage account needs ZCUMYR alongside the holdings' USDMYR. MYR
    // accounts (and legacy rows without the column) add nothing.
    state.accounts = [
      { user_id: "u1", currency: "MYR" },
      { user_id: "u1", currency: "ZCU" },
      { user_id: "u2", currency: "ZCU" }, // dedupes with u1's
    ];
    vi.mocked(fetchQuotes).mockResolvedValue(new Map<string, ResolvedQuote | { error: string }>([
      ["VWRA.L", quote(13_975_000_000)],
      ["BTC", { error: "coingecko: not found" }],
      ["MAYBANK", quote(1_000_000_000, "yahoo")],
    ]));
    vi.mocked(fetchFx).mockResolvedValue(
      new Map([["USDMYR", { ...quote(442_350_000), currency: "MYR" }]]),
    );

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      inserted: 3, prices_updated: 2, prices_failed: 1,
      fx_updated: 1, fx_failed: 0, snapshots_written: 2,
      errors: ["price BTC: coingecko: not found"],
    });

    // manual holding and the archived holding never reach the fetch layer
    expect(fetchQuotes).toHaveBeenCalledWith([
      { symbol: "VWRA.L", kind: "etf" },
      { symbol: "BTC", kind: "crypto" },
      { symbol: "MAYBANK", kind: "stock" },
    ]);
    // MYR needs no pair; the two USD holdings dedupe to one; the ZCU
    // ACCOUNT currency joins the enumeration (Task 5)
    expect(fetchFx).toHaveBeenCalledWith(["USDMYR", "ZCUMYR"]);

    // failed symbols are NOT upserted — the old row stays (ruling 10)
    const priceRows = state.upserts["prices"] as Array<{ symbol: string; source: string }>;
    expect(priceRows.map((r) => r.symbol).sort()).toEqual(["MAYBANK", "VWRA.L"]);
    expect(priceRows.find((r) => r.symbol === "VWRA.L")).toMatchObject({
      currency: "USD", price_e8: 13_975_000_000, as_of: "2077-01-01", source: "yahoo",
    });
    expect(state.upserts["fx_rates"]).toEqual([
      expect.objectContaining({ pair: "USDMYR", rate_e8: 442_350_000, source: "yahoo" }),
    ]);

    // one snapshot per distinct user
    expect(writeSnapshot).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeSnapshot).mock.calls.map((c) => c[1])).toEqual(["u1", "u2"]);
  });

  it("a fully-failed price and FX fetch populates errors and still writes the snapshot from stale prices", async () => {
    state.holdings = [
      { symbol: "VWRA.L", kind: "etf", currency: "USD", price_source: "auto", archived: false },
    ];
    state.accounts = [{ user_id: "u1" }];
    vi.mocked(fetchQuotes).mockResolvedValue(
      new Map<string, ResolvedQuote | { error: string }>([["VWRA.L", { error: "yahoo timeout" }]]),
    );
    vi.mocked(fetchFx).mockResolvedValue(
      new Map<string, ResolvedQuote | { error: string }>([["USDMYR", { error: "parse error" }]]),
    );

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      inserted: 3, prices_updated: 0, prices_failed: 1,
      fx_updated: 0, fx_failed: 1, snapshots_written: 1,
      errors: ["price VWRA.L: yahoo timeout", "fx USDMYR: parse error"],
    });
    expect(state.upserts["prices"]).toBeUndefined();
    expect(state.upserts["fx_rates"]).toBeUndefined();
    // stale grace: old rows stay untouched, and the snapshot still writes
    expect(writeSnapshot).toHaveBeenCalledWith(expect.anything(), "u1", expect.any(String));
  });

  it("a total source outage never 500s, still snapshots from stale prices, and REPORTS the failure", async () => {
    state.holdings = [
      { symbol: "VWRA.L", kind: "etf", currency: "USD", price_source: "auto", archived: false },
    ];
    state.accounts = [{ user_id: "u1" }];
    vi.mocked(fetchQuotes).mockRejectedValue(new Error("network down"));

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots_written).toBe(1);
    // ruling 3: counts alone cannot distinguish an outage from a
    // nothing-to-do day — the wholesale failure must name itself
    expect(body.errors).toEqual(["prices/fx: network down"]);
    expect(writeSnapshot).toHaveBeenCalledWith(expect.anything(), "u1", expect.any(String));
  });

  it("a non-Error thrown by the price layer still reports a fixed-string entry", async () => {
    state.holdings = [
      { symbol: "VWRA.L", kind: "etf", currency: "USD", price_source: "auto", archived: false },
    ];
    state.accounts = [{ user_id: "u1" }];
    vi.mocked(fetchQuotes).mockRejectedValue("not an Error");

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    expect((await res.json()).errors).toEqual(["prices/fx: price/FX refresh failed"]);
  });

  it("a failed HOLDINGS enumeration names itself instead of reading as an empty portfolio", async () => {
    // PostgREST resolves `{ data: null, error }`, so the block's try/catch
    // never fires: `holdings ?? []` is empty, nothing is fetched, and every
    // count is the clean nothing-to-do day's. errors[] is the only tell.
    state.selectFails.holdings = "holdings unavailable";

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toContain("prices/fx holdings: holdings unavailable");
    // The counts are untouched in meaning — they simply cannot show this.
    expect(body.prices_updated).toBe(0);
    expect(body.prices_failed).toBe(0);
    expect(body.inserted).toBe(3);
    // …and the run is no longer byte-identical to a clean day (that day's
    // assertion above is `errors: []`).
    expect(body.errors).not.toEqual([]);
  });

  it("a failed ACCOUNT-currency enumeration names itself while every count still reads clean", async () => {
    // The genuinely count-invisible case. The holding currencies resolve, so
    // prices and FX both report success counts exactly as on a good day —
    // while non-MYR ACCOUNT currencies have silently dropped out of the pair
    // enumeration. Not one count moves; only errors[] says so.
    state.holdings = [
      { symbol: "VWRA.L", kind: "etf", currency: "USD", price_source: "auto", archived: false },
    ];
    vi.mocked(fetchQuotes).mockResolvedValue(new Map([["VWRA.L", quote(19_616_000_000)]]));
    vi.mocked(fetchFx).mockResolvedValue(new Map([["USDMYR", quote(406_000_000)]]));
    state.selectFails.accounts = "accounts unavailable";

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prices_updated).toBe(1);
    expect(body.fx_updated).toBe(1);
    expect(body.prices_failed).toBe(0);
    expect(body.fx_failed).toBe(0);
    expect(body.errors).toContain("prices/fx accounts: accounts unavailable");
  });

  it("a failed user enumeration reports a snapshots error instead of a silent zero", async () => {
    vi.mocked(materializeDueRules).mockResolvedValue({ inserted: 0, skipped: [] });
    state.selectFails.accounts = "accounts select exploded";

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots_written).toBe(0);
    expect(body.errors).toContain("snapshots: accounts select exploded");
  });

  it("a per-user snapshot failure degrades the count, never the route, and NAMES itself (ruling 17)", async () => {
    state.accounts = [{ user_id: "u1" }, { user_id: "u2" }];
    vi.mocked(writeSnapshot)
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce();

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshots_written).toBe(1);
    // one entry per unit of work the counts cannot show — dated, no user id
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/^snapshot \d{4}-\d{2}-\d{2}: db hiccup$/);
    // the counts keep their meaning
    expect(body.inserted).toBe(3);
    expect(body.prices_updated).toBe(0);
    expect(body.prices_failed).toBe(0);
    expect(body.fx_updated).toBe(0);
    expect(body.fx_failed).toBe(0);
  });

  it("a non-Error snapshot rejection still reports a fixed-string entry", async () => {
    state.accounts = [{ user_id: "u1" }];
    vi.mocked(writeSnapshot).mockRejectedValueOnce("not an Error");

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    const body = await res.json();
    expect(body.snapshots_written).toBe(0);
    expect(body.errors[0]).toMatch(/^snapshot \d{4}-\d{2}-\d{2}: snapshot failed$/);
  });

  it("materializer skips are reported one per rule while every count is unchanged (rulings 16/17)", async () => {
    vi.mocked(materializeDueRules).mockResolvedValue({
      inserted: 2,
      skipped: [
        "rule-a: ZQR account — a MYR rule cannot be materialized into it",
        "rule-b: ZQR account — a MYR rule cannot be materialized into it",
      ],
    });

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      inserted: 2, prices_updated: 0, prices_failed: 0,
      fx_updated: 0, fx_failed: 0, snapshots_written: 0,
      errors: [
        "recurring rule-a: ZQR account — a MYR rule cannot be materialized into it",
        "recurring rule-b: ZQR account — a MYR rule cannot be materialized into it",
      ],
    });
  });

  it("a materializer failure is reported instead of 500ing the whole run", async () => {
    state.accounts = [{ user_id: "u1" }];
    vi.mocked(materializeDueRules).mockRejectedValue(new Error("rules select exploded"));

    const res = await GET(new Request("http://localhost/api/cron/daily", AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(0);
    expect(body.errors).toContain("recurring: rules select exploded");
    // the rest of the run still happens
    expect(body.snapshots_written).toBe(1);
  });
});
