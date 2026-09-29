import { describe, it, expect, vi, afterEach } from "vitest";
import { coingecko } from "./coingecko";

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

describe("coingecko.quote", () => {
  it("maps BTC to its coin id and parses USD price to exact e8", async () => {
    const fetchMock = stubFetch({ bitcoin: { usd: 117234.56, last_updated_at: 1755266400 } });
    const q = await coingecko.quote("BTC");
    expect(q).toEqual({ price_e8: 11_723_456_000_000, currency: "USD", as_of: "2025-08-15" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("ids=bitcoin");
    expect(url).toContain("vs_currencies=usd");
  });

  it("scales a sub-cent price exactly (SHIB)", async () => {
    stubFetch({ "shiba-inu": { usd: 0.00001234, last_updated_at: 1755266400 } });
    const q = await coingecko.quote("SHIB");
    expect(q).toEqual({ price_e8: 1234, currency: "USD", as_of: "2025-08-15" });
  });

  it("returns null for a symbol outside the coin-id map without fetching", async () => {
    const fetchMock = stubFetch({});
    expect(await coingecko.quote("WEIRDCOIN")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the coin is missing from the response body", async () => {
    stubFetch({});
    expect(await coingecko.quote("BTC")).toBeNull();
  });

  it("returns null on a malformed body", async () => {
    stubFetch("<html>429</html>");
    expect(await coingecko.quote("BTC")).toBeNull();
  });

  it("returns null on an HTTP error status", async () => {
    stubFetch({ bitcoin: { usd: 1 } }, 429);
    expect(await coingecko.quote("BTC")).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    expect(await coingecko.quote("BTC")).toBeNull();
  });
});

describe("coingecko.fx", () => {
  it("is unsupported: returns null without fetching", async () => {
    const fetchMock = stubFetch({});
    expect(await coingecko.fx("USDMYR")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
