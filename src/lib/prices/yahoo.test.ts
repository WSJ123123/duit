import { describe, it, expect, vi, afterEach } from "vitest";
import { yahoo } from "./yahoo";

/** Canned Yahoo v8 chart payload (shape verified in docs/findings.md). */
function chartFixture(
  price: number,
  currency = "USD",
  time = 1755266400, // 2025-08-15T14:00:00Z
  tz = "Europe/London",
): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            currency,
            symbol: "VWRA.L",
            exchangeTimezoneName: tz,
            regularMarketPrice: price,
            regularMarketTime: time,
          },
        },
      ],
      error: null,
    },
  };
}

function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("yahoo.quote", () => {
  it("parses a quote to exact e8 with the exchange-timezone trading date", async () => {
    const fetchMock = stubFetch(chartFixture(139.75));
    const q = await yahoo.quote("VWRA.L");
    expect(q).toEqual({ price_e8: 13_975_000_000, currency: "USD", as_of: "2025-08-15" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(encodeURIComponent("VWRA.L"));
  });

  it("returns null for a missing symbol (error body, no result)", async () => {
    stubFetch({ chart: { result: null, error: { code: "Not Found", description: "no data" } } });
    expect(await yahoo.quote("NOPE.XYZ")).toBeNull();
  });

  it("returns null on a malformed (non-JSON) body", async () => {
    stubFetch("<html>rate limited</html>");
    expect(await yahoo.quote("VWRA.L")).toBeNull();
  });

  it("returns null on a JSON body that fails the schema", async () => {
    stubFetch({ chart: { result: [{ meta: { currency: "USD" } }] } });
    expect(await yahoo.quote("VWRA.L")).toBeNull();
  });

  it("returns null on an HTTP error status", async () => {
    stubFetch(chartFixture(139.75), 404);
    expect(await yahoo.quote("VWRA.L")).toBeNull();
  });

  it("returns null when fetch rejects (timeout/network)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    expect(await yahoo.quote("VWRA.L")).toBeNull();
  });

  it("returns null on a non-positive price", async () => {
    stubFetch(chartFixture(0));
    expect(await yahoo.quote("VWRA.L")).toBeNull();
  });
});

describe("yahoo.fx", () => {
  it("maps the pair to the =X symbol and parses to exact e8", async () => {
    const fetchMock = stubFetch(chartFixture(4.4235, "MYR", 1755266400, "Asia/Kuala_Lumpur"));
    const q = await yahoo.fx("USDMYR");
    expect(q).toEqual({ price_e8: 442_350_000, currency: "MYR", as_of: "2025-08-15" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(encodeURIComponent("USDMYR=X"));
  });

  it("rejects a malformed pair without fetching", async () => {
    const fetchMock = stubFetch(chartFixture(1));
    expect(await yahoo.fx("US")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
